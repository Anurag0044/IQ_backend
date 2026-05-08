// ============================================
// CloudIQ Backend - Discussion Socket Handlers
// ============================================
// Handles channel join/leave, messaging, typing, reactions, presence, unread updates.
// Designed to plug into the existing io.on('connection') without rewrites.
//
// OPTIMIZED for Cloudant Lite plan:
//   - In-memory unread counters (batch-flushed every 30s instead of per-message writes)
//   - Cached community/membership lookups via cacheService
//   - postView instead of postFind for indexed queries
//   - Admin role cached on socket.data

const { v4: uuidv4 } = require('uuid');
const { extractUserInfo, checkAdminRoleSync } = require('../middleware/auth');
const { communityCache, membershipCache } = require('../services/cacheService');

const DB_COMMUNITIES = 'communities';
const DB_MEMBERSHIPS = 'community_memberships';
const DB_CHANNELS = 'channels';
const DB_MESSAGES = 'messages';
const DB_REACTIONS = 'message_reactions';
const DB_UNREAD = 'unread_states';

function nowIso() {
  return new Date().toISOString();
}

async function getDocOrNull(cloudant, db, docId) {
  try {
    return (await cloudant.getDocument({ db, docId })).result;
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

// ─── Cached community fetch ──────────────────────────────────────────────────
async function getCachedCommunity(cloudant, communityId) {
  const cacheKey = `comm:${communityId}`;
  const cached = communityCache.get(cacheKey);
  if (cached) return cached;

  const doc = await getDocOrNull(cloudant, DB_COMMUNITIES, communityId);
  if (doc) communityCache.set(cacheKey, doc);
  return doc;
}

// ─── Cached membership check ────────────────────────────────────────────────
async function isCommunityMember(cloudant, userId, community) {
  if (!userId || !community) return false;

  // Check in-document members array first (zero reads)
  if (Array.isArray(community.members) && community.members.includes(userId)) return true;

  // Check cache
  const cacheKey = `mem:${userId}:${community._id}`;
  const cached = membershipCache.get(cacheKey);
  if (cached !== undefined) return cached;

  // Check memberships DB via view (indexed, fast)
  try {
    const res = await cloudant.postView({
      db: DB_MEMBERSHIPS,
      ddoc: 'community_memberships',
      view: 'by_community',
      key: [community._id, userId],
      limit: 1,
    });
    const isMember = (res.result.rows || []).length > 0;
    membershipCache.set(cacheKey, isMember);
    return isMember;
  } catch (err) {
    console.warn('[SOCKET][DISCUSSIONS] Membership lookup failed:', err.message);
    return false;
  }
}

function isCommunityModerator(userId, community, isAdmin) {
  if (isAdmin) return true;
  if (!userId || !community) return false;
  if (community.owner_id === userId) return true;
  if (Array.isArray(community.co_admin_ids) && community.co_admin_ids.includes(userId)) return true;
  return false;
}

function canAccessChannel({ channel, userId, isAdmin, isMod }) {
  if (!channel) return false;
  if (isAdmin) return true;
  if (channel.visibility === 'mods') return Boolean(isMod);
  if (channel.visibility === 'restricted') {
    return Array.isArray(channel.allowed_member_ids) && channel.allowed_member_ids.includes(userId);
  }
  return true;
}

// ─── In-memory presence (per server runtime) ─────────────────────────────────
const onlineUsers = new Map(); // userId -> { socketId, lastSeenAt }

function broadcastPresence(io, communityId) {
  if (!communityId) return;
  const users = Array.from(onlineUsers.entries()).map(([userId, meta]) => ({
    user_id: userId,
    socket_id: meta.socketId,
    last_seen_at: meta.lastSeenAt,
  }));
  io.to(`community:${communityId}`).emit('online_presence', { community_id: communityId, users });
}

// ─── In-memory unread counters (batch-flushed to Cloudant) ───────────────────
// Key: `${userId}:${channelId}` → { count, communityId, dirty }
const pendingUnreads = new Map();
let unreadFlushTimer = null;

function bumpUnreadInMemory({ community, channelId, senderId }) {
  const members = Array.isArray(community?.members) ? community.members : [];
  if (members.length === 0) return;

  for (const userId of members) {
    if (!userId || userId === senderId) continue;
    const key = `${userId}:${channelId}`;
    const existing = pendingUnreads.get(key);
    if (existing) {
      existing.count += 1;
      existing.dirty = true;
    } else {
      pendingUnreads.set(key, {
        userId,
        channelId,
        communityId: community._id,
        count: 1,
        dirty: true,
      });
    }
  }
}

async function flushUnreadsToCloudant(cloudant) {
  if (pendingUnreads.size === 0) return;

  const dirtyEntries = [];
  for (const [key, entry] of pendingUnreads) {
    if (entry.dirty) {
      dirtyEntries.push({ key, ...entry });
      entry.dirty = false;
    }
  }

  if (dirtyEntries.length === 0) return;

  // Process in batches of 10 to avoid rate limits
  const batchSize = 10;
  for (let i = 0; i < dirtyEntries.length; i += batchSize) {
    const batch = dirtyEntries.slice(i, i + batchSize);

    for (const entry of batch) {
      try {
        // Find existing unread doc
        let existing = null;
        try {
          const res = await cloudant.postView({
            db: DB_UNREAD,
            ddoc: 'unread_states',
            view: 'by_user_channel',
            key: [entry.userId, entry.channelId],
            includeDocs: true,
            limit: 1,
          });
          existing = res.result.rows?.[0]?.doc || null;
        } catch (_err) {}

        const ts = nowIso();
        const doc = existing || {
          _id: uuidv4(),
          user_id: entry.userId,
          community_id: entry.communityId,
          channel_id: entry.channelId,
          unread_count: 0,
          last_read_at: null,
          created_at: ts,
          updated_at: ts,
        };

        doc.unread_count = Math.min(9999, Number(doc.unread_count || 0) + entry.count);
        doc.updated_at = ts;

        if (existing) {
          await cloudant.putDocument({ db: DB_UNREAD, docId: doc._id, document: doc });
        } else {
          await cloudant.postDocument({ db: DB_UNREAD, document: doc });
        }

        // Reset the count after successful flush
        const pending = pendingUnreads.get(entry.key);
        if (pending) pending.count = 0;
      } catch (err) {
        // Re-mark as dirty for next flush
        const pending = pendingUnreads.get(entry.key);
        if (pending) pending.dirty = true;
      }
    }

    // Small delay between batches to avoid too_many_requests
    if (i + batchSize < dirtyEntries.length) {
      await new Promise(r => setTimeout(r, 200));
    }
  }
}

function startUnreadFlusher(cloudant, intervalMs = 30000) {
  if (unreadFlushTimer) clearInterval(unreadFlushTimer);
  unreadFlushTimer = setInterval(() => flushUnreadsToCloudant(cloudant), intervalMs);
  if (unreadFlushTimer.unref) unreadFlushTimer.unref();
}

// ─── Socket Handler ──────────────────────────────────────────────────────────
function attachDiscussionSocketHandlers({ io, socket, cloudant }) {

  // Start the unread flusher on first attachment (idempotent)
  if (!unreadFlushTimer) startUnreadFlusher(cloudant);

  socket.on('join_community_discussions', async ({ community_id }) => {
    try {
      const userId = socket.data.userId;
      if (!userId || !community_id) return;
      const community = await getCachedCommunity(cloudant, community_id);
      const isAdmin = checkAdminRoleSync({ email: socket.data.email });
      const member = await isCommunityMember(cloudant, userId, community);
      if (!member && !isAdmin) return;
      socket.join(`community:${community_id}`);
      onlineUsers.set(userId, { socketId: socket.id, lastSeenAt: nowIso() });
      broadcastPresence(io, community_id);
      io.to(`community:${community_id}`).emit('join_leave_updates', { type: 'join', community_id, user_id: userId, at: nowIso() });
    } catch (err) {
      console.warn('[SOCKET][DISCUSSIONS] join_community_discussions failed:', err.message);
    }
  });

  socket.on('leave_community_discussions', async ({ community_id }) => {
    const userId = socket.data.userId;
    if (!userId || !community_id) return;
    socket.leave(`community:${community_id}`);
    onlineUsers.delete(userId);
    broadcastPresence(io, community_id);
    io.to(`community:${community_id}`).emit('join_leave_updates', { type: 'leave', community_id, user_id: userId, at: nowIso() });
  });

  socket.on('join_channel', async ({ channel_id }) => {
    try {
      const userId = socket.data.userId;
      if (!userId || !channel_id) return;

      const channel = await getDocOrNull(cloudant, DB_CHANNELS, channel_id);
      if (!channel) return;

      const community = await getCachedCommunity(cloudant, channel.community_id);
      const isAdmin = checkAdminRoleSync({ email: socket.data.email });
      const member = await isCommunityMember(cloudant, userId, community);
      if (!member && !isAdmin) return;

      const isMod = isCommunityModerator(userId, community, isAdmin);
      if (!canAccessChannel({ channel, userId, isAdmin, isMod })) return;

      socket.join(`channel:${channel._id}`);

      socket.emit('channel_joined', { channel_id: channel._id });
      socket.to(`channel:${channel._id}`).emit('join_leave_updates', { type: 'join', channel_id: channel._id, user_id: userId, at: nowIso() });
    } catch (err) {
      console.warn('[SOCKET][DISCUSSIONS] join_channel failed:', err.message);
    }
  });

  socket.on('leave_channel', async ({ channel_id }) => {
    const userId = socket.data.userId;
    if (!userId || !channel_id) return;
    socket.leave(`channel:${channel_id}`);
    socket.to(`channel:${channel_id}`).emit('join_leave_updates', { type: 'leave', channel_id, user_id: userId, at: nowIso() });
  });

  socket.on('typing_start', ({ channel_id }) => {
    const userId = socket.data.userId;
    if (!userId || !channel_id) return;
    socket.to(`channel:${channel_id}`).emit('typing_start', { channel_id, user_id: userId, at: nowIso() });
  });

  socket.on('typing_stop', ({ channel_id }) => {
    const userId = socket.data.userId;
    if (!userId || !channel_id) return;
    socket.to(`channel:${channel_id}`).emit('typing_stop', { channel_id, user_id: userId, at: nowIso() });
  });

  socket.on('new_message', async ({ channel_id, content, client_temp_id }) => {
    try {
      const userId = socket.data.userId;
      if (!userId || !channel_id) return;
      if (!content || !String(content).trim()) return;

      const channel = await getDocOrNull(cloudant, DB_CHANNELS, channel_id);
      if (!channel) return;

      const community = await getCachedCommunity(cloudant, channel.community_id);
      const isAdmin = checkAdminRoleSync({ email: socket.data.email });
      const member = await isCommunityMember(cloudant, userId, community);
      if (!member && !isAdmin) return;

      const isMod = isCommunityModerator(userId, community, isAdmin);
      if (!canAccessChannel({ channel, userId, isAdmin, isMod })) return;

      const { username } = extractUserInfo({ name: socket.data.username, sub: userId, email: socket.data.email });

      const messageDoc = {
        _id: uuidv4(),
        channel_id: channel._id,
        community_id: channel.community_id,
        sender_id: userId,
        sender_name: username,
        type: 'text',
        content: String(content).trim(),
        media: null,
        pinned: false,
        pinned_at: null,
        created_at: nowIso(),
        updated_at: nowIso(),
      };

      await cloudant.postDocument({ db: DB_MESSAGES, document: messageDoc });

      io.to(`channel:${channel._id}`).emit('new_message', { ...messageDoc, client_temp_id: client_temp_id || null });

      // In-memory unread bump (flushed to Cloudant every 30s, not per-message)
      bumpUnreadInMemory({ community, channelId: channel._id, senderId: userId });
      io.to(`community:${channel.community_id}`).emit('unread_count_updates', { channel_id: channel._id, at: nowIso() });
    } catch (err) {
      console.warn('[SOCKET][DISCUSSIONS] new_message failed:', err.message);
    }
  });

  socket.on('message_reaction', async ({ message_id, emoji, action }) => {
    try {
      const userId = socket.data.userId;
      if (!userId || !message_id || !emoji) return;

      const message = await getDocOrNull(cloudant, DB_MESSAGES, message_id);
      if (!message) return;

      const channel = await getDocOrNull(cloudant, DB_CHANNELS, message.channel_id);
      const community = await getCachedCommunity(cloudant, message.community_id);
      const isAdmin = checkAdminRoleSync({ email: socket.data.email });
      const member = await isCommunityMember(cloudant, userId, community);
      if (!member && !isAdmin) return;

      const isMod = isCommunityModerator(userId, community, isAdmin);
      if (!canAccessChannel({ channel, userId, isAdmin, isMod })) return;

      const doRemove = action === 'remove';

      // Check existing reaction via view
      let existing = null;
      try {
        const res = await cloudant.postView({
          db: DB_REACTIONS,
          ddoc: 'message_reactions',
          view: 'by_message_user',
          key: [message_id, userId, emoji],
          includeDocs: true,
          limit: 1,
        });
        existing = res.result.rows?.[0]?.doc || null;
      } catch (_err) {}

      if (doRemove) {
        if (existing) await cloudant.deleteDocument({ db: DB_REACTIONS, docId: existing._id, rev: existing._rev });
      } else {
        if (!existing) {
          await cloudant.postDocument({
            db: DB_REACTIONS,
            document: {
              _id: uuidv4(),
              message_id,
              channel_id: message.channel_id,
              community_id: message.community_id,
              user_id: userId,
              emoji,
              created_at: nowIso(),
            },
          });
        }
      }

      io.to(`channel:${message.channel_id}`).emit('message_reaction', {
        message_id,
        channel_id: message.channel_id,
        user_id: userId,
        emoji,
        action: doRemove ? 'remove' : 'add',
        created_at: nowIso(),
      });
    } catch (err) {
      console.warn('[SOCKET][DISCUSSIONS] message_reaction failed:', err.message);
    }
  });

  socket.on('disconnect', async () => {
    const userId = socket.data.userId;
    if (!userId) return;
    onlineUsers.delete(userId);
    // We don't know community id(s) reliably; client will rejoin on reconnect.
  });
}

module.exports = { attachDiscussionSocketHandlers };

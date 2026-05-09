// ============================================
// CloudIQ Backend - Discussion Socket Handlers
// ============================================
// Handles channel join/leave, messaging, typing, reactions, presence.
// Designed to plug into the existing io.on('connection') without rewrites.
//
// OPTIMIZED for Cloudant Lite plan:
//   - Cached community/membership lookups via cacheService
//   - postView instead of postFind for indexed queries
//   - Admin role cached on socket.data

const { v4: uuidv4 } = require('uuid');
const { extractUserInfo, checkAdminRoleSync } = require('../middleware/auth');
const { communityCache, membershipCache } = require('../services/cacheService');
const firebaseService = require('../services/firebaseService');

const DB_COMMUNITIES = 'communities';
const DB_MEMBERSHIPS = 'community_memberships';
const DB_CHANNELS = 'channels';
const DB_MESSAGES = 'messages';

function nowIso() {
  return new Date().toISOString();
}

async function syncMessageToFirebase(channelId, messageDoc) {
  if (!firebaseService.db || !channelId || !messageDoc?._id) return;

  await firebaseService.db.ref(`messages/${channelId}/${messageDoc._id}`).set({
    _id: messageDoc._id,
    channel_id: messageDoc.channel_id,
    community_id: messageDoc.community_id,
    sender_id: messageDoc.sender_id,
    sender_name: messageDoc.sender_name,
    type: messageDoc.type,
    content: messageDoc.content || null,
    media: messageDoc.media || null,
    pinned: Boolean(messageDoc.pinned),
    pinned_at: messageDoc.pinned_at || null,
    created_at: messageDoc.created_at,
  });
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
  if (cached === true) return true;

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
  // Keep socket authorization aligned with REST routes:
  // joined members can access members/restricted channels; mods remains restricted.
  if (channel.visibility === 'restricted') return true;
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

function emitDiscussionError(socket, code, message, extra = {}) {
  socket.emit('discussion_error', { code, message, ...extra });
}

function normalizeSocketId(value, maxLength = 120) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) return null;
  return trimmed;
}

function normalizeSocketText(value, maxLength = 4000) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxLength);
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
          existing = null;
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
          // Retired persistence path: keep in-memory compatibility only.
        } else {
          // Retired persistence path: keep in-memory compatibility only.
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

  socket.on('join_community_discussions', async (payload = {}) => {
    try {
      const community_id = normalizeSocketId(payload?.community_id);
      const userId = socket.data.userId;
      if (!userId || !community_id) {
        emitDiscussionError(socket, 'invalid_join_community', 'Missing user or community id');
        return;
      }
      const community = await getCachedCommunity(cloudant, community_id);
      if (!community) {
        emitDiscussionError(socket, 'community_not_found', 'Community not found', { community_id });
        return;
      }
      const isAdmin = checkAdminRoleSync({ email: socket.data.email });
      const member = await isCommunityMember(cloudant, userId, community);
      if (!member && !isAdmin) {
        emitDiscussionError(socket, 'community_forbidden', 'You must be a community member to join discussions', { community_id });
        return;
      }
      socket.join(`community:${community_id}`);
      onlineUsers.set(userId, { socketId: socket.id, lastSeenAt: nowIso() });
      broadcastPresence(io, community_id);
      io.to(`community:${community_id}`).emit('join_leave_updates', { type: 'join', community_id, user_id: userId, at: nowIso() });
    } catch (err) {
      console.warn('[SOCKET][DISCUSSIONS] join_community_discussions failed:', err.message);
    }
  });

  socket.on('leave_community_discussions', async (payload = {}) => {
    const community_id = normalizeSocketId(payload?.community_id);
    const userId = socket.data.userId;
    if (!userId || !community_id) return;
    socket.leave(`community:${community_id}`);
    onlineUsers.delete(userId);
    broadcastPresence(io, community_id);
    io.to(`community:${community_id}`).emit('join_leave_updates', { type: 'leave', community_id, user_id: userId, at: nowIso() });
  });

  socket.on('join_channel', async (payload = {}) => {
    try {
      const channel_id = normalizeSocketId(payload?.channel_id);
      const userId = socket.data.userId;
      if (!userId || !channel_id) {
        emitDiscussionError(socket, 'invalid_join_channel', 'Missing user or channel id');
        return;
      }

      const channel = await getDocOrNull(cloudant, DB_CHANNELS, channel_id);
      if (!channel) {
        emitDiscussionError(socket, 'channel_not_found', 'Channel not found', { channel_id });
        return;
      }

      const community = await getCachedCommunity(cloudant, channel.community_id);
      if (!community) {
        emitDiscussionError(socket, 'community_not_found', 'Community not found', { community_id: channel.community_id });
        return;
      }
      const isAdmin = checkAdminRoleSync({ email: socket.data.email });
      const member = await isCommunityMember(cloudant, userId, community);
      if (!member && !isAdmin) {
        emitDiscussionError(socket, 'channel_forbidden', 'You must be a community member to join this channel', { channel_id });
        return;
      }

      const isMod = isCommunityModerator(userId, community, isAdmin);
      if (!canAccessChannel({ channel, userId, isAdmin, isMod })) {
        emitDiscussionError(socket, 'channel_forbidden', 'Not authorized to access this channel', { channel_id });
        return;
      }

      socket.join(`channel:${channel._id}`);

      socket.emit('channel_joined', { channel_id: channel._id });
      socket.to(`channel:${channel._id}`).emit('join_leave_updates', { type: 'join', channel_id: channel._id, user_id: userId, at: nowIso() });
    } catch (err) {
      console.warn('[SOCKET][DISCUSSIONS] join_channel failed:', err.message);
    }
  });

  socket.on('leave_channel', async (payload = {}) => {
    const channel_id = normalizeSocketId(payload?.channel_id);
    const userId = socket.data.userId;
    if (!userId || !channel_id) return;
    socket.leave(`channel:${channel_id}`);
    socket.to(`channel:${channel_id}`).emit('join_leave_updates', { type: 'leave', channel_id, user_id: userId, at: nowIso() });
  });

  socket.on('typing_start', (payload = {}) => {
    const channel_id = normalizeSocketId(payload?.channel_id);
    const userId = socket.data.userId;
    if (!userId || !channel_id) return;
    socket.to(`channel:${channel_id}`).emit('typing_start', { channel_id, user_id: userId, at: nowIso() });
  });

  socket.on('typing_stop', (payload = {}) => {
    const channel_id = normalizeSocketId(payload?.channel_id);
    const userId = socket.data.userId;
    if (!userId || !channel_id) return;
    socket.to(`channel:${channel_id}`).emit('typing_stop', { channel_id, user_id: userId, at: nowIso() });
  });

  socket.on('new_message', async (payload = {}) => {
    try {
      const channel_id = normalizeSocketId(payload?.channel_id);
      const content = normalizeSocketText(payload?.content);
      const client_temp_id = normalizeSocketId(payload?.client_temp_id, 120);
      const userId = socket.data.userId;
      if (!userId || !channel_id) {
        emitDiscussionError(socket, 'invalid_message', 'Missing user or channel id');
        return;
      }
      if (!content) return;

      const channel = await getDocOrNull(cloudant, DB_CHANNELS, channel_id);
      if (!channel) {
        emitDiscussionError(socket, 'channel_not_found', 'Channel not found', { channel_id });
        return;
      }

      const community = await getCachedCommunity(cloudant, channel.community_id);
      if (!community) {
        emitDiscussionError(socket, 'community_not_found', 'Community not found', { community_id: channel.community_id });
        return;
      }
      const isAdmin = checkAdminRoleSync({ email: socket.data.email });
      const member = await isCommunityMember(cloudant, userId, community);
      if (!member && !isAdmin) {
        emitDiscussionError(socket, 'message_forbidden', 'You must be a community member to send messages', { channel_id });
        return;
      }

      const isMod = isCommunityModerator(userId, community, isAdmin);
      if (!canAccessChannel({ channel, userId, isAdmin, isMod })) {
        emitDiscussionError(socket, 'message_forbidden', 'Not authorized to send messages in this channel', { channel_id });
        return;
      }

      const { username } = extractUserInfo({ name: socket.data.username, sub: userId, email: socket.data.email });

      const messageDoc = {
        _id: uuidv4(),
        channel_id: channel._id,
        community_id: channel.community_id,
        sender_id: userId,
        sender_name: username,
        type: 'text',
        content,
        media: null,
        pinned: false,
        pinned_at: null,
        created_at: nowIso(),
        updated_at: nowIso(),
      };

      await cloudant.postDocument({ db: DB_MESSAGES, document: messageDoc });
      syncMessageToFirebase(channel._id, messageDoc).catch(err =>
        console.warn('[SOCKET][DISCUSSIONS] Firebase message sync failed:', err.message)
      );

      io.to(`channel:${channel._id}`).emit('new_message', { ...messageDoc, client_temp_id: client_temp_id || null });

      io.to(`community:${channel.community_id}`).emit('unread_count_updates', { channel_id: channel._id, at: nowIso() });
    } catch (err) {
      console.warn('[SOCKET][DISCUSSIONS] new_message failed:', err.message);
    }
  });

  socket.on('message_reaction', async (payload = {}) => {
    try {
      const message_id = normalizeSocketId(payload?.message_id);
      const emoji = normalizeSocketText(payload?.emoji, 32);
      const action = payload?.action;
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

// ============================================
// CloudIQ Backend - Discussion Socket Handlers
// ============================================
// Socket.IO remains a lightweight transport for joins, typing, presence, and
// compatibility message/reaction events. Discussion persistence is Firestore.

const { v4: uuidv4 } = require('uuid');
const { extractUserInfo, checkAdminRoleSync } = require('../middleware/auth');
const { communityCache, membershipCache } = require('../services/cacheService');
const firebaseService = require('../services/firebaseService');
const db = require('../services/firestoreClient');
const logger = require('../utils/logger');

const DB_COMMUNITIES = 'communities';
const DB_MEMBERSHIPS = 'community_memberships';

function nowIso() {
  return new Date().toISOString();
}

function getUserAvatarFromSocket(socket) {
  return socket.data.picture || socket.data.profile_image_url || socket.data.avatar || null;
}

async function getDocOrNull(collection, docId) {
  try {
    return await db.getDoc(collection, docId);
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

async function getCachedCommunity(communityId) {
  const cacheKey = `comm:${communityId}`;
  const cached = communityCache.get(cacheKey);
  if (cached) return cached;

  const doc = await getDocOrNull(DB_COMMUNITIES, communityId);
  if (doc) communityCache.set(cacheKey, doc);
  return doc;
}

async function isCommunityMember(userId, community) {
  if (!userId || !community) return false;
  if (Array.isArray(community.members) && community.members.includes(userId)) {
    logger.debug('[FIREBASE] member validated');
    return true;
  }

  const communityId = community._id || community.id;
  const cacheKey = `mem:${userId}:${communityId}`;
  const cached = membershipCache.get(cacheKey);
  if (cached === true) {
    logger.debug('[FIREBASE] member validated');
    return true;
  }

  // Check Firestore membership document (communityId_userId pattern)
  try {
    const membershipId = `${communityId}_${userId}`;
    const membership = await getDocOrNull(DB_MEMBERSHIPS, membershipId);
    if (membership) {
      membershipCache.set(cacheKey, true);
      logger.debug('[FIREBASE] member validated');
      return true;
    }
  } catch (err) {
    logger.warn('[SOCKET][DISCUSSIONS] Membership lookup failed:', err.message);
  }

  // Fallback: query by user_id + community_id
  try {
    const results = await db.queryDocs(
      DB_MEMBERSHIPS,
      [['community_id', '==', communityId], ['user_id', '==', userId]],
      null, 'asc', 1
    );
    const isMember = results.length > 0;
    if (isMember) {
      membershipCache.set(cacheKey, true);
      logger.debug('[FIREBASE] member validated');
    }
    return isMember;
  } catch (findErr) {
    logger.warn('[SOCKET][DISCUSSIONS] Membership fallback lookup failed:', findErr.message);
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

function canAccessChannel({ channel, isAdmin, isMod }) {
  if (!channel) return false;
  if (isAdmin) return true;
  if (channel.visibility === 'mods') return Boolean(isMod);
  return true;
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

async function authorizeChannel({ socket, channelId }) {
  const userId = socket.data.userId;
  if (!userId || !channelId) {
    return { ok: false, code: 'invalid_channel', message: 'Missing user or channel id' };
  }

  const channel = await firebaseService.getChannelFromFirebase(channelId);
  if (!channel) {
    return { ok: false, code: 'channel_not_found', message: 'Channel not found', extra: { channel_id: channelId } };
  }

  const community = await getCachedCommunity(channel.community_id || channel.communityId);
  if (!community) {
    return { ok: false, code: 'community_not_found', message: 'Community not found', extra: { community_id: channel.community_id || channel.communityId } };
  }

  const isAdmin = checkAdminRoleSync({ email: socket.data.email });
  const member = await isCommunityMember(userId, community);
  if (!member && !isAdmin) {
    return { ok: false, code: 'channel_forbidden', message: 'You must be a community member to join this channel', extra: { channel_id: channelId } };
  }

  const isMod = isCommunityModerator(userId, community, isAdmin);
  if (!canAccessChannel({ channel, isAdmin, isMod })) {
    return { ok: false, code: 'channel_forbidden', message: 'Not authorized to access this channel', extra: { channel_id: channelId } };
  }

  logger.debug('[FIREBASE] community access granted', {
    communityId: community._id,
    userId,
    channelId,
  });
  return { ok: true, userId, channel, community };
}

function attachDiscussionSocketHandlers({ io, socket }) {
  socket.data.discussionCommunities = new Set();

  socket.on('join_community_discussions', async (payload = {}) => {
    try {
      const community_id = normalizeSocketId(payload?.community_id);
      const userId = socket.data.userId;
      if (!userId || !community_id) {
        emitDiscussionError(socket, 'invalid_join_community', 'Missing user or community id');
        return;
      }

      const community = await getCachedCommunity(community_id);
      if (!community) {
        emitDiscussionError(socket, 'community_not_found', 'Community not found', { community_id });
        return;
      }

      const isAdmin = checkAdminRoleSync({ email: socket.data.email });
      const member = await isCommunityMember(userId, community);
      if (!member && !isAdmin) {
        emitDiscussionError(socket, 'community_forbidden', 'You must be a community member to join discussions', { community_id });
        return;
      }

      socket.join(`community:${community_id}`);
      socket.data.discussionCommunities.add(community_id);
      await firebaseService.updatePresence({ userId, communityId: community_id, status: 'online', socketId: socket.id });
      io.to(`community:${community_id}`).emit('join_leave_updates', { type: 'join', community_id, user_id: userId, at: nowIso() });
    } catch (err) {
      logger.warn('[SOCKET][DISCUSSIONS] join_community_discussions failed:', err.message);
    }
  });

  socket.on('leave_community_discussions', async (payload = {}) => {
    const community_id = normalizeSocketId(payload?.community_id);
    const userId = socket.data.userId;
    if (!userId || !community_id) return;
    socket.leave(`community:${community_id}`);
    socket.data.discussionCommunities.delete(community_id);
    await firebaseService.updatePresence({ userId, communityId: community_id, status: 'offline', socketId: socket.id }).catch(() => {});
    io.to(`community:${community_id}`).emit('join_leave_updates', { type: 'leave', community_id, user_id: userId, at: nowIso() });
  });

  socket.on('join_channel', async (payload = {}) => {
    try {
      const channel_id = normalizeSocketId(payload?.channel_id);
      const auth = await authorizeChannel({ socket, channelId: channel_id });
      if (!auth.ok) {
        emitDiscussionError(socket, auth.code, auth.message, auth.extra || {});
        return;
      }

      socket.join(`channel:${auth.channel._id || auth.channel.id}`);
      socket.emit('channel_joined', { channel_id: auth.channel._id || auth.channel.id });
      socket.to(`channel:${auth.channel._id || auth.channel.id}`).emit('join_leave_updates', {
        type: 'join',
        channel_id: auth.channel._id || auth.channel.id,
        user_id: auth.userId,
        at: nowIso(),
      });
    } catch (err) {
      logger.warn('[SOCKET][DISCUSSIONS] join_channel failed:', err.message);
    }
  });

  socket.on('leave_channel', (payload = {}) => {
    const channel_id = normalizeSocketId(payload?.channel_id);
    const userId = socket.data.userId;
    if (!userId || !channel_id) return;
    socket.leave(`channel:${channel_id}`);
    socket.to(`channel:${channel_id}`).emit('join_leave_updates', { type: 'leave', channel_id, user_id: userId, at: nowIso() });
  });

  socket.on('typing_start', async (payload = {}) => {
    const channel_id = normalizeSocketId(payload?.channel_id);
    const userId = socket.data.userId;
    if (!userId || !channel_id) return;
    await firebaseService.setTyping({ channelId: channel_id, userId, isTyping: true }).catch(() => {});
    socket.to(`channel:${channel_id}`).emit('typing_start', { channel_id, user_id: userId, at: nowIso() });
  });

  socket.on('typing_stop', async (payload = {}) => {
    const channel_id = normalizeSocketId(payload?.channel_id);
    const userId = socket.data.userId;
    if (!userId || !channel_id) return;
    await firebaseService.setTyping({ channelId: channel_id, userId, isTyping: false }).catch(() => {});
    socket.to(`channel:${channel_id}`).emit('typing_stop', { channel_id, user_id: userId, at: nowIso() });
  });

  socket.on('new_message', async (payload = {}) => {
    try {
      const channel_id = normalizeSocketId(payload?.channel_id);
      const content = normalizeSocketText(payload?.content ?? payload?.text);
      const client_temp_id = normalizeSocketId(payload?.client_temp_id, 120);
      if (!content) return;

      const auth = await authorizeChannel({ socket, channelId: channel_id });
      if (!auth.ok) {
        emitDiscussionError(socket, auth.code, auth.message, auth.extra || {});
        return;
      }

      const { username } = extractUserInfo({ firebaseUser: { uid: auth.userId, email: socket.data.email, name: socket.data.username } });
      const messageDoc = {
        _id: uuidv4(),
        channel_id: auth.channel._id || auth.channel.id,
        community_id: auth.channel.community_id || auth.channel.communityId,
        sender_id: auth.userId,
        sender_name: username,
        sender_avatar: getUserAvatarFromSocket(socket),
        type: 'text',
        content,
        media: null,
        pinned: false,
        pinned_at: null,
        created_at: nowIso(),
        updated_at: nowIso(),
      };

      const stored = await firebaseService.storeMessage(messageDoc);
      firebaseService.incrementUnreadStates({
        community: auth.community,
        channelId: stored.channel_id || stored.channelId,
        senderId: auth.userId,
      }).catch((err) => logger.warn('[SOCKET][DISCUSSIONS] Firestore unread update failed:', err.message));
      io.to(`channel:${stored.channel_id || stored.channelId}`).emit('new_message', { ...stored, client_temp_id: client_temp_id || null });
      io.to(`community:${stored.community_id || stored.communityId}`).emit('unread_count_updates', { channel_id: stored.channel_id || stored.channelId, at: nowIso() });
      logger.debug('[FIREBASE] message broadcast complete', {
        communityId: stored.communityId || stored.community_id,
        channelId: stored.channelId || stored.channel_id,
        messageId: stored.id || stored._id,
      });
    } catch (err) {
      logger.warn('[SOCKET][DISCUSSIONS] new_message failed:', err.message);
    }
  });

  socket.on('message_reaction', async (payload = {}) => {
    try {
      const message_id = normalizeSocketId(payload?.message_id);
      const emoji = normalizeSocketText(payload?.emoji, 32);
      const action = payload?.action === 'remove' ? 'remove' : 'add';
      const userId = socket.data.userId;
      if (!userId || !message_id || !emoji) return;

      const message = await firebaseService.getDocument('messages', message_id);
      if (!message) return;

      const auth = await authorizeChannel({ socket, channelId: message.channel_id || message.channelId });
      if (!auth.ok) return;

      await firebaseService.setReaction({
        messageId: message._id,
        channelId: message.channel_id || message.channelId,
        userId,
        emoji,
        action,
      });

      io.to(`channel:${message.channel_id || message.channelId}`).emit('message_reaction', {
        message_id,
        channel_id: message.channel_id || message.channelId,
        user_id: userId,
        emoji,
        action,
        created_at: nowIso(),
      });
    } catch (err) {
      logger.warn('[SOCKET][DISCUSSIONS] message_reaction failed:', err.message);
    }
  });

  socket.on('disconnect', async () => {
    const userId = socket.data.userId;
    if (!userId) return;
    const communities = Array.from(socket.data.discussionCommunities || []);
    await Promise.all(communities.map((communityId) =>
      firebaseService.updatePresence({ userId, communityId, status: 'offline', socketId: socket.id }).catch(() => {})
    ));
  });
}

module.exports = { attachDiscussionSocketHandlers };

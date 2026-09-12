// ============================================
// CloudIQ Backend - Discussion Routes
// ============================================

const express = require('express');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const db = require('../services/firestoreClient');
const firebaseService = require('../services/firebaseService');
const { uploadDiscussionMedia, deleteMedia } = require('../services/cloudinaryService');
const { ensureAuthenticated, extractUserInfo, checkAdminRole } = require('../middleware/auth');
const { communityCache, membershipCache, adminCache } = require('../services/cacheService');
const logger = require('../utils/logger');

const router = express.Router();

const DB_COMMUNITIES = 'communities';
const DB_MEMBERSHIPS = 'community_memberships';
const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_FILE_BYTES = 25 * 1024 * 1024;

const DISCUSSION_MEDIA_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
  'video/mp4', 'video/webm', 'video/quicktime', 'video/x-m4v',
  'application/pdf', 'text/plain',
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_VIDEO_BYTES },
  fileFilter: (_req, file, cb) => {
    const allowed = [
      'image/jpeg', 'image/png', 'image/webp', 'image/gif',
      'video/mp4', 'video/webm', 'video/quicktime', 'video/x-m4v',
      'application/pdf', 'text/plain',
    ];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Unsupported file type for chat media/attachments.'), false);
  },
});

function discussionUpload(req, res, next) {
  logger.info('[CLOUDINARY] upload started', { route: 'discussion_media' });
  upload.single('file')(req, res, (err) => {
    if (!err) {
      logger.debug('[CLOUDINARY] multer parsed successfully', {
        hasFile: Boolean(req.file),
        size: req.file?.size || 0,
        mimeType: req.file?.mimetype || null,
      });
      return next();
    }

    const isTooLarge = err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE';
    return res.status(isTooLarge ? 413 : 400).json({
      success: false,
      error: isTooLarge ? 'File is too large' : err.message || 'invalid file',
      code: isTooLarge ? 'file_too_large' : 'invalid_file',
    });
  });
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeChannelName(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-zA-Z0-9-_]/g, '')
    .toLowerCase()
    .slice(0, 80);
}

function getUserAvatar(user) {
  return user?.picture || user?.profile_image_url || user?.avatar || null;
}

function getDiscussionMediaType(mimeType) {
  if (mimeType?.startsWith('image/')) return 'image';
  if (mimeType?.startsWith('video/')) return 'video';
  if (mimeType === 'application/pdf') return 'pdf';
  if (mimeType === 'text/plain') return 'text';
  return 'file';
}

function validateDiscussionMedia(file) {
  if (!file) return { ok: false, status: 400, error: 'file is required', code: 'missing_file' };
  if (!Buffer.isBuffer(file.buffer) || file.buffer.length === 0 || file.size === 0) {
    return { ok: false, status: 400, error: 'Uploaded file is empty or invalid', code: 'invalid_file_buffer' };
  }
  if (!DISCUSSION_MEDIA_TYPES.has(file.mimetype)) {
    return { ok: false, status: 400, error: 'Unsupported discussion media type', code: 'unsupported_media' };
  }
  if (file.mimetype.startsWith('image/') && file.size > MAX_IMAGE_BYTES) {
    return { ok: false, status: 413, error: 'Image must be 10MB or smaller', code: 'file_too_large' };
  }
  if (file.mimetype.startsWith('video/') && file.size > MAX_VIDEO_BYTES) {
    return { ok: false, status: 413, error: 'Video must be 50MB or smaller', code: 'file_too_large' };
  }
  if (!file.mimetype.startsWith('image/') && !file.mimetype.startsWith('video/') && file.size > MAX_FILE_BYTES) {
    return { ok: false, status: 413, error: 'File must be 25MB or smaller', code: 'file_too_large' };
  }
  return { ok: true };
}

async function getCommunityOr404(communityId, { bustCache = false } = {}) {
  const cacheKey = `comm:${communityId}`;
  if (!bustCache) {
    const cached = communityCache.get(cacheKey);
    if (cached) return cached;
  }

  try {
    const doc = await db.getDoc(DB_COMMUNITIES, communityId);
    communityCache.set(cacheKey, doc);
    return doc;
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

async function isCommunityMember(userId, community) {
  if (!userId || !community) return false;
  if (Array.isArray(community.members) && community.members.includes(userId)) {
    logger.debug('[FIREBASE] member validated');
    return true;
  }

  const cacheKey = `mem:${userId}:${community._id}`;
  const cached = membershipCache.get(cacheKey);
  if (cached === true) {
    logger.debug('[FIREBASE] member validated');
    return true;
  }

  try {
    const docId = `${community._id}_${userId}`;
    const mem = await db.getDoc(DB_MEMBERSHIPS, docId);
    if (mem) {
      membershipCache.set(cacheKey, true);
      logger.debug('[FIREBASE] member validated');
      return true;
    }
  } catch (err) {
    logger.warn('[DISCUSSIONS] Membership lookup failed:', err.message);
  }

  try {
    const fallback = await db.queryDocs(DB_MEMBERSHIPS, [['community_id', '==', community._id], ['user_id', '==', userId]]);
    const isMember = fallback.length > 0;
    if (isMember) {
      membershipCache.set(cacheKey, true);
      logger.debug('[FIREBASE] member validated');
    }
    return isMember;
  } catch (findErr) {
    logger.warn('[DISCUSSIONS] Membership fallback lookup failed:', findErr.message);
    return false;
  }
}

async function getCachedAdminStatus(req) {
  const { email } = extractUserInfo(req);
  if (!email) return false;

  const cacheKey = `admin:${email.toLowerCase()}`;
  const cached = adminCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const isAdmin = await checkAdminRole(req);
  adminCache.set(cacheKey, isAdmin);
  return isAdmin;
}

function isCommunityModerator(userId, community, isAdmin) {
  if (isAdmin) return true;
  if (!userId || !community) return false;
  if (community.owner_id === userId) return true;
  if (Array.isArray(community.co_admin_ids) && community.co_admin_ids.includes(userId)) return true;
  return false;
}

async function ensureCanAccessCommunity(userId, community, isAdmin) {
  if (!community) return { ok: false, status: 404, error: 'Community not found' };
  const member = await isCommunityMember(userId, community);
  if (!member && !isAdmin) {
    return { ok: false, status: 403, error: 'You must be a community member to access discussions' };
  }
  return { ok: true };
}

async function getChannelOr404(channelId) {
  return firebaseService.getChannelFromFirebase(channelId);
}

function canAccessChannel({ channel, isAdmin, isMod }) {
  if (!channel) return false;
  if (isAdmin) return true;
  if (channel.visibility === 'mods') return Boolean(isMod);
  return true;
}

async function authorizeChannelAccess(req, channelId) {
  const { userId } = extractUserInfo(req);
  const isAdmin = await getCachedAdminStatus(req);
  const channel = await getChannelOr404(channelId);
  if (!channel) return { ok: false, status: 404, error: 'Channel not found' };

  const community = await getCommunityOr404(channel.community_id || channel.communityId, { bustCache: true });
  const access = await ensureCanAccessCommunity(userId, community, isAdmin);
  if (!access.ok) return access;
  logger.debug('[FIREBASE] community access granted', {
    communityId: community._id,
    userId,
    channelId,
  });

  const isMod = isCommunityModerator(userId, community, isAdmin);
  if (!canAccessChannel({ channel, isAdmin, isMod })) {
    return { ok: false, status: 403, error: 'Not authorized to access this channel' };
  }

  return { ok: true, userId, isAdmin, isMod, channel, community };
}

function sanitizeChannel(channel) {
  if (!channel) return null;
  const id = channel._id || channel.id;
  const communityId = channel.community_id || channel.communityId;
  return {
    _id: id,
    id,
    community_id: communityId,
    communityId,
    name: channel.name,
    topic: channel.topic || null,
    type: channel.type || 'text',
    visibility: channel.visibility || 'members',
    allowed_member_ids: channel.allowed_member_ids || null,
    allowedMemberIds: channel.allowedMemberIds || channel.allowed_member_ids || null,
    position: Number(channel.position || 0),
    created_by: channel.created_by || null,
    createdBy: channel.createdBy || channel.created_by || null,
    created_at: channel.created_at || channel.createdAt,
    createdAt: channel.createdAt || channel.created_at,
    updated_at: channel.updated_at || channel.updatedAt,
    updatedAt: channel.updatedAt || channel.updated_at,
  };
}

async function ensureDefaultChannel(community) {
  const channelDoc = {
    _id: `community:${community._id}:general`,
    community_id: community._id,
    name: 'general',
    topic: 'Welcome to the community discussion',
    type: 'text',
    visibility: 'members',
    position: 0,
    created_by: community.owner_id || null,
    created_at: community.created_at || nowIso(),
    updated_at: nowIso(),
  };
  return firebaseService.syncChannel(channelDoc);
}

// GET /api/discussions/communities/:communityId/channels
router.get('/communities/:communityId/channels', ensureAuthenticated, async (req, res) => {
  try {
    const { userId } = extractUserInfo(req);
    const isAdmin = await getCachedAdminStatus(req);
    const community = await getCommunityOr404(req.params.communityId, { bustCache: true });
    if (!community) return res.status(404).json({ success: false, error: 'Community not found' });

    const access = await ensureCanAccessCommunity(userId, community, isAdmin);
    if (!access.ok) return res.status(access.status).json({ success: false, error: access.error });
    logger.debug('[FIREBASE] community access granted', {
      communityId: community._id,
      userId,
      route: 'list_channels',
    });

    const isMod = isCommunityModerator(userId, community, isAdmin);
    let rawChannels = await firebaseService.listChannelsByCommunity(community._id);
    if (rawChannels.length === 0) {
      const seeded = await ensureDefaultChannel(community);
      rawChannels = seeded ? [seeded] : [];
    }

    const channels = rawChannels
      .map(sanitizeChannel)
      .filter((channel) => canAccessChannel({ channel, isAdmin, isMod }));

    return res.json({ success: true, channels });
  } catch (err) {
    logger.error('[DISCUSSIONS] List channels error:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to list channels' });
  }
});

// POST /api/discussions/communities/:communityId/channels
router.post('/communities/:communityId/channels', ensureAuthenticated, async (req, res) => {
  try {
    const { name, topic, type, visibility, allowed_member_ids } = req.body || {};
    const { userId } = extractUserInfo(req);
    const isAdmin = await getCachedAdminStatus(req);
    const community = await getCommunityOr404(req.params.communityId, { bustCache: true });
    if (!community) return res.status(404).json({ success: false, error: 'Community not found' });

    if (!isCommunityModerator(userId, community, isAdmin)) {
      return res.status(403).json({ success: false, error: 'Only community moderators can create channels' });
    }

    const channelName = normalizeChannelName(name);
    if (!channelName) return res.status(400).json({ success: false, error: 'Channel name is required' });

    const existingChannels = await firebaseService.listChannelsByCommunity(community._id);
    const duplicate = existingChannels.find((channel) => normalizeChannelName(channel.name) === channelName);
    if (duplicate) {
      return res.status(409).json({ success: false, error: 'Channel already exists', channel: sanitizeChannel(duplicate) });
    }

    const channelDoc = {
      _id: uuidv4(),
      community_id: community._id,
      name: channelName.slice(0, 80),
      topic: topic ? String(topic).trim().slice(0, 240) : '',
      type: type || 'text',
      visibility: visibility || 'members',
      allowed_member_ids: Array.isArray(allowed_member_ids) ? allowed_member_ids : null,
      position: Number(req.body?.position || 0),
      created_by: userId,
      created_at: nowIso(),
      updated_at: nowIso(),
    };

    const storedChannel = await firebaseService.syncChannel(channelDoc);

    const io = req.app.get('io');
    if (io) io.to(`community:${community._id}`).emit('channel_created', sanitizeChannel(storedChannel || channelDoc));

    return res.status(201).json({ success: true, channel: sanitizeChannel(storedChannel || channelDoc) });
  } catch (err) {
    logger.error('[DISCUSSIONS] Create channel error:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to create channel' });
  }
});

// DELETE /api/discussions/communities/:communityId/channels/:channelId
router.delete('/communities/:communityId/channels/:channelId', ensureAuthenticated, async (req, res) => {
  try {
    const { userId } = extractUserInfo(req);
    const isAdmin = await getCachedAdminStatus(req);
    const community = await getCommunityOr404(req.params.communityId, { bustCache: true });
    if (!community) return res.status(404).json({ success: false, error: 'Community not found' });

    if (!isCommunityModerator(userId, community, isAdmin)) {
      return res.status(403).json({ success: false, error: 'Only community moderators can delete channels' });
    }

    const channel = await getChannelOr404(req.params.channelId);
    if (!channel || (channel.community_id || channel.communityId) !== community._id) {
      return res.status(404).json({ success: false, error: 'Channel not found' });
    }

    await firebaseService.deleteChannel(channel._id || channel.id);

    const io = req.app.get('io');
    if (io) io.to(`community:${community._id}`).emit('channel_deleted', { channel_id: channel._id || channel.id, community_id: community._id });

    return res.json({ success: true, message: 'Channel deleted' });
  } catch (err) {
    logger.error('[DISCUSSIONS] Delete channel error:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to delete channel' });
  }
});

// GET /api/discussions/channels/:channelId/messages?limit=30&before=ISO
router.get('/channels/:channelId/messages', ensureAuthenticated, async (req, res) => {
  try {
    const auth = await authorizeChannelAccess(req, req.params.channelId);
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error });

    const limit = Math.max(1, Math.min(50, Number(req.query.limit || 30)));
    const before = req.query.before ? String(req.query.before) : null;
    const messages = await firebaseService.paginatedMessages(auth.channel._id || auth.channel.id, {
      communityId: auth.channel.community_id || auth.channel.communityId,
      limit,
      before,
    });
    return res.json({ success: true, messages });
  } catch (err) {
    logger.error('[DISCUSSIONS] Fetch messages error:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to fetch messages' });
  }
});

// POST /api/discussions/channels/:channelId/messages
router.post('/channels/:channelId/messages', ensureAuthenticated, async (req, res) => {
  try {
    const content = req.body?.content ?? req.body?.text;
    if (!content || !String(content).trim()) {
      return res.status(400).json({ success: false, error: 'Message content is required' });
    }

    const auth = await authorizeChannelAccess(req, req.params.channelId);
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error });

    const { username } = extractUserInfo(req);
    const messageDoc = {
      _id: uuidv4(),
      channel_id: auth.channel._id || auth.channel.id,
      community_id: auth.channel.community_id || auth.channel.communityId,
      sender_id: auth.userId,
      sender_name: username,
      sender_avatar: getUserAvatar(req.firebaseUser),
      type: 'text',
      content: String(content).trim(),
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
    }).catch((err) => logger.warn('[DISCUSSIONS] Firestore unread update failed:', err.message));
    const io = req.app.get('io');
    if (io) {
      io.to(`channel:${stored.channel_id || stored.channelId}`).emit('new_message', stored);
      logger.debug('[FIREBASE] message broadcast complete', {
        communityId: stored.communityId || stored.community_id,
        channelId: stored.channelId || stored.channel_id,
        messageId: stored.id || stored._id,
      });
    }

    return res.status(201).json({ success: true, message: stored });
  } catch (err) {
    logger.error('[DISCUSSIONS] Create message error:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to send message' });
  }
});

// POST /api/discussions/channels/:channelId/media
router.post('/channels/:channelId/media', ensureAuthenticated, discussionUpload, async (req, res) => {
  try {
    const file = req.file;
    const validation = validateDiscussionMedia(file);
    if (!validation.ok) {
      return res.status(validation.status).json({
        success: false,
        error: validation.error,
        code: validation.code,
      });
    }
    logger.debug('[CLOUDINARY] buffer validated', {
      isBuffer: Buffer.isBuffer(file.buffer),
      size: file.size,
      bufferBytes: file.buffer.length,
      mimeType: file.mimetype,
      originalName: file.originalname || null,
    });

    const auth = await authorizeChannelAccess(req, req.params.channelId);
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error });

    const messageId = uuidv4();
    const channelId = auth.channel._id || auth.channel.id;
    const communityId = auth.channel.community_id || auth.channel.communityId;
    const mediaType = getDiscussionMediaType(file.mimetype);
    const messageType = mediaType === 'image' || mediaType === 'video' ? mediaType : 'attachment';
    let uploaded;
    try {
      uploaded = await uploadDiscussionMedia(file, communityId, channelId);
    } catch (uploadErr) {
      logger.error('[DISCUSSIONS] Cloudinary upload failed:', {
        message: uploadErr.message,
        name: uploadErr.name,
        http_code: uploadErr.http_code,
        stack: uploadErr.stack,
      });
      const storageUnavailable = /not configured|unavailable|api_key|api secret|cloud_name/i.test(uploadErr.message);
      return res.status(storageUnavailable ? 503 : 500).json({
        success: false,
        error: storageUnavailable ? 'Cloudinary media storage is unavailable' : 'Discussion media upload failed',
        code: storageUnavailable ? 'cloudinary_unavailable' : 'upload_failed',
      });
    }

    const { username } = extractUserInfo(req);
    const messageDoc = {
      _id: messageId,
      channel_id: channelId,
      community_id: communityId,
      sender_id: auth.userId,
      sender_name: username,
      sender_avatar: getUserAvatar(req.firebaseUser),
      type: messageType,
      content: null,
      text: '',
      mediaUrl: uploaded.secure_url,
      media_url: uploaded.secure_url,
      mediaType: mediaType,
      media_type: mediaType,
      mediaPublicId: uploaded.public_id,
      media_public_id: uploaded.public_id,
      fileName: file.originalname || null,
      file_name: file.originalname || null,
      mediaResourceType: uploaded.resource_type,
      media_resource_type: uploaded.resource_type,
      media: {
        url: uploaded.secure_url,
        secure_url: uploaded.secure_url,
        public_id: uploaded.public_id,
        resource_type: uploaded.resource_type,
        media_type: mediaType,
        mime_type: file.mimetype,
        size_bytes: uploaded.bytes || file.size,
        filename: file.originalname || null,
      },
      pinned: false,
      pinned_at: null,
      created_at: nowIso(),
      updated_at: nowIso(),
    };

    let stored;
    try {
      stored = await firebaseService.storeMessage(messageDoc);
      logger.info('[FIRESTORE] metadata saved', {
        communityId,
        channelId,
        messageId: stored.id || stored._id,
        publicId: uploaded.public_id,
      });
    } catch (writeErr) {
      try { await deleteMedia(uploaded.public_id, uploaded.resource_type); } catch (cleanupErr) {
        logger.warn('[CLOUDINARY] uploaded media cleanup after Firestore failure failed:', cleanupErr.message);
      }
      logger.error('[DISCUSSIONS] Firestore metadata save failed after Cloudinary upload:', {
        message: writeErr.message,
        name: writeErr.name,
        code: writeErr.code,
        stack: writeErr.stack,
      });
      logger.error(writeErr);
      return res.status(500).json({
        success: false,
        error: 'Media uploaded but metadata save failed',
        code: 'firestore_metadata_failed',
      });
    }
    firebaseService.incrementUnreadStates({
      community: auth.community,
      channelId: stored.channel_id || stored.channelId,
      senderId: auth.userId,
    }).catch((err) => logger.warn('[DISCUSSIONS] Firestore unread update failed:', err.message));

    const io = req.app.get('io');
    if (io) {
      io.to(`channel:${stored.channel_id || stored.channelId}`).emit('new_message', stored);
      logger.debug('[FIREBASE] message broadcast complete', {
        communityId: stored.communityId || stored.community_id,
        channelId: stored.channelId || stored.channel_id,
        messageId: stored.id || stored._id,
      });
      logger.debug('[CLOUDINARY] media synced realtime', {
        communityId: stored.communityId || stored.community_id,
        channelId: stored.channelId || stored.channel_id,
        messageId: stored.id || stored._id,
      });
    }

    return res.status(201).json({ success: true, message: stored });
  } catch (err) {
    logger.error('[DISCUSSIONS] Upload media error:', {
      message: err.message,
      name: err.name,
      stack: err.stack,
    });
    return res.status(500).json({ success: false, error: 'Failed to upload chat media', code: 'media_upload_error' });
  }
});

router.post('/messages/:messageId/pin', ensureAuthenticated, async (req, res) => {
  try {
    const message = await firebaseService.getDocument('messages', req.params.messageId);
    if (!message) return res.status(404).json({ success: false, error: 'Message not found' });

    const auth = await authorizeChannelAccess(req, message.channel_id || message.channelId);
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error });
    if (!auth.isMod) return res.status(403).json({ success: false, error: 'Only moderators can pin messages' });

    await firebaseService.updateDocument('messages', message._id, { pinned: true, pinned_at: nowIso() });
    const io = req.app.get('io');
    if (io) io.to(`channel:${message.channel_id || message.channelId}`).emit('message_pinned', { message_id: message._id, pinned: true, pinned_at: nowIso() });
    return res.json({ success: true });
  } catch (err) {
    logger.error('[DISCUSSIONS] Pin message error:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to pin message' });
  }
});

router.post('/messages/:messageId/unpin', ensureAuthenticated, async (req, res) => {
  try {
    const message = await firebaseService.getDocument('messages', req.params.messageId);
    if (!message) return res.status(404).json({ success: false, error: 'Message not found' });

    const auth = await authorizeChannelAccess(req, message.channel_id || message.channelId);
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error });
    if (!auth.isMod) return res.status(403).json({ success: false, error: 'Only moderators can unpin messages' });

    await firebaseService.updateDocument('messages', message._id, { pinned: false, pinned_at: null });
    const io = req.app.get('io');
    if (io) io.to(`channel:${message.channel_id || message.channelId}`).emit('message_pinned', { message_id: message._id, pinned: false, pinned_at: null });
    return res.json({ success: true });
  } catch (err) {
    logger.error('[DISCUSSIONS] Unpin message error:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to unpin message' });
  }
});

router.post('/messages/:messageId/reactions', ensureAuthenticated, async (req, res) => {
  try {
    const { emoji, action } = req.body || {};
    if (!emoji || typeof emoji !== 'string' || emoji.length > 32) {
      return res.status(400).json({ success: false, error: 'emoji is required' });
    }

    const message = await firebaseService.getDocument('messages', req.params.messageId);
    if (!message) return res.status(404).json({ success: false, error: 'Message not found' });

    const auth = await authorizeChannelAccess(req, message.channel_id || message.channelId);
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error });

    const doRemove = action === 'remove';
    await firebaseService.setReaction({
      messageId: message._id,
      channelId: message.channel_id || message.channelId,
      userId: auth.userId,
      emoji,
      action: doRemove ? 'remove' : 'add',
    });

    const io = req.app.get('io');
    if (io) {
      io.to(`channel:${message.channel_id || message.channelId}`).emit('message_reaction', {
        message_id: message._id,
        channel_id: message.channel_id || message.channelId,
        user_id: auth.userId,
        emoji,
        action: doRemove ? 'remove' : 'add',
        created_at: nowIso(),
      });
    }

    return res.json({ success: true, persisted: true });
  } catch (err) {
    logger.error('[DISCUSSIONS] Reactions error:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to update reaction' });
  }
});

router.post('/channels/:channelId/read', ensureAuthenticated, async (req, res) => {
  try {
    const auth = await authorizeChannelAccess(req, req.params.channelId);
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error });

    await firebaseService.markChannelRead({
      userId: auth.userId,
      communityId: auth.channel.community_id || auth.channel.communityId,
      channelId: auth.channel._id || auth.channel.id,
    });

    const io = req.app.get('io');
    if (io) io.to(`channel:${auth.channel._id || auth.channel.id}`).emit('unread_count_updates', {
      channel_id: auth.channel._id || auth.channel.id,
      user_id: auth.userId,
      unread_count: 0,
    });

    return res.json({ success: true });
  } catch (err) {
    logger.error('[DISCUSSIONS] Mark read error:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to mark as read' });
  }
});

router.get('/communities/:communityId/unreads', ensureAuthenticated, async (req, res) => {
  try {
    const { userId } = extractUserInfo(req);
    const isAdmin = await getCachedAdminStatus(req);
    const community = await getCommunityOr404(req.params.communityId);
    const access = await ensureCanAccessCommunity(userId, community, isAdmin);
    if (!access.ok) return res.status(access.status).json({ success: false, error: access.error });

    const unreads = (await firebaseService.getUnreadStates(userId, community._id)).map((doc) => ({
      channel_id: doc.channel_id,
      unread_count: doc.unread_count || 0,
    }));
    return res.json({ success: true, unreads });
  } catch (err) {
    logger.error('[DISCUSSIONS] Fetch unreads error:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to fetch unread counts' });
  }
});

module.exports = router;

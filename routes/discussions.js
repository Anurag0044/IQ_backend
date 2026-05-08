// ============================================
// CloudIQ Backend - Discussion Routes (Phase 4)
// ============================================
// Discord-style channels inside communities.
// Reuses: Cloudant, auth/session, community membership rules, Cloudinary media pipeline.
//
// OPTIMIZED for Cloudant Lite plan:
//   - Cached community/membership lookups via cacheService
//   - postView instead of postFind for indexed queries
//   - putDocument for updates (not postDocument which creates duplicates)
//   - Removed redundant postFind fallbacks

const express = require('express');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const cloudant = require('../services/cloudantClient');
const { uploadImage, uploadVideo, uploadRaw, deleteUploadedMedia } = require('../services/mediaService');
const { ensureAuthenticated, extractUserInfo, checkAdminRole } = require('../middleware/auth');
const { communityCache, membershipCache, adminCache } = require('../services/cacheService');
const firebaseService = require('../services/firebaseService');

const router = express.Router();

const DB_COMMUNITIES = 'communities';
const DB_MEMBERSHIPS = 'community_memberships';

const DB_CHANNELS = 'channels';
const DB_MESSAGES = 'messages';
const DB_REACTIONS = 'message_reactions';
const DB_UNREAD = 'unread_states';

const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
const MAX_FILE_BYTES = 50 * 1024 * 1024;

// ─────────────────────────────────────────────
// Multer — chat media + attachments
// ─────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES },
  fileFilter: (_req, file, cb) => {
    const allowed = [
      'image/jpeg', 'image/png', 'image/webp', 'image/gif',
      'video/mp4', 'video/webm', 'video/quicktime', 'video/x-m4v',
      'application/pdf', 'text/plain', 'application/json', 'application/zip',
    ];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Unsupported file type for chat media/attachments.'), false);
  },
});

function nowIso() {
  return new Date().toISOString();
}

// ─── Cached community fetch ──────────────────────────────────────────────────
async function getCommunityOr404(communityId) {
  const cacheKey = `comm:${communityId}`;
  const cached = communityCache.get(cacheKey);
  if (cached) return cached;

  try {
    const doc = (await cloudant.getDocument({ db: DB_COMMUNITIES, docId: communityId })).result;
    communityCache.set(cacheKey, doc);
    return doc;
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

// ─── Cached membership check ────────────────────────────────────────────────
async function isCommunityMember(userId, community) {
  if (!userId || !community) return false;

  // In-document array (zero reads)
  if (Array.isArray(community.members) && community.members.includes(userId)) return true;

  // Cache check
  const cacheKey = `mem:${userId}:${community._id}`;
  const cached = membershipCache.get(cacheKey);
  if (cached !== undefined) return cached;

  // Indexed view query
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
    console.warn('[DISCUSSIONS] Membership lookup failed:', err.message);
    return false;
  }
}

// ─── Cached admin check ─────────────────────────────────────────────────────
async function getCachedAdminStatus(user) {
  const { email } = extractUserInfo(user);
  if (!email) return false;

  const cacheKey = `admin:${email.toLowerCase()}`;
  const cached = adminCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const isAdmin = await checkAdminRole(user);
  adminCache.set(cacheKey, isAdmin);
  return isAdmin;
}

async function isCommunityModerator(userId, community, isAdmin) {
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
  try {
    return (await cloudant.getDocument({ db: DB_CHANNELS, docId: channelId })).result;
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
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

// ─────────────────────────────────────────────
// Channels
// ─────────────────────────────────────────────

// GET /api/discussions/communities/:communityId/channels
router.get('/communities/:communityId/channels', ensureAuthenticated, async (req, res) => {
  try {
    const { userId } = extractUserInfo(req.user);
    const isAdmin = await getCachedAdminStatus(req.user);
    const community = await getCommunityOr404(req.params.communityId);
    if (!community) return res.status(404).json({ success: false, error: 'Community not found' });

    const access = await ensureCanAccessCommunity(userId, community, isAdmin);
    if (!access.ok) return res.status(access.status).json({ success: false, error: access.error });

    const isMod = await isCommunityModerator(userId, community, isAdmin);

    const response = await cloudant.postView({
      db: DB_CHANNELS,
      ddoc: 'channels',
      view: 'by_community',
      startkey: [community._id],
      endkey: [community._id, {}],
      includeDocs: true,
    });

    const allChannels = (response.result.rows || []).map((r) => r.doc).filter(Boolean);

    const channels = allChannels
      .filter((ch) => canAccessChannel({ channel: ch, userId, isAdmin, isMod }))
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));

    return res.json({ success: true, channels });
  } catch (err) {
    console.error('[DISCUSSIONS] List channels error:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to list channels' });
  }
});

// POST /api/discussions/communities/:communityId/channels
router.post('/communities/:communityId/channels', ensureAuthenticated, async (req, res) => {
  try {
    const { name, topic, visibility, allowed_member_ids, position } = req.body || {};
    if (!name || !String(name).trim()) {
      return res.status(400).json({ success: false, error: 'Channel name is required' });
    }

    const { userId } = extractUserInfo(req.user);
    const isAdmin = await getCachedAdminStatus(req.user);
    const community = await getCommunityOr404(req.params.communityId);
    if (!community) return res.status(404).json({ success: false, error: 'Community not found' });

    const access = await ensureCanAccessCommunity(userId, community, isAdmin);
    if (!access.ok) return res.status(access.status).json({ success: false, error: access.error });

    const isMod = await isCommunityModerator(userId, community, isAdmin);
    if (!isMod) {
      return res.status(403).json({ success: false, error: 'Only community moderators can create channels' });
    }

    const vis = visibility || 'members';
    const channelDoc = {
      _id: uuidv4(),
      community_id: community._id,
      name: String(name).trim().replace(/\s+/g, '-').toLowerCase(),
      topic: topic ? String(topic).trim() : null,
      type: 'text',
      visibility: vis,
      allowed_member_ids: Array.isArray(allowed_member_ids) ? allowed_member_ids : null,
      position: Number.isFinite(Number(position)) ? Number(position) : 0,
      created_by: userId,
      created_at: nowIso(),
      updated_at: nowIso(),
    };

    const write = await cloudant.postDocument({ db: DB_CHANNELS, document: channelDoc });
    if (!write.result.ok) return res.status(500).json({ success: false, error: 'Failed to create channel' });

    // Sync channel metadata to Firebase
    firebaseService.syncChannel(channelDoc).catch(err => console.error('[DISCUSSIONS] Firebase sync failed:', err));

    const io = req.app.get('io');
    if (io) io.to(`community:${community._id}`).emit('channel_created', channelDoc);

    return res.status(201).json({ success: true, channel: channelDoc });
  } catch (err) {
    console.error('[DISCUSSIONS] Create channel error:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to create channel' });
  }
});

// ─────────────────────────────────────────────
// Messages
// ─────────────────────────────────────────────

// GET /api/discussions/channels/:channelId/messages?limit=50&before=ISO
router.get('/channels/:channelId/messages', ensureAuthenticated, async (req, res) => {
  try {
    const { userId } = extractUserInfo(req.user);
    const isAdmin = await getCachedAdminStatus(req.user);
    const channel = await getChannelOr404(req.params.channelId);
    if (!channel) return res.status(404).json({ success: false, error: 'Channel not found' });

    const community = await getCommunityOr404(channel.community_id);
    const access = await ensureCanAccessCommunity(userId, community, isAdmin);
    if (!access.ok) return res.status(access.status).json({ success: false, error: access.error });

    const isMod = await isCommunityModerator(userId, community, isAdmin);
    if (!canAccessChannel({ channel, userId, isAdmin, isMod })) {
      return res.status(403).json({ success: false, error: 'Not authorized to access this channel' });
    }

    const limit = Math.max(1, Math.min(100, Number(req.query.limit || 50)));
    const before = req.query.before ? String(req.query.before) : null;

    const viewRes = await cloudant.postView({
      db: DB_MESSAGES,
      ddoc: 'messages',
      view: 'by_channel_created_at',
      startKey: before ? [channel._id, before] : [channel._id, {}],
      endKey: [channel._id, ''],
      includeDocs: true,
      limit,
      descending: true,
    });

    const messages = (viewRes.result.rows || [])
      .map((r) => r.doc)
      .filter((doc) => doc && !doc._id.startsWith('_design'));

    return res.json({ success: true, messages });
  } catch (err) {
    console.error('[DISCUSSIONS] Fetch messages error:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to fetch messages' });
  }
});

// POST /api/discussions/channels/:channelId/messages (text-only fallback; realtime path is socket)
router.post('/channels/:channelId/messages', ensureAuthenticated, async (req, res) => {
  try {
    const { content } = req.body || {};
    if (!content || !String(content).trim()) {
      return res.status(400).json({ success: false, error: 'Message content is required' });
    }

    const { userId, username } = extractUserInfo(req.user);
    const isAdmin = await getCachedAdminStatus(req.user);
    const channel = await getChannelOr404(req.params.channelId);
    if (!channel) return res.status(404).json({ success: false, error: 'Channel not found' });

    const community = await getCommunityOr404(channel.community_id);
    const access = await ensureCanAccessCommunity(userId, community, isAdmin);
    if (!access.ok) return res.status(access.status).json({ success: false, error: access.error });

    const isMod = await isCommunityModerator(userId, community, isAdmin);
    if (!canAccessChannel({ channel, userId, isAdmin, isMod })) {
      return res.status(403).json({ success: false, error: 'Not authorized to access this channel' });
    }

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

    const write = await cloudant.postDocument({ db: DB_MESSAGES, document: messageDoc });
    if (!write.result.ok) return res.status(500).json({ success: false, error: 'Failed to create message' });

    const io = req.app.get('io');
    if (io) io.to(`channel:${channel._id}`).emit('new_message', messageDoc);

    return res.status(201).json({ success: true, message: messageDoc });
  } catch (err) {
    console.error('[DISCUSSIONS] Create message error:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to send message' });
  }
});

// POST /api/discussions/channels/:channelId/media (multipart)
router.post(
  '/channels/:channelId/media',
  ensureAuthenticated,
  upload.single('file'),
  async (req, res) => {
    try {
      const file = req.file;
      if (!file) return res.status(400).json({ success: false, error: 'file is required' });

      const { userId, username } = extractUserInfo(req.user);
      const isAdmin = await getCachedAdminStatus(req.user);
      const channel = await getChannelOr404(req.params.channelId);
      if (!channel) return res.status(404).json({ success: false, error: 'Channel not found' });

      const community = await getCommunityOr404(channel.community_id);
      const access = await ensureCanAccessCommunity(userId, community, isAdmin);
      if (!access.ok) return res.status(access.status).json({ success: false, error: access.error });

      const isMod = await isCommunityModerator(userId, community, isAdmin);
      if (!canAccessChannel({ channel, userId, isAdmin, isMod })) {
        return res.status(403).json({ success: false, error: 'Not authorized to access this channel' });
      }

      if (file.mimetype.startsWith('video/') && file.size > MAX_VIDEO_BYTES) {
        return res.status(400).json({ success: false, error: 'Video must be 50MB or smaller' });
      }

      const messageId = uuidv4();
      let uploaded;
      let messageType = 'attachment';
      let resourceType = 'raw';
      let folder = 'chat_attachments';

      if (file.mimetype.startsWith('image/')) {
        messageType = 'image';
        resourceType = 'image';
        folder = 'chat_images';
        uploaded = await uploadImage({
          buffer: file.buffer,
          folder,
          ownerId: userId,
          contextType: 'chat_message',
          contextId: messageId,
          mimeType: file.mimetype,
          sizeBytes: file.size,
        });
      } else if (file.mimetype.startsWith('video/')) {
        messageType = 'video';
        resourceType = 'video';
        folder = 'chat_videos';
        uploaded = await uploadVideo({
          buffer: file.buffer,
          folder,
          ownerId: userId,
          contextType: 'chat_message',
          contextId: messageId,
          mimeType: file.mimetype,
          sizeBytes: file.size,
        });
      } else {
        uploaded = await uploadRaw({
          buffer: file.buffer,
          folder,
          ownerId: userId,
          contextType: 'chat_message',
          contextId: messageId,
          mimeType: file.mimetype,
          sizeBytes: file.size,
          filename: file.originalname,
        });
      }

      const messageDoc = {
        _id: messageId,
        channel_id: channel._id,
        community_id: channel.community_id,
        sender_id: userId,
        sender_name: username,
        type: messageType,
        content: null,
        media: {
          url: uploaded.secure_url,
          public_id: uploaded.public_id,
          resource_type: resourceType,
          mime_type: file.mimetype,
          size_bytes: file.size,
          filename: file.originalname || null,
        },
        pinned: false,
        pinned_at: null,
        created_at: nowIso(),
        updated_at: nowIso(),
      };

      const write = await cloudant.postDocument({ db: DB_MESSAGES, document: messageDoc });
      if (!write.result.ok) {
        try { await deleteUploadedMedia(uploaded.public_id, resourceType); } catch { }
        return res.status(500).json({ success: false, error: 'Failed to create message' });
      }

      // Sync message to Firebase for realtime
      try {
        const admin = require('firebase-admin');
        const firebaseMessage = {
          _id: messageDoc._id,
          channel_id: messageDoc.channel_id,
          community_id: messageDoc.community_id,
          sender_id: messageDoc.sender_id,
          sender_name: messageDoc.sender_name,
          type: messageDoc.type,
          content: messageDoc.content,
          media: messageDoc.media,
          pinned: messageDoc.pinned,
          pinned_at: messageDoc.pinned_at,
          created_at: messageDoc.created_at,
        };
        // Write directly to Firebase messages node
        if (firebaseService.db) {
          const messageRef = firebaseService.db.ref(`messages/${channel._id}/${messageDoc._id}`);
          await messageRef.set(firebaseMessage);
          console.log(`[DISCUSSIONS] Synced media message to Firebase: ${messageDoc._id}`);
        }
      } catch (firebaseErr) {
        console.warn('[DISCUSSIONS] Firebase sync failed for message:', firebaseErr.message);
      }

      const io = req.app.get('io');
      if (io) io.to(`channel:${channel._id}`).emit('new_message', messageDoc);

      return res.status(201).json({ success: true, message: messageDoc });
    } catch (err) {
      console.error('[DISCUSSIONS] Upload media error:', err.message);
      return res.status(500).json({ success: false, error: 'Failed to upload chat media' });
    }
  }
);

// POST /api/discussions/messages/:messageId/pin
router.post('/messages/:messageId/pin', ensureAuthenticated, async (req, res) => {
  try {
    const { userId } = extractUserInfo(req.user);
    const isAdmin = await getCachedAdminStatus(req.user);

    const message = (await cloudant.getDocument({ db: DB_MESSAGES, docId: req.params.messageId })).result;
    const community = await getCommunityOr404(message.community_id);
    const access = await ensureCanAccessCommunity(userId, community, isAdmin);
    if (!access.ok) return res.status(access.status).json({ success: false, error: access.error });

    const isMod = await isCommunityModerator(userId, community, isAdmin);
    if (!isMod) return res.status(403).json({ success: false, error: 'Only moderators can pin messages' });

    message.pinned = true;
    message.pinned_at = nowIso();
    message.updated_at = nowIso();

    await cloudant.putDocument({ db: DB_MESSAGES, docId: message._id, document: message });
    const io = req.app.get('io');
    if (io) io.to(`channel:${message.channel_id}`).emit('message_pinned', { message_id: message._id, pinned: true, pinned_at: message.pinned_at });
    return res.json({ success: true });
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ success: false, error: 'Message not found' });
    console.error('[DISCUSSIONS] Pin message error:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to pin message' });
  }
});

// POST /api/discussions/messages/:messageId/unpin
router.post('/messages/:messageId/unpin', ensureAuthenticated, async (req, res) => {
  try {
    const { userId } = extractUserInfo(req.user);
    const isAdmin = await getCachedAdminStatus(req.user);

    const message = (await cloudant.getDocument({ db: DB_MESSAGES, docId: req.params.messageId })).result;
    const community = await getCommunityOr404(message.community_id);
    const access = await ensureCanAccessCommunity(userId, community, isAdmin);
    if (!access.ok) return res.status(access.status).json({ success: false, error: access.error });

    const isMod = await isCommunityModerator(userId, community, isAdmin);
    if (!isMod) return res.status(403).json({ success: false, error: 'Only moderators can unpin messages' });

    message.pinned = false;
    message.pinned_at = null;
    message.updated_at = nowIso();

    await cloudant.putDocument({ db: DB_MESSAGES, docId: message._id, document: message });
    const io = req.app.get('io');
    if (io) io.to(`channel:${message.channel_id}`).emit('message_pinned', { message_id: message._id, pinned: false, pinned_at: null });
    return res.json({ success: true });
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ success: false, error: 'Message not found' });
    console.error('[DISCUSSIONS] Unpin message error:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to unpin message' });
  }
});

// POST /api/discussions/messages/:messageId/reactions { emoji, action:add|remove }
router.post('/messages/:messageId/reactions', ensureAuthenticated, async (req, res) => {
  try {
    const { emoji, action } = req.body || {};
    if (!emoji || typeof emoji !== 'string' || emoji.length > 32) {
      return res.status(400).json({ success: false, error: 'emoji is required' });
    }

    const { userId, username } = extractUserInfo(req.user);
    const isAdmin = await getCachedAdminStatus(req.user);
    const message = (await cloudant.getDocument({ db: DB_MESSAGES, docId: req.params.messageId })).result;
    const community = await getCommunityOr404(message.community_id);
    const access = await ensureCanAccessCommunity(userId, community, isAdmin);
    if (!access.ok) return res.status(access.status).json({ success: false, error: access.error });

    const isMod = await isCommunityModerator(userId, community, isAdmin);
    const channel = await getChannelOr404(message.channel_id);
    if (!canAccessChannel({ channel, userId, isAdmin, isMod })) {
      return res.status(403).json({ success: false, error: 'Not authorized' });
    }

    // Check existing reaction via indexed view
    let existing = null;
    try {
      const keyRes = await cloudant.postView({
        db: DB_REACTIONS,
        ddoc: 'message_reactions',
        view: 'by_message_user',
        key: [message._id, userId, emoji],
        includeDocs: true,
        limit: 1,
      });
      existing = keyRes.result.rows?.[0]?.doc || null;
    } catch (_err) {}

    const doRemove = action === 'remove';
    if (doRemove) {
      if (existing) {
        await cloudant.deleteDocument({ db: DB_REACTIONS, docId: existing._id, rev: existing._rev });
      }
    } else {
      if (!existing) {
        await cloudant.postDocument({
          db: DB_REACTIONS,
          document: {
            _id: uuidv4(),
            message_id: message._id,
            channel_id: message.channel_id,
            community_id: message.community_id,
            user_id: userId,
            username,
            emoji,
            created_at: nowIso(),
          },
        });
      }
    }

    const io = req.app.get('io');
    if (io) {
      io.to(`channel:${message.channel_id}`).emit('message_reaction', {
        message_id: message._id,
        channel_id: message.channel_id,
        user_id: userId,
        emoji,
        action: doRemove ? 'remove' : 'add',
        created_at: nowIso(),
      });
    }

    return res.json({ success: true });
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ success: false, error: 'Message not found' });
    console.error('[DISCUSSIONS] Reactions error:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to update reaction' });
  }
});

// POST /api/discussions/channels/:channelId/read — marks channel as read (reset unread)
router.post('/channels/:channelId/read', ensureAuthenticated, async (req, res) => {
  try {
    const { userId } = extractUserInfo(req.user);
    const isAdmin = await getCachedAdminStatus(req.user);
    const channel = await getChannelOr404(req.params.channelId);
    if (!channel) return res.status(404).json({ success: false, error: 'Channel not found' });

    const community = await getCommunityOr404(channel.community_id);
    const access = await ensureCanAccessCommunity(userId, community, isAdmin);
    if (!access.ok) return res.status(access.status).json({ success: false, error: access.error });

    const isMod = await isCommunityModerator(userId, community, isAdmin);
    if (!canAccessChannel({ channel, userId, isAdmin, isMod })) {
      return res.status(403).json({ success: false, error: 'Not authorized' });
    }

    // Find existing unread doc via indexed view
    let existing = null;
    try {
      const existingRes = await cloudant.postView({
        db: DB_UNREAD,
        ddoc: 'unread_states',
        view: 'by_user_channel',
        key: [userId, channel._id],
        includeDocs: true,
        limit: 1,
      });
      existing = existingRes.result.rows?.[0]?.doc || null;
    } catch (_err) {}

    const doc = existing || {
      _id: uuidv4(),
      user_id: userId,
      community_id: channel.community_id,
      channel_id: channel._id,
      unread_count: 0,
      last_read_at: null,
      updated_at: nowIso(),
      created_at: nowIso(),
    };

    doc.unread_count = 0;
    doc.last_read_at = nowIso();
    doc.updated_at = nowIso();

    if (existing) {
      await cloudant.putDocument({ db: DB_UNREAD, docId: doc._id, document: doc });
    } else {
      await cloudant.postDocument({ db: DB_UNREAD, document: doc });
    }

    const io = req.app.get('io');
    if (io) io.to(`channel:${channel._id}`).emit('unread_count_updates', { channel_id: channel._id, user_id: userId, unread_count: 0 });

    return res.json({ success: true });
  } catch (err) {
    console.error('[DISCUSSIONS] Mark read error:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to mark as read' });
  }
});

// GET /api/discussions/communities/:communityId/unreads — get unread counts
router.get('/communities/:communityId/unreads', ensureAuthenticated, async (req, res) => {
  try {
    const { userId } = extractUserInfo(req.user);

    // Use indexed view instead of postFind
    const viewRes = await cloudant.postView({
      db: DB_UNREAD,
      ddoc: 'unread_states',
      view: 'by_user',
      startkey: [userId],
      endkey: [userId, {}],
      includeDocs: true,
      limit: 500,
    });

    const unreads = (viewRes.result.rows || [])
      .map(row => row.doc)
      .filter(doc => doc && doc.community_id === req.params.communityId)
      .map(doc => ({
        channel_id: doc.channel_id,
        unread_count: doc.unread_count || 0,
      }));

    return res.json({ success: true, unreads });
  } catch (err) {
    console.error('[DISCUSSIONS] Fetch unreads error:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to fetch unread counts' });
  }
});

module.exports = router;

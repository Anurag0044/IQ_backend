// ============================================
// CloudIQ Backend - Community Routes
// ============================================

const express = require('express');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const db = require('../services/firestoreClient');
const { uploadBuffer, deleteImage } = require('../services/cloudinaryService');
const { resolveSenderInfo, createNotification } = require('../services/notificationService');
const { ensureAuthenticated, extractUserInfo, checkAdminRole } = require('../middleware/auth');
const { communityCache, membershipCache, adminCache, TTLCache } = require('../services/cacheService');
const firebaseService = require('../services/firebaseService');
const logger = require('../utils/logger');

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

const router = express.Router();
const DB = 'communities';
const REQUESTS_DB = 'community_requests';
const MEMBERS_DB = 'community_memberships';
const FRIENDS_DB = 'friendships';
const communityListCache = new TTLCache(15_000, 50);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Only JPEG, PNG, or WEBP images are allowed.'), false);
  },
});

function isTruthy(value) {
  return value === true || value === 'true' || value === '1';
}

function sanitizeCommunity(doc) {
  if (!doc) return null;
  const { logo_public_id, banner_public_id, ...safe } = doc;
  const memberCount = Array.isArray(doc.members) ? doc.members.length : (doc.member_count || 0);
  return { ...safe, member_count: memberCount };
}

function normalizeCoAdmins(value) {
  if (!value) return null;
  if (Array.isArray(value)) return value.filter(Boolean);
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.filter(Boolean);
    } catch (err) {
      return value.split(',').map((v) => v.trim()).filter(Boolean);
    }
  }
  return null;
}

async function isCommunityModerator(userId, email, community, isAdmin) {
  if (isAdmin) return true;
  if (!community || (!userId && !email)) return false;
  if (userId && community.owner_id === userId) return true;
  if (email && community.owner_email && community.owner_email.toLowerCase() === email.toLowerCase()) return true;
  if (Array.isArray(community.co_admin_ids) && community.co_admin_ids.includes(userId)) return true;
  return false;
}

async function isCommunityMember(userId, community) {
  if (!userId || !community) return false;
  if (Array.isArray(community.members) && community.members.includes(userId)) return true;
  try {
    const docId = `${community._id}_${userId}`;
    const mem = await db.getDoc(MEMBERS_DB, docId);
    return !!mem;
  } catch (err) {
    return false;
  }
}

async function createMembership(userId, username, userEmail, community, role = 'member') {
  if (!userId || !community) return;
  try {
    const docId = `${community._id}_${userId}`;
    let existing;
    try {
      existing = await db.getDoc(MEMBERS_DB, docId);
    } catch (e) { }

    if (existing) return;

    const now = new Date().toISOString();
    await db.setDoc(MEMBERS_DB, docId, {
      type: 'community_membership',
      community_id: community._id,
      community_name: community.name || '',
      user_id: userId,
      username: username || '',
      user_email: userEmail || '',
      role,
      membership_status: 'active',
      visibility_access: community.visibility || 'public',
      joined_at: now,
      created_at: now,
      updated_at: now,
    });
    logger.info(`[COMMUNITIES] Membership created: user=${userId} community=${community._id} role=${role}`);
  } catch (err) {
    logger.warn('[COMMUNITIES] Create membership failed:', err.message);
  }
}

async function removeMembership(userId, communityId) {
  try {
    const docId = `${communityId}_${userId}`;
    await db.deleteDoc(MEMBERS_DB, docId);
  } catch (err) {
    logger.warn('[COMMUNITIES] Remove membership failed:', err.message);
  }
}

async function isFriendWithModerators(userId, community) {
  if (!userId || !community) return false;
  const moderators = [community.owner_id, ...(community.co_admin_ids || [])].filter(Boolean);
  if (moderators.length === 0) return false;

  try {
    const friendships = await db.queryDocs(FRIENDS_DB, [['status', '==', 'accepted']], null, 'asc', 500);
    for (const doc of friendships) {
      if (doc.sender_id === userId || doc.receiver_id === userId) {
        const otherId = doc.sender_id === userId ? doc.receiver_id : doc.sender_id;
        if (moderators.includes(otherId)) return true;
      }
    }
    return false;
  } catch (err) {
    logger.warn('[COMMUNITIES] Friend lookup failed:', err.message);
    return false;
  }
}

function clearCommunityListCache() {
  communityListCache.clear();
}

async function notifyCommunityModerators(req, community, senderId, senderName, senderAvatar, message, type) {
  if (!community) return;
  const io = req.app.get('io');
  const userSockets = req.app.get('userSockets');

  const recipients = [community.owner_id, ...(community.co_admin_ids || [])].filter(Boolean);
  const uniqueRecipients = Array.from(new Set(recipients));

  for (const recipientId of uniqueRecipients) {
    await createNotification({
      io,
      userSockets,
      recipientId,
      senderId,
      senderName,
      senderAvatar,
      type,
      message,
      targetType: 'community',
      targetId: community._id,
    });
  }
}

// ─────────────────────────────────────────────
// GET /api/communities
// ─────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const mine = isTruthy(req.query.mine);
    let docs = [];

    if (mine) {
      if (!req.firebaseUser) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
      }

      const { userId } = extractUserInfo(req);
      const memberships = await db.queryDocs(MEMBERS_DB, [['user_id', '==', userId]]);
      
      const communityIds = memberships.map(m => m.community_id).filter(Boolean);
      
      if (communityIds.length === 0) {
        return res.json({ success: true, communities: [] });
      }

      for (const id of communityIds) {
        try {
          const doc = await db.getDoc(DB, id);
          if (doc) docs.push(doc);
        } catch (e) { }
      }
    } else {
      const limit = Math.max(1, Math.min(50, Number(req.query.limit || 25)));
      const before = req.query.before ? String(req.query.before) : null;
      const cacheKey = `communities:${limit}:${before || 'latest'}`;
      const cached = communityListCache.get(cacheKey);
      if (cached) {
        logger.debug('[API] duplicate request prevented /api/communities');
        return res.json(cached);
      }

      let filters = [];
      if (before) {
        filters.push(['created_at', '<', before]);
      }

      docs = await db.queryDocs(DB, filters, 'created_at', 'desc', limit);
    }

    docs.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    let userMemberships = [];
    let currentUserId = null;
    if (req.firebaseUser) {
      const userInfo = extractUserInfo(req);
      currentUserId = userInfo.userId;
      try {
        const mems = await db.queryDocs(MEMBERS_DB, [['user_id', '==', currentUserId]]);
        userMemberships = mems.map(m => m.community_id).filter(Boolean);
      } catch (err) {}
    }

    const sanitizedDocs = docs.map(doc => {
      const sanitized = sanitizeCommunity(doc);
      if (currentUserId && userMemberships.includes(doc._id)) {
        if (!Array.isArray(sanitized.members)) sanitized.members = [];
        if (!sanitized.members.includes(currentUserId)) {
          sanitized.members.push(currentUserId);
        }
      }
      return sanitized;
    });

    const payload = { success: true, communities: sanitizedDocs };
    if (!mine) {
      const limit = Math.max(1, Math.min(50, Number(req.query.limit || 25)));
      const before = req.query.before ? String(req.query.before) : null;
      communityListCache.set(`communities:${limit}:${before || 'latest'}`, payload);
    }
    return res.json(payload);
  } catch (err) {
    logger.error('[COMMUNITIES] Fetch error:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to fetch communities' });
  }
});

// ─────────────────────────────────────────────
// GET /api/communities/:id
// ─────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const community = await db.getDoc(DB, req.params.id);
    const sanitized = sanitizeCommunity(community);

    if (req.firebaseUser) {
      const { userId } = extractUserInfo(req);
      try {
        const mem = await db.getDoc(MEMBERS_DB, `${community._id}_${userId}`);
        if (mem) {
          if (!Array.isArray(sanitized.members)) sanitized.members = [];
          if (!sanitized.members.includes(userId)) {
            sanitized.members.push(userId);
          }
        }
      } catch (err) {}
    }

    return res.json({ success: true, community: sanitized });
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ success: false, error: 'Community not found' });
    logger.error('[COMMUNITIES] Get error:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to fetch community' });
  }
});

// ─────────────────────────────────────────────
// POST /api/communities
// ─────────────────────────────────────────────
router.post(
  '/',
  ensureAuthenticated,
  upload.fields([
    { name: 'logo', maxCount: 1 },
    { name: 'banner', maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const { name, description, category, color, visibility } = req.body;

      if (!name || !name.trim()) {
        return res.status(400).json({ success: false, error: 'Community name is required' });
      }

      if (!description || !description.trim()) {
        return res.status(400).json({ success: false, error: 'Community description is required' });
      }

      const { userId, email, username } = extractUserInfo(req);

      let logo_url = null;
      let logo_public_id = null;
      let banner_url = null;
      let banner_public_id = null;

      if (req.files?.logo?.[0]) {
        const result = await uploadBuffer(req.files.logo[0].buffer, 'community_logos');
        logo_url = result.secure_url;
        logo_public_id = result.public_id;
      }

      if (req.files?.banner?.[0]) {
        const result = await uploadBuffer(req.files.banner[0].buffer, 'community_banners');
        banner_url = result.secure_url;
        banner_public_id = result.public_id;
      }

      const id = uuidv4();
      const community = {
        name: name.trim(),
        description: description.trim(),
        category: category || 'General',
        color: color || '#0f62fe',
        visibility: visibility || 'public',
        logo_url,
        logo_public_id,
        banner_url,
        banner_public_id,
        owner_id: userId,
        owner_email: email,
        owner_name: username,
        co_admin_ids: [],
        members: [userId],
        member_count: 1,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      const saved = await db.setDoc(DB, id, community);

      await createMembership(userId, username, email, saved, 'owner');

      membershipCache.set(`mem:${userId}:${saved._id}`, true);

      const defaultChannel = {
        _id: uuidv4(),
        community_id: saved._id,
        name: saved.name.trim().replace(/\s+/g, '-').toLowerCase() || 'general',
        topic: 'Welcome to the community discussion',
        type: 'text',
        visibility: 'members',
        position: 0,
        created_by: userId,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      await firebaseService.syncChannel(defaultChannel).catch(err => {
        logger.warn('[COMMUNITIES] Failed to create default Firestore discussion channel:', err.message);
      });

      const io = req.app.get('io');
      if (io) io.emit('community_created', sanitizeCommunity(saved));
      clearCommunityListCache();

      return res.status(201).json({ success: true, community: sanitizeCommunity(saved) });
    } catch (err) {
      logger.error('[COMMUNITIES] Create error:', err.message);
      return res.status(500).json({ success: false, error: 'Failed to create community' });
    }
  }
);

// ─────────────────────────────────────────────
// PUT /api/communities/:id
// ─────────────────────────────────────────────
router.put(
  '/:id',
  ensureAuthenticated,
  upload.fields([
    { name: 'logo', maxCount: 1 },
    { name: 'banner', maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const { userId, email } = extractUserInfo(req);
      const isAdmin = await getCachedAdminStatus(req);

      let community;
      try {
        community = await db.getDoc(DB, req.params.id);
      } catch (err) {
        if (err.status === 404) return res.status(404).json({ success: false, error: 'Community not found' });
        throw err;
      }

      const canManage = await isCommunityModerator(userId, email, community, isAdmin);
      if (!canManage) {
        return res.status(403).json({ success: false, error: 'Not authorized to update this community' });
      }

      const removeLogo = isTruthy(req.body.remove_logo);
      const removeBanner = isTruthy(req.body.remove_banner);

      if (removeLogo && community.logo_public_id) {
        await deleteImage(community.logo_public_id);
        community.logo_public_id = null;
        community.logo_url = null;
      }

      if (removeBanner && community.banner_public_id) {
        await deleteImage(community.banner_public_id);
        community.banner_public_id = null;
        community.banner_url = null;
      }

      if (req.files?.logo?.[0]) {
        if (community.logo_public_id) await deleteImage(community.logo_public_id);
        const result = await uploadBuffer(req.files.logo[0].buffer, 'community_logos');
        community.logo_url = result.secure_url;
        community.logo_public_id = result.public_id;
      }

      if (req.files?.banner?.[0]) {
        if (community.banner_public_id) await deleteImage(community.banner_public_id);
        const result = await uploadBuffer(req.files.banner[0].buffer, 'community_banners');
        community.banner_url = result.secure_url;
        community.banner_public_id = result.public_id;
      }

      if (req.body.name !== undefined) community.name = req.body.name.trim();
      if (req.body.description !== undefined) community.description = req.body.description.trim();
      if (req.body.category !== undefined) community.category = req.body.category;
      if (req.body.color !== undefined) community.color = req.body.color;
      if (req.body.visibility !== undefined) community.visibility = req.body.visibility;

      const coAdmins = normalizeCoAdmins(req.body.co_admin_ids);
      if (coAdmins && (isAdmin || community.owner_id === userId)) {
        community.co_admin_ids = coAdmins;
      }

      community.updated_at = new Date().toISOString();

      await db.setDoc(DB, community._id, community);

      communityCache.delete(`comm:${community._id}`);
      clearCommunityListCache();

      const io = req.app.get('io');
      if (io) io.emit('community_updated', sanitizeCommunity(community));

      return res.json({ success: true, community: sanitizeCommunity(community) });
    } catch (err) {
      logger.error('[COMMUNITIES] Update error:', err.message);
      return res.status(500).json({ success: false, error: 'Failed to update community' });
    }
  }
);

// ─────────────────────────────────────────────
// DELETE /api/communities/:id
// ─────────────────────────────────────────────
router.delete('/:id', ensureAuthenticated, async (req, res) => {
  try {
    const { userId, email } = extractUserInfo(req);
    const isAdmin = await getCachedAdminStatus(req);

    let community;
    try {
      community = await db.getDoc(DB, req.params.id);
    } catch (err) {
      if (err.status === 404) return res.status(404).json({ success: false, error: 'Community not found' });
      throw err;
    }

    const canManage = await isCommunityModerator(userId, email, community, isAdmin);
    if (!canManage) {
      return res.status(403).json({ success: false, error: 'Not authorized to delete this community' });
    }

    if (community.logo_public_id) await deleteImage(community.logo_public_id);
    if (community.banner_public_id) await deleteImage(community.banner_public_id);

    try {
      const memberships = await db.queryDocs(MEMBERS_DB, [['community_id', '==', community._id]]);
      for (const m of memberships) {
        await db.deleteDoc(MEMBERS_DB, m._id);
      }
    } catch (e) {
      logger.error('[COMMUNITIES] Failed to cleanup memberships:', e.message);
    }

    try {
      const channels = await firebaseService.listChannelsByCommunity(community._id);
      for (const channelDoc of channels) {
        await firebaseService.deleteChannel(channelDoc._id || channelDoc.id);
        logger.info(`[COMMUNITIES] Cleaned Firebase data for channel ${channelDoc._id || channelDoc.id}`);
      }
    } catch (e) {
      logger.error('[COMMUNITIES] Failed to cleanup Firestore channels/messages:', e.message);
    }

    await db.deleteDoc(DB, community._id);
    
    communityCache.delete(`comm:${community._id}`);
    clearCommunityListCache();
    
    const io = req.app.get('io');
    if (io) io.emit('community_deleted', { community_id: community._id });
    return res.json({ success: true, message: 'Community deleted safely' });
  } catch (err) {
    logger.error('[COMMUNITIES] Delete error:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to delete community' });
  }
});

// ─────────────────────────────────────────────
// POST /api/communities/:id/join
// ─────────────────────────────────────────────
router.post('/:id/join', ensureAuthenticated, async (req, res) => {
  try {
    const { userId, username, email } = extractUserInfo(req);

    let community;
    try {
      community = await db.getDoc(DB, req.params.id);
    } catch (err) {
      if (err.status === 404) return res.status(404).json({ success: false, error: 'Community not found' });
      throw err;
    }

    if (await isCommunityMember(userId, community)) {
      const sanitized = sanitizeCommunity(community);
      if (!Array.isArray(sanitized.members)) sanitized.members = [];
      if (!sanitized.members.includes(userId)) {
        sanitized.members.push(userId);
      }
      return res.json({ success: true, community: sanitized });
    }

    if (community.visibility === 'private') {
      const isFriend = await isFriendWithModerators(userId, community);
      if (!isFriend) {
        return res.status(403).json({ success: false, error: 'Only connections can join this private community' });
      }
    }

    if (community.visibility === 'restricted') {
      try {
        const reqs = await db.queryDocs(REQUESTS_DB, [['requester_id', '==', userId], ['community_id', '==', community._id], ['status', '==', 'pending']]);
        if (reqs.length > 0) {
          return res.status(202).json({ success: true, pending: true, request: reqs[0] });
        }
      } catch (e) {
        logger.warn('[COMMUNITIES] Request lookup failed:', e.message);
      }

      const requestDoc = {
        community_id: community._id,
        community_name: community.name,
        requester_id: userId,
        requester_name: username,
        requester_email: email || '',
        status: 'pending',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      const savedReq = await db.addDoc(REQUESTS_DB, requestDoc);

      const { senderName, senderAvatar } = await resolveSenderInfo(
        userId,
        username,
        req.firebaseUser?.picture || null
      );

      await notifyCommunityModerators(
        req,
        community,
        userId,
        senderName,
        senderAvatar,
        `${senderName} requested to join ${community.name}`,
        'community_join_request'
      );

      const io = req.app.get('io');
      if (io) io.emit('community_request_created', { community_id: community._id, request: savedReq });

      return res.status(202).json({ success: true, pending: true, request: savedReq });
    }

    await createMembership(userId, username, email, community, 'member');
    membershipCache.set(`mem:${userId}:${community._id}`, true);

    let updatedCommunity = community;
    try {
      if (!Array.isArray(updatedCommunity.members)) updatedCommunity.members = [];
      if (!updatedCommunity.members.includes(userId)) updatedCommunity.members.push(userId);
      updatedCommunity.member_count = updatedCommunity.members.length;
      updatedCommunity.updated_at = new Date().toISOString();

      await db.setDoc(DB, updatedCommunity._id, updatedCommunity, { merge: true });
    } catch (e) {}

    communityCache.delete(`comm:${community._id}`);
    clearCommunityListCache();

    const io = req.app.get('io');
    if (io) io.emit('community_updated', sanitizeCommunity(updatedCommunity));

    const sanitized = sanitizeCommunity(updatedCommunity);
    if (!Array.isArray(sanitized.members)) sanitized.members = [];
    if (!sanitized.members.includes(userId)) sanitized.members.push(userId);

    return res.json({ success: true, community: sanitized });
  } catch (err) {
    logger.error('[COMMUNITIES] Join error:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to join community' });
  }
});

// ─────────────────────────────────────────────
// POST /api/communities/:id/leave
// ─────────────────────────────────────────────
router.post('/:id/leave', ensureAuthenticated, async (req, res) => {
  try {
    const { userId } = extractUserInfo(req);

    let community;
    try {
      community = await db.getDoc(DB, req.params.id);
    } catch (err) {
      if (err.status === 404) return res.status(404).json({ success: false, error: 'Community not found' });
      throw err;
    }

    if (community.owner_id === userId) {
      return res.status(400).json({ success: false, error: 'Owner cannot leave their own community' });
    }

    if (!Array.isArray(community.members)) community.members = [];
    community.members = community.members.filter((id) => id !== userId);

    if (Array.isArray(community.co_admin_ids)) {
      community.co_admin_ids = community.co_admin_ids.filter((id) => id !== userId);
    }

    community.member_count = community.members.length;
    community.updated_at = new Date().toISOString();

    await db.setDoc(DB, community._id, community);

    await removeMembership(userId, community._id);

    communityCache.delete(`comm:${community._id}`);
    clearCommunityListCache();
    membershipCache.set(`mem:${userId}:${community._id}`, false);

    try {
      await firebaseService.updatePresence({ userId, communityId: community._id, status: 'offline' });
      logger.info(`[COMMUNITIES] Firebase leave cleanup done for user=${userId} community=${community._id}`);
    } catch (fbErr) {
      logger.warn('[COMMUNITIES] Firebase leave cleanup error:', fbErr.message);
    }

    const io = req.app.get('io');
    if (io) {
      io.emit('community_updated', sanitizeCommunity(community));
      const userSockets = req.app.get('userSockets');
      const userSocketId = userSockets && userSockets.get(userId);
      if (userSocketId) {
        io.to(userSocketId).emit('membership_left', { community_id: community._id });
      }
    }

    return res.json({ success: true, community: sanitizeCommunity(community) });
  } catch (err) {
    logger.error('[COMMUNITIES] Leave error:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to leave community' });
  }
});

// ─────────────────────────────────────────────
// POST /api/communities/:id/request
// ─────────────────────────────────────────────
router.post('/:id/request', ensureAuthenticated, async (req, res) => {
  try {
    const { userId, username, email } = extractUserInfo(req);
    const community = await db.getDoc(DB, req.params.id);

    if (community.visibility !== 'restricted') {
      return res.status(400).json({ success: false, error: 'Community does not require requests' });
    }

    if (await isCommunityMember(userId, community)) {
      return res.json({ success: true, community: sanitizeCommunity(community) });
    }

    const reqs = await db.queryDocs(REQUESTS_DB, [['requester_id', '==', userId], ['community_id', '==', community._id], ['status', '==', 'pending']]);
    if (reqs.length > 0) {
      return res.status(202).json({ success: true, pending: true, request: reqs[0] });
    }

    const requestDoc = {
      community_id: community._id,
      community_name: community.name,
      requester_id: userId,
      requester_name: username,
      requester_email: email || '',
      status: 'pending',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const savedReq = await db.addDoc(REQUESTS_DB, requestDoc);

    const { senderName, senderAvatar } = await resolveSenderInfo(
      userId,
      username,
      req.firebaseUser?.picture || null
    );

    await notifyCommunityModerators(
      req,
      community,
      userId,
      senderName,
      senderAvatar,
      `${senderName} requested to join ${community.name}`,
      'community_join_request'
    );

    const io = req.app.get('io');
    if (io) io.emit('community_request_created', { community_id: community._id, request: savedReq });

    return res.status(202).json({ success: true, pending: true, request: savedReq });
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ success: false, error: 'Community not found' });
    logger.error('[COMMUNITIES] Request error:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to create request' });
  }
});

// ─────────────────────────────────────────────
// GET /api/communities/:id/requests
// ─────────────────────────────────────────────
router.get('/:id/requests', ensureAuthenticated, async (req, res) => {
  try {
    const { userId, email } = extractUserInfo(req);
    const isAdmin = await getCachedAdminStatus(req);
    let community;
    try {
      community = await db.getDoc(DB, req.params.id);
    } catch (err) {
      if (err.status === 404) return res.status(404).json({ success: false, error: 'Community not found' });
      throw err;
    }

    const canManage = await isCommunityModerator(userId, email, community, isAdmin);
    if (!canManage) {
      return res.status(403).json({ success: false, error: 'Not authorized' });
    }

    const requests = await db.queryDocs(REQUESTS_DB, [['community_id', '==', community._id], ['status', '==', 'pending']]);

    return res.json({ success: true, requests });
  } catch (err) {
    logger.error('[COMMUNITIES] Requests fetch error:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to fetch requests' });
  }
});

// ─────────────────────────────────────────────
// POST /api/communities/:id/requests/:requestId/approve
// ─────────────────────────────────────────────
router.post('/:id/requests/:requestId/approve', ensureAuthenticated, async (req, res) => {
  try {
    const { userId, email } = extractUserInfo(req);
    const isAdmin = await getCachedAdminStatus(req);
    const community = await db.getDoc(DB, req.params.id);

    const canManage = await isCommunityModerator(userId, email, community, isAdmin);
    if (!canManage) {
      return res.status(403).json({ success: false, error: 'Not authorized' });
    }

    const requestDoc = await db.getDoc(REQUESTS_DB, req.params.requestId);

    if (requestDoc.status !== 'pending') {
      return res.status(400).json({ success: false, error: 'Request already processed' });
    }

    requestDoc.status = 'approved';
    requestDoc.updated_at = new Date().toISOString();
    requestDoc.approved_by = userId;
    await db.setDoc(REQUESTS_DB, requestDoc._id, requestDoc);

    if (!Array.isArray(community.members)) community.members = [];
    if (!community.members.includes(requestDoc.requester_id)) {
      community.members.push(requestDoc.requester_id);
    }
    community.member_count = community.members.length;
    community.updated_at = new Date().toISOString();
    await db.setDoc(DB, community._id, community);

    await createMembership(
      requestDoc.requester_id,
      requestDoc.requester_name,
      requestDoc.requester_email || '',
      community,
      'member'
    );
    membershipCache.set(`mem:${requestDoc.requester_id}:${community._id}`, true);
    communityCache.delete(`comm:${community._id}`);
    clearCommunityListCache();

    const { senderName, senderAvatar } = await resolveSenderInfo(
      userId,
      req.firebaseUser?.name || 'Moderator',
      req.firebaseUser?.picture || null
    );

    await createNotification({
      io: req.app.get('io'),
      userSockets: req.app.get('userSockets'),
      recipientId: requestDoc.requester_id,
      senderId: userId,
      senderName,
      senderAvatar,
      type: 'community_join_approved',
      message: `${senderName} approved your request to join ${community.name}`,
      targetType: 'community',
      targetId: community._id,
    });

    const io = req.app.get('io');
    if (io) {
      io.emit('community_updated', sanitizeCommunity(community));
      io.emit('community_request_approved', { community_id: community._id, request_id: requestDoc._id });
    }

    return res.json({ success: true, community: sanitizeCommunity(community), request: requestDoc });
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ success: false, error: 'Request not found' });
    logger.error('[COMMUNITIES] Request approve error:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to approve request' });
  }
});

// ─────────────────────────────────────────────
// POST /api/communities/:id/requests/:requestId/reject
// ─────────────────────────────────────────────
router.post('/:id/requests/:requestId/reject', ensureAuthenticated, async (req, res) => {
  try {
    const { userId, email } = extractUserInfo(req);
    const isAdmin = await getCachedAdminStatus(req);
    const community = await db.getDoc(DB, req.params.id);

    const canManage = await isCommunityModerator(userId, email, community, isAdmin);
    if (!canManage) {
      return res.status(403).json({ success: false, error: 'Not authorized' });
    }

    const requestDoc = await db.getDoc(REQUESTS_DB, req.params.requestId);

    if (requestDoc.status !== 'pending') {
      return res.status(400).json({ success: false, error: 'Request already processed' });
    }

    requestDoc.status = 'rejected';
    requestDoc.updated_at = new Date().toISOString();
    requestDoc.rejected_by = userId;
    await db.setDoc(REQUESTS_DB, requestDoc._id, requestDoc);

    const { senderName, senderAvatar } = await resolveSenderInfo(
      userId,
      req.firebaseUser?.name || 'Moderator',
      req.firebaseUser?.picture || null
    );

    await createNotification({
      io: req.app.get('io'),
      userSockets: req.app.get('userSockets'),
      recipientId: requestDoc.requester_id,
      senderId: userId,
      senderName,
      senderAvatar,
      type: 'community_join_rejected',
      message: `${senderName} declined your request to join ${community.name}`,
      targetType: 'community',
      targetId: community._id,
    });

    const io = req.app.get('io');
    if (io) io.emit('community_request_rejected', { community_id: community._id, request_id: requestDoc._id });

    return res.json({ success: true, request: requestDoc });
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ success: false, error: 'Request not found' });
    logger.error('[COMMUNITIES] Request reject error:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to reject request' });
  }
});

module.exports = router;

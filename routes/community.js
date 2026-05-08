// ============================================
// CloudIQ Backend - Community Routes
// ============================================
// Endpoints:
//   GET    /api/communities           → list communities (public)
//   GET    /api/communities/:id       → get community by id (public)
//   POST   /api/communities           → create community (auth)
//   PUT    /api/communities/:id       → update community (auth, owner/co-admin/admin)
//   DELETE /api/communities/:id       → delete community (auth, owner/co-admin/admin)
//   POST   /api/communities/:id/join  → join community (auth)
//   POST   /api/communities/:id/leave → leave community (auth)

const express = require('express');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const cloudant = require('../services/cloudantClient');
const { uploadBuffer, deleteImage } = require('../services/cloudinaryService');
const { resolveSenderInfo, createNotification } = require('../services/notificationService');
const { ensureAuthenticated, extractUserInfo, checkAdminRole } = require('../middleware/auth');
const { communityCache, membershipCache, adminCache } = require('../services/cacheService');
const firebaseService = require('../services/firebaseService');

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

const router = express.Router();
const DB = 'communities';
const REQUESTS_DB = 'community_requests';
const MEMBERS_DB = 'community_memberships';
const FRIENDS_DB = 'friendships';

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
  const { _rev, logo_public_id, banner_public_id, ...safe } = doc;
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
    const res = await cloudant.postView({
      db: MEMBERS_DB,
      ddoc: 'community_memberships',
      view: 'by_community',
      key: [community._id, userId],
      includeDocs: true,
      limit: 1,
    });
    return (res.result.rows || []).length > 0;
  } catch (err) {
    console.warn('[COMMUNITIES] Membership lookup failed:', err.message);
    return false;
  }
}

async function createMembership(userId, username, userEmail, community) {
  if (!userId || !community) return;
  try {
    const existing = await cloudant.postView({
      db: MEMBERS_DB,
      ddoc: 'community_memberships',
      view: 'by_community',
      key: [community._id, userId],
      includeDocs: true,
      limit: 1,
    });
    if ((existing.result.rows || []).length > 0) return;

    await cloudant.postDocument({
      db: MEMBERS_DB,
      document: {
        _id: uuidv4(),
        community_id: community._id,
        user_id: userId,
        username: username || '',
        user_email: userEmail || '',
        status: 'active',
        visibility_access: community.visibility || 'public',
        created_at: new Date().toISOString(),
      },
    });
  } catch (err) {
    console.warn('[COMMUNITIES] Create membership failed:', err.message);
  }
}

async function removeMembership(userId, communityId) {
  try {
    const existing = await cloudant.postView({
      db: MEMBERS_DB,
      ddoc: 'community_memberships',
      view: 'by_community',
      key: [communityId, userId],
      includeDocs: true,
      limit: 1,
    });
    if ((existing.result.rows || []).length === 0) return;
    const doc = existing.result.rows[0].doc;
    await cloudant.deleteDocument({ db: MEMBERS_DB, docId: doc._id, rev: doc._rev });
  } catch (err) {
    console.warn('[COMMUNITIES] Remove membership failed:', err.message);
  }
}

async function isFriendWithModerators(userId, community) {
  if (!userId || !community) return false;
  const moderators = [community.owner_id, ...(community.co_admin_ids || [])].filter(Boolean);
  if (moderators.length === 0) return false;

  try {
    const res = await cloudant.postView({
      db: FRIENDS_DB,
      ddoc: 'friendships',
      view: 'by_user',
      key: userId,
      includeDocs: true,
    });
    
    for (const row of (res.result.rows || [])) {
      const doc = row.doc;
      if (doc && doc.status === 'accepted') {
        const otherId = doc.user_1 === userId ? doc.user_2 : doc.user_1;
        if (moderators.includes(otherId)) return true;
      }
    }
    return false;
  } catch (err) {
    console.warn('[COMMUNITIES] Friend lookup failed:', err.message);
    return false;
  }
}

async function notifyCommunityModerators(req, community, senderId, senderName, senderAvatar, message, type) {
  if (!community) return;
  const io = req.app.get('io');
  const userSockets = req.app.get('userSockets');

  const recipients = [community.owner_id, ...(community.co_admin_ids || [])].filter(Boolean);
  const uniqueRecipients = Array.from(new Set(recipients));

  for (const recipientId of uniqueRecipients) {
    await createNotification({
      cloudant,
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
// Public — list communities
// Optional: ?mine=true (requires auth)
// ─────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const mine = isTruthy(req.query.mine);
    let docs = [];

    if (mine) {
      if (!req.isAuthenticated || !req.isAuthenticated()) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
      }

      const { userId } = extractUserInfo(req.user);
      const response = await cloudant.postView({
        db: DB,
        ddoc: 'communities',
        view: 'by_member',
        key: userId,
        includeDocs: true,
      });

      docs = (response.result.rows || [])
        .map((row) => row.doc)
        .filter((doc) => doc && !doc._id.startsWith('_design'));
    } else {
      const response = await cloudant.postAllDocs({
        db: DB,
        includeDocs: true,
      });

      docs = (response.result.rows || [])
        .map((row) => row.doc)
        .filter((doc) => doc && !doc._id.startsWith('_design'));
    }

    docs.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    let userMemberships = [];
    let currentUserId = null;
    if (req.isAuthenticated && req.isAuthenticated()) {
      const userInfo = extractUserInfo(req.user);
      currentUserId = userInfo.userId;
      try {
        const mems = await cloudant.postView({
          db: MEMBERS_DB,
          ddoc: 'community_memberships',
          view: 'by_user',
          startkey: [currentUserId],
          endkey: [currentUserId, {}],
          includeDocs: true,
          limit: 1000
        });
        userMemberships = (mems.result.rows || []).map(row => row.doc?.community_id).filter(Boolean);
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

    return res.json({ success: true, communities: sanitizedDocs });
  } catch (err) {
    console.error('[COMMUNITIES] Fetch error:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to fetch communities' });
  }
});

// ─────────────────────────────────────────────
// GET /api/communities/:id
// Public — fetch a single community
// ─────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const community = (await cloudant.getDocument({ db: DB, docId: req.params.id })).result;
    const sanitized = sanitizeCommunity(community);

    if (req.isAuthenticated && req.isAuthenticated()) {
      const { userId } = extractUserInfo(req.user);
      try {
        const mems = await cloudant.postView({
          db: MEMBERS_DB,
          ddoc: 'community_memberships',
          view: 'by_community',
          key: [community._id, userId],
          includeDocs: true,
          limit: 1
        });
        if ((mems.result.rows || []).length > 0) {
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
    console.error('[COMMUNITIES] Get error:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to fetch community' });
  }
});

// ─────────────────────────────────────────────
// POST /api/communities
// Auth required — create a community
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

      const { userId, email, username } = extractUserInfo(req.user);

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

      const community = {
        _id: uuidv4(),
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

      const response = await cloudant.postDocument({ db: DB, document: community });
      if (!response.result.ok) {
        return res.status(500).json({ success: false, error: 'Failed to create community' });
      }

      await createMembership(userId, community);

      const defaultChannel = {
        _id: uuidv4(),
        community_id: community._id,
        name: community.name.trim().replace(/\s+/g, '-').toLowerCase() || 'general',
        topic: 'Welcome to the community discussion',
        type: 'text',
        visibility: 'members',
        position: 0,
        created_by: userId,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      await cloudant.postDocument({ db: 'channels', document: defaultChannel }).catch(err => {
        console.warn('[COMMUNITIES] Failed to create default discussion channel:', err.message);
      });

      const io = req.app.get('io');
      if (io) io.emit('community_created', sanitizeCommunity(community));

      return res.status(201).json({ success: true, community: sanitizeCommunity(community) });
    } catch (err) {
      console.error('[COMMUNITIES] Create error:', err.message);
      return res.status(500).json({ success: false, error: 'Failed to create community' });
    }
  }
);

// ─────────────────────────────────────────────
// PUT /api/communities/:id
// Auth required — update a community (owner/co-admin/admin)
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
      const { userId, email } = extractUserInfo(req.user);
      const isAdmin = await getCachedAdminStatus(req.user);

      let community;
      try {
        community = (await cloudant.getDocument({ db: DB, docId: req.params.id })).result;
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

      const response = await cloudant.putDocument({ db: DB, docId: community._id, document: community });
      if (!response.result.ok) {
        return res.status(500).json({ success: false, error: 'Failed to update community' });
      }

      // Invalidate caches
      communityCache.delete(`comm:${community._id}`);

      const io = req.app.get('io');
      if (io) io.emit('community_updated', sanitizeCommunity(community));

      return res.json({ success: true, community: sanitizeCommunity(community) });
    } catch (err) {
      console.error('[COMMUNITIES] Update error:', err.message);
      return res.status(500).json({ success: false, error: 'Failed to update community' });
    }
  }
);

// ─────────────────────────────────────────────
// DELETE /api/communities/:id
// Auth required — delete a community (owner/co-admin/admin)
// ─────────────────────────────────────────────
router.delete('/:id', ensureAuthenticated, async (req, res) => {
  try {
    const { userId, email } = extractUserInfo(req.user);
    const isAdmin = await getCachedAdminStatus(req.user);

    let community;
    try {
      community = (await cloudant.getDocument({ db: DB, docId: req.params.id })).result;
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

    // Remove associated memberships
    try {
      const memberships = await cloudant.postView({
        db: MEMBERS_DB,
        ddoc: 'community_memberships',
        view: 'by_community',
        startkey: [community._id],
        endkey: [community._id, {}],
        includeDocs: true,
        limit: 1000
      });
      for (const row of (memberships.result.rows || [])) {
        await cloudant.deleteDocument({ db: MEMBERS_DB, docId: row.doc._id, rev: row.doc._rev });
      }
    } catch (e) {
      console.error('[COMMUNITIES] Failed to cleanup memberships:', e.message);
    }

    // Remove associated channels and their messages
    try {
      const channels = await cloudant.postView({
        db: 'channels',
        ddoc: 'channels',
        view: 'by_community',
        startkey: [community._id],
        endkey: [community._id, {}],
        includeDocs: true,
        limit: 100
      });
      
      for (const row of (channels.result.rows || [])) {
        const channelDoc = row.doc;
        
        // Delete messages for this channel
        try {
          const messages = await cloudant.postView({
            db: 'messages',
            ddoc: 'messages',
            view: 'by_channel_created_at',
            startkey: [channelDoc._id],
            endkey: [channelDoc._id, {}],
            includeDocs: true,
            limit: 1000
          });
          for (const msgRow of (messages.result.rows || [])) {
            await cloudant.deleteDocument({ db: 'messages', docId: msgRow.doc._id, rev: msgRow.doc._rev });
          }
        } catch (msgErr) {}

        // Delete unread states for this channel
        try {
          const unreads = await cloudant.postView({
            db: 'unread_states',
            ddoc: 'unread_states',
            view: 'by_channel',
            key: channelDoc._id,
            includeDocs: true,
            limit: 1000
          });
          for (const unreadRow of (unreads.result.rows || [])) {
            await cloudant.deleteDocument({ db: 'unread_states', docId: unreadRow.doc._id, rev: unreadRow.doc._rev });
          }
        } catch (unrErr) {}

        // Delete the channel itself
        await cloudant.deleteDocument({ db: 'channels', docId: channelDoc._id, rev: channelDoc._rev });

        // Cleanup Firebase data for this channel
        try {
          await firebaseService.deleteChannel(channelDoc._id);
          console.log(`[COMMUNITIES] Cleaned Firebase data for channel ${channelDoc._id}`);
        } catch (firebaseErr) {
          console.warn('[COMMUNITIES] Firebase cleanup failed for channel:', firebaseErr.message);
        }
      }
    } catch (e) {
      console.error('[COMMUNITIES] Failed to cleanup channels/messages:', e.message);
    }

    // Remove community
    await cloudant.deleteDocument({ db: DB, docId: community._id, rev: community._rev });
    
    // Invalidate caches
    communityCache.delete(`comm:${community._id}`);
    // memberships are cascade deleted so it's safer to invalidate by prefix if possible, but they'll naturally expire or be 404ed anyway.
    // adminCache is unrelated.
    
    const io = req.app.get('io');
    if (io) io.emit('community_deleted', { community_id: community._id });
    return res.json({ success: true, message: 'Community deleted safely' });
  } catch (err) {
    console.error('[COMMUNITIES] Delete error:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to delete community' });
  }
});

// ─────────────────────────────────────────────
// POST /api/communities/:id/join
// Auth required — join a community
// ─────────────────────────────────────────────
router.post('/:id/join', ensureAuthenticated, async (req, res) => {
  try {
    const { userId, username, email } = extractUserInfo(req.user);

    let community;
    try {
      community = (await cloudant.getDocument({ db: DB, docId: req.params.id })).result;
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
        const existing = await cloudant.postView({
          db: REQUESTS_DB,
          ddoc: 'community_requests',
          view: 'by_requester',
          startkey: [userId],
          endkey: [userId, {}],
          includeDocs: true,
        });

        const pendingReq = (existing.result.rows || []).find(r => 
          r.doc && r.doc.community_id === community._id && r.doc.status === 'pending'
        );

        if (pendingReq) {
          return res.status(202).json({ success: true, pending: true, request: pendingReq.doc });
        }
      } catch (e) {
        console.warn('[COMMUNITIES] Request lookup failed:', e.message);
      }

      const { username } = extractUserInfo(req.user);
      const requestDoc = {
        _id: uuidv4(),
        community_id: community._id,
        community_name: community.name,
        requester_id: userId,
        requester_name: username,
        status: 'pending',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      await cloudant.postDocument({ db: REQUESTS_DB, document: requestDoc });

      const { senderName, senderAvatar } = await resolveSenderInfo(
        cloudant,
        userId,
        username,
        req.user?.picture || null
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
      if (io) io.emit('community_request_created', { community_id: community._id, request: requestDoc });

      return res.status(202).json({ success: true, pending: true, request: requestDoc });
    }

    if (!Array.isArray(community.members)) community.members = [];
    community.members.push(userId);
    community.member_count = community.members.length;
    community.updated_at = new Date().toISOString();

    const response = await cloudant.putDocument({ db: DB, docId: community._id, document: community });
    if (!response.result.ok) {
      return res.status(500).json({ success: false, error: 'Failed to join community' });
    }

    await createMembership(userId, username, email, community);
    
    // Invalidate caches
    communityCache.delete(`comm:${community._id}`);
    membershipCache.delete(`mem:${userId}:${community._id}`);

    const io = req.app.get('io');
    if (io) io.emit('community_updated', sanitizeCommunity(community));

    return res.json({ success: true, community: sanitizeCommunity(community) });
  } catch (err) {
    console.error('[COMMUNITIES] Join error:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to join community' });
  }
});

// ─────────────────────────────────────────────
// POST /api/communities/:id/leave
// Auth required — leave a community
// ─────────────────────────────────────────────
router.post('/:id/leave', ensureAuthenticated, async (req, res) => {
  try {
    const { userId } = extractUserInfo(req.user);

    let community;
    try {
      community = (await cloudant.getDocument({ db: DB, docId: req.params.id })).result;
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

    const response = await cloudant.putDocument({ db: DB, docId: community._id, document: community });
    if (!response.result.ok) {
      return res.status(500).json({ success: false, error: 'Failed to leave community' });
    }

    await removeMembership(userId, community._id);

    // Invalidate caches
    communityCache.delete(`comm:${community._id}`);
    membershipCache.delete(`mem:${userId}:${community._id}`);

    const io = req.app.get('io');
    if (io) io.emit('community_updated', sanitizeCommunity(community));

    return res.json({ success: true, community: sanitizeCommunity(community) });
  } catch (err) {
    console.error('[COMMUNITIES] Leave error:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to leave community' });
  }
});

// ─────────────────────────────────────────────
// POST /api/communities/:id/request
// Auth required — create a join request (restricted communities)
// ─────────────────────────────────────────────
router.post('/:id/request', ensureAuthenticated, async (req, res) => {
  try {
    const { userId, username } = extractUserInfo(req.user);
    const community = (await cloudant.getDocument({ db: DB, docId: req.params.id })).result;

    if (community.visibility !== 'restricted') {
      return res.status(400).json({ success: false, error: 'Community does not require requests' });
    }

    if (await isCommunityMember(userId, community)) {
      return res.json({ success: true, community: sanitizeCommunity(community) });
    }

    const existing = await cloudant.postView({
      db: REQUESTS_DB,
      ddoc: 'community_requests',
      view: 'by_requester',
      startkey: [userId],
      endkey: [userId, {}],
      includeDocs: true,
    });

    const pendingReq = (existing.result.rows || []).find(r => 
      r.doc && r.doc.community_id === community._id && r.doc.status === 'pending'
    );

    if (pendingReq) {
      return res.status(202).json({ success: true, pending: true, request: pendingReq.doc });
    }

    const requestDoc = {
      _id: uuidv4(),
      community_id: community._id,
      community_name: community.name,
      requester_id: userId,
      requester_name: username,
      status: 'pending',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    await cloudant.postDocument({ db: REQUESTS_DB, document: requestDoc });

    const { senderName, senderAvatar } = await resolveSenderInfo(
      cloudant,
      userId,
      username,
      req.user?.picture || null
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
    if (io) io.emit('community_request_created', { community_id: community._id, request: requestDoc });

    return res.status(202).json({ success: true, pending: true, request: requestDoc });
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ success: false, error: 'Community not found' });
    console.error('[COMMUNITIES] Request error:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to create request' });
  }
});

// ─────────────────────────────────────────────
// GET /api/communities/:id/requests
// Auth required — list pending requests (owner/co-admin/admin)
// ─────────────────────────────────────────────
router.get('/:id/requests', ensureAuthenticated, async (req, res) => {
  try {
    const { userId } = extractUserInfo(req.user);
    const isAdmin = await getCachedAdminStatus(req.user);
    const community = (await cloudant.getDocument({ db: DB, docId: req.params.id })).result;

    const canManage = await isCommunityModerator(userId, community, isAdmin);
    if (!canManage) {
      return res.status(403).json({ success: false, error: 'Not authorized' });
    }

    const response = await cloudant.postView({
      db: REQUESTS_DB,
      ddoc: 'community_requests',
      view: 'by_community_status',
      key: [community._id, 'pending'],
      includeDocs: true,
    });

    const requests = (response.result.rows || [])
      .map((row) => row.doc)
      .filter((doc) => doc && doc.status === 'pending');

    return res.json({ success: true, requests });
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ success: false, error: 'Community not found' });
    console.error('[COMMUNITIES] Requests fetch error:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to fetch requests' });
  }
});

// ─────────────────────────────────────────────
// POST /api/communities/:id/requests/:requestId/approve
// Auth required — approve join request
// ─────────────────────────────────────────────
router.post('/:id/requests/:requestId/approve', ensureAuthenticated, async (req, res) => {
  try {
    const { userId } = extractUserInfo(req.user);
    const isAdmin = await getCachedAdminStatus(req.user);
    const community = (await cloudant.getDocument({ db: DB, docId: req.params.id })).result;

    const canManage = await isCommunityModerator(userId, community, isAdmin);
    if (!canManage) {
      return res.status(403).json({ success: false, error: 'Not authorized' });
    }

    const requestDoc = (await cloudant.getDocument({ db: REQUESTS_DB, docId: req.params.requestId })).result;

    if (requestDoc.status !== 'pending') {
      return res.status(400).json({ success: false, error: 'Request already processed' });
    }

    requestDoc.status = 'approved';
    requestDoc.updated_at = new Date().toISOString();
    requestDoc.approved_by = userId;
    await cloudant.postDocument({ db: REQUESTS_DB, document: requestDoc });

    if (!Array.isArray(community.members)) community.members = [];
    if (!community.members.includes(requestDoc.requester_id)) {
      community.members.push(requestDoc.requester_id);
    }
    community.member_count = community.members.length;
    community.updated_at = new Date().toISOString();
    await cloudant.postDocument({ db: DB, document: community });

    await createMembership(requestDoc.requester_id, community);

    const { senderName, senderAvatar } = await resolveSenderInfo(
      cloudant,
      userId,
      req.user?.name || 'Moderator',
      req.user?.picture || null
    );

    await createNotification({
      cloudant,
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
    console.error('[COMMUNITIES] Request approve error:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to approve request' });
  }
});

// ─────────────────────────────────────────────
// POST /api/communities/:id/requests/:requestId/reject
// Auth required — reject join request
// ─────────────────────────────────────────────
router.post('/:id/requests/:requestId/reject', ensureAuthenticated, async (req, res) => {
  try {
    const { userId } = extractUserInfo(req.user);
    const isAdmin = await getCachedAdminStatus(req.user);
    const community = (await cloudant.getDocument({ db: DB, docId: req.params.id })).result;

    const canManage = await isCommunityModerator(userId, community, isAdmin);
    if (!canManage) {
      return res.status(403).json({ success: false, error: 'Not authorized' });
    }

    const requestDoc = (await cloudant.getDocument({ db: REQUESTS_DB, docId: req.params.requestId })).result;

    if (requestDoc.status !== 'pending') {
      return res.status(400).json({ success: false, error: 'Request already processed' });
    }

    requestDoc.status = 'rejected';
    requestDoc.updated_at = new Date().toISOString();
    requestDoc.rejected_by = userId;
    await cloudant.postDocument({ db: REQUESTS_DB, document: requestDoc });

    const { senderName, senderAvatar } = await resolveSenderInfo(
      cloudant,
      userId,
      req.user?.name || 'Moderator',
      req.user?.picture || null
    );

    await createNotification({
      cloudant,
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
    console.error('[COMMUNITIES] Request reject error:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to reject request' });
  }
});

module.exports = router;

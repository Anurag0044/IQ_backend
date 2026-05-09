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

const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
const MAX_FILE_BYTES = 50 * 1024 * 1024;

// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
// Multer Ã¢â‚¬â€ chat media + attachments
// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
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

async function syncMessageToFirebase(channelId, messageDoc) {
  if (!firebaseService.db || !channelId || !messageDoc?._id) return;

  const firebaseMessage = {
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
  };

  await firebaseService.db.ref(`messages/${channelId}/${messageDoc._id}`).set(firebaseMessage);
}

// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ Cached community fetch Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
async function getCommunityOr404(communityId, { bustCache = false } = {}) {
  const cacheKey = `comm:${communityId}`;
  if (!bustCache) {
    const cached = communityCache.get(cacheKey);
    if (cached) return cached;
  }

  try {
    const doc = (await cloudant.getDocument({ db: DB_COMMUNITIES, docId: communityId })).result;
    communityCache.set(cacheKey, doc);
    return doc;
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ Cached membership check Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
async function isCommunityMember(userId, community) {
  if (!userId || !community) return false;

  // In-document array (zero reads)
  if (Array.isArray(community.members) && community.members.includes(userId)) return true;

  // Cache check (positive only)
  const cacheKey = `mem:${userId}:${community._id}`;
  const cached = membershipCache.get(cacheKey);
  if (cached === true) return true;

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
    if (isMember) membershipCache.set(cacheKey, true);
    if (isMember) return true;
  } catch (err) {
    console.warn('[DISCUSSIONS] Membership lookup failed:', err.message);
  }

  // Fallback to postFind if view is missing/fails
  try {
    const fallback = await cloudant.postFind({
      db: DB_MEMBERSHIPS,
      selector: { community_id: community._id, user_id: userId, membership_status: 'active' },
      limit: 1,
      fields: ['_id'],
    });
    const found = (fallback.result.docs || []).length > 0;
    if (found) membershipCache.set(cacheKey, true);
    return found;
  } catch (findErr) {
    console.warn('[DISCUSSIONS] postFind membership fallback also failed:', findErr.message);
    return false;
  }
}

// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ Cached admin check Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
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

// All joined members can see all channels.
// Only mod-only channels remain restricted to moderators.
function canAccessChannel({ channel, userId, isAdmin, isMod }) {
  if (!channel) return false;
  if (isAdmin) return true;
  if (channel.visibility === 'mods') return Boolean(isMod);
  // 'members', 'restricted', or anything else â€” any community member can see
  return true;
}

// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
// Channels
// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

// GET /api/discussions/communities/:communityId/channels
router.get('/communities/:communityId/channels', ensureAuthenticated, async (req, res) => {
  try {
    const { userId } = extractUserInfo(req.user);
    const isAdmin = await getCachedAdminStatus(req.user);
    // Bust community cache so stale members[] arrays don't block recently-joined users
    const community = await getCommunityOr404(req.params.communityId, { bustCache: true });
    if (!community) return res.status(404).json({ success: false, error: 'Community not found' });

    const access = await ensureCanAccessCommunity(userId, community, isAdmin);
    if (!access.ok) return res.status(access.status).json({ success: false, error: access.error });

    const isMod = await isCommunityModerator(userId, community, isAdmin);

    // postFind â€” no design document required; works on any Cloudant instance
    const findRes = await cloudant.postFind({
      db: DB_CHANNELS,
      selector: { community_id: community._id },
      limit: 200,
    });

    const allChannels = (findRes.result.docs || []).filter(Boolean);

    const channels = allChannels
      .filter((ch) => canAccessChannel({ channel: ch, userId, isAdmin, isMod }))
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));

    firebaseService.syncChannelBatch(channels).catch(err =>
      console.warn('[DISCUSSIONS] Firebase channel list sync failed:', err.message)
    );

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

    const { userId, email } = extractUserInfo(req.user);
    const isAdmin = await getCachedAdminStatus(req.user);
    const community = await getCommunityOr404(req.params.communityId, { bustCache: true });
    if (!community) return res.status(404).json({ success: false, error: 'Community not found' });

    const access = await ensureCanAccessCommunity(userId, community, isAdmin);
    if (!access.ok) return res.status(access.status).json({ success: false, error: access.error });

    // Only the community owner can create channels
    const isOwnerById = userId && community.owner_id === userId;
    const isOwnerByEmail = email && community.owner_email &&
      String(community.owner_email).toLowerCase() === String(email).toLowerCase();
    if (!isOwnerById && !isOwnerByEmail) {
      return res.status(403).json({ success: false, error: 'Only the community owner can create channels' });
    }

    const normalizedName = String(name).trim().replace(/\s+/g, '-').toLowerCase();

    // Duplicate channel name guard — postFind, no design document required
    try {
      const existing = await cloudant.postFind({
        db: DB_CHANNELS,
        selector: { community_id: community._id, name: normalizedName },
        limit: 1,
        fields: ['_id', 'name'],
      });
      const duplicate = (existing.result.docs || [])[0] || null;
      if (duplicate) {
        return res.status(409).json({ success: false, error: `Channel '${normalizedName}' already exists`, channel: duplicate });
      }
    } catch (dupErr) {
      console.warn('[DISCUSSIONS] Duplicate check failed (proceeding):', dupErr.message);
    }

    const vis = visibility || 'members';
    const channelDoc = {
      _id: uuidv4(),
      community_id: community._id,
      name: normalizedName,
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

    // Sync channel metadata to Firebase (non-blocking)
    firebaseService.syncChannel(channelDoc).catch(err => console.error('[DISCUSSIONS] Firebase sync failed:', err));

    const io = req.app.get('io');
    if (io) io.to(`community:${community._id}`).emit('channel_created', channelDoc);

    return res.status(201).json({ success: true, channel: channelDoc });
  } catch (err) {
    console.error('[DISCUSSIONS] Create channel error:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to create channel' });
  }
});

// DELETE /api/discussions/communities/:communityId/channels/:channelId
// Mods and community creator only
router.delete('/communities/:communityId/channels/:channelId', ensureAuthenticated, async (req, res) => {
  try {
    const { userId } = extractUserInfo(req.user);
    const isAdmin = await getCachedAdminStatus(req.user);
    const community = await getCommunityOr404(req.params.communityId, { bustCache: true });
    if (!community) return res.status(404).json({ success: false, error: 'Community not found' });

    const isMod = await isCommunityModerator(userId, community, isAdmin);
    if (!isMod) {
      return res.status(403).json({ success: false, error: 'Only community moderators can delete channels' });
    }

    const channel = await getChannelOr404(req.params.channelId);
    if (!channel) return res.status(404).json({ success: false, error: 'Channel not found' });
    if (channel.community_id !== community._id) {
      return res.status(403).json({ success: false, error: 'Channel does not belong to this community' });
    }

    // Delete all messages in this channel from Cloudant
    try {
      const msgs = await cloudant.postView({
        db: DB_MESSAGES,
        ddoc: 'messages',
        view: 'by_channel_created_at',
        startKey: [channel._id],
        endKey: [channel._id, {}],
        includeDocs: true,
        limit: 1000,
      });
      for (const row of (msgs.result.rows || [])) {
        if (row.doc) {
          await cloudant.deleteDocument({ db: DB_MESSAGES, docId: row.doc._id, rev: row.doc._rev }).catch(() => {});
        }
      }
    } catch (msgErr) {
      console.warn('[DISCUSSIONS] Failed to delete channel messages:', msgErr.message);
    }

    // Delete from Cloudant
    await cloudant.deleteDocument({ db: DB_CHANNELS, docId: channel._id, rev: channel._rev });

    // Cleanup Firebase data for this channel
    firebaseService.deleteChannel(channel._id).catch(err =>
      console.warn('[DISCUSSIONS] Firebase channel cleanup failed:', err.message)
    );

    const io = req.app.get('io');
    if (io) io.to(`community:${community._id}`).emit('channel_deleted', { channel_id: channel._id, community_id: community._id });

    return res.json({ success: true, message: 'Channel deleted' });
  } catch (err) {
    console.error('[DISCUSSIONS] Delete channel error:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to delete channel' });
  }
});

// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
// Messages
// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

// GET /api/discussions/channels/:channelId/messages?limit=50&before=ISO
router.get('/channels/:channelId/messages', ensureAuthenticated, async (req, res) => {
  try {
    const { userId } = extractUserInfo(req.user);
    const isAdmin = await getCachedAdminStatus(req.user);
    const channel = await getChannelOr404(req.params.channelId);
    if (!channel) return res.status(404).json({ success: false, error: 'Channel not found' });

    const community = await getCommunityOr404(channel.community_id, { bustCache: true });
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
      endKey: [channel._id],
      descending: true,
      includeDocs: true,
      limit,
    });

    const messages = (viewRes.result.rows || [])
      .map((row) => row.doc)
      .filter((doc) => doc && !doc._id.startsWith('_design'))
      .reverse(); // return in ascending order (oldest first) for display

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

    const { userId } = extractUserInfo(req.user);
    const isAdmin = await getCachedAdminStatus(req.user);
    const channel = await getChannelOr404(req.params.channelId);
    if (!channel) return res.status(404).json({ success: false, error: 'Channel not found' });

    const community = await getCommunityOr404(channel.community_id, { bustCache: true });
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

    syncMessageToFirebase(channel._id, messageDoc).catch(err =>
      console.warn('[DISCUSSIONS] Firebase sync failed for message:', err.message)
    );

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

      // Ã¢â€â‚¬Ã¢â€â‚¬ Sync message to Firebase (Firebase is source of truth for rendering) Ã¢â€â‚¬Ã¢â€â‚¬
      try {
        if (firebaseService.db) {
          await syncMessageToFirebase(channel._id, messageDoc);
          console.log(`[DISCUSSIONS] Synced media message to Firebase: ${messageDoc._id}`);
        }
      } catch (firebaseErr) {
        console.warn('[DISCUSSIONS] Firebase sync failed for message:', firebaseErr.message);
      }

      // NOTE: Do NOT emit via Socket.IO here Ã¢â‚¬â€ Firebase onValue is the single
      // rendering source of truth. Emitting both causes double-append on client.

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

    const doRemove = action === 'remove';
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

    return res.json({ success: true, persisted: false });
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ success: false, error: 'Message not found' });
    console.error('[DISCUSSIONS] Reactions error:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to update reaction' });
  }
});

// POST /api/discussions/channels/:channelId/read Ã¢â‚¬â€ marks channel as read (reset unread)
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

    const io = req.app.get('io');
    if (io) io.to(`channel:${channel._id}`).emit('unread_count_updates', { channel_id: channel._id, user_id: userId, unread_count: 0 });

    return res.json({ success: true });
  } catch (err) {
    console.error('[DISCUSSIONS] Mark read error:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to mark as read' });
  }
});

// GET /api/discussions/communities/:communityId/unreads Ã¢â‚¬â€ get unread counts
router.get('/communities/:communityId/unreads', ensureAuthenticated, async (req, res) => {
  try {
    return res.json({ success: true, unreads: [] });
  } catch (err) {
    console.error('[DISCUSSIONS] Fetch unreads error:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to fetch unread counts' });
  }
});

module.exports = router;


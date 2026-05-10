const express = require('express');
const { v4: uuidv4 } = require('uuid');
const cloudant = require('../services/cloudantClient');
const { ensureAuthenticated, extractUserInfo } = require('../middleware/auth');
const { TTLCache } = require('../services/cacheService');
const logger = require('../utils/logger');

const router = express.Router();
const DB = 'friendships';
const friendsCache = new TTLCache(10_000, 200);

function clearFriendCaches(...userIds) {
  for (const userId of userIds.filter(Boolean)) {
    friendsCache.invalidatePrefix(`friends:${userId}:`);
    friendsCache.invalidatePrefix(`discover:${userId}:`);
  }
}

function isCloudantRateLimit(err) {
  const status = err?.status || err?.statusCode;
  const message = String(err?.message || '').toLowerCase();
  return status === 429 || message.includes('too_many_requests') || message.includes('rate limit');
}

// ─────────────────────────────────────────────
// GET /api/friends/discover
// Returns all onboarded users (excluding self)
// with friendship status attached
// ─────────────────────────────────────────────
router.get('/discover', ensureAuthenticated, async (req, res) => {
  try {
    const { userId } = extractUserInfo(req.user);
    const limit = Math.max(1, Math.min(100, Number(req.query.limit || 50)));
    const cacheKey = `discover:${userId}:${limit}`;
    const cached = friendsCache.get(cacheKey);
    if (cached) {
      logger.debug('[API] duplicate request prevented /api/friends/discover');
      return res.json(cached);
    }

    let usersRows = [];
    try {
      const usersRes = await cloudant.postView({
        db: 'users',
        ddoc: 'users',
        view: 'by_onboarded',
        startKey: [true],
        endKey: [true, {}],
        includeDocs: true,
        limit,
      });
      usersRows = usersRes.result.rows || [];
    } catch (viewErr) {
      console.warn('[FRIENDS] Indexed user discovery failed, using bounded fallback:', viewErr.message);
      const usersRes = await cloudant.postAllDocs({ db: 'users', includeDocs: true, limit });
      usersRows = usersRes.result.rows || [];
    }

    const allUsers = usersRows
      .map(r => r.doc)
      .filter(doc => doc && !doc._id.startsWith('_design') && doc._id !== userId && doc.is_onboarded)
      .slice(0, limit);

    // Fetch all friendships involving current user
    const fsRes = await cloudant.postFind({
      db: DB,
      selector: {
        $or: [{ sender_id: userId }, { receiver_id: userId }]
      },
      limit: 500
    });
    const friendships = fsRes.result.docs;

    // Enrich each user with friendship status
    const users = allUsers.map(u => {
      const fs = friendships.find(
        f => f.sender_id === u._id || f.receiver_id === u._id
      );
      let friendship_status = 'none';       // not connected
      let friendship_id     = null;
      let i_sent            = false;

      if (fs) {
        friendship_status = fs.status;     // 'pending' | 'accepted'
        friendship_id     = fs._id;
        i_sent            = fs.sender_id === userId;
      }

      return {
        user_id:              u._id,
        username:             u.username || u.email?.split('@')[0] || 'CloudIQ User',
        email:                u.email,
        profile_image_url:    u.profile_image_url || null,
        purpose:              u.purpose || '',
        friendship_status,
        friendship_id,
        i_sent,               // true = I sent the request, false = they sent it
      };
    });

    const payload = { success: true, users };
    friendsCache.set(cacheKey, payload);
    return res.json(payload);
  } catch (err) {
    console.error('[FRIENDS] Discover error:', err.message);
    if (isCloudantRateLimit(err)) {
      return res.status(429).json({ success: false, error: 'Cloudant rate limit reached. Please retry shortly.' });
    }
    return res.status(500).json({ success: false, error: 'Failed to fetch users' });
  }
});

// ─────────────────────────────────────────────
// POST /api/friends/request
// Send a connection request
// ─────────────────────────────────────────────
router.post('/request', ensureAuthenticated, async (req, res) => {
  try {
    const { receiver_id } = req.body;
    const { userId: sender_id, username } = extractUserInfo(req.user);

    if (!receiver_id) return res.status(400).json({ success: false, error: 'receiver_id is required' });
    if (sender_id === receiver_id) return res.status(400).json({ success: false, error: 'Cannot send request to yourself' });

    // Check for existing request in either direction
    const checkQuery = await cloudant.postFind({
      db: DB,
      selector: {
        $or: [
          { sender_id, receiver_id },
          { sender_id: receiver_id, receiver_id: sender_id }
        ]
      }
    });

    if (checkQuery.result.docs.length > 0) {
      const existing = checkQuery.result.docs[0];
      return res.status(400).json({
        success: false,
        error: existing.status === 'pending' ? 'Request already pending' : 'Already connected'
      });
    }

    // Get sender profile for real username
    let senderName = username;
    try {
      const profile = (await cloudant.getDocument({ db: 'users', docId: sender_id })).result;
      if (profile.username) senderName = profile.username;
    } catch (e) { /* use App ID name */ }

    const friendship = {
      _id: uuidv4(),
      sender_id,
      sender_name: senderName,
      receiver_id,
      status: 'pending',
      created_at: new Date().toISOString()
    };

    const response = await cloudant.postDocument({ db: DB, document: friendship });

    if (response.result.ok) {
      clearFriendCaches(sender_id, receiver_id);
      // Real-time notification
      const io = req.app.get('io');
      const userSockets = req.app.get('userSockets');
      if (io && userSockets) {
        const targetSocketId = userSockets.get(receiver_id);
        if (targetSocketId) {
          io.to(targetSocketId).emit('friend_request', {
            type: 'friend_request',
            message: `${senderName} wants to connect with you`,
            sender_id,
            sender_name: senderName,
            friendship_id: friendship._id,
            created_at: friendship.created_at
          });
        }
      }
      return res.json({ success: true, friendship });
    } else {
      return res.status(500).json({ success: false, error: 'Failed to send request' });
    }
  } catch (err) {
    console.error('[FRIENDS] Request error:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to process request' });
  }
});

// ─────────────────────────────────────────────
// POST /api/friends/accept
// Accept a connection request
// ─────────────────────────────────────────────
router.post('/accept', ensureAuthenticated, async (req, res) => {
  try {
    const { request_id } = req.body;
    const { userId } = extractUserInfo(req.user);

    if (!request_id) return res.status(400).json({ success: false, error: 'request_id is required' });

    let friendship;
    try {
      friendship = (await cloudant.getDocument({ db: DB, docId: request_id })).result;
    } catch (err) {
      if (err.status === 404) return res.status(404).json({ success: false, error: 'Request not found' });
      throw err;
    }

    if (friendship.receiver_id !== userId) return res.status(403).json({ success: false, error: 'Not authorized' });
    if (friendship.status === 'accepted') return res.status(400).json({ success: false, error: 'Already accepted' });

    // Get acceptor's profile name
    let acceptorName = userId;
    try {
      const profile = (await cloudant.getDocument({ db: 'users', docId: userId })).result;
      if (profile.username) acceptorName = profile.username;
    } catch (e) { /* use id */ }

    friendship.status = 'accepted';
    friendship.updated_at = new Date().toISOString();

    const updateResponse = await cloudant.postDocument({ db: DB, document: friendship });

    if (updateResponse.result.ok) {
      clearFriendCaches(friendship.sender_id, friendship.receiver_id);
      const io = req.app.get('io');
      const userSockets = req.app.get('userSockets');
      if (io && userSockets) {
        const targetSocketId = userSockets.get(friendship.sender_id);
        if (targetSocketId) {
          io.to(targetSocketId).emit('friend_accept', {
            type: 'friend_accept',
            message: `${acceptorName} accepted your connection request`,
            receiver_id: userId,
            acceptor_name: acceptorName,
            created_at: friendship.updated_at
          });
        }
      }
      return res.json({ success: true, friendship });
    } else {
      return res.status(500).json({ success: false, error: 'Failed to accept' });
    }
  } catch (err) {
    console.error('[FRIENDS] Accept error:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to accept' });
  }
});

// ─────────────────────────────────────────────
// POST /api/friends/reject
// Reject or withdraw a connection request
// ─────────────────────────────────────────────
router.post('/reject', ensureAuthenticated, async (req, res) => {
  try {
    const { request_id } = req.body;
    const { userId } = extractUserInfo(req.user);

    if (!request_id) return res.status(400).json({ success: false, error: 'request_id is required' });

    let friendship;
    try {
      friendship = (await cloudant.getDocument({ db: DB, docId: request_id })).result;
    } catch (err) {
      if (err.status === 404) return res.status(404).json({ success: false, error: 'Request not found' });
      throw err;
    }

    // Only sender (withdraw) or receiver (reject) can act
    if (friendship.sender_id !== userId && friendship.receiver_id !== userId) {
      return res.status(403).json({ success: false, error: 'Not authorized' });
    }

    await cloudant.deleteDocument({ db: DB, docId: friendship._id, rev: friendship._rev });
    clearFriendCaches(friendship.sender_id, friendship.receiver_id);
    return res.json({ success: true, message: 'Request rejected/withdrawn' });
  } catch (err) {
    console.error('[FRIENDS] Reject error:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to reject request' });
  }
});

// ─────────────────────────────────────────────
// DELETE /api/friends/:id
// Remove an accepted connection
// ─────────────────────────────────────────────
router.delete('/:id', ensureAuthenticated, async (req, res) => {
  try {
    const { id } = req.params;
    const { userId } = extractUserInfo(req.user);

    let friendship;
    try {
      friendship = (await cloudant.getDocument({ db: DB, docId: id })).result;
    } catch (err) {
      if (err.status === 404) return res.status(404).json({ success: false, error: 'Connection not found' });
      throw err;
    }

    if (friendship.sender_id !== userId && friendship.receiver_id !== userId) {
      return res.status(403).json({ success: false, error: 'Not authorized' });
    }

    await cloudant.deleteDocument({ db: DB, docId: friendship._id, rev: friendship._rev });
    clearFriendCaches(friendship.sender_id, friendship.receiver_id);
    return res.json({ success: true, message: 'Connection removed' });
  } catch (err) {
    console.error('[FRIENDS] Remove error:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to remove connection' });
  }
});

// ─────────────────────────────────────────────
// GET /api/friends
// Get friend list (accepted + pending)
// ─────────────────────────────────────────────
router.get('/', ensureAuthenticated, async (req, res) => {
  try {
    const { userId } = extractUserInfo(req.user);
    const cacheKey = `friends:${userId}:list`;
    const cached = friendsCache.get(cacheKey);
    if (cached) {
      logger.debug('[API] duplicate request prevented /api/friends');
      return res.json(cached);
    }

    const response = await cloudant.postFind({
      db: DB,
      selector: { $or: [{ sender_id: userId }, { receiver_id: userId }] },
      limit: 500
    });

    const list = response.result.docs;
    const accepted         = list.filter(f => f.status === 'accepted');
    const pendingSent     = list.filter(f => f.status === 'pending' && f.sender_id === userId);
    const pendingReceived = list.filter(f => f.status === 'pending' && f.receiver_id === userId);

    const payload = { success: true, friends: accepted, pendingSent, pendingReceived, all: list };
    friendsCache.set(cacheKey, payload);
    return res.json(payload);
  } catch (err) {
    console.error('[FRIENDS] Get list error:', err.message);
    if (isCloudantRateLimit(err)) {
      return res.status(429).json({ success: false, error: 'Cloudant rate limit reached. Please retry shortly.' });
    }
    return res.status(500).json({ success: false, error: 'Failed to fetch friends' });
  }
});

module.exports = router;

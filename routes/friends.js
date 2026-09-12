const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../services/firestoreClient');
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

// ─────────────────────────────────────────────
// GET /api/friends/discover
// ─────────────────────────────────────────────
router.get('/discover', ensureAuthenticated, async (req, res) => {
  try {
    const { userId } = extractUserInfo(req);
    const limit = Math.max(1, Math.min(100, Number(req.query.limit || 50)));
    const cacheKey = `discover:${userId}:${limit}`;
    const cached = friendsCache.get(cacheKey);
    if (cached) {
      logger.debug('[API] duplicate request prevented /api/friends/discover');
      return res.json(cached);
    }

    let allUsers = [];
    try {
      allUsers = await db.queryDocs('users', [['is_onboarded', '==', true]], null, 'asc', limit + 10);
      allUsers = allUsers.filter(doc => doc._id !== userId).slice(0, limit);
    } catch (viewErr) {
      console.warn('[FRIENDS] Indexed user discovery failed:', viewErr.message);
    }

    const fsSent = await db.queryDocs(DB, [['sender_id', '==', userId]], null, 'asc', 500);
    const fsReceived = await db.queryDocs(DB, [['receiver_id', '==', userId]], null, 'asc', 500);
    const friendships = [...fsSent, ...fsReceived];

    const users = allUsers.map(u => {
      const fs = friendships.find(
        f => f.sender_id === u._id || f.receiver_id === u._id
      );
      let friendship_status = 'none';
      let friendship_id     = null;
      let i_sent            = false;

      if (fs) {
        friendship_status = fs.status;
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
        i_sent,
      };
    });

    const payload = { success: true, users };
    friendsCache.set(cacheKey, payload);
    return res.json(payload);
  } catch (err) {
    console.error('[FRIENDS] Discover error:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to fetch users' });
  }
});

// ─────────────────────────────────────────────
// POST /api/friends/request
// ─────────────────────────────────────────────
router.post('/request', ensureAuthenticated, async (req, res) => {
  try {
    const { receiver_id } = req.body;
    const { userId: sender_id, username } = extractUserInfo(req);

    if (!receiver_id) return res.status(400).json({ success: false, error: 'receiver_id is required' });
    if (sender_id === receiver_id) return res.status(400).json({ success: false, error: 'Cannot send request to yourself' });

    const checkSent = await db.queryDocs(DB, [['sender_id', '==', sender_id], ['receiver_id', '==', receiver_id]]);
    const checkReceived = await db.queryDocs(DB, [['sender_id', '==', receiver_id], ['receiver_id', '==', sender_id]]);

    if (checkSent.length > 0 || checkReceived.length > 0) {
      const existing = checkSent.length > 0 ? checkSent[0] : checkReceived[0];
      return res.status(400).json({
        success: false,
        error: existing.status === 'pending' ? 'Request already pending' : 'Already connected'
      });
    }

    let senderName = username;
    try {
      const profile = await db.getDoc('users', sender_id);
      if (profile.username) senderName = profile.username;
    } catch (e) { }

    const friendship = {
      sender_id,
      sender_name: senderName,
      receiver_id,
      status: 'pending',
      created_at: new Date().toISOString()
    };

    const saved = await db.addDoc(DB, friendship);

    clearFriendCaches(sender_id, receiver_id);

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
          friendship_id: saved._id,
          created_at: saved.created_at
        });
      }
    }
    return res.json({ success: true, friendship: saved });
  } catch (err) {
    console.error('[FRIENDS] Request error:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to process request' });
  }
});

// ─────────────────────────────────────────────
// POST /api/friends/accept
// ─────────────────────────────────────────────
router.post('/accept', ensureAuthenticated, async (req, res) => {
  try {
    const { request_id } = req.body;
    const { userId } = extractUserInfo(req);

    if (!request_id) return res.status(400).json({ success: false, error: 'request_id is required' });

    let friendship;
    try {
      friendship = await db.getDoc(DB, request_id);
    } catch (err) {
      if (err.status === 404) return res.status(404).json({ success: false, error: 'Request not found' });
      throw err;
    }

    if (friendship.receiver_id !== userId) return res.status(403).json({ success: false, error: 'Not authorized' });
    if (friendship.status === 'accepted') return res.status(400).json({ success: false, error: 'Already accepted' });

    let acceptorName = userId;
    try {
      const profile = await db.getDoc('users', userId);
      if (profile.username) acceptorName = profile.username;
    } catch (e) { }

    friendship.status = 'accepted';
    friendship.updated_at = new Date().toISOString();

    await db.setDoc(DB, request_id, friendship, { merge: true });

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
  } catch (err) {
    console.error('[FRIENDS] Accept error:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to accept' });
  }
});

// ─────────────────────────────────────────────
// POST /api/friends/reject
// ─────────────────────────────────────────────
router.post('/reject', ensureAuthenticated, async (req, res) => {
  try {
    const { request_id } = req.body;
    const { userId } = extractUserInfo(req);

    if (!request_id) return res.status(400).json({ success: false, error: 'request_id is required' });

    let friendship;
    try {
      friendship = await db.getDoc(DB, request_id);
    } catch (err) {
      if (err.status === 404) return res.status(404).json({ success: false, error: 'Request not found' });
      throw err;
    }

    if (friendship.sender_id !== userId && friendship.receiver_id !== userId) {
      return res.status(403).json({ success: false, error: 'Not authorized' });
    }

    await db.deleteDoc(DB, friendship._id);
    clearFriendCaches(friendship.sender_id, friendship.receiver_id);
    return res.json({ success: true, message: 'Request rejected/withdrawn' });
  } catch (err) {
    console.error('[FRIENDS] Reject error:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to reject request' });
  }
});

// ─────────────────────────────────────────────
// DELETE /api/friends/:id
// ─────────────────────────────────────────────
router.delete('/:id', ensureAuthenticated, async (req, res) => {
  try {
    const { id } = req.params;
    const { userId } = extractUserInfo(req);

    let friendship;
    try {
      friendship = await db.getDoc(DB, id);
    } catch (err) {
      if (err.status === 404) return res.status(404).json({ success: false, error: 'Connection not found' });
      throw err;
    }

    if (friendship.sender_id !== userId && friendship.receiver_id !== userId) {
      return res.status(403).json({ success: false, error: 'Not authorized' });
    }

    await db.deleteDoc(DB, friendship._id);
    clearFriendCaches(friendship.sender_id, friendship.receiver_id);
    return res.json({ success: true, message: 'Connection removed' });
  } catch (err) {
    console.error('[FRIENDS] Remove error:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to remove connection' });
  }
});

// ─────────────────────────────────────────────
// GET /api/friends
// ─────────────────────────────────────────────
router.get('/', ensureAuthenticated, async (req, res) => {
  try {
    const { userId } = extractUserInfo(req);
    const cacheKey = `friends:${userId}:list`;
    const cached = friendsCache.get(cacheKey);
    if (cached) {
      logger.debug('[API] duplicate request prevented /api/friends');
      return res.json(cached);
    }

    const fsSent = await db.queryDocs(DB, [['sender_id', '==', userId]], null, 'asc', 500);
    const fsReceived = await db.queryDocs(DB, [['receiver_id', '==', userId]], null, 'asc', 500);
    const list = [...fsSent, ...fsReceived];

    const accepted         = list.filter(f => f.status === 'accepted');
    const pendingSent     = list.filter(f => f.status === 'pending' && f.sender_id === userId);
    const pendingReceived = list.filter(f => f.status === 'pending' && f.receiver_id === userId);

    const payload = { success: true, friends: accepted, pendingSent, pendingReceived, all: list };
    friendsCache.set(cacheKey, payload);
    return res.json(payload);
  } catch (err) {
    console.error('[FRIENDS] Get list error:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to fetch friends' });
  }
});

module.exports = router;

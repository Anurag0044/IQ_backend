const express = require('express');
const { v4: uuidv4 } = require('uuid');
const cloudant = require('../services/cloudantClient');
const { ensureAuthenticated, extractUserInfo } = require('../middleware/auth');

const router = express.Router();
const DB = 'friendships';

// ─────────────────────────────────────────────
// POST /api/friends/request
// Send a friend request
// ─────────────────────────────────────────────
router.post('/request', ensureAuthenticated, async (req, res) => {
  try {
    const { receiver_id } = req.body;
    const { userId: sender_id } = extractUserInfo(req.user);

    if (!receiver_id) {
      return res.status(400).json({ success: false, error: 'receiver_id is required' });
    }

    // Prevent self request
    if (sender_id === receiver_id) {
      return res.status(400).json({ success: false, error: 'Cannot send friend request to yourself' });
    }

    // Check for existing request (pending or accepted) in both directions
    const checkQuery = await cloudant.postFind({
      db: DB,
      selector: {
        $or: [
          { sender_id: sender_id, receiver_id: receiver_id },
          { sender_id: receiver_id, receiver_id: sender_id }
        ]
      }
    });

    if (checkQuery.result.docs.length > 0) {
      const existing = checkQuery.result.docs[0];
      if (existing.status === 'pending') {
        return res.status(400).json({ success: false, error: 'Friend request already pending' });
      } else {
        return res.status(400).json({ success: false, error: 'Already friends' });
      }
    }

    const friendship = {
      _id: uuidv4(),
      sender_id,
      receiver_id,
      status: 'pending',
      created_at: new Date().toISOString()
    };

    const response = await cloudant.postDocument({
      db: DB,
      document: friendship
    });

    if (response.result.ok) {
      // Optional: emit real-time notification
      const io = req.app.get('io');
      const userSockets = req.app.get('userSockets');
      if (io && userSockets) {
        const targetSocketId = userSockets.get(receiver_id);
        if (targetSocketId) {
          io.to(targetSocketId).emit('new_notification', {
            type: 'friend_request',
            message: 'You have a new friend request',
            sender_id,
            created_at: friendship.created_at
          });
        }
      }

      res.json({ success: true, message: 'Friend request sent', friendship });
    } else {
      res.status(500).json({ success: false, error: 'Failed to send request' });
    }
  } catch (err) {
    console.error('[FRIENDS] Request error:', err.message);
    res.status(500).json({ success: false, error: 'Failed to process request' });
  }
});

// ─────────────────────────────────────────────
// POST /api/friends/accept
// Accept a friend request
// ─────────────────────────────────────────────
router.post('/accept', ensureAuthenticated, async (req, res) => {
  try {
    const { request_id } = req.body;
    const { userId } = extractUserInfo(req.user);

    if (!request_id) {
      return res.status(400).json({ success: false, error: 'request_id is required' });
    }

    // Fetch the request
    let friendship;
    try {
      const docResponse = await cloudant.getDocument({ db: DB, docId: request_id });
      friendship = docResponse.result;
    } catch (err) {
      if (err.status === 404) {
        return res.status(404).json({ success: false, error: 'Friend request not found' });
      }
      throw err;
    }

    // Ensure only the receiver can accept it
    if (friendship.receiver_id !== userId) {
      return res.status(403).json({ success: false, error: 'Not authorized to accept this request' });
    }

    if (friendship.status === 'accepted') {
      return res.status(400).json({ success: false, error: 'Request already accepted' });
    }

    friendship.status = 'accepted';
    friendship.updated_at = new Date().toISOString();

    const updateResponse = await cloudant.postDocument({
      db: DB,
      document: friendship
    });

    if (updateResponse.result.ok) {
      // Optional: emit real-time notification
      const io = req.app.get('io');
      const userSockets = req.app.get('userSockets');
      if (io && userSockets) {
        const targetSocketId = userSockets.get(friendship.sender_id);
        if (targetSocketId) {
          io.to(targetSocketId).emit('new_notification', {
            type: 'friend_accept',
            message: 'Your friend request was accepted',
            receiver_id: userId,
            created_at: friendship.updated_at
          });
        }
      }

      res.json({ success: true, message: 'Friend request accepted', friendship });
    } else {
      res.status(500).json({ success: false, error: 'Failed to accept request' });
    }
  } catch (err) {
    console.error('[FRIENDS] Accept error:', err.message);
    res.status(500).json({ success: false, error: 'Failed to accept request' });
  }
});

// ─────────────────────────────────────────────
// GET /api/friends
// Get friend list (both accepted and pending)
// ─────────────────────────────────────────────
router.get('/', ensureAuthenticated, async (req, res) => {
  try {
    const { userId } = extractUserInfo(req.user);

    // Find all where sender_id = userId OR receiver_id = userId
    const response = await cloudant.postFind({
      db: DB,
      selector: {
        $or: [
          { sender_id: userId },
          { receiver_id: userId }
        ]
      }
    });

    const list = response.result.docs;
    
    // Split into categories for convenience
    const accepted = list.filter(f => f.status === 'accepted');
    const pendingSent = list.filter(f => f.status === 'pending' && f.sender_id === userId);
    const pendingReceived = list.filter(f => f.status === 'pending' && f.receiver_id === userId);

    res.json({
      success: true,
      friends: accepted,
      pendingSent,
      pendingReceived,
      all: list
    });
  } catch (err) {
    console.error('[FRIENDS] Get list error:', err.message);
    res.status(500).json({ success: false, error: 'Failed to fetch friends' });
  }
});

module.exports = router;

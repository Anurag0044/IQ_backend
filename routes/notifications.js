// ============================================
// CloudIQ Backend - Notifications Routes
// ============================================
// GET /api/notifications → fetch notifications for logged-in user

const express = require('express');
const cloudant = require('../services/cloudantClient');
const { ensureAuthenticated, extractUserInfo } = require('../middleware/auth');

const router = express.Router();
const DB = 'notifications';

// ─────────────────────────────────────────────
// GET /api/notifications
// Auth required — returns notifications for current user
// ─────────────────────────────────────────────
router.get('/', ensureAuthenticated, async (req, res) => {
  try {
    const { userId } = extractUserInfo(req.user);

    const response = await cloudant.postAllDocs({
      db: DB,
      includeDocs: true,
    });

    const notifications = response.result.rows
      .map((r) => r.doc)
      .filter((doc) => doc && !doc._id.startsWith('_design') && doc.user_id === userId)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    res.json({ success: true, notifications });
  } catch (err) {
    console.error('[NOTIFICATIONS] Fetch error:', err.message);
    res.status(500).json({ success: false, error: 'Failed to fetch notifications' });
  }
});

// ─────────────────────────────────────────────
// PATCH /api/notifications/:id/read
// Auth required — marks a notification as read
// ─────────────────────────────────────────────
router.patch('/:id/read', ensureAuthenticated, async (req, res) => {
  try {
    const { userId } = extractUserInfo(req.user);
    const notificationId = req.params.id;

    let notification;
    try {
      notification = (await cloudant.getDocument({ db: DB, docId: notificationId })).result;
    } catch (err) {
      if (err.status === 404) {
        return res.status(404).json({ success: false, error: 'Notification not found' });
      }
      throw err;
    }

    if (notification.user_id !== userId) {
      return res.status(403).json({ success: false, error: 'Not authorized' });
    }

    if (notification.read) {
      return res.json({ success: true, notification });
    }

    const updated = {
      ...notification,
      read: true,
      read_at: new Date().toISOString(),
    };

    const updateResponse = await cloudant.postDocument({
      db: DB,
      document: updated,
    });

    if (updateResponse.result.ok) {
      return res.json({ success: true, notification: updated });
    }

    return res.status(500).json({ success: false, error: 'Failed to update notification' });
  } catch (err) {
    console.error('[NOTIFICATIONS] Read update error:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to mark notification as read' });
  }
});

module.exports = router;

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

module.exports = router;

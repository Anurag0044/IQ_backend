// ============================================
// CloudIQ Backend - Notifications Routes
// ============================================
// GET /api/notifications → fetch notifications for logged-in user

const express = require('express');
const cloudant = require('../services/cloudantClient');
const { ensureAuthenticated, extractUserInfo } = require('../middleware/auth');
const { TTLCache } = require('../services/cacheService');
const logger = require('../utils/logger');

const router = express.Router();
const DB = 'notifications';
const notificationsCache = new TTLCache(10_000, 200);

function isCloudantRateLimit(err) {
  const status = err?.status || err?.statusCode;
  const message = String(err?.message || '').toLowerCase();
  return status === 429 || message.includes('too_many_requests') || message.includes('rate limit');
}

// ─────────────────────────────────────────────
// GET /api/notifications
// Auth required — returns notifications for current user
// ─────────────────────────────────────────────
router.get('/', ensureAuthenticated, async (req, res) => {
  try {
    const { userId } = extractUserInfo(req.user);
    const limit = Math.max(1, Math.min(50, Number(req.query.limit || 25)));
    const cacheKey = `notifications:${userId}:${limit}`;
    const cached = notificationsCache.get(cacheKey);
    if (cached) {
      logger.debug('[API] duplicate request prevented /api/notifications');
      return res.json(cached);
    }

    const response = await cloudant.postView({
      db: DB,
      ddoc: 'notifications',
      view: 'by_user',
      startKey: [userId, {}],
      endKey: [userId],
      descending: true,
      includeDocs: true,
      limit,
    });

    const notifications = (response.result.rows || [])
      .map((r) => r.doc)
      .filter((doc) => doc && !doc._id.startsWith('_design') && doc.user_id === userId);

    const payload = { success: true, notifications };
    notificationsCache.set(cacheKey, payload);
    res.json(payload);
  } catch (err) {
    console.error('[NOTIFICATIONS] Fetch error:', err.message);
    if (isCloudantRateLimit(err)) {
      return res.status(429).json({ success: false, error: 'Cloudant rate limit reached. Please retry shortly.' });
    }
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
      notificationsCache.invalidatePrefix(`notifications:${userId}:`);
      return res.json({ success: true, notification: updated });
    }

    return res.status(500).json({ success: false, error: 'Failed to update notification' });
  } catch (err) {
    console.error('[NOTIFICATIONS] Read update error:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to mark notification as read' });
  }
});

module.exports = router;

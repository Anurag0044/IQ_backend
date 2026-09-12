// ============================================
// CloudIQ Backend - Notifications Routes
// ============================================

const express = require('express');
const db = require('../services/firestoreClient');
const { ensureAuthenticated, extractUserInfo } = require('../middleware/auth');
const { TTLCache } = require('../services/cacheService');
const logger = require('../utils/logger');

const router = express.Router();
const DB = 'notifications';
const notificationsCache = new TTLCache(10_000, 200);

// ─────────────────────────────────────────────
// GET /api/notifications
// ─────────────────────────────────────────────
router.get('/', ensureAuthenticated, async (req, res) => {
  try {
    const { userId } = extractUserInfo(req);
    const limit = Math.max(1, Math.min(50, Number(req.query.limit || 25)));
    const cacheKey = `notifications:${userId}:${limit}`;
    const cached = notificationsCache.get(cacheKey);
    if (cached) {
      logger.debug('[API] duplicate request prevented /api/notifications');
      return res.json(cached);
    }

    const notifications = await db.queryDocs(DB, [['user_id', '==', userId]], 'created_at', 'desc', limit);

    const payload = { success: true, notifications };
    notificationsCache.set(cacheKey, payload);
    res.json(payload);
  } catch (err) {
    console.error('[NOTIFICATIONS] Fetch error:', err.message);
    res.status(500).json({ success: false, error: 'Failed to fetch notifications' });
  }
});

// ─────────────────────────────────────────────
// PATCH /api/notifications/:id/read
// ─────────────────────────────────────────────
router.patch('/:id/read', ensureAuthenticated, async (req, res) => {
  try {
    const { userId } = extractUserInfo(req);
    const notificationId = req.params.id;

    let notification;
    try {
      notification = await db.getDoc(DB, notificationId);
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
      read: true,
      read_at: new Date().toISOString(),
    };

    const saved = await db.setDoc(DB, notificationId, updated, { merge: true });
    
    notificationsCache.invalidatePrefix(`notifications:${userId}:`);
    return res.json({ success: true, notification: { ...notification, ...saved } });
  } catch (err) {
    console.error('[NOTIFICATIONS] Read update error:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to mark notification as read' });
  }
});

module.exports = router;

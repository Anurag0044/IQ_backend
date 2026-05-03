// ============================================
// CloudIQ Backend - User Routes (Protected)
// ============================================
// Routes accessible to all authenticated users

const express = require('express');
const { ensureAuthenticated } = require('../middleware/auth');

const router = express.Router();

// Apply authentication middleware to all user routes
router.use(ensureAuthenticated);

/**
 * GET /api/user/profile
 * Returns the authenticated user's profile
 */
router.get('/profile', (req, res) => {
  const user = req.user;

  res.json({
    success: true,
    data: {
      name: user.name || user.given_name || 'User',
      email: user.email || null,
      picture: user.picture || null,
    },
  });
});

/**
 * GET /api/user/dashboard
 * Returns user-specific dashboard data
 */
router.get('/dashboard', (req, res) => {
  res.json({
    success: true,
    data: {
      recentCourses: [],
      progress: {
        completed: 0,
        inProgress: 0,
        total: 0,
      },
      streakDays: 0,
      lastActive: new Date().toISOString(),
    },
  });
});

/**
 * GET /api/user/courses
 * Returns courses available to the user
 */
router.get('/courses', (req, res) => {
  res.json({
    success: true,
    data: {
      enrolled: [],
      recommended: [],
      completed: [],
    },
  });
});

/**
 * GET /api/user/notifications
 * Returns user notifications
 */
router.get('/notifications', (req, res) => {
  const user = req.user;
  const email = user.email || (user.emails && user.emails[0]?.value) || '';
  if (!email) return res.json({ success: true, data: [] });
  
  const db = require('../utils/db');
  const notifications = db.getNotifications(email);
  res.json({ success: true, data: notifications });
});

module.exports = router;

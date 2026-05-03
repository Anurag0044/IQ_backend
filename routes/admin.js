// ============================================
// CloudIQ Backend - Admin Routes
// ============================================
// Protected routes accessible only to admin users
// All routes here require both authentication AND admin role

const express = require('express');
const { ensureAuthenticated, ensureAdmin } = require('../middleware/auth');

const router = express.Router();

// Apply both middleware to ALL admin routes
router.use(ensureAuthenticated);
router.use(ensureAdmin);

/**
 * GET /api/admin/dashboard
 * Returns admin dashboard data (stats, overview)
 */
router.get('/dashboard', (req, res) => {
  const users = db.getAllUsers();
  res.json({
    success: true,
    message: 'Welcome to the Admin Dashboard',
    data: {
      totalUsers: users.length,
      activeSessions: 0,
      totalCourses: 0,
      systemHealth: 'operational',
      lastUpdated: new Date().toISOString(),
    },
  });
});

const db = require('../utils/db');

/**
 * GET /api/admin/users
 * Returns list of all users (admin only)
 */
router.get('/users', (req, res) => {
  const users = db.getAllUsers();
  res.json({
    success: true,
    message: 'User list retrieved successfully',
    data: {
      users: users,
      total: users.length,
      page: 1,
      limit: users.length,
    },
  });
});

/**
 * POST /api/admin/users
 * Add a new user with a specific role
 */
router.post('/users', (req, res) => {
  const { email, role } = req.body;
  if (!email || !role) {
    return res.status(400).json({ success: false, message: 'Email and role are required' });
  }
  
  try {
    db.updateUserRole(email, role);
    res.json({ success: true, message: `User ${email} added as ${role}` });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

/**
 * PUT /api/admin/users/:email/role
 * Update an existing user's role
 */
router.put('/users/:email/role', (req, res) => {
  const { email } = req.params;
  const { role } = req.body;
  
  if (!role) {
    return res.status(400).json({ success: false, message: 'Role is required' });
  }
  
  try {
    db.updateUserRole(email, role);
    res.json({ success: true, message: `User ${email} updated to ${role}` });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

/**
 * DELETE /api/admin/users/:email
 * Remove a user
 */
router.delete('/users/:email', (req, res) => {
  const { email } = req.params;
  
  try {
    db.deleteUser(email);
    res.json({ success: true, message: `User ${email} deleted` });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

/**
 * GET /api/admin/analytics
 * Returns platform analytics data (admin only)
 */
router.get('/analytics', (req, res) => {
  res.json({
    success: true,
    message: 'Analytics data retrieved successfully',
    data: {
      dailyActiveUsers: 0,
      weeklyActiveUsers: 0,
      monthlyActiveUsers: 0,
      courseCompletionRate: 0,
      avgSessionDuration: '0m',
      topCourses: [],
    },
  });
});

/**
 * GET /api/admin/settings
 * Returns platform-wide settings (admin only)
 */
router.get('/settings', (req, res) => {
  res.json({
    success: true,
    message: 'Platform settings retrieved successfully',
    data: {
      maintenanceMode: false,
      registrationEnabled: true,
      maxUsersPerCourse: 100,
      apiRateLimit: 1000,
      features: {
        voiceLearning: true,
        aiChatbot: true,
        community: true,
        quiz: true,
      },
    },
  });
});

/**
 * PUT /api/admin/settings
 * Updates platform-wide settings (admin only)
 */
router.put('/settings', (req, res) => {
  const updates = req.body;

  // TODO: Validate and persist settings to database
  console.log('[ADMIN] Settings update requested:', updates);

  res.json({
    success: true,
    message: 'Platform settings updated successfully',
    data: updates,
  });
});

/**
 * GET /api/admin/roles
 * Returns App ID roles configuration (admin only)
 */
router.get('/roles', (req, res) => {
  res.json({
    success: true,
    message: 'Roles retrieved successfully',
    data: {
      roles: [
        {
          id: process.env.ADMIN_ROLE_ID,
          name: 'admin',
          description: 'Admin of the CloudIQ platform',
          permissions: ['manage_users', 'manage_courses', 'manage_settings', 'view_analytics'],
        },
        {
          id: 'user-role-id',
          name: 'user',
          description: 'Regular platform user',
          permissions: ['view_courses', 'take_quizzes', 'join_community'],
        },
      ],
    },
  });
});

module.exports = router;

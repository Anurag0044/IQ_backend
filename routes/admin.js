// ============================================
// CloudIQ Backend - Admin Routes (Role-Based)
// ============================================
// Role hierarchy: main_admin > co_admin > elder_admin > junior_admin
//
// GET  /api/admin/list         — list all admins (any admin)
// POST /api/admin/add          — add admin (main_admin / co_admin only)
// PUT  /api/admin/:id/role     — change role (hierarchy enforced)
// DELETE /api/admin/:id        — remove admin (hierarchy enforced)
// GET  /api/admin/dashboard    — stats stub (any admin)

const express = require('express');
const { ensureAuthenticated, ensureAdmin } = require('../middleware/auth');
const {
  listAdmins,
  addAdmin,
  removeAdmin,
  updateAdminRole,
  getAdminRole,
} = require('../services/adminDb');
const { extractUserInfo } = require('../middleware/auth');
const cloudant = require('../services/cloudantClient');
const { adminCache } = require('../services/cacheService');

const router = express.Router();

// All admin routes require authentication + admin status
router.use(ensureAuthenticated, ensureAdmin);

// ─────────────────────────────────────────────
// Helper: get requester's role
// ─────────────────────────────────────────────
async function requesterRole(req) {
  const { email } = extractUserInfo(req.user);
  return getAdminRole(email);
}

// ─────────────────────────────────────────────
// GET /api/admin/dashboard
// ─────────────────────────────────────────────
router.get('/dashboard', async (req, res) => {
  try {
    // Count users in Cloudant users DB
    let totalUsers = 0;
    try {
      const info = await cloudant.getDatabaseInformation({ db: 'users' });
      totalUsers = info.result.doc_count || 0;
    } catch (_) { /* db may not exist yet */ }

    let totalPosts = 0;
    try {
      const info = await cloudant.getDatabaseInformation({ db: 'posts' });
      totalPosts = info.result.doc_count || 0;
    } catch (_) {}

    const { email } = extractUserInfo(req.user);
    const myRole = await getAdminRole(email);

    return res.json({
      success: true,
      data: {
        totalUsers,
        totalPosts,
        systemHealth: 'operational',
        lastUpdated:  new Date().toISOString(),
        myRole,
      },
    });
  } catch (err) {
    console.error('[ADMIN] dashboard error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────
// GET /api/admin/list
// Any admin can view the list
// ─────────────────────────────────────────────
router.get('/list', async (req, res) => {
  try {
    const admins = await listAdmins();
    return res.json({ success: true, admins });
  } catch (err) {
    console.error('[ADMIN] list error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────
// POST /api/admin/add
// Only main_admin and co_admin
// ─────────────────────────────────────────────
router.post('/add', async (req, res) => {
  try {
    const { email: addedByEmail } = extractUserInfo(req.user);
    const myRole = await getAdminRole(addedByEmail);

    if (!['main_admin', 'co_admin'].includes(myRole)) {
      return res.status(403).json({ success: false, error: 'Only main_admin or co_admin can add admins' });
    }

    const { email, role } = req.body;
    if (!email || !role) {
      return res.status(400).json({ success: false, error: 'email and role are required' });
    }

    const result = await addAdmin(email, role, addedByEmail);
    if (!result.success) return res.status(400).json({ success: false, error: result.message });
    adminCache.delete(`admin:${String(email).trim().toLowerCase()}`);
    return res.status(201).json({ success: true, message: result.message });
  } catch (err) {
    console.error('[ADMIN] add error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────
// PUT /api/admin/:id/role
// Role hierarchy enforced inside updateAdminRole
// ─────────────────────────────────────────────
router.put('/:id/role', async (req, res) => {
  try {
    const { email: updatedByEmail } = extractUserInfo(req.user);
    const { id: targetEmail } = req.params;
    const { role: newRole } = req.body;

    if (!newRole) {
      return res.status(400).json({ success: false, error: 'role is required' });
    }

    const result = await updateAdminRole(targetEmail, newRole, updatedByEmail);
    if (!result.success) return res.status(400).json({ success: false, error: result.message });
    adminCache.delete(`admin:${String(targetEmail).trim().toLowerCase()}`);
    return res.json({ success: true, message: result.message });
  } catch (err) {
    console.error('[ADMIN] update role error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────
// DELETE /api/admin/:id
// Role hierarchy enforced inside removeAdmin
// ─────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const { email: removedByEmail } = extractUserInfo(req.user);
    const { id: targetEmail } = req.params;

    const result = await removeAdmin(targetEmail, removedByEmail);
    if (!result.success) return res.status(400).json({ success: false, error: result.message });
    adminCache.delete(`admin:${String(targetEmail).trim().toLowerCase()}`);
    return res.json({ success: true, message: result.message });
  } catch (err) {
    console.error('[ADMIN] delete error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────
// GET /api/admin/me/role
// Returns the calling admin's own role
// ─────────────────────────────────────────────
router.get('/me/role', async (req, res) => {
  try {
    const { email } = extractUserInfo(req.user);
    const role = await getAdminRole(email);
    return res.json({ success: true, role, email });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;

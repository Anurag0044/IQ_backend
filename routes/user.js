// ============================================
// CloudIQ Backend - User Profile Routes
// ============================================
// GET  /api/user/profile     — check onboarding + return profile
// POST /api/user/onboarding  — first-time setup (username, purpose, image)
// PUT  /api/user/profile     — update username / profile image

const express = require('express');
const multer = require('multer');
const cloudant = require('../services/cloudantClient');
const { uploadBuffer, deleteImage } = require('../services/cloudinaryService');
const { ensureAuthenticated } = require('../middleware/auth');

const router = express.Router();
const DB_NAME = 'users'; // existing Cloudant DB

// ─────────────────────────────────────────────
// Multer — profile images (5 MB, jpeg/png/webp)
// ─────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Only JPEG, PNG, or WEBP images are allowed.'), false);
  },
});

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────
function getUserId(req) {
  // App ID stores the subject as `sub` or `id`
  return (
    req.user?.sub ||
    req.user?.id ||
    req.user?.uid ||
    req.user?.email ||
    (req.user?.emails && req.user.emails[0]?.value) ||
    'unknown'
  );
}

function getUserEmail(req) {
  return (
    req.user?.email ||
    (req.user?.emails && req.user.emails[0]?.value) ||
    ''
  ).toLowerCase();
}

function extractPublicId(url) {
  if (!url) return null;
  const match = url.match(/\/upload\/(?:v\d+\/)?(.+)\.[a-z]{2,5}$/i);
  return match ? match[1] : null;
}

// ─────────────────────────────────────────────
// GET /api/user/profile
// Check if user is onboarded; return profile if yes
// ─────────────────────────────────────────────
router.get('/profile', ensureAuthenticated, async (req, res) => {
  try {
    const userId = getUserId(req);

    try {
      const doc = (await cloudant.getDocument({ db: DB_NAME, docId: userId })).result;
      const { profile_image_public_id, _rev, ...safe } = doc;
      return res.json({ success: true, is_onboarded: true, data: safe });
    } catch (err) {
      if (err.status === 404) {
        // New user — not yet onboarded
        return res.json({
          success: true,
          is_onboarded: false,
          data: { email: getUserEmail(req) },
        });
      }
      throw err;
    }
  } catch (err) {
    console.error('[User] Get profile error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────
// GET /api/user/dashboard (legacy stub)
// ─────────────────────────────────────────────
router.get('/dashboard', ensureAuthenticated, (req, res) => {
  res.json({ success: true, data: { recentCourses: [], progress: { completed: 0, inProgress: 0, total: 0 }, streakDays: 0 } });
});

// ─────────────────────────────────────────────
// GET /api/user/courses (legacy stub)
// ─────────────────────────────────────────────
router.get('/courses', ensureAuthenticated, (req, res) => {
  res.json({ success: true, data: { enrolled: [], recommended: [], completed: [] } });
});

// ─────────────────────────────────────────────
// POST /api/user/onboarding
// First-time user setup — creates Cloudant document
// ─────────────────────────────────────────────
router.post('/onboarding', ensureAuthenticated, upload.single('profile_image'), async (req, res) => {
  try {
    const userId = getUserId(req);
    const email = getUserEmail(req);
    const { username, purpose, referral_source, professional_role } = req.body;

    if (!username?.trim()) {
      return res.status(400).json({ success: false, error: 'Username is required.' });
    }

    // Upload profile image to Cloudinary
    let profile_image_url = null;
    let profile_image_public_id = null;

    if (req.file) {
      const result = await uploadBuffer(req.file.buffer, 'profile_images');
      profile_image_url = result.secure_url;
      profile_image_public_id = result.public_id;
    }

    const userDoc = {
      _id: userId,
      email,
      username: username.trim(),
      professional_role: professional_role?.trim() || '',
      purpose: purpose?.trim() || '',
      referral_source: referral_source || '',
      profile_image_url,
      profile_image_public_id,
      is_onboarded: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const response = await cloudant.postDocument({ db: DB_NAME, document: userDoc });

    if (!response.result.ok) throw new Error('Cloudant did not confirm document creation');

    console.log(`[User] Onboarding complete: ${username} (${email})`);

    const { profile_image_public_id: _p, ...safe } = userDoc;
    return res.status(201).json({ success: true, data: safe });
  } catch (err) {
    console.error('[User] Onboarding error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────
// PUT /api/user/profile
// Update username and/or profile image
// ─────────────────────────────────────────────
router.put('/profile', ensureAuthenticated, upload.single('profile_image'), async (req, res) => {
  try {
    const userId = getUserId(req);
    const { username, professional_role } = req.body;

    // Fetch existing document (_rev required for Cloudant update)
    const existing = (await cloudant.getDocument({ db: DB_NAME, docId: userId })).result;

    let profile_image_url = existing.profile_image_url;
    let profile_image_public_id = existing.profile_image_public_id;

    if (req.file) {
      // Delete old Cloudinary image (non-blocking)
      const oldId = existing.profile_image_public_id || extractPublicId(existing.profile_image_url);
      if (oldId) {
        try { await deleteImage(oldId); }
        catch (e) { console.error('[User] Old image delete failed:', e.message); }
      }
      const result = await uploadBuffer(req.file.buffer, 'profile_images');
      profile_image_url = result.secure_url;
      profile_image_public_id = result.public_id;
    }

    const updated = {
      ...existing,
      username: username?.trim() || existing.username,
      professional_role: professional_role !== undefined
        ? professional_role.trim()
        : (existing.professional_role || ''),
      profile_image_url,
      profile_image_public_id,
      updated_at: new Date().toISOString(),
    };

    await cloudant.putDocument({ db: DB_NAME, docId: userId, document: updated });
    console.log(`[User] Profile updated: ${updated.username} (${userId})`);

    const { profile_image_public_id: _p, _rev: _r, ...safe } = updated;
    return res.json({ success: true, data: safe });
  } catch (err) {
    if (err.status === 404) {
      return res.status(404).json({ success: false, error: 'Profile not found. Please complete onboarding first.' });
    }
    console.error('[User] Update profile error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────
// DELETE /api/user/profile-image
// Remove profile picture — clears Cloudinary + nulls DB field
// ─────────────────────────────────────────────
router.delete('/profile-image', ensureAuthenticated, async (req, res) => {
  try {
    const userId = getUserId(req);
    const existing = (await cloudant.getDocument({ db: DB_NAME, docId: userId })).result;

    const publicId = existing.profile_image_public_id || extractPublicId(existing.profile_image_url);
    if (publicId) {
      try { await deleteImage(publicId); }
      catch (e) { console.error('[User] Cloudinary image delete failed:', e.message); }
    }

    const updated = {
      ...existing,
      profile_image_url: null,
      profile_image_public_id: null,
      updated_at: new Date().toISOString(),
    };
    await cloudant.putDocument({ db: DB_NAME, docId: userId, document: updated });

    console.log(`[User] Profile image removed for: ${userId}`);
    const { profile_image_public_id: _p, _rev: _r, ...safe } = updated;
    return res.json({ success: true, data: safe });
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ success: false, error: 'Profile not found.' });
    console.error('[User] Delete profile image error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────
// DELETE /api/user/account
// Permanently delete: Cloudinary image + Cloudant doc + session
// ─────────────────────────────────────────────
router.delete('/account', ensureAuthenticated, async (req, res) => {
  try {
    const userId = getUserId(req);

    // Fetch existing doc (may not exist if user never onboarded)
    try {
      const existing = (await cloudant.getDocument({ db: DB_NAME, docId: userId })).result;

      // Delete Cloudinary profile image
      const publicId = existing.profile_image_public_id || extractPublicId(existing.profile_image_url);
      if (publicId) {
        try { await deleteImage(publicId); }
        catch (e) { console.error('[User] Cloudinary delete failed during account deletion:', e.message); }
      }

      // Delete Cloudant document
      await cloudant.deleteDocument({ db: DB_NAME, docId: userId, rev: existing._rev });
      console.log(`[User] Account deleted from Cloudant: ${userId}`);
    } catch (err) {
      if (err.status !== 404) throw err; // 404 = no profile, still destroy session
    }

    // Destroy session
    req.session.destroy(() => {
      res.clearCookie('connect.sid');
      return res.json({ success: true, message: 'Account permanently deleted.' });
    });
  } catch (err) {
    console.error('[User] Delete account error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;

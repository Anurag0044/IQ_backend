// ============================================
// CloudIQ Backend - User Profile Routes
// ============================================
// GET  /api/user/profile     — check onboarding + return profile
// POST /api/user/onboarding  — first-time setup (username, purpose, image)
// PUT  /api/user/profile     — update username / profile image

const express = require('express');
const multer = require('multer');
const db = require('../services/firestoreClient');
const { uploadBuffer, deleteImage } = require('../services/cloudinaryService');
const { ensureAuthenticated } = require('../middleware/auth');
const logger = require('../utils/logger');

const router = express.Router();
const DB_NAME = 'users';

// ─── Multer — profile images (5 MB, jpeg/png/webp) ───────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Only JPEG, PNG, or WEBP images are allowed.'), false);
  },
});

// ─── Helpers ─────────────────────────────────────────────────────────────────
function getUserId(req) {
  return req.firebaseUser?.uid || 'unknown';
}

function getUserEmail(req) {
  return req.firebaseUser?.email || '';
}

function extractPublicId(url) {
  if (!url) return null;
  const match = url.match(/\/upload\/(?:v\d+\/)?(.+)\.[a-z]{2,5}$/i);
  return match ? match[1] : null;
}

// ─── GET /api/user/profile ───────────────────────────────────────────────────
router.get('/profile', ensureAuthenticated, async (req, res) => {
  try {
    const userId = getUserId(req);

    try {
      const doc = await db.getDoc(DB_NAME, userId);
      const { profile_image_public_id, ...safe } = doc;
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
    logger.error('[User] Get profile error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/user/dashboard ─────────────────────────────────────────────────
router.get('/dashboard', ensureAuthenticated, async (req, res) => {
  try {
    const userId = getUserId(req);

    let userDoc;
    try {
      userDoc = await db.getDoc(DB_NAME, userId);
    } catch (err) {
      if (err.status === 404) {
        return res.json({ success: true, data: { timeSpent: 0, tutorialsCount: 0, activities: [] } });
      }
      throw err;
    }

    let tutorialsCount = 0;
    try {
      tutorialsCount = await db.getCollectionCount('tutorials');
    } catch (err) {
      logger.warn('[User] tutorials count failed:', err.message);
    }

    return res.json({
      success: true,
      data: {
        timeSpent: userDoc.time_spent || 0,
        points: userDoc.points || 0,
        dailyTimeSpent: userDoc.daily_time_spent || {},
        tutorialsCount,
        activities: userDoc.activities || [],
      },
    });
  } catch (err) {
    logger.error('[User] Dashboard error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─── PUT /api/user/sync-session ──────────────────────────────────────────────
router.put('/sync-session', ensureAuthenticated, async (req, res) => {
  try {
    const userId = getUserId(req);
    const { timeAdded = 0, activity, pointsAdded = 0 } = req.body;

    const existing = await db.getDoc(DB_NAME, userId);

    let time_spent = (existing.time_spent || 0) + timeAdded;
    let points = (existing.points || 0) + pointsAdded;

    let daily_time_spent = existing.daily_time_spent || {};
    if (timeAdded > 0) {
      const today = new Date().toISOString().split('T')[0];
      daily_time_spent[today] = (daily_time_spent[today] || 0) + timeAdded;
    }

    let activities = existing.activities || [];
    if (activity) {
      activities.unshift({
        title: activity.title || 'Activity',
        desc: activity.desc || '',
        icon: activity.icon || 'BookOpen',
        time: new Date().toISOString(),
      });
      if (activities.length > 10) activities = activities.slice(0, 10);
    }

    const updatedFields = {
      time_spent,
      points,
      daily_time_spent,
      activities,
      updated_at: new Date().toISOString()
    };

    await db.setDoc(DB_NAME, userId, updatedFields, { merge: true });

    return res.json({ success: true, data: { timeSpent: time_spent, points, dailyTimeSpent: daily_time_spent, activities } });
  } catch (err) {
    logger.error('[User] sync-session error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET /api/user/courses (legacy stub) ─────────────────────────────────────
router.get('/courses', ensureAuthenticated, (req, res) => {
  res.json({ success: true, data: { enrolled: [], recommended: [], completed: [] } });
});

// ─── POST /api/user/onboarding ───────────────────────────────────────────────
router.post('/onboarding', ensureAuthenticated, upload.single('profile_image'), async (req, res) => {
  try {
    const userId = getUserId(req);
    const email = getUserEmail(req);
    const { username, purpose, referral_source, professional_role } = req.body;

    if (!username?.trim()) {
      return res.status(400).json({ success: false, error: 'Username is required.' });
    }

    let profile_image_url = null;
    let profile_image_public_id = null;

    if (req.file) {
      const result = await uploadBuffer(req.file.buffer, 'profile_images');
      profile_image_url = result.secure_url;
      profile_image_public_id = result.public_id;
    }

    const userDoc = {
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

    await db.setDoc(DB_NAME, userId, userDoc);

    logger.info(`[User] Onboarding complete: ${username} (${email})`);

    const { profile_image_public_id: _p, ...safe } = userDoc;
    safe._id = userId;
    return res.status(201).json({ success: true, data: safe });
  } catch (err) {
    logger.error('[User] Onboarding error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─── PUT /api/user/profile ───────────────────────────────────────────────────
router.put('/profile', ensureAuthenticated, upload.single('profile_image'), async (req, res) => {
  try {
    const userId = getUserId(req);
    const { username, professional_role } = req.body;

    const existing = await db.getDoc(DB_NAME, userId);

    let profile_image_url = existing.profile_image_url;
    let profile_image_public_id = existing.profile_image_public_id;

    if (req.file) {
      const oldId = existing.profile_image_public_id || extractPublicId(existing.profile_image_url);
      if (oldId) {
        try { await deleteImage(oldId); }
        catch (e) { logger.error('[User] Old image delete failed:', e.message); }
      }
      const result = await uploadBuffer(req.file.buffer, 'profile_images');
      profile_image_url = result.secure_url;
      profile_image_public_id = result.public_id;
    }

    const updates = {
      username: username?.trim() || existing.username,
      professional_role: professional_role !== undefined
        ? professional_role.trim()
        : (existing.professional_role || ''),
      profile_image_url,
      profile_image_public_id,
      updated_at: new Date().toISOString(),
    };

    await db.setDoc(DB_NAME, userId, updates, { merge: true });
    logger.info(`[User] Profile updated: ${updates.username} (${userId})`);

    const { profile_image_public_id: _p, ...safe } = { ...existing, ...updates };
    return res.json({ success: true, data: safe });
  } catch (err) {
    if (err.status === 404) {
      return res.status(404).json({ success: false, error: 'Profile not found. Please complete onboarding first.' });
    }
    logger.error('[User] Update profile error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─── DELETE /api/user/profile-image ──────────────────────────────────────────
router.delete('/profile-image', ensureAuthenticated, async (req, res) => {
  try {
    const userId = getUserId(req);
    const existing = await db.getDoc(DB_NAME, userId);

    const publicId = existing.profile_image_public_id || extractPublicId(existing.profile_image_url);
    if (publicId) {
      try { await deleteImage(publicId); }
      catch (e) { logger.error('[User] Cloudinary image delete failed:', e.message); }
    }

    const updates = {
      profile_image_url: null,
      profile_image_public_id: null,
      updated_at: new Date().toISOString(),
    };
    
    await db.setDoc(DB_NAME, userId, updates, { merge: true });

    logger.info(`[User] Profile image removed for: ${userId}`);
    const { profile_image_public_id: _p, ...safe } = { ...existing, ...updates };
    return res.json({ success: true, data: safe });
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ success: false, error: 'Profile not found.' });
    logger.error('[User] Delete profile image error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─── DELETE /api/user/account ────────────────────────────────────────────────
router.delete('/account', ensureAuthenticated, async (req, res) => {
  try {
    const userId = getUserId(req);

    try {
      const existing = await db.getDoc(DB_NAME, userId);

      const publicId = existing.profile_image_public_id || extractPublicId(existing.profile_image_url);
      if (publicId) {
        try { await deleteImage(publicId); }
        catch (e) { logger.error('[User] Cloudinary delete failed during account deletion:', e.message); }
      }

      await db.deleteDoc(DB_NAME, userId);
      logger.info(`[User] Account deleted from Cloudant: ${userId}`);
    } catch (err) {
      if (err.status !== 404) throw err;
    }

    req.session.destroy(() => {
      res.clearCookie('connect.sid');
      return res.json({ success: true, message: 'Account permanently deleted.' });
    });
  } catch (err) {
    logger.error('[User] Delete account error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;

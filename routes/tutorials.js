// ============================================
// CloudIQ Backend - Tutorials Routes
// ============================================

const express    = require('express');
const multer     = require('multer');
const { v4: uuidv4 } = require('uuid');
const db         = require('../services/firestoreClient');
const { uploadImage, uploadVideo, deleteUploadedMedia, recordTutorialMedia } = require('../services/mediaService');
const { ensureAuthenticated, extractUserInfo, checkAdminRole } = require('../middleware/auth');
const logger = require('../utils/logger');

const router  = express.Router();
const DB_NAME = 'tutorials';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = [
      'image/jpeg',
      'image/png',
      'image/webp',
      'image/gif',
      'video/mp4',
      'video/webm',
      'video/quicktime',
      'video/x-m4v',
    ];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Only JPEG, PNG, WEBP, GIF, MP4, WEBM, or MOV videos are allowed.'), false);
  },
});

const uploadInline = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = [
      'image/jpeg',
      'image/png',
      'image/webp',
      'video/mp4',
      'video/webm',
      'video/quicktime',
      'video/x-m4v',
    ];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Only JPEG, PNG, WEBP, MP4, WEBM, or MOV files are allowed for inline content.'), false);
  },
});

function extractPublicId(imageUrl) {
  if (!imageUrl) return null;
  try {
    const match = imageUrl.match(/\/upload\/(?:v\d+\/)?(.+)\.[a-z]{2,5}$/i);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

async function isCommunityMember(userId, communityId) {
  if (!userId || !communityId) return false;
  try {
    const community = await db.getDoc('communities', communityId);
    if (Array.isArray(community.members) && community.members.includes(userId)) return true;
  } catch (err) {
    if (err.status !== 404) {
      logger.warn('[Tutorials] Community lookup failed:', err.message);
    }
  }

  try {
    const mems = await db.queryDocs('community_memberships', [['community_id', '==', communityId], ['user_id', '==', userId]], null, 'asc', 1);
    return mems.length > 0;
  } catch (err) {
    logger.warn('[Tutorials] Membership lookup failed:', err.message);
    return false;
  }
}

async function isCommunityModerator(userId, communityId) {
  if (!userId || !communityId) return false;
  try {
    const community = await db.getDoc('communities', communityId);
    if (community.owner_id === userId) return true;
    if (Array.isArray(community.co_admin_ids) && community.co_admin_ids.includes(userId)) return true;
  } catch (err) {
    if (err.status !== 404) {
      logger.warn('[Tutorials] Community lookup failed:', err.message);
    }
  }
  return false;
}

// ─────────────────────────────────────────────
// POST /api/tutorials/create
// ─────────────────────────────────────────────
router.post(
  '/create',
  ensureAuthenticated,
  upload.fields([
    { name: 'image', maxCount: 1 },
    { name: 'video', maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const { title, description, content, content_markdown, category, tags, community_id } = req.body;

      const missing = [];
      if (!title?.trim())       missing.push('title');
      if (!description?.trim()) missing.push('description');
      if (!content?.trim() && !content_markdown?.trim()) missing.push('content');

      if (missing.length > 0) {
        return res.status(400).json({
          success: false,
          error: `Missing required fields: ${missing.join(', ')}`,
        });
      }

      const { userId, email, username } = extractUserInfo(req);
      const isAdmin = await checkAdminRole(req);

      if (!isAdmin) {
        if (!community_id) {
          return res.status(403).json({ success: false, error: 'Only admins can create global tutorials.' });
        }

        const isMember = await isCommunityMember(userId, community_id);
        if (!isMember) {
          return res.status(403).json({ success: false, error: 'You must be a community member to publish tutorials here.' });
        }

        const isModerator = await isCommunityModerator(userId, community_id);
        if (!isModerator) {
          const userTutorials = await db.queryDocs(DB_NAME, [['community_id', '==', community_id], ['created_by_id', '==', userId]]);
          if (userTutorials.length >= 3) {
            return res.status(403).json({ success: false, error: 'You have reached the maximum of 3 tutorials for this community. Admins and co-admins can create more.' });
          }
        }
      }

      const imageFile = req.files?.image?.[0] || null;
      const videoFile = req.files?.video?.[0] || null;

      if (imageFile && imageFile.size > 10 * 1024 * 1024) {
        return res.status(400).json({ success: false, error: 'Cover image must be 10MB or smaller' });
      }
      if (videoFile && videoFile.size > 50 * 1024 * 1024) {
        return res.status(400).json({ success: false, error: 'Cover video must be 50MB or smaller' });
      }

      let image_url = null;
      let public_id = null;
      let video_url = null;
      let video_public_id = null;

      if (imageFile) {
        const result = await uploadImage({
          buffer: imageFile.buffer,
          folder: 'tutorials',
          ownerId: userId,
          contextType: 'tutorial',
          contextId: null,
          mimeType: imageFile.mimetype,
          sizeBytes: imageFile.size,
        });
        image_url = result.secure_url;
        public_id = result.public_id;
      }

      if (videoFile) {
        const result = await uploadVideo({
          buffer: videoFile.buffer,
          folder: 'tutorial_videos',
          ownerId: userId,
          contextType: 'tutorial',
          contextId: null,
          mimeType: videoFile.mimetype,
          sizeBytes: videoFile.size,
        });
        video_url = result.secure_url;
        video_public_id = result.public_id;
      }

      const tagsList = tags
        ? String(tags).split(',').map((t) => t.trim()).filter(Boolean)
        : [];

      const tutorialId = uuidv4();

      const tutorial = {
        title:             title.trim(),
        description:       description.trim(),
        content:           content?.trim() || '',
        content_markdown:  content_markdown?.trim() || '',
        content_format:    content_markdown?.trim() ? 'markdown' : 'html',
        image_url,
        public_id,
        video_url,
        video_public_id,
        category:          category || 'General',
        tags:              tagsList,
        community_id:      community_id || null,
        created_by:        email || 'unknown',
        created_by_id:     userId,
        created_by_name:   username,
        created_at:        new Date().toISOString(),
      };

      const saved = await db.setDoc(DB_NAME, tutorialId, tutorial);

      if (public_id) await recordTutorialMedia({ tutorialId: saved._id, url: image_url, publicId: public_id, resourceType: 'image' });
      if (video_public_id) await recordTutorialMedia({ tutorialId: saved._id, url: video_url, publicId: video_public_id, resourceType: 'video' });

      logger.info(`[Tutorials] Created: "${title}" by ${email || 'unknown'}`);

      return res.status(201).json({
        success: true,
        message: 'Tutorial created successfully',
        data: {
          id:          saved._id,
          title:       saved.title,
          description: saved.description,
          content:     saved.content,
          content_markdown: saved.content_markdown,
          content_format: saved.content_format,
          image_url:   saved.image_url,
          video_url:   saved.video_url,
          category:    saved.category,
          tags:        saved.tags,
          community_id: saved.community_id,
          created_by:  saved.created_by,
          created_at:  saved.created_at,
        },
      });
    } catch (err) {
      logger.error('[Tutorials] Create error:', err.message);
      return res.status(500).json({ success: false, error: err.message });
    }
  }
);

// ─────────────────────────────────────────────
// POST /api/tutorials/upload-inline-image
// ─────────────────────────────────────────────
router.post(
  '/upload-inline-image',
  ensureAuthenticated,
  uploadInline.single('image'),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ success: false, error: 'No image file provided.' });
      }

      const { userId } = extractUserInfo(req);
      const tutorialId = req.body?.tutorial_id || null;
      const isVideo = req.file.mimetype.startsWith('video/');

      if (!isVideo && req.file.size > 2 * 1024 * 1024) {
        return res.status(400).json({ success: false, error: 'Inline images must be 2MB or smaller.' });
      }
      if (isVideo && req.file.size > 50 * 1024 * 1024) {
        return res.status(400).json({ success: false, error: 'Inline videos must be 50MB or smaller.' });
      }

      const result = isVideo
        ? await uploadVideo({
          buffer: req.file.buffer,
          folder: 'tutorial_content',
          ownerId: userId,
          contextType: 'tutorial_content',
          contextId: tutorialId,
          mimeType: req.file.mimetype,
          sizeBytes: req.file.size,
        })
        : await uploadImage({
          buffer: req.file.buffer,
          folder: 'tutorial_content',
          ownerId: userId,
          contextType: 'tutorial_content',
          contextId: tutorialId,
          mimeType: req.file.mimetype,
          sizeBytes: req.file.size,
        });

      if (tutorialId) {
        await recordTutorialMedia({
          tutorialId,
          url: result.secure_url,
          publicId: result.public_id,
          resourceType: isVideo ? 'video' : 'image',
        });
      }

      logger.info(`[Tutorials] Inline media uploaded: ${result.public_id}`);

      return res.json({ success: true, url: result.secure_url, public_id: result.public_id, resource_type: isVideo ? 'video' : 'image' });
    } catch (err) {
      logger.error('[Tutorials] Inline image upload error:', err.message);
      return res.status(500).json({ success: false, error: err.message });
    }
  }
);

// Alias
router.post(
  '/upload-inline-media',
  ensureAuthenticated,
  uploadInline.single('media'),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ success: false, error: 'No media file provided.' });
      }

      const { userId } = extractUserInfo(req);
      const tutorialId = req.body?.tutorial_id || null;
      const isVideo = req.file.mimetype.startsWith('video/');

      if (!isVideo && req.file.size > 2 * 1024 * 1024) {
        return res.status(400).json({ success: false, error: 'Inline images must be 2MB or smaller.' });
      }
      if (isVideo && req.file.size > 50 * 1024 * 1024) {
        return res.status(400).json({ success: false, error: 'Inline videos must be 50MB or smaller.' });
      }

      const result = isVideo
        ? await uploadVideo({
          buffer: req.file.buffer,
          folder: 'tutorial_content',
          ownerId: userId,
          contextType: 'tutorial_content',
          contextId: tutorialId,
          mimeType: req.file.mimetype,
          sizeBytes: req.file.size,
        })
        : await uploadImage({
          buffer: req.file.buffer,
          folder: 'tutorial_content',
          ownerId: userId,
          contextType: 'tutorial_content',
          contextId: tutorialId,
          mimeType: req.file.mimetype,
          sizeBytes: req.file.size,
        });

      if (tutorialId) {
        await recordTutorialMedia({
          tutorialId,
          url: result.secure_url,
          publicId: result.public_id,
          resourceType: isVideo ? 'video' : 'image',
        });
      }

      logger.info(`[Tutorials] Inline media uploaded: ${result.public_id}`);

      return res.json({ success: true, url: result.secure_url, public_id: result.public_id, resource_type: isVideo ? 'video' : 'image' });
    } catch (err) {
      logger.error('[Tutorials] Inline media upload error:', err.message);
      return res.status(500).json({ success: false, error: err.message });
    }
  }
);

// ─────────────────────────────────────────────
// DELETE /api/tutorials/image
// ─────────────────────────────────────────────
router.delete(
  '/image',
  ensureAuthenticated,
  async (req, res) => {
    try {
      const { public_id, resource_type } = req.body;
      if (!public_id) {
        return res.status(400).json({ success: false, error: 'public_id is required' });
      }

      await deleteUploadedMedia(public_id, resource_type || 'image');
      logger.info(`[Tutorials] Inline media deleted: ${public_id}`);

      return res.json({ success: true, message: 'Image deleted successfully' });
    } catch (err) {
      logger.error('[Tutorials] Inline image delete error:', err.message);
      return res.status(500).json({ success: false, error: err.message });
    }
  }
);

// ─────────────────────────────────────────────
// GET /api/tutorials
// ─────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    let tutorials = await db.getAllDocs(DB_NAME);

    tutorials = tutorials
      .map(({ public_id, video_public_id, ...safe }) => safe)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    logger.debug(`[Tutorials] GET all -> ${tutorials.length} tutorial(s)`);

    return res.json({ success: true, total: tutorials.length, data: tutorials });
  } catch (err) {
    logger.error('[Tutorials] Get all error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────
// PUT /api/tutorials/:id
// ─────────────────────────────────────────────
router.put(
  '/:id',
  ensureAuthenticated,
  upload.fields([
    { name: 'image', maxCount: 1 },
    { name: 'video', maxCount: 1 },
  ]),
  async (req, res) => {
    const { id } = req.params;
    try {
      const { title, description, content, content_markdown, category, tags, community_id } = req.body;
      const { userId, email } = extractUserInfo(req);
      const isAdmin = await checkAdminRole(req);

      let existing;
      try {
        existing = await db.getDoc(DB_NAME, id);
      } catch (err) {
        if (err.status === 404) return res.status(404).json({ success: false, error: 'Tutorial not found' });
        throw err;
      }

      const canEdit = isAdmin
        || existing.created_by === (email || '').toLowerCase()
        || existing.created_by_id === userId
        || (existing.community_id && await isCommunityModerator(userId, existing.community_id));

      if (!canEdit) {
        return res.status(403).json({ success: false, error: 'Not authorized to update this tutorial' });
      }

      let image_url = existing.image_url;
      let public_id = existing.public_id;
      let video_url = existing.video_url || null;
      let video_public_id = existing.video_public_id || null;

      const imageFile = req.files?.image?.[0] || null;
      const videoFile = req.files?.video?.[0] || null;

      if (imageFile && imageFile.size > 10 * 1024 * 1024) {
        return res.status(400).json({ success: false, error: 'Cover image must be 10MB or smaller' });
      }
      if (videoFile && videoFile.size > 50 * 1024 * 1024) {
        return res.status(400).json({ success: false, error: 'Cover video must be 50MB or smaller' });
      }

      if (imageFile) {
        const oldId = existing.public_id || extractPublicId(existing.image_url);
        if (oldId) {
          try { await deleteUploadedMedia(oldId, 'image'); } catch (e) {
            logger.error('[Tutorials] Old image delete failed (continuing):', e.message);
          }
        }
        const uploaded = await uploadImage({
          buffer: imageFile.buffer,
          folder: 'tutorials',
          ownerId: userId,
          contextType: 'tutorial',
          contextId: existing._id,
          mimeType: imageFile.mimetype,
          sizeBytes: imageFile.size,
        });
        image_url = uploaded.secure_url;
        public_id = uploaded.public_id;
        await recordTutorialMedia({ tutorialId: existing._id, url: image_url, publicId: public_id, resourceType: 'image' });
      }

      if (videoFile) {
        if (video_public_id) {
          try { await deleteUploadedMedia(video_public_id, 'video'); } catch (e) {
            logger.error('[Tutorials] Old video delete failed (continuing):', e.message);
          }
        }
        const uploaded = await uploadVideo({
          buffer: videoFile.buffer,
          folder: 'tutorial_videos',
          ownerId: userId,
          contextType: 'tutorial',
          contextId: existing._id,
          mimeType: videoFile.mimetype,
          sizeBytes: videoFile.size,
        });
        video_url = uploaded.secure_url;
        video_public_id = uploaded.public_id;
        await recordTutorialMedia({ tutorialId: existing._id, url: video_url, publicId: video_public_id, resourceType: 'video' });
      }

      const tagsList = tags
        ? String(tags).split(',').map((t) => t.trim()).filter(Boolean)
        : existing.tags || [];

      const updated = {
        title:       (title?.trim())       || existing.title,
        description: (description?.trim()) || existing.description,
        content:     (content?.trim())     || existing.content,
        content_markdown: content_markdown !== undefined ? (content_markdown?.trim() || '') : existing.content_markdown,
        content_format: content_markdown !== undefined
          ? (content_markdown?.trim() ? 'markdown' : 'html')
          : (existing.content_format || 'html'),
        image_url,
        public_id,
        video_url,
        video_public_id,
        category: category || existing.category || 'General',
        tags: tagsList,
        community_id: community_id !== undefined ? (community_id || null) : existing.community_id,
        updated_at: new Date().toISOString(),
      };

      const saved = await db.setDoc(DB_NAME, id, updated, { merge: true });

      logger.info(`[Tutorials] Updated: "${saved.title}" (${id})`);

      const { public_id: _p, video_public_id: _v, ...safeData } = saved;
      return res.json({ success: true, data: safeData });
    } catch (err) {
      if (err.status === 404) return res.status(404).json({ success: false, error: 'Tutorial not found' });
      logger.error('[Tutorials] Update error:', err.message);
      return res.status(500).json({ success: false, error: err.message });
    }
  }
);

// ─────────────────────────────────────────────
// GET /api/tutorials/:id
// ─────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const doc = await db.getDoc(DB_NAME, id);
    const { public_id, video_public_id, ...safe } = doc;
    return res.json({ success: true, data: safe });
  } catch (err) {
    if (err.status === 404) {
      return res.status(404).json({ success: false, error: 'Tutorial not found' });
    }
    logger.error('[Tutorials] Get one error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────
// DELETE /api/tutorials/:id
// ─────────────────────────────────────────────
router.delete('/:id', ensureAuthenticated, async (req, res) => {
  const { id } = req.params;
  try {
    let doc;
    try {
      doc = await db.getDoc(DB_NAME, id);
    } catch (err) {
      if (err.status === 404) {
        return res.status(404).json({ success: false, error: 'Tutorial not found' });
      }
      throw err;
    }

    const { userId, email } = extractUserInfo(req);
    const isAdmin = await checkAdminRole(req);
    const canDelete = isAdmin
      || doc.created_by === (email || '').toLowerCase()
      || doc.created_by_id === userId
      || (doc.community_id && await isCommunityModerator(userId, doc.community_id));

    if (!canDelete) {
      return res.status(403).json({ success: false, error: 'Not authorized to delete this tutorial' });
    }

    const publicIdToDelete = doc.public_id || extractPublicId(doc.image_url);

    if (publicIdToDelete) {
      try {
        await deleteUploadedMedia(publicIdToDelete, 'image');
        logger.info(`[Tutorials] Cloudinary image deleted: ${publicIdToDelete}`);
      } catch (cloudErr) {
        logger.error('[Tutorials] Cloudinary delete failed (continuing):', cloudErr.message);
      }
    }

    if (doc.video_public_id) {
      try {
        await deleteUploadedMedia(doc.video_public_id, 'video');
        logger.info(`[Tutorials] Cloudinary video deleted: ${doc.video_public_id}`);
      } catch (cloudErr) {
        logger.error('[Tutorials] Cloudinary video delete failed (continuing):', cloudErr.message);
      }
    }

    await db.deleteDoc(DB_NAME, id);

    logger.info(`[Tutorials] Deleted tutorial: "${doc.title}" (${id})`);
    return res.json({ success: true, message: `Tutorial "${doc.title}" deleted successfully` });
  } catch (err) {
    if (err.status === 404) {
      return res.status(404).json({ success: false, error: 'Tutorial not found' });
    }
    logger.error('[Tutorials] Delete error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

router.use((err, req, res, _next) => {
  if (err instanceof multer.MulterError || err.message?.includes('Only')) {
    return res.status(400).json({ success: false, error: err.message });
  }
  logger.error('[Tutorials] Unexpected error:', err);
  return res.status(500).json({ success: false, error: 'Internal server error' });
});

module.exports = router;

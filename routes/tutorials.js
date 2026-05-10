// ============================================
// CloudIQ Backend - Tutorials Routes
// ============================================
// Admin-only: create, delete, upload-inline-image
// Public:     read all / read one
//
// Endpoints:
//   POST   /api/tutorials/create              â€” admin only, multipart/form-data
//   POST   /api/tutorials/upload-inline-image â€” admin only, returns image URL
//   GET    /api/tutorials                     â€” public
//   GET    /api/tutorials/:id                 â€” public
//   DELETE /api/tutorials/:id                 â€” admin only

const express    = require('express');
const multer     = require('multer');
const { v4: uuidv4 } = require('uuid');
const cloudant   = require('../services/cloudantClient');
const { uploadImage, uploadVideo, deleteUploadedMedia, recordTutorialMedia } = require('../services/mediaService');
const { ensureAuthenticated, extractUserInfo, checkAdminRole } = require('../middleware/auth');
const logger = require('../utils/logger');

const router  = express.Router();
const DB_NAME = 'tutorials';

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Multer configs
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// Cover image/video: image 10 MB, video 50 MB
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

// Inline content media: image 2 MB max, video 50 MB max
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

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Helper â€” extract Cloudinary public_id from URL
// Handles: .../upload/v<ver>/<folder>/<name>.<ext>
//          .../upload/<folder>/<name>.<ext>
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
    const community = (await cloudant.getDocument({ db: 'communities', docId: communityId })).result;
    if (Array.isArray(community.members) && community.members.includes(userId)) return true;
  } catch (err) {
    if (err.status !== 404) {
      logger.warn('[Tutorials] Community lookup failed:', err.message);
    }
  }

  try {
    const res = await cloudant.postFind({
      db: 'community_memberships',
      selector: { community_id: communityId, user_id: userId },
      limit: 1,
    });
    return res.result.docs.length > 0;
  } catch (err) {
    logger.warn('[Tutorials] Membership lookup failed:', err.message);
    return false;
  }
}

async function isCommunityModerator(userId, communityId) {
  if (!userId || !communityId) return false;
  try {
    const community = (await cloudant.getDocument({ db: 'communities', docId: communityId })).result;
    if (community.owner_id === userId) return true;
    if (Array.isArray(community.co_admin_ids) && community.co_admin_ids.includes(userId)) return true;
  } catch (err) {
    if (err.status !== 404) {
      logger.warn('[Tutorials] Community lookup failed:', err.message);
    }
  }
  return false;
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Helper â€” ensure tutorials DB + design doc exist
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function ensureTutorialsDb() {
  try {
    await cloudant.getDatabaseInformation({ db: DB_NAME });
  } catch (err) {
    if (err.status === 404) {
      await cloudant.putDatabase({ db: DB_NAME });
      logger.info('[Tutorials] Created tutorials database');
      await cloudant.postDocument({
        db: DB_NAME,
        document: {
          _id: '_design/tutorials',
          views: {
            by_created_at: {
              map: 'function(doc) { if (doc.created_at) emit(doc.created_at, null); }',
            },
          },
        },
      });
    }
  }
}

ensureTutorialsDb().catch(console.error);

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// POST /api/tutorials/create
// Admin only â€” creates a new tutorial with cover image upload
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

      const { userId, email, username } = extractUserInfo(req.user);
      const isAdmin = await checkAdminRole(req.user);

      // Authorization check:
      // - Admins can create any tutorial (global or for a community).
      // - Non-admins can only create tutorials for a community they are a member of.
      if (!isAdmin) {
        if (!community_id) {
          return res.status(403).json({ success: false, error: 'Only admins can create global tutorials.' });
        }

        const isMember = await isCommunityMember(userId, community_id);
        if (!isMember) {
          return res.status(403).json({ success: false, error: 'You must be a community member to publish tutorials here.' });
        }

        // Per-user tutorial creation limit for non-moderators
        const isModerator = await isCommunityModerator(userId, community_id);
        if (!isModerator) {
          const userTutorials = await cloudant.postFind({
            db: DB_NAME,
            selector: { community_id, created_by_id: userId },
            fields: ['_id'],
          });

          if (userTutorials.result.docs.length >= 3) {
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

      // Upload cover media to Cloudinary (if provided)
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

      // Build tutorial document â€” supports HTML or markdown
      const tutorial = {
        _id:               tutorialId,
        title:             title.trim(),
        description:       description.trim(),
        content:           content?.trim() || '',
        content_markdown:  content_markdown?.trim() || '',
        content_format:    content_markdown?.trim() ? 'markdown' : 'html',
        image_url,
        public_id,   // internal Cloudinary ID â€” NOT sent to frontend
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

      const response = await cloudant.postDocument({ db: DB_NAME, document: tutorial });

      if (!response.result.ok) {
        throw new Error('Cloudant did not confirm document creation');
      }

      if (public_id) await recordTutorialMedia({ tutorialId, url: image_url, publicId: public_id, resourceType: 'image' });
      if (video_public_id) await recordTutorialMedia({ tutorialId, url: video_url, publicId: video_public_id, resourceType: 'video' });

      logger.info(`[Tutorials] Created: "${title}" by ${email || 'unknown'}`);

      return res.status(201).json({
        success: true,
        message: 'Tutorial created successfully',
        data: {
          id:          tutorial._id,
          title:       tutorial.title,
          description: tutorial.description,
          content:     tutorial.content,
          content_markdown: tutorial.content_markdown,
          content_format: tutorial.content_format,
          image_url:   tutorial.image_url,
          video_url:   tutorial.video_url,
          category:    tutorial.category,
          tags:        tutorial.tags,
          community_id: tutorial.community_id,
          created_by:  tutorial.created_by,
          created_at:  tutorial.created_at,
        },
      });
    } catch (err) {
      logger.error('[Tutorials] Create error:', err.message);
      return res.status(500).json({ success: false, error: err.message });
    }
  }
);

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// POST /api/tutorials/upload-inline-image
// Auth required â€” uploads a single media file for use inside tutorial content
// Body: multipart/form-data with field "image" or "media"
// Returns: { success: true, url, public_id, resource_type }
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.post(
  '/upload-inline-image',
  ensureAuthenticated,
  uploadInline.single('image'),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ success: false, error: 'No image file provided.' });
      }

      const { userId } = extractUserInfo(req.user);
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

// Alias for new clients
router.post(
  '/upload-inline-media',
  ensureAuthenticated,
  uploadInline.single('media'),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ success: false, error: 'No media file provided.' });
      }

      const { userId } = extractUserInfo(req.user);
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

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// DELETE /api/tutorials/image
// Auth required â€” deletes an inline media asset by public_id
// Body: { public_id: "...", resource_type?: "image"|"video" }
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// GET /api/tutorials
// Public â€” returns all tutorials, newest first
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.get('/', async (req, res) => {
  try {
    // NOTE: IBM Cloudant SDK requires includeDocs at TOP level, not inside allDocsQuery
    const response = await cloudant.postAllDocs({
      db:          DB_NAME,
      includeDocs: true,
    });

    const tutorials = (response.result.rows || [])
      .map((row) => row.doc)
      .filter((doc) => doc && !doc._id.startsWith('_design'))
      .map(({ public_id, _rev, ...safe }) => safe) // strip internal fields
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    logger.debug(`[Tutorials] GET all -> ${tutorials.length} tutorial(s)`);

    return res.json({ success: true, total: tutorials.length, data: tutorials });
  } catch (err) {
    logger.error('[Tutorials] Get all error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// PUT /api/tutorials/:id
// Admin only â€” update title/description/content/image
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
      const { userId, email } = extractUserInfo(req.user);
      const isAdmin = await checkAdminRole(req.user);

      // Fetch existing document (need _rev for update)
      const existing = (await cloudant.getDocument({ db: DB_NAME, docId: id })).result;

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

      // Replace cover image if a new file was uploaded
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
        ...existing,
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

      // Cloudant update â€” must include _rev in the document body
      await cloudant.putDocument({ db: DB_NAME, docId: id, document: updated });

      logger.info(`[Tutorials] Updated: "${updated.title}" (${id})`);

      // Strip internal fields before returning
      const { public_id: _p, _rev: _r, video_public_id: _v, ...safeData } = updated;
      return res.json({ success: true, data: safeData });
    } catch (err) {
      if (err.status === 404) return res.status(404).json({ success: false, error: 'Tutorial not found' });
      logger.error('[Tutorials] Update error:', err.message);
      return res.status(500).json({ success: false, error: err.message });
    }
  }
);

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// GET /api/tutorials/:id
// Public â€” returns one tutorial by id
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.get('/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const response = await cloudant.getDocument({ db: DB_NAME, docId: id });
    const { public_id, _rev, ...safe } = response.result;
    return res.json({ success: true, data: safe });
  } catch (err) {
    if (err.status === 404) {
      return res.status(404).json({ success: false, error: 'Tutorial not found' });
    }
    logger.error('[Tutorials] Get one error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// DELETE /api/tutorials/:id
// Admin only â€” deletes Cloudinary image THEN Cloudant document
// Cloudinary failure does NOT block the Cloudant deletion
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.delete('/:id', ensureAuthenticated, async (req, res) => {
  const { id } = req.params;
  try {
    // Step 1: Fetch document for _rev + public_id
    const docResponse = await cloudant.getDocument({ db: DB_NAME, docId: id });
    const doc = docResponse.result;

    const { userId, email } = extractUserInfo(req.user);
    const isAdmin = await checkAdminRole(req.user);
    const canDelete = isAdmin
      || doc.created_by === (email || '').toLowerCase()
      || doc.created_by_id === userId
      || (doc.community_id && await isCommunityModerator(userId, doc.community_id));

    if (!canDelete) {
      return res.status(403).json({ success: false, error: 'Not authorized to delete this tutorial' });
    }

    // Step 2: Resolve Cloudinary public_id
    //   Primary:  stored public_id field
    //   Fallback: parse from image_url (handles legacy docs without public_id)
    const publicIdToDelete = doc.public_id || extractPublicId(doc.image_url);

    // Step 3: Delete Cloudinary image â€” non-blocking, DB delete happens either way
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

    // Step 4: Delete document from Cloudant
    await cloudant.deleteDocument({ db: DB_NAME, docId: id, rev: doc._rev });

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

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Multer error handler
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.use((err, req, res, _next) => {
  if (err instanceof multer.MulterError || err.message?.includes('Only')) {
    return res.status(400).json({ success: false, error: err.message });
  }
  logger.error('[Tutorials] Unexpected error:', err);
  return res.status(500).json({ success: false, error: 'Internal server error' });
});

module.exports = router;


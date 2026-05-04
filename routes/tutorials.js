// ============================================
// CloudIQ Backend - Tutorials Routes
// ============================================
// Admin-only: create, delete, upload-inline-image
// Public:     read all / read one
//
// Endpoints:
//   POST   /api/tutorials/create              — admin only, multipart/form-data
//   POST   /api/tutorials/upload-inline-image — admin only, returns image URL
//   GET    /api/tutorials                     — public
//   GET    /api/tutorials/:id                 — public
//   DELETE /api/tutorials/:id                 — admin only

const express    = require('express');
const multer     = require('multer');
const { v4: uuidv4 } = require('uuid');
const cloudant   = require('../services/cloudantClient');
const { uploadBuffer, deleteImage } = require('../services/cloudinaryService');
const { ensureAuthenticated, ensureAdmin } = require('../middleware/auth');

const router  = express.Router();
const DB_NAME = 'tutorials';

// ─────────────────────────────────────────────
// Multer configs
// ─────────────────────────────────────────────

// Cover image: 10 MB
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Only JPEG, PNG, WEBP, and GIF images are allowed.'), false);
  },
});

// Inline content images: 2 MB max
const uploadInline = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Only JPEG, PNG, and WEBP images are allowed for inline content.'), false);
  },
});

// ─────────────────────────────────────────────
// Helper — extract Cloudinary public_id from URL
// Handles: .../upload/v<ver>/<folder>/<name>.<ext>
//          .../upload/<folder>/<name>.<ext>
// ─────────────────────────────────────────────
function extractPublicId(imageUrl) {
  if (!imageUrl) return null;
  try {
    const match = imageUrl.match(/\/upload\/(?:v\d+\/)?(.+)\.[a-z]{2,5}$/i);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────
// Helper — ensure tutorials DB + design doc exist
// ─────────────────────────────────────────────
async function ensureTutorialsDb() {
  try {
    await cloudant.getDatabaseInformation({ db: DB_NAME });
  } catch (err) {
    if (err.status === 404) {
      await cloudant.putDatabase({ db: DB_NAME });
      console.log('[Tutorials] Created tutorials database');
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

// ─────────────────────────────────────────────
// POST /api/tutorials/create
// Admin only — creates a new tutorial with cover image upload
// ─────────────────────────────────────────────
router.post(
  '/create',
  ensureAuthenticated,
  ensureAdmin,
  upload.single('image'),
  async (req, res) => {
    try {
      const { title, description, content } = req.body;

      const missing = [];
      if (!title?.trim())       missing.push('title');
      if (!description?.trim()) missing.push('description');
      if (!content?.trim())     missing.push('content');

      if (missing.length > 0) {
        return res.status(400).json({
          success: false,
          error: `Missing required fields: ${missing.join(', ')}`,
        });
      }

      // Upload cover image to Cloudinary (if provided)
      let image_url = null;
      let public_id = null;

      if (req.file) {
        const result = await uploadBuffer(req.file.buffer, 'tutorials');
        image_url = result.secure_url;
        public_id = result.public_id;
      }

      const creator = req.user;
      const creatorEmail = (
        creator.email ||
        (creator.emails && creator.emails[0]?.value) ||
        'unknown'
      ).toLowerCase();

      // Build tutorial document — content is HTML string (supports inline <img> tags)
      const tutorial = {
        _id:         uuidv4(),
        title:       title.trim(),
        description: description.trim(),
        content:     content.trim(),
        image_url,
        public_id,   // internal Cloudinary ID — NOT sent to frontend
        created_by:  creatorEmail,
        created_at:  new Date().toISOString(),
      };

      const response = await cloudant.postDocument({ db: DB_NAME, document: tutorial });

      if (!response.result.ok) {
        throw new Error('Cloudant did not confirm document creation');
      }

      console.log(`[Tutorials] Created: "${title}" by ${creatorEmail}`);

      return res.status(201).json({
        success: true,
        message: 'Tutorial created successfully',
        data: {
          id:          tutorial._id,
          title:       tutorial.title,
          description: tutorial.description,
          content:     tutorial.content,
          image_url:   tutorial.image_url,
          created_by:  tutorial.created_by,
          created_at:  tutorial.created_at,
        },
      });
    } catch (err) {
      console.error('[Tutorials] Create error:', err.message);
      return res.status(500).json({ success: false, error: err.message });
    }
  }
);

// ─────────────────────────────────────────────
// POST /api/tutorials/upload-inline-image
// Admin only — uploads a single image for use inside tutorial content
// Body: multipart/form-data with field "image"
// Returns: { success: true, url: "https://res.cloudinary.com/...", public_id: "..." }
// ─────────────────────────────────────────────
router.post(
  '/upload-inline-image',
  ensureAuthenticated,
  ensureAdmin,
  uploadInline.single('image'),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ success: false, error: 'No image file provided.' });
      }

      const result = await uploadBuffer(req.file.buffer, 'tutorial_content');
      console.log(`[Tutorials] Inline image uploaded: ${result.public_id}`);

      return res.json({ success: true, url: result.secure_url, public_id: result.public_id });
    } catch (err) {
      console.error('[Tutorials] Inline image upload error:', err.message);
      return res.status(500).json({ success: false, error: err.message });
    }
  }
);

// ─────────────────────────────────────────────
// DELETE /api/tutorials/image
// Admin only — deletes an inline image from Cloudinary by public_id
// Body: { public_id: "..." }
// ─────────────────────────────────────────────
router.delete(
  '/image',
  ensureAuthenticated,
  ensureAdmin,
  async (req, res) => {
    try {
      const { public_id } = req.body;
      if (!public_id) {
        return res.status(400).json({ success: false, error: 'public_id is required' });
      }

      await deleteImage(public_id);
      console.log(`[Tutorials] Inline image deleted: ${public_id}`);

      return res.json({ success: true, message: 'Image deleted successfully' });
    } catch (err) {
      console.error('[Tutorials] Inline image delete error:', err.message);
      return res.status(500).json({ success: false, error: err.message });
    }
  }
);

// ─────────────────────────────────────────────
// GET /api/tutorials
// Public — returns all tutorials, newest first
// ─────────────────────────────────────────────
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

    console.log(`[Tutorials] GET all -> ${tutorials.length} tutorial(s)`);

    return res.json({ success: true, total: tutorials.length, data: tutorials });
  } catch (err) {
    console.error('[Tutorials] Get all error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────
// PUT /api/tutorials/:id
// Admin only — update title/description/content/image
// ─────────────────────────────────────────────
router.put(
  '/:id',
  ensureAuthenticated,
  ensureAdmin,
  upload.single('image'),
  async (req, res) => {
    const { id } = req.params;
    try {
      const { title, description, content } = req.body;

      // Fetch existing document (need _rev for update)
      const existing = (await cloudant.getDocument({ db: DB_NAME, docId: id })).result;

      let image_url = existing.image_url;
      let public_id = existing.public_id;

      // Replace cover image if a new file was uploaded
      if (req.file) {
        const oldId = existing.public_id || extractPublicId(existing.image_url);
        if (oldId) {
          try { await deleteImage(oldId); } catch (e) {
            console.error('[Tutorials] Old image delete failed (continuing):', e.message);
          }
        }
        const uploaded = await uploadBuffer(req.file.buffer, 'tutorials');
        image_url = uploaded.secure_url;
        public_id = uploaded.public_id;
      }

      const updated = {
        ...existing,
        title:       (title?.trim())       || existing.title,
        description: (description?.trim()) || existing.description,
        content:     (content?.trim())     || existing.content,
        image_url,
        public_id,
        updated_at: new Date().toISOString(),
      };

      // Cloudant update — must include _rev in the document body
      await cloudant.putDocument({ db: DB_NAME, docId: id, document: updated });

      console.log(`[Tutorials] Updated: "${updated.title}" (${id})`);

      // Strip internal fields before returning
      const { public_id: _p, _rev: _r, ...safeData } = updated;
      return res.json({ success: true, data: safeData });
    } catch (err) {
      if (err.status === 404) return res.status(404).json({ success: false, error: 'Tutorial not found' });
      console.error('[Tutorials] Update error:', err.message);
      return res.status(500).json({ success: false, error: err.message });
    }
  }
);

// ─────────────────────────────────────────────
// GET /api/tutorials/:id
// Public — returns one tutorial by id
// ─────────────────────────────────────────────
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
    console.error('[Tutorials] Get one error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────
// DELETE /api/tutorials/:id
// Admin only — deletes Cloudinary image THEN Cloudant document
// Cloudinary failure does NOT block the Cloudant deletion
// ─────────────────────────────────────────────
router.delete('/:id', ensureAuthenticated, ensureAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    // Step 1: Fetch document for _rev + public_id
    const docResponse = await cloudant.getDocument({ db: DB_NAME, docId: id });
    const doc = docResponse.result;

    // Step 2: Resolve Cloudinary public_id
    //   Primary:  stored public_id field
    //   Fallback: parse from image_url (handles legacy docs without public_id)
    const publicIdToDelete = doc.public_id || extractPublicId(doc.image_url);

    // Step 3: Delete Cloudinary image — non-blocking, DB delete happens either way
    if (publicIdToDelete) {
      try {
        await deleteImage(publicIdToDelete);
        console.log(`[Tutorials] Cloudinary image deleted: ${publicIdToDelete}`);
      } catch (cloudErr) {
        console.error('[Tutorials] Cloudinary delete failed (continuing):', cloudErr.message);
      }
    }

    // Step 4: Delete document from Cloudant
    await cloudant.deleteDocument({ db: DB_NAME, docId: id, rev: doc._rev });

    console.log(`[Tutorials] Deleted tutorial: "${doc.title}" (${id})`);
    return res.json({ success: true, message: `Tutorial "${doc.title}" deleted successfully` });
  } catch (err) {
    if (err.status === 404) {
      return res.status(404).json({ success: false, error: 'Tutorial not found' });
    }
    console.error('[Tutorials] Delete error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────
// Multer error handler
// ─────────────────────────────────────────────
router.use((err, req, res, _next) => {
  if (err instanceof multer.MulterError || err.message?.includes('Only')) {
    return res.status(400).json({ success: false, error: err.message });
  }
  console.error('[Tutorials] Unexpected error:', err);
  return res.status(500).json({ success: false, error: 'Internal server error' });
});

module.exports = router;

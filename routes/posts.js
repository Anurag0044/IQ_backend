// ============================================
// CloudIQ Backend - Posts Routes
// ============================================
// Endpoints:
//   GET  /api/posts       → fetch all posts (public)
//   POST /api/posts/create → create a post (auth required)
//   DELETE /api/posts/:id  → delete a post (owner or admin)
//   POST /api/posts/:id/like → like/unlike a post (auth required)

const express = require('express');
const multer  = require('multer');
const { v4: uuidv4 } = require('uuid');
const cloudant = require('../services/cloudantClient');
const { uploadBuffer, deleteImage } = require('../services/cloudinaryService');
const { ensureAuthenticated, checkAdminRole, extractUserInfo } = require('../middleware/auth');

const router = express.Router();
const DB = 'posts';

// ─────────────────────────────────────────────
// Multer — post images (5 MB, jpeg/png/webp)
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

function extractPublicId(url) {
  if (!url) return null;
  const match = url.match(/\/upload\/(?:v\d+\/)?(.+)\.[a-z]{2,5}$/i);
  return match ? match[1] : null;
}

// ─────────────────────────────────────────────
// GET /api/posts
// Public — returns all posts, newest first
// ─────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const response = await cloudant.postAllDocs({
      db: DB,
      includeDocs: true,
    });

    // Filter out design docs, then sort newest first
    const posts = response.result.rows
      .map((r) => r.doc)
      .filter((doc) => doc && !doc._id.startsWith('_design'))
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    res.json({ success: true, posts });
  } catch (err) {
    console.error('[POSTS] Fetch error:', err.message);
    res.status(500).json({ success: false, error: 'Failed to fetch posts' });
  }
});

// ─────────────────────────────────────────────
// POST /api/posts/create
// Auth required — creates a new post
// ─────────────────────────────────────────────
router.post('/create', ensureAuthenticated, upload.single('image'), async (req, res) => {
  try {
    const { content } = req.body;
    if (!content || !content.trim()) {
      return res.status(400).json({ success: false, error: 'Content is required' });
    }

    const { userId, email, username: appIdUsername } = extractUserInfo(req.user);

    // Try to get Cloudant profile for real-time username + avatar
    let username     = appIdUsername;
    let author_avatar = null;
    try {
      const profileDoc = (await cloudant.getDocument({ db: 'users', docId: userId })).result;
      if (profileDoc.username)         username      = profileDoc.username;
      if (profileDoc.profile_image_url) author_avatar = profileDoc.profile_image_url;
    } catch (e) { /* profile not onboarded yet — use App ID values */ }

    // Upload post image to Cloudinary if provided
    let image_url       = null;
    let image_public_id = null;
    if (req.file) {
      const result = await uploadBuffer(req.file.buffer, 'community_posts');
      image_url       = result.secure_url;
      image_public_id = result.public_id;
    }

    const newPost = {
      _id:          uuidv4(),
      user_id:      userId,
      email,
      username,
      author_avatar,          // Cloudinary URL (or null)
      content:      content.trim(),
      image_url,              // Post image
      image_public_id,
      likes:        [],
      like_count:   0,
      created_at:   new Date().toISOString(),
    };

    const response = await cloudant.postDocument({ db: DB, document: newPost });
    if (response.result.ok) {
      res.json({ success: true, post: newPost });
    } else {
      res.status(500).json({ success: false, error: 'Cloudant insert failed' });
    }
  } catch (err) {
    console.error('[POSTS] Create error:', err.message);
    res.status(500).json({ success: false, error: 'Failed to create post' });
  }
});

// ─────────────────────────────────────────────
// DELETE /api/posts/:id
// Auth required — owner can delete own post, admin can delete any
// ─────────────────────────────────────────────
router.delete('/:id', ensureAuthenticated, async (req, res) => {
  try {
    const postId = req.params.id;

    // Fetch the post
    let post;
    try {
      const docResponse = await cloudant.getDocument({ db: DB, docId: postId });
      post = docResponse.result;
    } catch (err) {
      if (err.status === 404) {
        return res.status(404).json({ success: false, error: 'Post not found' });
      }
      throw err;
    }

    const { userId } = extractUserInfo(req.user);
    const isAdmin = checkAdminRole(req.user);

    // Only owner or admin can delete
    if (post.user_id !== userId && !isAdmin) {
      return res.status(403).json({ success: false, error: 'You can only delete your own posts.' });
    }

    // Delete image from Cloudinary if it exists
    const publicId = post.image_public_id || extractPublicId(post.image_url);
    if (publicId) {
      try { await deleteImage(publicId); }
      catch (e) { console.error('[POSTS] Cloudinary delete failed:', e.message); }
    }

    const deleteResponse = await cloudant.deleteDocument({
      db: DB,
      docId: post._id,
      rev: post._rev,
    });

    if (deleteResponse.result.ok) {
      res.json({ success: true, message: 'Post deleted' });
    } else {
      res.status(500).json({ success: false, error: 'Failed to delete post' });
    }
  } catch (err) {
    console.error('[POSTS] Delete error:', err.message);
    res.status(500).json({ success: false, error: 'Failed to delete post' });
  }
});

// ─────────────────────────────────────────────
// POST /api/posts/:id/like
// Auth required — toggles like on a post
// ─────────────────────────────────────────────
router.post('/:id/like', ensureAuthenticated, async (req, res) => {
  try {
    const postId = req.params.id;
    const { email } = extractUserInfo(req.user);

    // Fetch the post
    let post;
    try {
      const docResponse = await cloudant.getDocument({ db: DB, docId: postId });
      post = docResponse.result;
    } catch (err) {
      if (err.status === 404) {
        return res.status(404).json({ success: false, error: 'Post not found' });
      }
      throw err;
    }

    if (!post.likes) post.likes = [];

    const index = post.likes.indexOf(email);
    let liked = false;

    if (index === -1) {
      // Like
      post.likes.push(email);
      liked = true;
    } else {
      // Unlike
      post.likes.splice(index, 1);
      liked = false;
    }

    post.like_count = post.likes.length;

    const updateResponse = await cloudant.postDocument({
      db: DB,
      document: post,
    });

    if (updateResponse.result.ok) {
      // Create notification for post owner (only on like, not unlike, and not self-like)
      if (liked && post.email && post.email !== email) {
        const { userId: fromUserId, username } = extractUserInfo(req.user);
        const notificationData = {
          _id: uuidv4(),
          user_id: post.user_id,
          from_user_id: fromUserId,
          type: 'like',
          post_id: post._id,
          message: `${username} liked your post`,
          read: false,
          created_at: new Date().toISOString(),
        };

        try {
          await cloudant.postDocument({
            db: 'notifications',
            document: notificationData,
          });
          
          // Emit real-time notification
          const io = req.app.get('io');
          const userSockets = req.app.get('userSockets');
          if (io && userSockets) {
            const targetSocketId = userSockets.get(post.user_id);
            if (targetSocketId) {
              io.to(targetSocketId).emit('new_notification', notificationData);
            }
          }
        } catch (notifErr) {
          console.error('[POSTS] Notification create error:', notifErr.message);
          // Don't fail the like if notification fails
        }
      }

      res.json({
        success: true,
        liked,
        likesCount: post.like_count,
      });
    } else {
      res.status(500).json({ success: false, error: 'Failed to update post' });
    }
  } catch (err) {
    console.error('[POSTS] Like error:', err.message);
    res.status(500).json({ success: false, error: 'Failed to like post' });
  }
});

module.exports = router;

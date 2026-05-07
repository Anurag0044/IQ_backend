// ============================================
// CloudIQ Backend - Posts Routes
// ============================================
// Endpoints:
//   GET  /api/posts       → fetch all posts (public)
//   POST /api/posts/create → create a post (auth required)
//   DELETE /api/posts/:id  → delete a post (owner or admin)
//   POST /api/posts/:id/like → like/unlike a post (auth required)

const express = require('express');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const cloudant = require('../services/cloudantClient');
const { uploadImage, uploadVideo, deleteUploadedMedia } = require('../services/mediaService');
const { resolveSenderInfo, createNotification } = require('../services/notificationService');
const { ensureAuthenticated, checkAdminRole, extractUserInfo } = require('../middleware/auth');

const router = express.Router();
const DB = 'posts';

// ─────────────────────────────────────────────
// Multer — post images/videos (image 5 MB, video 50 MB)
// ─────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
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
    else cb(new Error('Only JPEG, PNG, WEBP, MP4, WEBM, or MOV videos are allowed.'), false);
  },
});

function extractPublicId(url) {
  if (!url) return null;
  const match = url.match(/\/upload\/(?:v\d+\/)?(.+)\.[a-z]{2,5}$/i);
  return match ? match[1] : null;
}

async function isCommunityModerator(userId, communityId) {
  if (!userId || !communityId) return false;
  try {
    const community = (await cloudant.getDocument({ db: 'communities', docId: communityId })).result;
    if (community.owner_id === userId) return true;
    if (Array.isArray(community.co_admin_ids) && community.co_admin_ids.includes(userId)) return true;
  } catch (err) {
    if (err.status !== 404) {
      console.warn('[POSTS] Community lookup failed:', err.message);
    }
  }
  return false;
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
router.post('/create', ensureAuthenticated, upload.fields([
  { name: 'image', maxCount: 1 },
  { name: 'video', maxCount: 1 },
]), async (req, res) => {
  try {
    const { content } = req.body;
    const communityId = req.body.community_id || req.body.communityId || null;
    if (!content || !content.trim()) {
      return res.status(400).json({ success: false, error: 'Content is required' });
    }

    const { userId, email, username: appIdUsername } = extractUserInfo(req.user);

    // Try to get Cloudant profile for real-time username + avatar
    let username = appIdUsername;
    let author_avatar = null;
    try {
      const profileDoc = (await cloudant.getDocument({ db: 'users', docId: userId })).result;
      if (profileDoc.username) username = profileDoc.username;
      if (profileDoc.profile_image_url) author_avatar = profileDoc.profile_image_url;
    } catch (e) { /* profile not onboarded yet — use App ID values */ }

    const postId = uuidv4();

    const imageFile = req.files?.image?.[0] || null;
    const videoFile = req.files?.video?.[0] || null;

    if (imageFile && imageFile.size > 5 * 1024 * 1024) {
      return res.status(400).json({ success: false, error: 'Image must be 5MB or smaller' });
    }
    if (videoFile && videoFile.size > 50 * 1024 * 1024) {
      return res.status(400).json({ success: false, error: 'Video must be 50MB or smaller' });
    }
    if (imageFile && videoFile) {
      return res.status(400).json({ success: false, error: 'Upload either an image or a video, not both' });
    }

    // Upload post media to Cloudinary if provided
    let image_url = null;
    let image_public_id = null;
    let video_url = null;
    let video_public_id = null;
    let media_type = null;

    if (imageFile) {
      const result = await uploadImage({
        buffer: imageFile.buffer,
        folder: 'community_posts',
        ownerId: userId,
        contextType: 'post',
        contextId: postId,
        mimeType: imageFile.mimetype,
        sizeBytes: imageFile.size,
      });
      image_url = result.secure_url;
      image_public_id = result.public_id;
      media_type = 'image';
    }

    if (videoFile) {
      const result = await uploadVideo({
        buffer: videoFile.buffer,
        folder: 'community_post_videos',
        ownerId: userId,
        contextType: 'post',
        contextId: postId,
        mimeType: videoFile.mimetype,
        sizeBytes: videoFile.size,
      });
      video_url = result.secure_url;
      video_public_id = result.public_id;
      media_type = 'video';
    }

    let community_name = 'General';
    let community_color = null;
    let community_id = null;

    if (communityId) {
      try {
        const communityDoc = (await cloudant.getDocument({ db: 'communities', docId: communityId })).result;
        community_id = communityDoc._id;
        community_name = communityDoc.name || community_name;
        community_color = communityDoc.color || null;
      } catch (err) {
        if (err.status === 404) {
          return res.status(404).json({ success: false, error: 'Community not found' });
        }
        throw err;
      }
    }

    const newPost = {
      _id: postId,
      user_id: userId,
      email,
      username,
      author_avatar,          // Cloudinary URL (or null)
      content: content.trim(),
      image_url,              // Post image
      image_public_id,
      video_url,
      video_public_id,
      media_type,
      community_id,
      community_name,
      community_color,
      likes: [],
      like_count: 0,
      created_at: new Date().toISOString(),
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
    const isAdmin = await checkAdminRole(req.user);
    const isCommunityMod = await isCommunityModerator(userId, post.community_id);

    // Only owner or admin can delete
    if (post.user_id !== userId && !isAdmin && !isCommunityMod) {
      return res.status(403).json({ success: false, error: 'You can only delete your own posts.' });
    }

    // Delete image from Cloudinary if it exists
    const imagePublicId = post.image_public_id || extractPublicId(post.image_url);
    if (imagePublicId) {
      try { await deleteUploadedMedia(imagePublicId, 'image'); }
      catch (e) { console.error('[POSTS] Cloudinary image delete failed:', e.message); }
    }

    if (post.video_public_id) {
      try { await deleteUploadedMedia(post.video_public_id, 'video'); }
      catch (e) { console.error('[POSTS] Cloudinary video delete failed:', e.message); }
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
    const { userId: fromUserId, email, username: appIdUsername } = extractUserInfo(req.user);

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
      const recipientId = post.user_id;
      const isSelfLike = recipientId === fromUserId || (post.email && post.email === email);

      if (liked && recipientId && !isSelfLike) {
        try {
          const { senderName, senderAvatar } = await resolveSenderInfo(
            cloudant,
            fromUserId,
            appIdUsername,
            req.user?.picture || null
          );

          await createNotification({
            cloudant,
            io: req.app.get('io'),
            userSockets: req.app.get('userSockets'),
            recipientId,
            senderId: fromUserId,
            senderName,
            senderAvatar,
            type: 'post_like',
            message: `${senderName} liked your post`,
            postId: post._id,
            targetType: 'post',
            targetId: post._id,
          });
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

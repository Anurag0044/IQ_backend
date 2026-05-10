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
const { TTLCache } = require('../services/cacheService');
const logger = require('../utils/logger');

const router = express.Router();
const DB = 'posts';
const postsCache = new TTLCache(15_000, 20);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
const IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const VIDEO_MIME_TYPES = new Set(['video/mp4', 'video/webm', 'video/quicktime']);
const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'mov']);

function isCloudantRateLimit(err) {
  const status = err?.status || err?.statusCode;
  const message = String(err?.message || '').toLowerCase();
  return status === 429 || message.includes('too_many_requests') || message.includes('rate limit');
}

// ─────────────────────────────────────────────
// Multer — post images/videos (image 5 MB, video 50 MB)
// ─────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_VIDEO_BYTES, files: 2 },
  fileFilter: (_, file, cb) => {
    if (IMAGE_MIME_TYPES.has(file.mimetype) || VIDEO_MIME_TYPES.has(file.mimetype)) cb(null, true);
    else cb(new Error('Only JPEG, PNG, WEBP, MP4, WEBM, or MOV videos are allowed.'), false);
  },
});

function extractPublicId(url) {
  if (!url) return null;
  const match = url.match(/\/upload\/(?:v\d+\/)?(.+)\.[a-z]{2,5}$/i);
  return match ? match[1] : null;
}

function getExtension(filename) {
  const match = String(filename || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  return match ? match[1] : '';
}

function validatePostMediaFile(file, expectedType) {
  if (!file) return null;

  if (expectedType === 'image') {
    if (!IMAGE_MIME_TYPES.has(file.mimetype)) return 'Only JPEG, PNG, or WEBP images are allowed.';
    if (file.size > MAX_IMAGE_BYTES) return 'Image must be 5MB or smaller';
    return null;
  }

  if (!VIDEO_MIME_TYPES.has(file.mimetype)) return 'Only MP4, WEBM, or MOV videos are allowed.';
  if (!VIDEO_EXTENSIONS.has(getExtension(file.originalname))) {
    return 'Only MP4, WEBM, or MOV videos are allowed.';
  }
  if (file.size > MAX_VIDEO_BYTES) return 'Video must be 100MB or smaller';
  return null;
}

async function cleanupUploadedPostMedia(mediaItems) {
  for (const item of mediaItems || []) {
    try {
      await deleteUploadedMedia(item.publicId, item.resourceType || item.type || 'image');
    } catch (e) {
      console.error('[POSTS] Cloudinary cleanup failed:', e.message);
    }
  }
}

function normalizePostMedia(post) {
  if (Array.isArray(post.media) && post.media.length > 0) {
    return post.media
      .map((item) => ({
        type: item.type || item.mediaType || item.resource_type || 'image',
        url: item.url || item.secure_url || item.mediaUrl || null,
        publicId: item.publicId || item.public_id || item.mediaPublicId || null,
        resourceType: item.resourceType || item.resource_type || item.type || 'image',
      }))
      .filter((item) => item.url || item.publicId);
  }

  const media = [];
  const imagePublicId = post.image_public_id || (post.mediaType === 'image' ? post.mediaPublicId : null) || extractPublicId(post.image_url);
  const videoPublicId = post.video_public_id || (post.mediaType === 'video' ? post.mediaPublicId : null) || extractPublicId(post.video_url);

  if (post.image_url || imagePublicId) {
    media.push({ type: 'image', url: post.image_url || null, publicId: imagePublicId, resourceType: 'image' });
  }
  if (post.video_url || videoPublicId) {
    media.push({ type: 'video', url: post.video_url || null, publicId: videoPublicId, resourceType: 'video' });
  }
  if (!media.length && (post.mediaUrl || post.mediaPublicId)) {
    media.push({
      type: post.mediaType || 'image',
      url: post.mediaUrl || null,
      publicId: post.mediaPublicId || null,
      resourceType: post.mediaType || 'image',
    });
  }
  return media;
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
    const limit = Math.max(1, Math.min(50, Number(req.query.limit || 25)));
    const before = req.query.before ? String(req.query.before) : null;
    const cacheKey = `posts:${limit}:${before || 'latest'}`;
    const cached = postsCache.get(cacheKey);
    if (cached) {
      logger.debug('[API] duplicate request prevented /api/posts');
      return res.json(cached);
    }

    const response = await cloudant.postView({
      db: DB,
      ddoc: 'posts',
      view: 'by_created_at',
      startKey: before || {},
      descending: true,
      includeDocs: true,
      limit,
    });

    const posts = (response.result.rows || [])
      .map((r) => r.doc)
      .filter((doc) => doc && !doc._id.startsWith('_design'));

    const payload = {
      success: true,
      posts,
      nextBefore: posts.length ? posts[posts.length - 1].created_at : null,
    };
    postsCache.set(cacheKey, payload);
    return res.json(payload);
  } catch (err) {
    console.error('[POSTS] Fetch error:', err.message);
    if (isCloudantRateLimit(err)) {
      return res.status(429).json({ success: false, error: 'Cloudant rate limit reached. Please retry shortly.' });
    }
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
  { name: 'media', maxCount: 2 },
]), async (req, res) => {
  const uploadedMedia = [];
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

    const mediaFiles = req.files?.media || [];
    const imageFile = req.files?.image?.[0] || mediaFiles.find((file) => IMAGE_MIME_TYPES.has(file.mimetype)) || null;
    const videoFile = req.files?.video?.[0] || mediaFiles.find((file) => VIDEO_MIME_TYPES.has(file.mimetype)) || null;

    const imageValidationError = validatePostMediaFile(imageFile, 'image');
    if (imageValidationError) return res.status(400).json({ success: false, error: imageValidationError });

    const videoValidationError = validatePostMediaFile(videoFile, 'video');
    if (videoValidationError) return res.status(400).json({ success: false, error: videoValidationError });

    // Upload post media to Cloudinary if provided
    let image_url = null;
    let image_public_id = null;
    let video_url = null;
    let video_public_id = null;
    let media_type = null;
    const media = [];

    if (imageFile) {
      const result = await uploadImage({
        buffer: imageFile.buffer,
        folder: 'cloudiq/posts/images',
        ownerId: userId,
        contextType: 'post',
        contextId: postId,
        mimeType: imageFile.mimetype,
        sizeBytes: imageFile.size,
      });
      image_url = result.secure_url;
      image_public_id = result.public_id;
      media_type = 'image';
      const item = {
        type: 'image',
        url: image_url,
        publicId: image_public_id,
        resourceType: 'image',
        mimeType: imageFile.mimetype,
        sizeBytes: imageFile.size,
      };
      media.push(item);
      uploadedMedia.push(item);
    }

    if (videoFile) {
      logger.info('[POSTS] video upload started', { postId, bytes: videoFile.size, mimeType: videoFile.mimetype });
      const result = await uploadVideo({
        buffer: videoFile.buffer,
        folder: 'cloudiq/posts/videos',
        ownerId: userId,
        contextType: 'post',
        contextId: postId,
        mimeType: videoFile.mimetype,
        sizeBytes: videoFile.size,
        cloudinaryOptions: {
          quality: 'auto',
          eager: [
            { streaming_profile: 'auto', format: 'm3u8' },
            { quality: 'auto', format: 'mp4' },
          ],
          eagerAsync: true,
        },
      });
      video_url = result.secure_url;
      video_public_id = result.public_id;
      media_type = 'video';
      const item = {
        type: 'video',
        url: video_url,
        publicId: video_public_id,
        resourceType: 'video',
        mimeType: videoFile.mimetype,
        sizeBytes: videoFile.size,
        format: result.format || null,
      };
      media.push(item);
      uploadedMedia.push(item);
      logger.info('[POSTS] video upload completed', { postId, publicId: video_public_id });
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
          await cleanupUploadedPostMedia(uploadedMedia);
          return res.status(404).json({ success: false, error: 'Community not found' });
        }
        throw err;
      }
    }
    const primaryMedia = media.find((item) => item.type === 'video') || media[0] || null;

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
      media_type: primaryMedia?.type || media_type,
      mediaUrl: primaryMedia?.url || null,
      mediaType: primaryMedia?.type || null,
      mediaPublicId: primaryMedia?.publicId || null,
      media,
      community_id,
      community_name,
      community_color,
      likes: [],
      like_count: 0,
      created_at: new Date().toISOString(),
    };

    const response = await cloudant.postDocument({ db: DB, document: newPost });
    if (response.result.ok) {
      postsCache.clear();
      logger.info('[POSTS] post created', { postId, mediaType: newPost.mediaType, mediaCount: media.length });
      res.json({ success: true, post: newPost });
    } else {
      await cleanupUploadedPostMedia(uploadedMedia);
      res.status(500).json({ success: false, error: 'Cloudant insert failed' });
    }
  } catch (err) {
    await cleanupUploadedPostMedia(uploadedMedia);
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

    const mediaToDelete = normalizePostMedia(post);
    const deletedPublicIds = new Set();
    for (const mediaItem of mediaToDelete) {
      if (!mediaItem.publicId || deletedPublicIds.has(mediaItem.publicId)) continue;
      deletedPublicIds.add(mediaItem.publicId);
      try {
        await deleteUploadedMedia(mediaItem.publicId, mediaItem.resourceType || mediaItem.type || 'image');
      } catch (e) {
        console.error('[POSTS] Cloudinary media delete failed:', e.message);
      }
    }

    const deleteResponse = await cloudant.deleteDocument({
      db: DB,
      docId: post._id,
      rev: post._rev,
    });

    if (deleteResponse.result.ok) {
      postsCache.clear();
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
      postsCache.clear();
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

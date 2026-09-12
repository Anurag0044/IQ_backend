const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../services/firestoreClient');
const { resolveSenderInfo, createNotification } = require('../services/notificationService');
const { ensureAuthenticated, extractUserInfo, checkAdminRole } = require('../middleware/auth');

const router = express.Router();
const DB = 'comments';

async function isCommunityModerator(userId, communityId) {
  if (!userId || !communityId) return false;
  try {
    const community = await db.getDoc('communities', communityId);
    if (community.owner_id === userId) return true;
    if (Array.isArray(community.co_admin_ids) && community.co_admin_ids.includes(userId)) return true;
  } catch (err) {
    if (err.status !== 404) {
      console.warn('[COMMENTS] Community lookup failed:', err.message);
    }
  }
  return false;
}

// ─────────────────────────────────────────────
// POST /api/comments/create
// ─────────────────────────────────────────────
router.post('/create', ensureAuthenticated, async (req, res) => {
  try {
    const { post_id, content, parent_id } = req.body;

    if (!post_id || !content || !content.trim()) {
      return res.status(400).json({ success: false, error: 'post_id and content are required' });
    }

    const { userId, username, email } = extractUserInfo(req);

    const newComment = {
      post_id,
      user_id: userId,
      username,
      email,
      content: content.trim(),
      parent_id: parent_id || null,
      created_at: new Date().toISOString(),
    };

    const id = uuidv4();
    await db.setDoc(DB, id, newComment);
    newComment._id = id;

    const io = req.app.get('io');
    if (io) {
      io.to(`post:${post_id}`).emit('comment_created', { ...newComment, replies: [] });
    }

    try {
      const { senderName, senderAvatar } = await resolveSenderInfo(
        userId,
        username,
        req.firebaseUser?.picture || null
      );

      let postAuthorId = null;

      try {
        const postDoc = await db.getDoc('posts', post_id);
        postAuthorId = postDoc.user_id || null;
      } catch (err) {
        if (err.status !== 404) {
          console.warn('[COMMENTS] Post fetch error for notification:', err.message);
        }
      }

      if (postAuthorId && postAuthorId !== userId) {
        await createNotification({
          io: req.app.get('io'),
          userSockets: req.app.get('userSockets'),
          recipientId: postAuthorId,
          senderId: userId,
          senderName,
          senderAvatar,
          type: 'post_reply',
          message: `${senderName} replied to your post`,
          postId: post_id,
          commentId: newComment._id,
          targetType: 'post',
          targetId: post_id,
        });
      }

      if (parent_id) {
        try {
          const parent = await db.getDoc(DB, parent_id);
          if (parent?.user_id && parent.user_id !== userId && parent.user_id !== postAuthorId) {
            await createNotification({
              io: req.app.get('io'),
              userSockets: req.app.get('userSockets'),
              recipientId: parent.user_id,
              senderId: userId,
              senderName,
              senderAvatar,
              type: 'comment_reply',
              message: `${senderName} replied to your comment`,
              postId: post_id,
              commentId: newComment._id,
              targetType: 'comment',
              targetId: parent_id,
            });
          }
        } catch (err) {
          if (err.status !== 404) {
            console.warn('[COMMENTS] Parent fetch error for notification:', err.message);
          }
        }
      }
    } catch (notifErr) {
      console.error('[COMMENTS] Notification create error:', notifErr.message);
    }

    res.json({ success: true, comment: newComment });
  } catch (err) {
    console.error('[COMMENTS] Create error:', err.message);
    res.status(500).json({ success: false, error: 'Failed to create comment' });
  }
});

// ─────────────────────────────────────────────
// GET /api/comments/:post_id
// ─────────────────────────────────────────────
router.get('/:post_id', async (req, res) => {
  try {
    const postId = req.params.post_id;

    const docs = await db.queryDocs(DB, [['post_id', '==', postId]]);
    docs.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

    const commentMap = {};
    const rootComments = [];

    docs.forEach(doc => {
      doc.replies = [];
      commentMap[doc._id] = doc;
    });

    docs.forEach(doc => {
      if (doc.parent_id && commentMap[doc.parent_id]) {
        commentMap[doc.parent_id].replies.push(doc);
      } else {
        rootComments.push(doc);
      }
    });

    res.json({ success: true, comments: rootComments });
  } catch (err) {
    console.error('[COMMENTS] Fetch error:', err.message);
    res.status(500).json({ success: false, error: 'Failed to fetch comments' });
  }
});

// ─────────────────────────────────────────────
// DELETE /api/comments/:id
// ─────────────────────────────────────────────
router.delete('/:id', ensureAuthenticated, async (req, res) => {
  try {
    const { userId } = extractUserInfo(req);
    const isAdmin = await checkAdminRole(req);

    let comment;
    try {
      comment = await db.getDoc(DB, req.params.id);
    } catch (err) {
      if (err.status === 404) return res.status(404).json({ success: false, error: 'Comment not found' });
      throw err;
    }

    let canDelete = comment.user_id === userId || isAdmin;

    if (!canDelete && comment.post_id) {
      try {
        const post = await db.getDoc('posts', comment.post_id);
        if (post.user_id === userId) {
          canDelete = true;
        } else if (post.community_id) {
          const isCommunityMod = await isCommunityModerator(userId, post.community_id);
          if (isCommunityMod) canDelete = true;
        }
      } catch (err) {
        if (err.status !== 404) {
          console.warn('[COMMENTS] Post lookup failed:', err.message);
        }
      }
    }

    if (!canDelete) {
      return res.status(403).json({ success: false, error: 'Not authorized to delete this comment' });
    }

    await db.deleteDoc(DB, comment._id);
    return res.json({ success: true, message: 'Comment deleted' });
  } catch (err) {
    console.error('[COMMENTS] Delete error:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to delete comment' });
  }
});

module.exports = router;

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const cloudant = require('../services/cloudantClient');
const { ensureAuthenticated, extractUserInfo } = require('../middleware/auth');

const router = express.Router();
const DB = 'comments';

// ─────────────────────────────────────────────
// POST /api/comments/create
// Auth required — creates a comment or reply
// ─────────────────────────────────────────────
router.post('/create', ensureAuthenticated, async (req, res) => {
  try {
    const { post_id, content, parent_id } = req.body;

    if (!post_id || !content || !content.trim()) {
      return res.status(400).json({ success: false, error: 'post_id and content are required' });
    }

    const { userId, username, email } = extractUserInfo(req.user);

    const newComment = {
      _id: uuidv4(),
      post_id,
      user_id: userId,
      username,
      email,
      content: content.trim(),
      parent_id: parent_id || null,
      created_at: new Date().toISOString(),
    };

    const response = await cloudant.postDocument({
      db: DB,
      document: newComment,
    });

    if (response.result.ok) {
      res.json({ success: true, comment: newComment });
    } else {
      res.status(500).json({ success: false, error: 'Failed to create comment' });
    }
  } catch (err) {
    console.error('[COMMENTS] Create error:', err.message);
    res.status(500).json({ success: false, error: 'Failed to create comment' });
  }
});

// ─────────────────────────────────────────────
// GET /api/comments/:post_id
// Public — Returns comments nested with replies
// ─────────────────────────────────────────────
router.get('/:post_id', async (req, res) => {
  try {
    const postId = req.params.post_id;

    let response;
    try {
      response = await cloudant.postView({
        db: DB,
        ddoc: 'comments',
        view: 'by_post',
        key: postId,
        includeDocs: true,
      });
    } catch (viewErr) {
      console.warn('[COMMENTS] View query failed, falling back to Mango find:', viewErr.message);
      response = await cloudant.postFind({
        db: DB,
        selector: { post_id: postId }
      });
    }

    // Handle both postView and postFind response structures
    const isView = response.result.rows !== undefined;
    let docs = isView 
      ? response.result.rows.map(r => r.doc).filter(doc => doc)
      : response.result.docs;

    // Sort chronologically
    docs.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

    // Build the nested structure
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

module.exports = router;

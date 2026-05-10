const express = require('express');
const { ensureAuthenticated } = require('../middleware/auth');
const brainstormService = require('../services/brainstormService');

const router = express.Router();

function sendServiceResult(res, result, successStatus = 200) {
  if (!result.ok) {
    return res.status(result.status || 400).json({
      success: false,
      error: result.error || 'Brainstorm request failed',
      code: result.code || undefined,
    });
  }
  const { ok, status, error, code, ...payload } = result;
  return res.status(successStatus).json({ success: true, ...payload });
}

function handleError(res, err, fallback = 'Brainstorm request failed') {
  const status = err.status || err.statusCode || 500;
  return res.status(status).json({
    success: false,
    error: err.message || fallback,
    code: err.code || undefined,
  });
}

router.use(ensureAuthenticated);

router.post('/rooms', async (req, res) => {
  try {
    const result = await brainstormService.createRoom({
      user: req.user,
      communityId: req.body?.communityId || req.body?.community_id,
      title: req.body?.title,
    });
    return sendServiceResult(res, result, 201);
  } catch (err) {
    return handleError(res, err, 'Failed to create brainstorm room');
  }
});

router.get('/rooms/:roomId', async (req, res) => {
  try {
    const auth = await brainstormService.authorizeRoomAccess(req.user, req.params.roomId);
    if (!auth.ok) return sendServiceResult(res, auth);
    const whiteboard = await brainstormService.getWhiteboard(req.params.roomId);
    return res.json({ success: true, room: auth.room, whiteboard });
  } catch (err) {
    return handleError(res, err, 'Failed to load brainstorm room');
  }
});

router.post('/rooms/:roomId/join', async (req, res) => {
  try {
    const result = await brainstormService.joinRoom({ user: req.user, roomId: req.params.roomId });
    return sendServiceResult(res, result);
  } catch (err) {
    return handleError(res, err, 'Failed to join brainstorm room');
  }
});

router.post('/rooms/:roomId/leave', async (req, res) => {
  try {
    const result = await brainstormService.leaveRoom({ user: req.user, roomId: req.params.roomId });
    return sendServiceResult(res, result);
  } catch (err) {
    return handleError(res, err, 'Failed to leave brainstorm room');
  }
});

router.post('/rooms/:roomId/sync', async (req, res) => {
  try {
    const auth = await brainstormService.authorizeRoomAccess(req.user, req.params.roomId);
    if (!auth.ok) return sendServiceResult(res, auth);
    const whiteboard = await brainstormService.syncWhiteboard({
      roomId: req.params.roomId,
      whiteboard: req.body?.whiteboard || req.body || {},
      userId: auth.userId,
    });
    return res.json({ success: true, whiteboard });
  } catch (err) {
    return handleError(res, err, 'Failed to sync whiteboard');
  }
});

router.post('/rooms/:roomId/clear', async (req, res) => {
  try {
    const auth = await brainstormService.authorizeRoomAccess(req.user, req.params.roomId);
    if (!auth.ok) return sendServiceResult(res, auth);
    const whiteboard = await brainstormService.clearWhiteboard({
      roomId: req.params.roomId,
      userId: auth.userId,
    });
    return res.json({ success: true, whiteboard });
  } catch (err) {
    return handleError(res, err, 'Failed to clear whiteboard');
  }
});

router.post('/rooms/:roomId/notes', async (req, res) => {
  try {
    const auth = await brainstormService.authorizeRoomAccess(req.user, req.params.roomId);
    if (!auth.ok) return sendServiceResult(res, auth);
    const note = await brainstormService.addStickyNote({
      roomId: req.params.roomId,
      note: req.body?.note || req.body || {},
      userId: auth.userId,
    });
    return res.status(201).json({ success: true, note });
  } catch (err) {
    return handleError(res, err, 'Failed to add sticky note');
  }
});

router.post('/rooms/:roomId/connectors', async (req, res) => {
  try {
    const auth = await brainstormService.authorizeRoomAccess(req.user, req.params.roomId);
    if (!auth.ok) return sendServiceResult(res, auth);
    const connector = await brainstormService.addConnector({
      roomId: req.params.roomId,
      connector: req.body?.connector || req.body || {},
      userId: auth.userId,
    });
    return res.status(201).json({ success: true, connector });
  } catch (err) {
    return handleError(res, err, 'Failed to add connector');
  }
});

router.delete('/rooms/:roomId', async (req, res) => {
  try {
    const result = await brainstormService.deleteRoom({ user: req.user, roomId: req.params.roomId });
    return sendServiceResult(res, result);
  } catch (err) {
    return handleError(res, err, 'Failed to delete brainstorm room');
  }
});

router.post('/ai/generate', async (req, res) => {
  try {
    const result = await brainstormService.runAiAction({
      user: req.user,
      action: 'generate',
      prompt: req.body?.prompt,
      roomId: req.body?.roomId || req.body?.room_id || null,
    });
    return sendServiceResult(res, result);
  } catch (err) {
    return handleError(res, err, 'Orion failed to generate ideas');
  }
});

router.post('/ai/expand', async (req, res) => {
  try {
    const result = await brainstormService.runAiAction({
      user: req.user,
      action: 'expand',
      prompt: req.body?.prompt || req.body?.idea,
      roomId: req.body?.roomId || req.body?.room_id || null,
    });
    return sendServiceResult(res, result);
  } catch (err) {
    return handleError(res, err, 'Orion failed to expand the idea');
  }
});

router.post('/ai/project', async (req, res) => {
  try {
    const result = await brainstormService.runAiAction({
      user: req.user,
      action: 'project',
      prompt: req.body?.prompt || req.body?.idea,
      roomId: req.body?.roomId || req.body?.room_id || null,
    });
    return sendServiceResult(res, result);
  } catch (err) {
    return handleError(res, err, 'Orion failed to convert the idea');
  }
});

module.exports = router;

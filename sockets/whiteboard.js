const brainstormService = require('../services/brainstormService');
const logger = require('../utils/logger');

const MIN_SYNC_INTERVAL_MS = 250;

function emitWhiteboardError(socket, code, message, extra = {}) {
  socket.emit('whiteboard_error', { code, message, ...extra });
}

function normalizeRoomId(payload = {}) {
  return String(payload.roomId || payload.room_id || '').trim();
}

function attachWhiteboardSocketHandlers({ io, socket }) {
  socket.data.whiteboardRooms = socket.data.whiteboardRooms || new Set();
  socket.data.whiteboardLastSyncAt = socket.data.whiteboardLastSyncAt || new Map();

  socket.on('whiteboard:create_room', async (payload = {}) => {
    try {
      if (!socket.data.userId) {
        emitWhiteboardError(socket, 'not_registered', 'Register your socket before creating whiteboard rooms');
        return;
      }
      const result = await brainstormService.createRoom({
        user: {
          sub: socket.data.userId,
          email: socket.data.email,
          name: socket.data.username,
        },
        communityId: payload.communityId || payload.community_id,
        title: payload.title,
      });
      if (!result.ok) {
        emitWhiteboardError(socket, 'create_room_failed', result.error, { status: result.status });
        return;
      }
      socket.emit('whiteboard:room_created', { room: result.room });
    } catch (err) {
      emitWhiteboardError(socket, 'create_room_failed', err.message);
    }
  });

  socket.on('whiteboard:join_room', async (payload = {}) => {
    const roomId = normalizeRoomId(payload);
    try {
      const auth = await brainstormService.authorizeSocketRoomAccess(socket, roomId);
      if (!auth.ok) {
        emitWhiteboardError(socket, 'join_forbidden', auth.error, { roomId, status: auth.status });
        return;
      }
      socket.join(`whiteboard:${roomId}`);
      socket.data.whiteboardRooms.add(roomId);
      await brainstormService.markUserPresence({
        roomId,
        userId: auth.userId,
        status: 'online',
        socketId: socket.id,
      });
      const whiteboard = await brainstormService.getWhiteboard(roomId);
      socket.emit('whiteboard:room_joined', { roomId, room: auth.room, whiteboard });
      socket.to(`whiteboard:${roomId}`).emit('whiteboard:user_joined', {
        roomId,
        userId: auth.userId,
        at: new Date().toISOString(),
      });
      logger.info('[WHITEBOARD] user joined', { roomId, userId: auth.userId });
    } catch (err) {
      emitWhiteboardError(socket, 'join_failed', err.message, { roomId });
    }
  });

  socket.on('whiteboard:leave_room', async (payload = {}) => {
    const roomId = normalizeRoomId(payload);
    const userId = socket.data.userId;
    if (!roomId) return;
    socket.leave(`whiteboard:${roomId}`);
    socket.data.whiteboardRooms.delete(roomId);
    if (userId) {
      await brainstormService.markUserPresence({ roomId, userId, status: 'offline', socketId: socket.id }).catch(() => {});
      socket.to(`whiteboard:${roomId}`).emit('whiteboard:user_left', { roomId, userId, at: new Date().toISOString() });
    }
  });

  socket.on('whiteboard:sync_canvas', async (payload = {}) => {
    const roomId = normalizeRoomId(payload);
    try {
      const now = Date.now();
      const last = socket.data.whiteboardLastSyncAt.get(roomId) || 0;
      if (now - last < MIN_SYNC_INTERVAL_MS) {
        emitWhiteboardError(socket, 'sync_throttled', 'Whiteboard updates are arriving too quickly', { roomId });
        return;
      }
      socket.data.whiteboardLastSyncAt.set(roomId, now);

      const auth = await brainstormService.authorizeSocketRoomAccess(socket, roomId);
      if (!auth.ok) {
        emitWhiteboardError(socket, 'sync_forbidden', auth.error, { roomId, status: auth.status });
        return;
      }
      const whiteboard = await brainstormService.syncWhiteboard({
        roomId,
        whiteboard: payload.whiteboard || payload,
        userId: auth.userId,
      });
      socket.to(`whiteboard:${roomId}`).emit('whiteboard:canvas_synced', {
        roomId,
        whiteboard,
        mutationId: payload.mutationId || payload.mutation_id || null,
        sourceSocketId: socket.id,
      });
    } catch (err) {
      emitWhiteboardError(socket, err.code || 'sync_failed', err.message, { roomId });
    }
  });

  socket.on('whiteboard:clear_canvas', async (payload = {}) => {
    const roomId = normalizeRoomId(payload);
    try {
      const auth = await brainstormService.authorizeSocketRoomAccess(socket, roomId);
      if (!auth.ok) {
        emitWhiteboardError(socket, 'clear_forbidden', auth.error, { roomId, status: auth.status });
        return;
      }
      const whiteboard = await brainstormService.clearWhiteboard({ roomId, userId: auth.userId });
      io.to(`whiteboard:${roomId}`).emit('whiteboard:canvas_cleared', {
        roomId,
        whiteboard,
        mutationId: payload.mutationId || payload.mutation_id || null,
        sourceSocketId: socket.id,
      });
    } catch (err) {
      emitWhiteboardError(socket, err.code || 'clear_failed', err.message, { roomId });
    }
  });

  socket.on('whiteboard:add_sticky_note', async (payload = {}) => {
    const roomId = normalizeRoomId(payload);
    try {
      const auth = await brainstormService.authorizeSocketRoomAccess(socket, roomId);
      if (!auth.ok) {
        emitWhiteboardError(socket, 'note_forbidden', auth.error, { roomId, status: auth.status });
        return;
      }
      const note = await brainstormService.addStickyNote({
        roomId,
        note: payload.note || payload,
        userId: auth.userId,
      });
      io.to(`whiteboard:${roomId}`).emit('whiteboard:sticky_note_added', {
        roomId,
        note,
        mutationId: payload.mutationId || payload.mutation_id || null,
        sourceSocketId: socket.id,
      });
    } catch (err) {
      emitWhiteboardError(socket, err.code || 'note_failed', err.message, { roomId });
    }
  });

  socket.on('whiteboard:add_connector', async (payload = {}) => {
    const roomId = normalizeRoomId(payload);
    try {
      const auth = await brainstormService.authorizeSocketRoomAccess(socket, roomId);
      if (!auth.ok) {
        emitWhiteboardError(socket, 'connector_forbidden', auth.error, { roomId, status: auth.status });
        return;
      }
      const connector = await brainstormService.addConnector({
        roomId,
        connector: payload.connector || payload,
        userId: auth.userId,
      });
      io.to(`whiteboard:${roomId}`).emit('whiteboard:connector_added', {
        roomId,
        connector,
        mutationId: payload.mutationId || payload.mutation_id || null,
        sourceSocketId: socket.id,
      });
    } catch (err) {
      emitWhiteboardError(socket, err.code || 'connector_failed', err.message, { roomId });
    }
  });

  socket.on('disconnect', () => {
    const userId = socket.data.userId;
    const rooms = Array.from(socket.data.whiteboardRooms || []);
    for (const roomId of rooms) {
      if (!userId) continue;
      brainstormService.markUserPresence({ roomId, userId, status: 'offline', socketId: socket.id }).catch(() => {});
      socket.to(`whiteboard:${roomId}`).emit('whiteboard:user_left', { roomId, userId, at: new Date().toISOString() });
    }
  });
}

module.exports = {
  attachWhiteboardSocketHandlers,
};

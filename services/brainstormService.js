const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const cloudant = require('./cloudantClient');
const firebaseService = require('./firebaseService');
const { communityCache, membershipCache, adminCache } = require('./cacheService');
const { extractUserInfo, checkAdminRole, checkAdminRoleSync } = require('../middleware/auth');
const logger = require('../utils/logger');

const DB_COMMUNITIES = 'communities';
const DB_MEMBERSHIPS = 'community_memberships';
const MAX_PROMPT_CHARS = 4000;
const MAX_WHITEBOARD_ITEMS = 2000;
const MAX_SYNC_BYTES = 750 * 1024;
const MAX_NOTE_TEXT_CHARS = 2000;
const MAX_AI_REQUESTS_PER_MINUTE = 8;
const aiRateLimits = new Map();

const NVIDIA_API_URL = process.env.NVIDIA_API_URL || 'https://integrate.api.nvidia.com/v1/chat/completions';
const NVIDIA_API_KEY = process.env.ORION_API_KEY || process.env.NVIDIA_API_KEY || process.env.NVIDIA_NIM_API_KEY || '';
const ORION_MODEL = normalizeNvidiaModel(process.env.ORION_MODEL || 'moonshotai/kimi-k2-instruct');

function normalizeNvidiaModel(model) {
  const value = String(model || '').trim();
  if (!value) return 'moonshotai/kimi-k2-instruct';
  if (value === 'kimi-k2-instruct') return 'moonshotai/kimi-k2-instruct';
  if (value === 'kimi-k2-instruct-0905') return 'moonshotai/kimi-k2-instruct-0905';
  return value;
}

function nowIso() {
  return new Date().toISOString();
}

function sanitizeId(value, max = 160) {
  return String(value || '').trim().slice(0, max);
}

function firebaseKey(value) {
  return encodeURIComponent(String(value || 'unknown')).replace(/[.#$[\]/]/g, '-');
}

function sanitizeText(value, max) {
  return String(value || '').trim().slice(0, max);
}

function assertPayloadSize(value, maxBytes = MAX_SYNC_BYTES) {
  const bytes = Buffer.byteLength(JSON.stringify(value || {}), 'utf8');
  if (bytes > maxBytes) {
    const err = new Error('Whiteboard payload is too large');
    err.status = 413;
    err.code = 'payload_too_large';
    throw err;
  }
}

function normalizeWhiteboardState(input = {}) {
  assertPayloadSize(input);
  const strokes = Array.isArray(input.strokes) ? input.strokes.slice(-MAX_WHITEBOARD_ITEMS) : [];
  const shapes = Array.isArray(input.shapes) ? input.shapes.slice(-MAX_WHITEBOARD_ITEMS) : [];
  const notes = Array.isArray(input.notes) ? input.notes.slice(-MAX_WHITEBOARD_ITEMS) : [];
  const connectors = Array.isArray(input.connectors || input.arrows)
    ? (input.connectors || input.arrows).slice(-MAX_WHITEBOARD_ITEMS)
    : [];

  return {
    strokes,
    shapes,
    notes,
    connectors,
    updatedAt: nowIso(),
  };
}

function normalizeStickyNote(input = {}) {
  assertPayloadSize(input, 32 * 1024);
  return {
    id: sanitizeId(input.id) || uuidv4(),
    text: sanitizeText(input.text, MAX_NOTE_TEXT_CHARS),
    x: Number(input.x || 0),
    y: Number(input.y || 0),
    color: sanitizeText(input.color || '#fff3a3', 32),
    createdAt: input.createdAt || nowIso(),
    updatedAt: nowIso(),
  };
}

function normalizeConnector(input = {}) {
  assertPayloadSize(input, 32 * 1024);
  return {
    id: sanitizeId(input.id) || uuidv4(),
    from: input.from || input.start || null,
    to: input.to || input.end || null,
    points: Array.isArray(input.points) ? input.points.slice(0, 100) : [],
    label: sanitizeText(input.label, 200),
    style: input.style && typeof input.style === 'object' ? input.style : {},
    createdAt: input.createdAt || nowIso(),
    updatedAt: nowIso(),
  };
}

function getRealtimeRef(roomId, path = '') {
  if (!firebaseService.db) throw new Error('Firebase Realtime Database is not configured');
  const safeRoomId = sanitizeId(roomId);
  if (!safeRoomId) throw new Error('roomId is required');
  const suffix = path ? `/${path}` : '';
  return firebaseService.db.ref(`brainstormRooms/${safeRoomId}${suffix}`);
}

async function getCommunityOr404(communityId, { bustCache = false } = {}) {
  const safeCommunityId = sanitizeId(communityId);
  if (!safeCommunityId) return null;
  const cacheKey = `comm:${safeCommunityId}`;
  if (!bustCache) {
    const cached = communityCache.get(cacheKey);
    if (cached) return cached;
  }

  try {
    const doc = (await cloudant.getDocument({ db: DB_COMMUNITIES, docId: safeCommunityId })).result;
    communityCache.set(cacheKey, doc);
    return doc;
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

async function isCommunityMember(userId, community) {
  if (!userId || !community) return false;
  if (Array.isArray(community.members) && community.members.includes(userId)) return true;

  const cacheKey = `mem:${userId}:${community._id}`;
  const cached = membershipCache.get(cacheKey);
  if (cached === true) return true;

  try {
    const response = await cloudant.postView({
      db: DB_MEMBERSHIPS,
      ddoc: 'community_memberships',
      view: 'by_community',
      key: [community._id, userId],
      limit: 1,
    });
    const isMember = (response.result.rows || []).length > 0;
    if (isMember) membershipCache.set(cacheKey, true);
    return isMember;
  } catch (err) {
    logger.warn('[WHITEBOARD] membership lookup failed:', err.message);
    return false;
  }
}

async function getCachedAdminStatus(user) {
  const { email } = extractUserInfo(user);
  if (!email) return false;
  const cacheKey = `admin:${email.toLowerCase()}`;
  const cached = adminCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const isAdmin = await checkAdminRole(user);
  adminCache.set(cacheKey, isAdmin);
  return isAdmin;
}

async function canAccessCommunity(user, communityId) {
  const { userId } = extractUserInfo(user);
  const community = await getCommunityOr404(communityId);
  if (!community) return { ok: false, status: 404, error: 'Community not found' };
  const isAdmin = await getCachedAdminStatus(user);
  const isMember = await isCommunityMember(userId, community);
  if (!isAdmin && !isMember) {
    return { ok: false, status: 403, error: 'You must be a community member to access this brainstorm room' };
  }
  return { ok: true, userId, community, isAdmin };
}

function canManageRoom(userId, room, isAdmin) {
  if (isAdmin) return true;
  if (!room || !userId) return false;
  if (room.ownerId === userId || room.owner_id === userId) return true;
  return Array.isArray(room.editorIds || room.editor_ids) && (room.editorIds || room.editor_ids).includes(userId);
}

async function getRoom(roomId) {
  return firebaseService.getDocument('brainstorm_sessions', sanitizeId(roomId));
}

async function authorizeRoomAccess(user, roomId) {
  const { userId } = extractUserInfo(user);
  const room = await getRoom(roomId);
  if (!room) return { ok: false, status: 404, error: 'Brainstorm room not found' };
  const community = await getCommunityOr404(room.communityId || room.community_id);
  if (!community) return { ok: false, status: 404, error: 'Community not found' };
  const isAdmin = await getCachedAdminStatus(user);
  const isMember = await isCommunityMember(userId, community);
  if (!isAdmin && !isMember && !canManageRoom(userId, room, false)) {
    return { ok: false, status: 403, error: 'You do not have access to this brainstorm room' };
  }
  return { ok: true, userId, room, community, isAdmin, canManage: canManageRoom(userId, room, isAdmin) };
}

async function authorizeSocketRoomAccess(socket, roomId) {
  const userId = socket.data.userId;
  if (!userId) return { ok: false, status: 401, error: 'Register your socket before joining whiteboard rooms' };
  const room = await getRoom(roomId);
  if (!room) return { ok: false, status: 404, error: 'Brainstorm room not found' };
  const community = await getCommunityOr404(room.communityId || room.community_id);
  if (!community) return { ok: false, status: 404, error: 'Community not found' };
  const isAdmin = checkAdminRoleSync({ email: socket.data.email });
  const isMember = await isCommunityMember(userId, community);
  if (!isAdmin && !isMember && !canManageRoom(userId, room, false)) {
    return { ok: false, status: 403, error: 'You do not have access to this brainstorm room' };
  }
  return { ok: true, userId, room, community, isAdmin, canManage: canManageRoom(userId, room, isAdmin) };
}

async function createRoom({ user, communityId, title }) {
  const auth = await canAccessCommunity(user, communityId);
  if (!auth.ok) return auth;
  const { userId, community } = auth;
  const roomId = uuidv4();
  const now = nowIso();
  const room = {
    _id: roomId,
    id: roomId,
    title: sanitizeText(title || 'Brainstorm Room', 120) || 'Brainstorm Room',
    community_id: community._id,
    communityId: community._id,
    owner_id: userId,
    ownerId: userId,
    active_users: {},
    activeUsers: {},
    created_at: now,
    createdAt: now,
    updated_at: now,
    updatedAt: now,
  };
  await firebaseService.createDocument('brainstorm_sessions', room, roomId);
  await getRealtimeRef(roomId).set({
    metadata: {
      roomId,
      communityId: community._id,
      ownerId: userId,
      createdAt: now,
      updatedAt: now,
    },
    whiteboard: normalizeWhiteboardState(),
    activeUsers: {},
  });
  return { ok: true, room };
}

async function joinRoom({ user, roomId }) {
  const auth = await authorizeRoomAccess(user, roomId);
  if (!auth.ok) return auth;
  await markUserPresence({ roomId, userId: auth.userId, status: 'online' });
  logger.info('[WHITEBOARD] user joined', { roomId, userId: auth.userId });
  return { ok: true, room: auth.room };
}

async function leaveRoom({ user, roomId }) {
  const auth = await authorizeRoomAccess(user, roomId);
  if (!auth.ok) return auth;
  await markUserPresence({ roomId, userId: auth.userId, status: 'offline' });
  return { ok: true };
}

async function markUserPresence({ roomId, userId, status = 'online', socketId = null }) {
  const now = nowIso();
  const payload = { userId, user_id: userId, status, socketId, socket_id: socketId, updatedAt: now, updated_at: now };
  await getRealtimeRef(roomId, `activeUsers/${firebaseKey(userId)}`).set(payload);
  await firebaseService.updateDocument('brainstorm_sessions', roomId, {
    lastActiveUserId: userId,
    last_active_user_id: userId,
    lastPresenceStatus: status,
    last_presence_status: status,
    updated_at: now,
    updatedAt: now,
  });
}

async function getWhiteboard(roomId) {
  const snapshot = await getRealtimeRef(roomId, 'whiteboard').once('value');
  return snapshot.val() || normalizeWhiteboardState();
}

async function syncWhiteboard({ roomId, whiteboard, userId }) {
  const state = normalizeWhiteboardState(whiteboard);
  await getRealtimeRef(roomId, 'whiteboard').set({ ...state, updatedBy: userId || null });
  await firebaseService.updateDocument('brainstorm_sessions', roomId, {
    lastWhiteboardSyncAt: state.updatedAt,
    last_whiteboard_sync_at: state.updatedAt,
    updated_at: state.updatedAt,
    updatedAt: state.updatedAt,
  });
  logger.info('[WHITEBOARD] room synced', { roomId });
  return state;
}

async function clearWhiteboard({ roomId, userId }) {
  const state = normalizeWhiteboardState();
  await getRealtimeRef(roomId, 'whiteboard').set({ ...state, clearedBy: userId || null });
  await firebaseService.updateDocument('brainstorm_sessions', roomId, {
    lastWhiteboardSyncAt: state.updatedAt,
    last_whiteboard_sync_at: state.updatedAt,
    updated_at: state.updatedAt,
    updatedAt: state.updatedAt,
  });
  logger.info('[WHITEBOARD] room synced', { roomId, action: 'clear' });
  return state;
}

async function addStickyNote({ roomId, note, userId }) {
  const payload = { ...normalizeStickyNote(note), createdBy: userId || null, created_by: userId || null };
  await getRealtimeRef(roomId, `whiteboard/notes/${firebaseKey(payload.id)}`).set(payload);
  await firebaseService.updateDocument('brainstorm_sessions', roomId, {
    lastWhiteboardSyncAt: payload.updatedAt,
    last_whiteboard_sync_at: payload.updatedAt,
    updated_at: payload.updatedAt,
    updatedAt: payload.updatedAt,
  });
  return payload;
}

async function addConnector({ roomId, connector, userId }) {
  const payload = { ...normalizeConnector(connector), createdBy: userId || null, created_by: userId || null };
  await getRealtimeRef(roomId, `whiteboard/connectors/${firebaseKey(payload.id)}`).set(payload);
  await firebaseService.updateDocument('brainstorm_sessions', roomId, {
    lastWhiteboardSyncAt: payload.updatedAt,
    last_whiteboard_sync_at: payload.updatedAt,
    updated_at: payload.updatedAt,
    updatedAt: payload.updatedAt,
  });
  return payload;
}

async function deleteRoom({ user, roomId }) {
  const auth = await authorizeRoomAccess(user, roomId);
  if (!auth.ok) return auth;
  const isOwner = auth.room.ownerId === auth.userId || auth.room.owner_id === auth.userId;
  if (!isOwner && !auth.isAdmin) {
    return { ok: false, status: 403, error: 'Only the room owner can delete this room' };
  }
  await getRealtimeRef(roomId).remove();
  await firebaseService.deleteDocument('brainstorm_sessions', sanitizeId(roomId));
  return { ok: true };
}

function enforceAiRateLimit(userId) {
  const now = Date.now();
  const windowStart = now - 60_000;
  const entries = (aiRateLimits.get(userId) || []).filter((ts) => ts > windowStart);
  if (entries.length >= MAX_AI_REQUESTS_PER_MINUTE) {
    const err = new Error('Too many Orion brainstorming requests. Please slow down.');
    err.status = 429;
    throw err;
  }
  entries.push(now);
  aiRateLimits.set(userId, entries);
}

function buildAiPrompt(action, prompt, context = {}) {
  const base = sanitizeText(prompt, MAX_PROMPT_CHARS);
  if (action === 'expand') {
    return `Expand this brainstorming idea into a stronger concept with architecture, users, differentiators, risks, and next steps:\n\n${base}`;
  }
  if (action === 'project') {
    return `Convert this brainstorm into a practical project plan. Include scope, milestones, architecture, backlog, risks, and launch checklist:\n\n${base}`;
  }
  return [
    'Generate a high-quality CloudIQ brainstorming response for this prompt:',
    base,
    '',
    'Include startup ideas, app concepts, cloud architecture, monetization ideas, roadmap, and recommended tech stack.',
    context.roomTitle ? `Room title: ${context.roomTitle}` : '',
  ].filter(Boolean).join('\n');
}

async function callOrionBrainstorm(action, prompt, context = {}) {
  if (!NVIDIA_API_KEY) {
    const err = new Error('Orion API key is not configured.');
    err.status = 500;
    throw err;
  }

  const response = await axios.post(
    NVIDIA_API_URL,
    {
      model: ORION_MODEL,
      messages: [
        {
          role: 'system',
          content: 'You are Orion A.I inside CloudIQ. Generate structured, practical innovation brainstorming output for cloud builders. Use clear headings and concise bullets.',
        },
        { role: 'user', content: buildAiPrompt(action, prompt, context) },
      ],
      temperature: action === 'generate' ? 0.75 : 0.55,
      top_p: 0.9,
      max_tokens: 3000,
      stream: false,
    },
    {
      headers: {
        Authorization: `Bearer ${NVIDIA_API_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: Number(process.env.ORION_API_TIMEOUT_MS || 60000),
      validateStatus: () => true,
    }
  );

  if (response.status < 200 || response.status >= 300) {
    const err = new Error(response.data?.error?.message || response.data?.message || `NVIDIA returned HTTP ${response.status}`);
    err.status = 502;
    throw err;
  }

  return response.data?.choices?.[0]?.message?.content || '';
}

async function runAiAction({ user, action, prompt, roomId = null }) {
  const { userId } = extractUserInfo(user);
  enforceAiRateLimit(userId);
  const cleanPrompt = sanitizeText(prompt, MAX_PROMPT_CHARS);
  if (!cleanPrompt) return { ok: false, status: 400, error: 'prompt is required' };

  let room = null;
  if (roomId) {
    const auth = await authorizeRoomAccess(user, roomId);
    if (!auth.ok) return auth;
    room = auth.room;
  }

  try {
    const text = await callOrionBrainstorm(action, cleanPrompt, { roomTitle: room?.title });
    const now = nowIso();
    const generation = {
      _id: uuidv4(),
      userId,
      user_id: userId,
      roomId: roomId || null,
      room_id: roomId || null,
      action,
      prompt: cleanPrompt,
      response: text,
      model: ORION_MODEL,
      createdAt: now,
      created_at: now,
    };
    await firebaseService.createDocument('brainstorm_ai_generations', generation, generation._id);
    logger.info('[ORION] generation completed', { action, roomId: roomId || null, userId });
    return { ok: true, generation };
  } catch (err) {
    if (action === 'expand') logger.error('[ORION] expand request failed', { message: err.message, roomId: roomId || null });
    throw err;
  }
}

module.exports = {
  MAX_SYNC_BYTES,
  authorizeRoomAccess,
  authorizeSocketRoomAccess,
  createRoom,
  joinRoom,
  leaveRoom,
  deleteRoom,
  getWhiteboard,
  syncWhiteboard,
  clearWhiteboard,
  addStickyNote,
  addConnector,
  markUserPresence,
  runAiAction,
};

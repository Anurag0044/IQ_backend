const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const db = require('./firestoreClient');
const firebaseService = require('./firebaseService');
const { communityCache, membershipCache, adminCache } = require('./cacheService');
const { extractUserInfo, checkAdminRole, checkAdminRoleSync } = require('../middleware/auth');
const logger = require('../utils/logger');

const DB_COMMUNITIES = 'communities';
const DB_MEMBERSHIPS = 'community_memberships';
const MAX_PROMPT_CHARS = 4000;
const MAX_ORION_PROMPT_CHARS = Number(process.env.ORION_BRAINSTORM_PROMPT_CHARS || 1800);
const MAX_WHITEBOARD_ITEMS = 2000;
const MAX_SYNC_BYTES = 750 * 1024;
const MAX_NOTE_TEXT_CHARS = 2000;
const MAX_AI_REQUESTS_PER_MINUTE = 8;
const AI_RATE_LIMIT_WINDOW_MS = 60_000;
const MAX_AI_IDEMPOTENCY_KEYS = 200;
const AI_RETRY_CACHE_MS = 1500;
const MAX_AI_PROMPT_CURSORS = 500;
const aiRateLimits = new Map();
const inFlightAiRequests = new Map();
const completedAiRequests = new Map();
const promptCursors = new Map();

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

function cleanIdeaText(value, max, { fallback = '', title = false } = {}) {
  let text = String(value || '').replace(/\r/g, '\n').trim();
  if (!text) return fallback;

  text = text
    .replace(/```(?:json|markdown|md)?/gi, '')
    .replace(/```/g, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*/g, '')
    .replace(/__/g, '')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/^\s*(?:[-*+]|\u2022)\s+/gm, '')
    .replace(/^\s*\*{0,2}\d+\s*[\.)-]\s*\*{0,2}/gm, '')
    .replace(/\s*\n+\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();

  if (title) {
    text = text
      .replace(/^(?:idea|title)\s*[:\-]\s*/i, '')
      .replace(/[.:;\-_\s]+$/g, '')
      .trim();
  }

  return sanitizeText(text || fallback, max);
}

function createServiceError(message, status = 400, code = 'bad_request') {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

function stableHash(value) {
  let hash = 0;
  const input = String(value || '');
  for (let i = 0; i < input.length; i += 1) {
    hash = ((hash << 5) - hash) + input.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

function validatePrompt(prompt) {
  if (typeof prompt !== 'string') {
    throw createServiceError('prompt must be a string', 400, 'invalid_prompt');
  }
  const cleanPrompt = prompt.trim();
  if (!cleanPrompt) {
    throw createServiceError('prompt is required', 400, 'prompt_required');
  }
  if (cleanPrompt.length > MAX_PROMPT_CHARS) {
    throw createServiceError(`prompt must be ${MAX_PROMPT_CHARS} characters or fewer`, 413, 'prompt_too_large');
  }
  return cleanPrompt;
}

function makeEmptyIdea(overrides = {}) {
  return {
    title: '',
    description: '',
    architecture: '',
    roadmap: '',
    monetization: '',
    techStack: '',
    ...overrides,
  };
}

function normalizeIdea(input = {}, index = 0) {
  const source = input && typeof input === 'object' ? input : {};
  const title = cleanIdeaText(source.title || source.name, 160, { fallback: `Idea ${index + 1}`, title: true });
  const description = cleanIdeaText(source.description || source.summary || source.overview, 2000);
  const architecture = cleanIdeaText(source.architecture || source.systemDesign || source.system_design, 2000);
  const roadmapValue = Array.isArray(source.roadmap) ? source.roadmap.join('\n') : source.roadmap;
  const monetizationValue = Array.isArray(source.monetization) ? source.monetization.join('\n') : source.monetization;
  const techStackValue = Array.isArray(source.techStack || source.tech_stack)
    ? (source.techStack || source.tech_stack).join(', ')
    : (source.techStack || source.tech_stack);

  return makeEmptyIdea({
    title,
    description,
    architecture,
    roadmap: cleanIdeaText(roadmapValue, 2000),
    monetization: cleanIdeaText(monetizationValue, 2000),
    techStack: cleanIdeaText(techStackValue, 1200),
  });
}

function normalizeIdeaList(ideas = []) {
  const normalized = (Array.isArray(ideas) ? ideas : [ideas])
    .map(normalizeIdea)
    .filter((idea) => idea.title || idea.description);
  return normalized.length ? normalized : [normalizeIdea({}, 0)];
}

function extractJsonCandidate(text) {
  const value = String(text || '').trim();
  if (!value) return null;

  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();

  const arrayStart = value.indexOf('[');
  const objectStart = value.indexOf('{');
  const starts = [arrayStart, objectStart].filter((idx) => idx >= 0);
  if (starts.length === 0) return null;

  const start = Math.min(...starts);
  const end = value.lastIndexOf(value[start] === '[' ? ']' : '}');
  if (end <= start) return null;
  return value.slice(start, end + 1);
}

function tryParseJsonIdeas(text) {
  const candidate = extractJsonCandidate(text);
  if (!candidate) return null;
  try {
    const parsed = JSON.parse(candidate);
    const ideas = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed.ideas)
        ? parsed.ideas
        : parsed.idea
          ? [parsed.idea]
          : [parsed];
    return normalizeIdeaList(ideas);
  } catch (err) {
    logger.debug('[ORION RESPONSE] JSON parse failed', { message: err.message });
    return null;
  }
}

function parseMarkdownSections(text) {
  const sections = {};
  let current = 'description';
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    const heading = line.replace(/^#{1,6}\s*/, '').replace(/\*\*/g, '').replace(/:$/, '').trim().toLowerCase();
    if (/^(title|idea|description|overview|architecture|roadmap|monetization|tech stack|techstack|technology stack)$/.test(heading)) {
      current = heading.replace(/\s+/g, '');
      continue;
    }
    if (!line) continue;
    sections[current] = [sections[current], line].filter(Boolean).join('\n');
  }

  return normalizeIdea({
    title: sections.title || sections.idea || 'Orion Brainstorm',
    description: sections.description || sections.overview || sanitizeText(text, 2000),
    architecture: sections.architecture || '',
    roadmap: sections.roadmap || '',
    monetization: sections.monetization || '',
    techStack: sections.techstack || sections.technologystack || '',
  });
}

function parseOrionIdeas(text) {
  const jsonIdeas = tryParseJsonIdeas(text);
  if (jsonIdeas?.length) {
    return { ideas: normalizeIdeaList(jsonIdeas).slice(0, 1), format: 'json' };
  }
  return { ideas: normalizeIdeaList([parseMarkdownSections(text)]).slice(0, 1), format: 'text_fallback' };
}

function makePublicGeneration(generation) {
  if (!generation) return null;
  const ideas = Array.isArray(generation.ideas) ? generation.ideas.map(normalizeIdea) : [];
  const idea = ideas[0] || normalizeIdea({}, 0);
  return {
    _id: generation._id,
    id: generation.id || generation._id,
    userId: generation.userId,
    user_id: generation.user_id,
    roomId: generation.roomId || null,
    room_id: generation.room_id || null,
    action: generation.action,
    prompt: generation.prompt,
    idea,
    ideas: [idea],
    response: JSON.stringify({ idea }),
    model: generation.model,
    createdAt: generation.createdAt,
    created_at: generation.created_at,
  };
}

function makeBrainstormMetadata({ action, roomId, userId, model, generationId, startedAt, responseTimeMs, parseFormat, cached = false, ideaCursor = null }) {
  return {
    action,
    roomId: roomId || null,
    userId,
    model,
    generationId: generationId || null,
    responseTimeMs,
    parseFormat,
    cached,
    ideaCursor,
    createdAt: nowIso(),
    startedAt,
  };
}

function makeAiResponse({ ok, ideas = [], metadata = {}, error = null, generation = null, status = 200, code = undefined }) {
  const normalizedIdeas = ok ? normalizeIdeaList(ideas).slice(0, 1) : [];
  const idea = normalizedIdeas[0] || null;
  return {
    ok,
    status,
    success: ok,
    idea,
    ideas: normalizedIdeas,
    metadata,
    error,
    code,
    generation: makePublicGeneration(generation),
  };
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
    const doc = await db.getDoc(DB_COMMUNITIES, safeCommunityId);
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
    const communityId = community._id || community.id;
    // Check direct membership doc first
    const membershipId = `${communityId}_${userId}`;
    const membershipDoc = await db.getDoc(DB_MEMBERSHIPS, membershipId).catch(() => null);
    if (membershipDoc) {
      membershipCache.set(cacheKey, true);
      return true;
    }
    // Fallback query
    const results = await db.queryDocs(DB_MEMBERSHIPS, [
      ['community_id', '==', communityId],
      ['user_id', '==', userId],
    ], null, 'asc', 1);
    const isMember = results.length > 0;
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
  const windowStart = now - AI_RATE_LIMIT_WINDOW_MS;
  const entries = (aiRateLimits.get(userId) || []).filter((ts) => ts > windowStart);
  if (entries.length >= MAX_AI_REQUESTS_PER_MINUTE) {
    const err = new Error('Too many Orion brainstorming requests. Please slow down.');
    err.status = 429;
    err.code = 'rate_limited';
    throw err;
  }
  entries.push(now);
  aiRateLimits.set(userId, entries);

  for (const [key, timestamps] of aiRateLimits.entries()) {
    const fresh = timestamps.filter((ts) => ts > windowStart);
    if (fresh.length) aiRateLimits.set(key, fresh);
    else aiRateLimits.delete(key);
  }
}

function normalizePreviousIdeas(value = []) {
  if (!Array.isArray(value)) return [];
  return value
    .map((idea) => normalizeIdea(idea))
    .filter((idea) => idea.title || idea.description)
    .slice(-5);
}

function resolveIdeaCursor({ baseKey, requestedCursor = null }) {
  const explicit = Number(requestedCursor);
  if (Number.isFinite(explicit) && explicit > 0) {
    return Math.min(50, Math.floor(explicit));
  }

  const current = promptCursors.get(baseKey) || { cursor: 0, updatedAt: 0 };
  if (current.cursor > 0 && Date.now() - current.updatedAt < AI_RETRY_CACHE_MS) {
    return current.cursor;
  }
  const cursor = Math.min(50, current.cursor + 1);
  promptCursors.set(baseKey, { cursor, updatedAt: Date.now() });

  if (promptCursors.size > MAX_AI_PROMPT_CURSORS) {
    const oldest = [...promptCursors.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt)[0];
    if (oldest) promptCursors.delete(oldest[0]);
  }

  return cursor;
}

function buildAiPrompt(action, prompt, context = {}) {
  const base = sanitizeText(prompt, MAX_ORION_PROMPT_CHARS);
  const jsonInstruction = [
    'Return valid JSON only. Do not return markdown, headings, numbered lists, bullets, commentary, or code fences.',
    'The response must match this exact shape:',
    '{"idea":{"title":"","description":"","architecture":"","roadmap":"","monetization":"","techStack":""}}',
    'Return exactly one idea object. Every field must be a plain concise string.',
    'Do not prefix titles with numbers, markdown bold markers, hashes, or bullets.',
    'Do not include partial sentences. If unsure, return one complete conservative idea object.',
  ].join('\n');
  const previous = normalizePreviousIdeas(context.previousIdeas);
  const previousTitles = previous.map((idea) => idea.title).filter(Boolean).join(', ');
  const cursorLine = context.ideaCursor
    ? `Idea number to generate for this prompt: ${context.ideaCursor}. Make it meaningfully different from earlier ideas.`
    : '';
  const previousLine = previousTitles
    ? `Avoid repeating these existing idea titles: ${previousTitles}.`
    : '';
  if (action === 'expand') {
    return `Expand this brainstorming idea into one stronger concise concept:\n\n${base}\n\n${jsonInstruction}`;
  }
  if (action === 'project') {
    return `Convert this brainstorm into one concise practical project idea:\n\n${base}\n\n${jsonInstruction}`;
  }
  return [
    'Generate one high-quality CloudIQ brainstorming idea for this prompt:',
    base,
    '',
    cursorLine,
    previousLine,
    jsonInstruction,
    context.roomTitle ? `Room title: ${context.roomTitle}` : '',
  ].filter(Boolean).join('\n');
}

async function callOrionBrainstorm(action, prompt, context = {}) {
  if (!NVIDIA_API_KEY) {
    const err = new Error('Orion API key is not configured.');
    err.status = 500;
    throw err;
  }

  const requestStartedAt = Date.now();
  const userPrompt = buildAiPrompt(action, prompt, context);
  logger.debug('[ORION PERFORMANCE] request size', {
    action,
    promptChars: userPrompt.length,
    estimatedPromptTokens: Math.ceil(userPrompt.length / 4),
    maxTokens: Number(process.env.ORION_BRAINSTORM_MAX_TOKENS || 900),
  });

  const response = await axios.post(
    NVIDIA_API_URL,
    {
      model: ORION_MODEL,
      messages: [
        {
          role: 'system',
          content: [
            'You are Orion A.I inside CloudIQ Brainstorming.',
            'You generate frontend-safe structured brainstorming data for cloud builders.',
            'For brainstorming endpoints, return valid JSON only with one "idea" object.',
            'Never use markdown, numbered markdown lists, bold markers, headings, code fences, or explanatory text outside JSON.',
            'Never include secrets, API keys, stack traces, or internal implementation details.',
          ].join(' '),
        },
        { role: 'user', content: userPrompt },
      ],
      temperature: action === 'generate' ? 0.75 : 0.55,
      top_p: 0.85,
      max_tokens: Number(process.env.ORION_BRAINSTORM_MAX_TOKENS || 900),
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
    const err = new Error(response.data?.error?.message || response.data?.message || 'Orion provider failed to respond.');
    err.status = 502;
    err.code = 'provider_failure';
    err.providerStatus = response.status;
    throw err;
  }

  const content = response.data?.choices?.[0]?.message?.content;
  if (!content || typeof content !== 'string') {
    const err = new Error('Orion returned an empty response.');
    err.status = 502;
    err.code = 'empty_ai_response';
    throw err;
  }
  logger.info('[ORION PERFORMANCE] provider response received', {
    action,
    responseTimeMs: Date.now() - requestStartedAt,
    responseChars: content.length,
    estimatedResponseTokens: Math.ceil(content.length / 4),
  });
  return content;
}

async function runAiAction({ user, action, prompt, roomId = null, ideaCursor = null, previousIdeas = [] }) {
  const { userId } = extractUserInfo(user);
  if (!userId) {
    return makeAiResponse({
      ok: false,
      status: 401,
      error: 'Authentication is required',
      code: 'invalid_auth',
      metadata: { action, roomId: roomId || null, model: ORION_MODEL },
    });
  }

  let cleanPrompt;
  try {
    cleanPrompt = validatePrompt(prompt);
    enforceAiRateLimit(userId);
  } catch (err) {
    return makeAiResponse({
      ok: false,
      status: err.status || 400,
      error: err.message,
      code: err.code || 'bad_request',
      metadata: { action, roomId: roomId || null, userId, model: ORION_MODEL },
    });
  }

  let room = null;
  if (roomId) {
    const auth = await authorizeRoomAccess(user, roomId);
    if (!auth.ok) {
      return makeAiResponse({
        ok: false,
        status: auth.status || 403,
        error: auth.error,
        code: auth.code || 'room_forbidden',
        metadata: { action, roomId, userId, model: ORION_MODEL },
      });
    }
    room = auth.room;
  }

  const startedAt = nowIso();
  const startMs = Date.now();
  const baseRequestKey = `${userId}:${action}:${roomId || 'none'}:${stableHash(cleanPrompt)}`;
  if (inFlightAiRequests.has(baseRequestKey)) {
    logger.info('[BRAINSTORMING] duplicate AI request joined', { action, roomId: roomId || null, userId });
    return inFlightAiRequests.get(baseRequestKey);
  }
  const cursor = action === 'generate'
    ? resolveIdeaCursor({ baseKey: baseRequestKey, requestedCursor: ideaCursor })
    : 1;
  const requestKey = `${baseRequestKey}:${cursor}`;
  const cached = completedAiRequests.get(requestKey);
  if (cached && Date.now() - cached.savedAt < AI_RETRY_CACHE_MS) {
    logger.info('[BRAINSTORMING] duplicate AI request reused', { action, roomId: roomId || null, userId });
    return makeAiResponse({
      ...cached.result,
      metadata: { ...cached.result.metadata, cached: true },
    });
  }

  if (inFlightAiRequests.has(requestKey)) {
    logger.info('[BRAINSTORMING] duplicate AI request joined', { action, roomId: roomId || null, userId });
    return inFlightAiRequests.get(requestKey);
  }

  const task = (async () => {
    logger.info('[ORION API] request received', {
      action,
      roomId: roomId || null,
      userId,
      promptChars: cleanPrompt.length,
      ideaCursor: cursor,
    });
    logger.debug('[ORION API] prompt', {
      action,
      roomId: roomId || null,
      ideaCursor: cursor,
      prompt: cleanPrompt,
    });

  try {
    const text = await callOrionBrainstorm(action, cleanPrompt, {
      roomTitle: room?.title,
      ideaCursor: cursor,
      previousIdeas,
    });
    const parsed = parseOrionIdeas(text);
    const idea = parsed.ideas[0] || normalizeIdea({}, 0);
    logger.info('[ORION RESPONSE] parsing result', {
      action,
      roomId: roomId || null,
      ideaCount: 1,
      parseFormat: parsed.format,
      responseTimeMs: Date.now() - startMs,
    });
    const now = nowIso();
    const generation = {
      _id: uuidv4(),
      userId,
      user_id: userId,
      roomId: roomId || null,
      room_id: roomId || null,
      action,
      prompt: cleanPrompt,
      response: JSON.stringify({ idea }),
      idea,
      ideas: [idea],
      model: ORION_MODEL,
      createdAt: now,
      created_at: now,
    };
    await firebaseService.createDocument('brainstorm_ai_generations', generation, generation._id);
    logger.info('[BRAINSTORMING] AI generation stored', { action, roomId: roomId || null, userId, generationId: generation._id });
    const result = makeAiResponse({
      ok: true,
      ideas: [idea],
      metadata: makeBrainstormMetadata({
        action,
        roomId,
        userId,
        model: ORION_MODEL,
        generationId: generation._id,
        startedAt,
        responseTimeMs: Date.now() - startMs,
        parseFormat: parsed.format,
        ideaCursor: cursor,
      }),
      error: null,
      generation,
    });
    completedAiRequests.set(requestKey, { savedAt: Date.now(), result });
    if (completedAiRequests.size > MAX_AI_IDEMPOTENCY_KEYS) {
      const oldestKey = completedAiRequests.keys().next().value;
      completedAiRequests.delete(oldestKey);
    }
    return result;
  } catch (err) {
    const timedOut = err.code === 'ECONNABORTED' || /timeout/i.test(err.message || '');
    const code = timedOut ? 'ai_timeout' : (err.code || 'orion_failed');
    const status = err.status || err.statusCode || (timedOut ? 504 : 502);
    logger.error('[ORION ERROR] request failed', {
      action,
      roomId: roomId || null,
      userId,
      code,
      status,
      providerStatus: err.providerStatus,
      responseTimeMs: Date.now() - startMs,
      message: err.message,
    });
    return makeAiResponse({
      ok: false,
      status,
      error: status === 429 ? err.message : 'Orion failed to generate a reliable response. Please try again.',
      code,
      metadata: makeBrainstormMetadata({
        action,
        roomId,
        userId,
        model: ORION_MODEL,
        startedAt,
        responseTimeMs: Date.now() - startMs,
        parseFormat: null,
      }),
    });
  }
  })().finally(() => {
    inFlightAiRequests.delete(requestKey);
    inFlightAiRequests.delete(baseRequestKey);
  });

  inFlightAiRequests.set(requestKey, task);
  inFlightAiRequests.set(baseRequestKey, task);
  return task;
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

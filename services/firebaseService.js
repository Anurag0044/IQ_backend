// ============================================
// CloudIQ Backend - Firebase Admin Service
// ============================================
// Firestore is the backend source of truth for discussions:
// channels, messages, typing, presence, unread states, and reactions.
//
// Realtime Database support is intentionally kept for older code paths and
// existing env compatibility. Do not remove VITE_FIREBASE_DATABASE_URL.

const admin = require('firebase-admin');
const { deleteMedia } = require('./cloudinaryService');

require('dotenv').config();

let firebaseApp = null;
let firestore = null;
let realtimeDb = null;
let firestoreSettingsApplied = false;

const hasFirebaseCredentials = Boolean(
  process.env.FIREBASE_PROJECT_ID &&
  process.env.FIREBASE_CLIENT_EMAIL &&
  process.env.FIREBASE_PRIVATE_KEY
);

function normalizePrivateKey(value) {
  return String(value || '').replace(/\\n/g, '\n');
}

function getDatabaseURL() {
  return (
    process.env.FIREBASE_DATABASE_URL ||
    process.env.VITE_FIREBASE_DATABASE_URL ||
    `https://${process.env.FIREBASE_PROJECT_ID}-default-rtdb.firebaseio.com`
  );
}

function safeDocData(snapshot) {
  if (!snapshot || !snapshot.exists) return null;
  return { _id: snapshot.id, id: snapshot.id, ...snapshot.data() };
}

function normalizeChannelDocument(channel, id) {
  const channelId = id || channel?._id || channel?.id;
  const communityId = channel?.community_id || channel?.communityId;
  const createdAt = channel?.created_at || channel?.createdAt || new Date().toISOString();
  const updatedAt = channel?.updated_at || channel?.updatedAt || createdAt;

  return {
    ...channel,
    _id: channelId,
    id: channelId,
    community_id: communityId,
    communityId,
    name: channel?.name,
    topic: channel?.topic || null,
    type: channel?.type || 'text',
    visibility: channel?.visibility || 'members',
    allowed_member_ids: channel?.allowed_member_ids || channel?.allowedMemberIds || null,
    allowedMemberIds: channel?.allowed_member_ids || channel?.allowedMemberIds || null,
    position: Number(channel?.position || 0),
    created_by: channel?.created_by || channel?.createdBy || null,
    createdBy: channel?.created_by || channel?.createdBy || null,
    created_at: createdAt,
    createdAt,
    updated_at: updatedAt,
    updatedAt,
  };
}

function normalizeMessageDocument(message, id) {
  const messageId = id || message?._id || message?.id;
  const channelId = message?.channel_id || message?.channelId;
  const communityId = message?.community_id || message?.communityId;
  const senderId = message?.sender_id || message?.senderId;
  const senderName = message?.sender_name || message?.senderName || 'Anonymous';
  const senderAvatar = message?.sender_avatar || message?.senderAvatar || null;
  const text = message?.text ?? message?.content ?? '';
  const mediaUrl = message?.mediaUrl || message?.media_url || message?.media?.url || null;
  const mediaType = message?.mediaType || message?.media_type || message?.media?.media_type || message?.media?.resource_type || null;
  const fileName = message?.fileName || message?.file_name || message?.media?.filename || null;
  const mediaStoragePath = message?.mediaStoragePath || message?.media_storage_path || message?.media?.storage_path || null;
  const mediaPublicId = message?.mediaPublicId || message?.media_public_id || message?.media?.public_id || null;
  const mediaResourceType = message?.mediaResourceType || message?.media_resource_type || message?.media?.resource_type || null;
  const createdAt = message?.created_at || message?.createdAt || new Date().toISOString();
  const updatedAt = message?.updated_at || message?.updatedAt || createdAt;

  return {
    ...message,
    _id: messageId,
    id: messageId,
    community_id: communityId,
    communityId,
    channel_id: channelId,
    channelId,
    sender_id: senderId,
    senderId,
    sender_name: senderName,
    senderName,
    sender_avatar: senderAvatar,
    senderAvatar,
    type: message?.type || 'text',
    content: message?.content ?? text,
    text,
    mediaUrl,
    media_url: mediaUrl,
    mediaType,
    media_type: mediaType,
    fileName,
    file_name: fileName,
    mediaStoragePath,
    media_storage_path: mediaStoragePath,
    mediaPublicId,
    media_public_id: mediaPublicId,
    mediaResourceType,
    media_resource_type: mediaResourceType,
    media: message?.media || (mediaUrl ? {
      url: mediaUrl,
      secure_url: mediaUrl,
      media_type: mediaType,
      public_id: mediaPublicId,
      resource_type: mediaResourceType || mediaType,
      filename: fileName,
      storage_path: mediaStoragePath,
      mime_type: message?.mime_type || message?.mimeType || null,
      size_bytes: message?.size_bytes || message?.sizeBytes || null,
    } : null),
    pinned: Boolean(message?.pinned),
    pinned_at: message?.pinned_at || message?.pinnedAt || null,
    pinnedAt: message?.pinned_at || message?.pinnedAt || null,
    created_at: createdAt,
    createdAt,
    updated_at: updatedAt,
    updatedAt,
  };
}

function createUnavailableFirebaseService() {
  console.warn('[FIREBASE] Firebase credentials not configured. Firebase discussion storage disabled.');
  const unavailable = async () => {
    throw new Error('Firebase is not configured');
  };

  return {
    createDocument: unavailable,
    updateDocument: unavailable,
    deleteDocument: unavailable,
    getDocument: async () => null,
    realtimeQuery: () => null,
    paginatedMessages: async () => [],
    listChannelsByCommunity: async () => [],
    syncChannel: async () => {},
    deleteChannel: async () => {},
    syncChannelBatch: async () => {},
    getChannelFromFirebase: async () => null,
    storeMessage: unavailable,
    updatePresence: async () => {},
    setTyping: async () => {},
    setReaction: async () => {},
    markChannelRead: async () => {},
    incrementUnreadStates: async () => {},
    getUnreadStates: async () => [],
    debugFirestoreWrite: unavailable,
    db: null,
    firestore: null,
    app: null,
  };
}

if (hasFirebaseCredentials) {
  try {
    if (admin.apps.length === 0) {
      firebaseApp = admin.initializeApp({
        credential: admin.credential.cert({
          projectId: process.env.FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          privateKey: normalizePrivateKey(process.env.FIREBASE_PRIVATE_KEY),
        }),
        databaseURL: getDatabaseURL(),
      });
    } else {
      firebaseApp = admin.apps[0];
    }

    firestore = admin.firestore(firebaseApp);
    if (!firestoreSettingsApplied) {
      firestore.settings({ ignoreUndefinedProperties: true });
      firestoreSettingsApplied = true;
    }
    realtimeDb = admin.database(firebaseApp);
    console.log('[FIREBASE] backend initialized', {
      apps: admin.apps.length,
      projectId: process.env.FIREBASE_PROJECT_ID,
      firestoreSingleton: true,
    });
  } catch (err) {
    console.error('[FIREBASE] backend initialization failed:', err.message);
    console.error(err.stack);
    firebaseApp = null;
    firestore = null;
    realtimeDb = null;
  }
}

function logFirestoreError(stage, err, extra = {}) {
  console.error(`[FIRESTORE] ${stage} failed`, {
    message: err?.message,
    name: err?.name,
    code: err?.code,
    details: err?.details,
    stack: err?.stack,
    ...extra,
  });
  if (err) console.error(err);
  if (err?.stack) console.error(err.stack);
}

async function createDocument(collectionName, document, docId = null) {
  if (!firestore) throw new Error('Firebase is not configured');
  const id = docId || document?._id || document?.id || firestore.collection(collectionName).doc().id;
  const ref = firestore.collection(collectionName).doc(id);
  const payload = {
    ...document,
    _id: id,
    id,
    updated_at: document?.updated_at || document?.updatedAt || new Date().toISOString(),
  };
  if (!payload.created_at) payload.created_at = payload.updated_at;
  if (!payload.updatedAt) payload.updatedAt = payload.updated_at;
  if (!payload.createdAt) payload.createdAt = payload.created_at;
  try {
    console.log('[FIRESTORE] saving document', { collectionName, docId: id });
    await ref.set(payload, { merge: true });
    console.log('[FIRESTORE] document saved', { collectionName, docId: id });
  } catch (err) {
    logFirestoreError('document save', err, { collectionName, docId: id });
    throw err;
  }
  return payload;
}

async function updateDocument(collectionName, docId, updates) {
  if (!firestore) throw new Error('Firebase is not configured');
  const updatedAt = updates?.updated_at || updates?.updatedAt || new Date().toISOString();
  const payload = {
    ...updates,
    updated_at: updatedAt,
    updatedAt,
  };
  await firestore.collection(collectionName).doc(docId).set(payload, { merge: true });
  return { _id: docId, id: docId, ...payload };
}

async function deleteDocument(collectionName, docId) {
  if (!firestore) throw new Error('Firebase is not configured');
  await firestore.collection(collectionName).doc(docId).delete();
}

async function getDocument(collectionName, docId) {
  if (!firestore || !docId) return null;
  const snapshot = await firestore.collection(collectionName).doc(docId).get();
  return safeDocData(snapshot);
}

function realtimeQuery(collectionName, constraints = {}, onSnapshot, onError) {
  if (!firestore) return null;
  let query = firestore.collection(collectionName);

  for (const filter of constraints.where || []) {
    query = query.where(filter.field, filter.op || '==', filter.value);
  }
  for (const order of constraints.orderBy || []) {
    query = query.orderBy(order.field, order.direction || 'asc');
  }
  if (constraints.limit) query = query.limit(constraints.limit);

  console.log('[FIREBASE] listener active');
  if (collectionName === 'messages') console.log('[FIREBASE] realtime sync active');
  if (collectionName === 'channels') console.log('[FIREBASE] channel listener active');
  return query.onSnapshot(onSnapshot, onError);
}

async function paginatedMessages(channelId, { communityId = null, limit = 30, before = null } = {}) {
  if (!firestore || !channelId) return [];
  const safeLimit = Math.max(1, Math.min(50, Number(limit || 30)));
  console.log('[FIREBASE] querying messages', { communityId, channelId, limit: safeLimit, before: before || null });

  const builders = [];
  if (communityId) {
    builders.push(() => firestore.collection('messages').where('communityId', '==', communityId).where('channelId', '==', channelId).orderBy('createdAt', 'desc').limit(safeLimit));
    builders.push(() => firestore.collection('messages').where('community_id', '==', communityId).where('channel_id', '==', channelId).orderBy('created_at', 'desc').limit(safeLimit));
  }
  builders.push(() => firestore.collection('messages').where('channelId', '==', channelId).orderBy('createdAt', 'desc').limit(safeLimit));
  builders.push(() => firestore.collection('messages').where('channel_id', '==', channelId).orderBy('created_at', 'desc').limit(safeLimit));

  const byId = new Map();
  for (const buildQuery of builders) {
    try {
      let query = buildQuery();
      if (before) query = query.startAfter(before);
      const snapshot = await query.get();
      for (const doc of snapshot.docs) {
        const data = safeDocData(doc);
        if (!data) continue;
        const docCommunityId = data.communityId || data.community_id;
        const docChannelId = data.channelId || data.channel_id;
        if (communityId && docCommunityId !== communityId) continue;
        if (docChannelId !== channelId) continue;
        byId.set(data._id || data.id, data);
      }
    } catch (err) {
      console.warn('[FIREBASE] message query fallback used:', err.message);
    }
  }

  const messages = Array.from(byId.values())
    .sort((a, b) => String(a.createdAt || a.created_at || '').localeCompare(String(b.createdAt || b.created_at || '')))
    .slice(-safeLimit);
  await repairMessageMirrorFields(messages).catch((err) => console.warn('[FIREBASE] message mirror repair failed:', err.message));
  console.log('[FIREBASE] history restored', { communityId, channelId, count: messages.length, messageIds: messages.map((message) => message._id || message.id) });
  console.log('[FIREBASE] messages synced', { communityId, channelId, count: messages.length });
  return messages;
}

async function listChannelsByCommunity(communityId) {
  if (!firestore || !communityId) return [];
  console.log('[FIREBASE] querying channels', {
    communityId,
    filters: ['community_id == communityId', 'communityId == communityId'],
  });

  const [snakeSnapshot, camelSnapshot] = await Promise.all([
    firestore
    .collection('channels')
    .where('community_id', '==', communityId)
      .get(),
    firestore
      .collection('channels')
      .where('communityId', '==', communityId)
      .get(),
  ]);
  console.log('[FIREBASE] channel loaded');
  console.log('[FIREBASE] channel listener active');

  const byId = new Map();
  for (const snapshot of [snakeSnapshot, camelSnapshot]) {
    for (const doc of snapshot.docs) {
      const data = safeDocData(doc);
      if (data) byId.set(data._id || data.id, data);
    }
  }

  const channels = Array.from(byId.values())
    .sort((a, b) => {
      const positionDelta = Number(a.position || 0) - Number(b.position || 0);
      if (positionDelta !== 0) return positionDelta;
      return String(a.created_at || '').localeCompare(String(b.created_at || ''));
    });

  await repairChannelMirrorFields(channels).catch((err) =>
    console.warn('[FIREBASE] channel mirror repair failed:', err.message)
  );

  console.log('[FIREBASE] channel query result', {
    communityId,
    count: channels.length,
    channelIds: channels.map((channel) => channel._id || channel.id),
  });
  return channels;
}

async function syncChannel(channel) {
  if (!firestore || !channel?._id) return;
  const payload = normalizeChannelDocument(channel, channel._id);
  console.log('[FIREBASE] creating channel', {
    communityId: payload.communityId,
    channelId: payload.id,
    name: payload.name,
    createdBy: payload.createdBy,
  });
  await createDocument('channels', payload, payload._id);
  console.log('[FIREBASE] channel created');
  return payload;
}

async function repairChannelMirrorFields(channels) {
  if (!firestore || !Array.isArray(channels) || channels.length === 0) return;

  const batch = firestore.batch();
  let writes = 0;
  for (const channel of channels) {
    const normalized = normalizeChannelDocument(channel, channel._id || channel.id);
    const needsRepair =
      !channel.communityId ||
      !channel.community_id ||
      !channel.createdBy && normalized.createdBy ||
      !channel.createdAt ||
      !channel.created_at;

    if (!needsRepair || !normalized._id) continue;
    batch.set(firestore.collection('channels').doc(normalized._id), normalized, { merge: true });
    writes += 1;
  }

  if (writes > 0) await batch.commit();
}

async function syncChannelBatch(channels) {
  if (!firestore || !Array.isArray(channels) || channels.length === 0) return;
  const batch = firestore.batch();
  for (const channel of channels) {
    if (!channel?._id) continue;
    const ref = firestore.collection('channels').doc(channel._id);
    batch.set(ref, normalizeChannelDocument(channel, channel._id), { merge: true });
  }
  await batch.commit();
  console.log('[FIREBASE] channel loaded');
}

async function deleteChannel(channelId) {
  if (!firestore || !channelId) return;
  await cleanupDiscussionMediaForChannel(channelId);
  await deleteQueryInBatches(firestore.collection('messages').where('channel_id', '==', channelId));
  await deleteQueryInBatches(firestore.collection('messages').where('channelId', '==', channelId));
  await deleteQueryInBatches(firestore.collection('typing').where('channel_id', '==', channelId));
  await deleteQueryInBatches(firestore.collection('typing').where('channelId', '==', channelId));
  await deleteQueryInBatches(firestore.collection('reactions').where('channel_id', '==', channelId));
  await deleteQueryInBatches(firestore.collection('reactions').where('channelId', '==', channelId));
  await deleteQueryInBatches(firestore.collection('unread_states').where('channel_id', '==', channelId));
  await deleteQueryInBatches(firestore.collection('unread_states').where('channelId', '==', channelId));
  await firestore.collection('channels').doc(channelId).delete();
  console.log('[FIREBASE] channel cleanup complete', { channelId });
}

async function cleanupDiscussionMediaForChannel(channelId) {
  if (!firestore || !channelId) return;

  const [snakeSnapshot, camelSnapshot] = await Promise.all([
    firestore.collection('messages').where('channel_id', '==', channelId).get(),
    firestore.collection('messages').where('channelId', '==', channelId).get(),
  ]);

  const mediaByPublicId = new Map();
  for (const snapshot of [snakeSnapshot, camelSnapshot]) {
    for (const doc of snapshot.docs) {
      const data = doc.data() || {};
      const publicId = data.mediaPublicId || data.media_public_id || data.media?.public_id;
      const resourceType = data.mediaResourceType || data.media_resource_type || data.media?.resource_type || 'image';
      if (publicId) mediaByPublicId.set(publicId, resourceType);
    }
  }

  await Promise.all(Array.from(mediaByPublicId.entries()).map(([publicId, resourceType]) =>
    deleteMedia(publicId, resourceType).catch((err) => {
      console.warn('[CLOUDINARY] cleanup failed:', err.message);
    })
  ));

  console.log('[CLOUDINARY] cleanup complete', { channelId, files: mediaByPublicId.size });
}

async function deleteQueryInBatches(query, batchSize = 400) {
  let snapshot = await query.limit(batchSize).get();
  while (!snapshot.empty) {
    const batch = firestore.batch();
    snapshot.docs.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
    if (snapshot.size < batchSize) break;
    snapshot = await query.limit(batchSize).get();
  }
}

async function getChannelFromFirebase(channelId) {
  const channel = await getDocument('channels', channelId);
  if (channel) console.log('[FIREBASE] channel loaded');
  return channel;
}

async function storeMessage(message) {
  const payload = normalizeMessageDocument(message, message._id || message.id);
  if (!payload.communityId || !payload.channelId || !payload.senderId || (payload.type === 'text' && !payload.text)) {
    throw new Error('Invalid Firestore message payload');
  }
  console.log('[FIREBASE] storing message', {
    communityId: payload.communityId,
    channelId: payload.channelId,
    senderId: payload.senderId,
    messageId: payload.id,
  });
  try {
    console.log('[FIRESTORE] saving metadata', {
      collectionName: 'messages',
      messageId: payload.id,
      channelId: payload.channelId,
      communityId: payload.communityId,
      hasMedia: Boolean(payload.mediaUrl || payload.media_url),
    });
    const stored = await createDocument('messages', payload, payload._id);
    console.log('[FIRESTORE] metadata saved', {
      messageId: stored.id || stored._id,
      channelId: stored.channelId || stored.channel_id,
      communityId: stored.communityId || stored.community_id,
    });
    console.log('[FIREBASE] message stored');
    return stored;
  } catch (err) {
    logFirestoreError('message metadata save', err, {
      messageId: payload.id,
      channelId: payload.channelId,
      communityId: payload.communityId,
    });
    throw err;
  }
}

async function debugFirestoreWrite() {
  if (!firestore) throw new Error('Firebase is not configured');
  const payload = {
    working: true,
    createdAt: Date.now(),
    created_at: new Date().toISOString(),
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cwd: process.cwd(),
    },
  };

  try {
    console.log('[FIRESTORE][DEBUG] writing test document');
    const ref = await firestore.collection('test').add(payload);
    console.log('[FIRESTORE][DEBUG] test document written', { id: ref.id });
    return { id: ref.id, ...payload };
  } catch (err) {
    logFirestoreError('debug write', err, { collectionName: 'test' });
    throw err;
  }
}

async function repairMessageMirrorFields(messages) {
  if (!firestore || !Array.isArray(messages) || messages.length === 0) return;

  const batch = firestore.batch();
  let writes = 0;
  for (const message of messages) {
    const normalized = normalizeMessageDocument(message, message._id || message.id);
    const needsRepair =
      !message.communityId ||
      !message.community_id ||
      !message.channelId ||
      !message.channel_id ||
      !message.senderId ||
      !message.sender_id ||
      !message.createdAt ||
      !message.created_at ||
      (message.text === undefined && normalized.text !== undefined);

    if (!needsRepair || !normalized._id) continue;
    batch.set(firestore.collection('messages').doc(normalized._id), normalized, { merge: true });
    writes += 1;
  }

  if (writes > 0) await batch.commit();
}

async function updatePresence({ userId, communityId = null, status = 'online', socketId = null }) {
  if (!firestore || !userId) return;
  await createDocument('presence', {
    _id: userId,
    user_id: userId,
    userId,
    community_id: communityId,
    communityId,
    status,
    socket_id: socketId,
    socketId,
    last_seen_at: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
  }, userId);
  console.log('[FIREBASE] presence updated');
}

async function setTyping({ channelId, userId, isTyping }) {
  if (!firestore || !channelId || !userId) return;
  const docId = `${channelId}:${userId}`;
  if (isTyping) {
    await createDocument('typing', {
      _id: docId,
      channel_id: channelId,
      channelId,
      user_id: userId,
      userId,
      active: true,
      updated_at: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }, docId);
  } else {
    await deleteDocument('typing', docId);
  }
}

async function setReaction({ messageId, channelId, userId, emoji, action }) {
  if (!firestore || !messageId || !userId || !emoji) return;
  const docId = `${messageId}:${userId}:${encodeURIComponent(emoji)}`;
  if (action === 'remove') {
    await deleteDocument('reactions', docId);
    return;
  }
  await createDocument('reactions', {
    _id: docId,
    message_id: messageId,
    messageId,
    channel_id: channelId || null,
    channelId: channelId || null,
    user_id: userId,
    userId,
    emoji,
    created_at: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  }, docId);
}

async function markChannelRead({ userId, communityId, channelId }) {
  if (!firestore || !userId || !channelId) return;
  const docId = `${userId}:${channelId}`;
  await createDocument('unread_states', {
    _id: docId,
    user_id: userId,
    userId,
    community_id: communityId || null,
    communityId: communityId || null,
    channel_id: channelId,
    channelId,
    unread_count: 0,
    unreadCount: 0,
    last_read_at: new Date().toISOString(),
    lastReadAt: new Date().toISOString(),
  }, docId);
}

async function incrementUnreadStates({ community, channelId, senderId }) {
  if (!firestore || !community || !channelId) return;
  const members = Array.isArray(community.members) ? community.members.filter(Boolean) : [];
  const recipients = members.filter((userId) => userId && userId !== senderId);
  if (recipients.length === 0) return;

  const now = new Date().toISOString();
  let batch = firestore.batch();
  let count = 0;

  for (const userId of recipients) {
    const docId = `${userId}:${channelId}`;
    const ref = firestore.collection('unread_states').doc(docId);
    batch.set(ref, {
      _id: docId,
      id: docId,
      user_id: userId,
      userId,
      community_id: community._id,
      communityId: community._id,
      channel_id: channelId,
      channelId,
      unread_count: admin.firestore.FieldValue.increment(1),
      unreadCount: admin.firestore.FieldValue.increment(1),
      updated_at: now,
      updatedAt: now,
    }, { merge: true });
    count += 1;

    if (count >= 400) {
      await batch.commit();
      batch = firestore.batch();
      count = 0;
    }
  }

  if (count > 0) await batch.commit();
}

async function getUnreadStates(userId, communityId) {
  if (!firestore || !userId || !communityId) return [];
  const snapshot = await firestore
    .collection('unread_states')
    .where('user_id', '==', userId)
    .where('community_id', '==', communityId)
    .limit(200)
    .get();
  return snapshot.docs.map(safeDocData).filter(Boolean);
}

module.exports = hasFirebaseCredentials && firestore
  ? {
      createDocument,
      updateDocument,
      deleteDocument,
      getDocument,
      realtimeQuery,
      paginatedMessages,
      listChannelsByCommunity,
      syncChannel,
      deleteChannel,
      syncChannelBatch,
      getChannelFromFirebase,
      storeMessage,
      updatePresence,
      setTyping,
      setReaction,
      markChannelRead,
      incrementUnreadStates,
      getUnreadStates,
      debugFirestoreWrite,
      db: realtimeDb,
      firestore,
      app: firebaseApp,
    }
  : createUnavailableFirebaseService();

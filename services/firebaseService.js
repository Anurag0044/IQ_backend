// ============================================
// CloudIQ Backend - Firebase Admin Service
// ============================================
// Syncs channel metadata from Cloudant to Firebase Realtime Database
// Used for: channels (metadata only), not messages/messages (handled by frontend)
// Keeps: communities, memberships, posts, tutorials in Cloudant

const admin = require('firebase-admin');

require('dotenv').config();

let firebaseApp = null;
let firebaseDb = null;

// Check if Firebase credentials are configured
const hasFirebaseCredentials = Boolean(
  process.env.FIREBASE_PROJECT_ID &&
  process.env.FIREBASE_CLIENT_EMAIL &&
  process.env.FIREBASE_PRIVATE_KEY
);

function createUnavailableFirebaseService() {
  console.warn('[FIREBASE] Firebase credentials not configured. Firebase sync will be disabled.');
  return {
    syncChannel: async () => { console.warn('[FIREBASE] Sync skipped - not configured'); },
    deleteChannel: async () => { console.warn('[FIREBASE] Delete skipped - not configured'); },
    syncChannelBatch: async () => { console.warn('[FIREBASE] Batch sync skipped - not configured'); },
  };
}

// Initialize Firebase Admin SDK
if (hasFirebaseCredentials) {
  try {
    // Prevent duplicate initialization (important for nodemon restarts)
    if (admin.apps.length === 0) {
      firebaseApp = admin.initializeApp({
        credential: admin.credential.cert({
          projectId: process.env.FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          // Handle Windows multiline private key correctly
          privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
        }),
        databaseURL: process.env.FIREBASE_DATABASE_URL || `https://${process.env.FIREBASE_PROJECT_ID}-default-rtdb.firebaseio.com`,
      });
      firebaseDb = admin.database();
      console.log('[FIREBASE] Admin SDK initialized successfully');
    } else {
      // Reuse existing app if already initialized
      firebaseApp = admin.apps[0];
      firebaseDb = admin.database();
      console.log('[FIREBASE] Admin SDK already initialized, reusing existing app');
    }
  } catch (err) {
    console.error('[FIREBASE] Admin SDK initialization failed:', err.message);
    firebaseApp = null;
    firebaseDb = null;
  }
}

// ─────────────────────────────────────────────
// Channel Metadata Sync (Cloudant → Firebase)
// ─────────────────────────────────────────────

/**
 * Sync a single channel from Cloudant to Firebase
 * This is called when a channel is created or updated
 */
async function syncChannel(channel) {
  if (!firebaseDb || !channel || !channel._id) {
    return;
  }

  try {
    const channelRef = firebaseDb.ref(`channels/${channel._id}`);
    await channelRef.set({
      id: channel._id,
      community_id: channel.community_id,
      name: channel.name,
      topic: channel.topic || null,
      type: channel.type || 'text',
      visibility: channel.visibility || 'members',
      allowed_member_ids: channel.allowed_member_ids || null,
      position: channel.position || 0,
      created_by: channel.created_by || null,
      created_at: channel.created_at,
      updated_at: channel.updated_at,
    });
    console.log(`[FIREBASE] Synced channel ${channel._id} to Firebase`);
  } catch (err) {
    console.error('[FIREBASE] Sync channel failed:', err.message);
  }
}

/**
 * Delete a channel from Firebase
 * Called when a channel is deleted from Cloudant
 */
async function deleteChannel(channelId) {
  if (!firebaseDb || !channelId) {
    return;
  }

  try {
    const channelRef = firebaseDb.ref(`channels/${channelId}`);
    await channelRef.remove();
    console.log(`[FIREBASE] Deleted channel ${channelId} from Firebase`);
  } catch (err) {
    console.error('[FIREBASE] Delete channel failed:', err.message);
  }
}

/**
 * Batch sync multiple channels
 * Used for initial migration or bulk updates
 */
async function syncChannelBatch(channels) {
  if (!firebaseDb || !Array.isArray(channels)) {
    return;
  }

  try {
    const updates = {};
    channels.forEach(channel => {
      if (channel && channel._id) {
        updates[`channels/${channel._id}`] = {
          id: channel._id,
          community_id: channel.community_id,
          name: channel.name,
          topic: channel.topic || null,
          type: channel.type || 'text',
          visibility: channel.visibility || 'members',
          allowed_member_ids: channel.allowed_member_ids || null,
          position: channel.position || 0,
          created_by: channel.created_by || null,
          created_at: channel.created_at,
          updated_at: channel.updated_at,
        };
      }
    });

    if (Object.keys(updates).length > 0) {
      await firebaseDb.ref().update(updates);
      console.log(`[FIREBASE] Batch synced ${Object.keys(updates).length} channels to Firebase`);
    }
  } catch (err) {
    console.error('[FIREBASE] Batch sync channels failed:', err.message);
  }
}

// ─────────────────────────────────────────────
// Permission Sync Helpers
// ─────────────────────────────────────────────

/**
 * Get channel metadata from Firebase
 * Used to verify Firebase has the latest channel data
 */
async function getChannelFromFirebase(channelId) {
  if (!firebaseDb || !channelId) {
    return null;
  }

  try {
    const snapshot = await firebaseDb.ref(`channels/${channelId}`).once('value');
    if (snapshot.exists()) {
      return snapshot.val();
    }
    return null;
  } catch (err) {
    console.error('[FIREBASE] Get channel from Firebase failed:', err.message);
    return null;
  }
}

// Export the service
module.exports = hasFirebaseCredentials
  ? {
      syncChannel,
      deleteChannel,
      syncChannelBatch,
      getChannelFromFirebase,
      db: firebaseDb,
      app: firebaseApp,
    }
  : createUnavailableFirebaseService();

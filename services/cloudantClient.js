// ============================================
// CloudIQ Backend - Cloudant Client Service
// ============================================
// Initializes IBM Cloudant connection and ensures
// all required databases exist on startup.

const { CloudantV1 } = require('@ibm-cloud/cloudant');
const { IamAuthenticator } = require('ibm-cloud-sdk-core');

require('dotenv').config();

const hasCloudantCredentials = Boolean(process.env.CLOUDANT_APIKEY && process.env.CLOUDANT_URL);

function createUnavailableCloudantClient() {
  const missingParams = [];
  if (!process.env.CLOUDANT_APIKEY) missingParams.push('CLOUDANT_APIKEY');
  if (!process.env.CLOUDANT_URL) missingParams.push('CLOUDANT_URL');

  const unavailableError = new Error(
    `Cloudant is not configured. Missing environment variable(s): ${missingParams.join(', ')}`
  );

  const rejectUnavailable = async () => {
    throw unavailableError;
  };

  return {
    getDatabaseInformation: rejectUnavailable,
    putDatabase: rejectUnavailable,
    getDesignDocument: rejectUnavailable,
    postDocument: rejectUnavailable,
    getDocument: rejectUnavailable,
    postView: rejectUnavailable,
    postFind: rejectUnavailable,
    postAllDocs: rejectUnavailable,
    putDocument: rejectUnavailable,
    deleteDocument: rejectUnavailable,
    setServiceUrl: () => { },
  };
}

const cloudant = hasCloudantCredentials
  ? (() => {
    const authenticator = new IamAuthenticator({
      apikey: process.env.CLOUDANT_APIKEY,
    });

    const client = CloudantV1.newInstance({
      authenticator: authenticator,
    });
    client.setServiceUrl(process.env.CLOUDANT_URL);
    console.log('[LABS][CLOUDANT] Cloudant client initialized');
    return client;
  })()
  : (() => {
    console.warn('[LABS][CLOUDANT] Cloudant client not initialized; credentials missing');
    return createUnavailableCloudantClient();
  })();

// ─────────────────────────────────────────────
// All databases required by the platform
// ─────────────────────────────────────────────
const DATABASES = [
  'users',
  'posts',
  'comments',
  'notifications',
  'communities',
  'community_requests',
  'community_memberships',
  'friendships',
  'admins',       // Stores additional admin emails (super admin is in ADMIN_EMAILS env)
  'tutorials',    // Stores tutorial documents with Cloudinary image URLs
  'tutorial_media',
  'upload_metadata',
  // Phase 4: Realtime discussions
  'channels',
  'messages',
  'message_reactions',
  'unread_states',
  // GitHub Codespaces labs
  'lab_sessions',
];

/**
 * Ensures a single database exists.
 * Creates it if it doesn't exist.
 */
async function ensureDatabase(dbName) {
  try {
    await cloudant.getDatabaseInformation({ db: dbName });
    console.log(`  ✔ ${dbName}`);
  } catch (err) {
    if (err.status === 404) {
      try {
        await cloudant.putDatabase({ db: dbName });
        console.log(`  ✚ ${dbName} (created)`);
      } catch (createErr) {
        console.error(`  ✖ Failed to create ${dbName}:`, createErr.message);
      }
    } else {
      console.error(`  ✖ Error checking ${dbName}:`, err.message);
    }
  }
}

/**
 * Creates Cloudant design documents (indexes) for efficient querying.
 */
async function createDesignDocs() {
  const designDocs = [
    // Posts: query by user_id, sort by created_at
    {
      db: 'posts',
      docId: '_design/posts',
      doc: {
        _id: '_design/posts',
        views: {
          by_created_at: {
            map: 'function(doc) { if (doc.created_at) emit(doc.created_at, null); }',
          },
          by_user: {
            map: 'function(doc) { if (doc.user_id) emit(doc.user_id, null); }',
          },
          by_community: {
            map: 'function(doc) { if (doc.community_id) emit(doc.community_id, null); }',
          },
        },
      },
    },
    // Comments: query by post_id
    {
      db: 'comments',
      docId: '_design/comments',
      doc: {
        _id: '_design/comments',
        views: {
          by_post: {
            map: 'function(doc) { if (doc.post_id) emit(doc.post_id, null); }',
          },
        },
      },
    },
    // Notifications: query by user_id
    {
      db: 'notifications',
      docId: '_design/notifications',
      doc: {
        _id: '_design/notifications',
        views: {
          by_user: {
            map: 'function(doc) { if (doc.user_id) emit([doc.user_id, doc.created_at], null); }',
          },
        },
      },
    },
    // Friendships: query by user
    {
      db: 'friendships',
      docId: '_design/friendships',
      doc: {
        _id: '_design/friendships',
        views: {
          by_user: {
            map: 'function(doc) { emit(doc.user_1, null); emit(doc.user_2, null); }',
          },
        },
      },
    },
    // Communities: query by member
    {
      db: 'communities',
      docId: '_design/communities',
      doc: {
        _id: '_design/communities',
        views: {
          by_member: {
            map: 'function(doc) { if (doc.members) { doc.members.forEach(function(m) { emit(m, null); }); } }',
          },
        },
      },
    },
    // Community requests: query by community + status, and by requester
    {
      db: 'community_requests',
      docId: '_design/community_requests',
      doc: {
        _id: '_design/community_requests',
        views: {
          by_community_status: {
            map: 'function(doc) { if (doc.community_id && doc.status) emit([doc.community_id, doc.status, doc.created_at], null); }',
          },
          by_requester: {
            map: 'function(doc) { if (doc.requester_id) emit([doc.requester_id, doc.created_at], null); }',
          },
        },
      },
    },
    // Community memberships: query by community + user
    {
      db: 'community_memberships',
      docId: '_design/community_memberships',
      doc: {
        _id: '_design/community_memberships',
        views: {
          by_community: {
            map: 'function(doc) { if (doc.community_id) emit([doc.community_id, doc.user_id], null); }',
          },
          by_user: {
            map: 'function(doc) { if (doc.user_id) emit([doc.user_id, doc.community_id], null); }',
          },
        },
      },
    },
    // Tutorial media: query by tutorial
    {
      db: 'tutorial_media',
      docId: '_design/tutorial_media',
      doc: {
        _id: '_design/tutorial_media',
        views: {
          by_tutorial: {
            map: 'function(doc) { if (doc.tutorial_id) emit([doc.tutorial_id, doc.created_at], null); }',
          },
        },
      },
    },
    // Upload metadata: query by owner and context
    {
      db: 'upload_metadata',
      docId: '_design/upload_metadata',
      doc: {
        _id: '_design/upload_metadata',
        views: {
          by_owner: {
            map: 'function(doc) { if (doc.owner_id) emit([doc.owner_id, doc.created_at], null); }',
          },
          by_context: {
            map: 'function(doc) { if (doc.context_type && doc.context_id) emit([doc.context_type, doc.context_id, doc.created_at], null); }',
          },
        },
      },
    },
    // Channels: query by community + position
    {
      db: 'channels',
      docId: '_design/channels',
      doc: {
        _id: '_design/channels',
        views: {
          by_community: {
            map: 'function(doc) { if (doc.community_id) emit([doc.community_id, doc.position || 0, doc.created_at], null); }',
          },
        },
      },
    },
    // Messages: query by channel + created_at (history)
    {
      db: 'messages',
      docId: '_design/messages',
      doc: {
        _id: '_design/messages',
        views: {
          by_channel_created_at: {
            map: 'function(doc) { if (doc.channel_id && doc.created_at) emit([doc.channel_id, doc.created_at], null); }',
          },
          pinned_by_channel: {
            map: 'function(doc) { if (doc.channel_id && doc.pinned === true && doc.pinned_at) emit([doc.channel_id, doc.pinned_at], null); }',
          },
        },
      },
    },
    // Message reactions: query by message
    {
      db: 'message_reactions',
      docId: '_design/message_reactions',
      doc: {
        _id: '_design/message_reactions',
        views: {
          by_message: {
            map: 'function(doc) { if (doc.message_id && doc.created_at) emit([doc.message_id, doc.emoji || null, doc.created_at], null); }',
          },
          by_message_user: {
            map: 'function(doc) { if (doc.message_id && doc.user_id) emit([doc.message_id, doc.user_id, doc.emoji || null], null); }',
          },
        },
      },
    },
    // Unread states: query by user/channel
    {
      db: 'unread_states',
      docId: '_design/unread_states',
      doc: {
        _id: '_design/unread_states',
        views: {
          by_user: {
            map: 'function(doc) { if (doc.user_id && doc.updated_at) emit([doc.user_id, doc.updated_at], null); }',
          },
          by_user_channel: {
            map: 'function(doc) { if (doc.user_id && doc.channel_id) emit([doc.user_id, doc.channel_id], null); }',
          },
          by_channel: {
            map: 'function(doc) { if (doc.channel_id) emit(doc.channel_id, null); }',
          },
        },
      },
    },
    // Lab sessions: query active labs by user and expired labs for cleanup
    {
      db: 'lab_sessions',
      docId: '_design/lab_sessions',
      doc: {
        _id: '_design/lab_sessions',
        views: {
          by_user_status: {
            map: 'function(doc) { if (doc.user_id && doc.status) emit([doc.user_id, doc.status, doc.created_at], null); }',
          },
          by_status_expires_at: {
            map: 'function(doc) { if (doc.status && doc.expires_at) emit([doc.status, doc.expires_at], null); }',
          },
        },
      },
    },
  ];

  for (const dd of designDocs) {
    try {
      await cloudant.getDesignDocument({ db: dd.db, ddoc: dd.docId.replace('_design/', '') });
      // Already exists — skip
    } catch (err) {
      if (err.status === 404) {
        try {
          await cloudant.postDocument({ db: dd.db, document: dd.doc });
          console.log(`  ⚡ Created index: ${dd.db}/${dd.docId}`);
        } catch (createErr) {
          // Ignore conflicts (409) — another instance may have created it
          if (createErr.status !== 409) {
            console.error(`  ✖ Failed to create index ${dd.db}/${dd.docId}:`, createErr.message);
          }
        }
      }
    }
  }
}

/**
 * Initialize all databases and indexes on startup.
 */
async function initAllDatabases() {
  if (!hasCloudantCredentials) {
    console.warn('[CLOUDANT] Skipping startup initialization because Cloudant credentials are missing.');
    return;
  }

  console.log('[CLOUDANT] Initializing databases...');
  for (const db of DATABASES) {
    await ensureDatabase(db);
  }
  console.log('[CLOUDANT] Creating design documents...');
  await createDesignDocs();
  console.log('[CLOUDANT] ✅ All databases ready.');
}

initAllDatabases().catch((err) => {
  console.error('[CLOUDANT] Startup initialization failed:', err.message);
});

module.exports = cloudant;

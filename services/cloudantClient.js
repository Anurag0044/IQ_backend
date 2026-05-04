// ============================================
// CloudIQ Backend - Cloudant Client Service
// ============================================
// Initializes IBM Cloudant connection and ensures
// all required databases exist on startup.

const { CloudantV1 } = require('@ibm-cloud/cloudant');
const { IamAuthenticator } = require('ibm-cloud-sdk-core');

require('dotenv').config();

const authenticator = new IamAuthenticator({
  apikey: process.env.CLOUDANT_APIKEY,
});

const cloudant = CloudantV1.newInstance({
  authenticator: authenticator,
});
cloudant.setServiceUrl(process.env.CLOUDANT_URL);

// ─────────────────────────────────────────────
// All databases required by the platform
// ─────────────────────────────────────────────
const DATABASES = [
  'users',
  'posts',
  'comments',
  'notifications',
  'communities',
  'friendships',
  'admins',       // Stores additional admin emails (super admin is in ADMIN_EMAILS env)
  'tutorials',    // Stores tutorial documents with Cloudinary image URLs
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
  console.log('[CLOUDANT] Initializing databases...');
  for (const db of DATABASES) {
    await ensureDatabase(db);
  }
  console.log('[CLOUDANT] Creating design documents...');
  await createDesignDocs();
  console.log('[CLOUDANT] ✅ All databases ready.');
}

initAllDatabases();

module.exports = cloudant;

// ============================================
// CloudIQ Backend - Firestore Client
// ============================================
// Wraps firebase-admin Firestore with a clean CRUD API.
// Reuses the same admin instance initialized by firebaseService.js.
// All functions call getFirestore() lazily so they work even if this
// module is required before firebaseService finishes its sync init.

const logger = require('../utils/logger');
const { v4: uuidv4 } = require('uuid');

// Lazy getter — avoids circular-require / load-order race condition.
// firebaseService initializes Firestore synchronously at module load,
// but both modules may be required in different orders. By deferring
// the reference to call-time we always get the live instance.
function getFirestore() {
  const { firestore } = require('./firebaseService');
  return firestore || null;
}

function ensureFirestore() {
  const fs = getFirestore();
  if (!fs) {
    throw { status: 500, message: 'Firestore not configured. Check FIREBASE_* environment variables.' };
  }
  return fs;
}

// ─── Core CRUD ───────────────────────────────────────────────────────────────

/**
 * Get a single document by ID.
 * Throws { status: 404 } if not found.
 */
async function getDoc(collection, id) {
  const fs = ensureFirestore();
  try {
    const snap = await fs.collection(collection).doc(String(id)).get();
    if (!snap.exists) {
      throw { status: 404, message: `Document ${id} not found in ${collection}` };
    }
    return { _id: snap.id, id: snap.id, ...snap.data() };
  } catch (err) {
    if (err.status === 404) throw err;
    logger.error(`[FIRESTORE] getDoc failed for ${collection}/${id}:`, err.message || err);
    throw err;
  }
}

/**
 * Create or overwrite a document (set).
 * opts.merge = true → only updates provided fields (safe partial update).
 * opts.merge = false (default) → full overwrite.
 */
async function setDoc(collection, id, data, opts = { merge: false }) {
  const fs = ensureFirestore();
  try {
    // Strip undefined values to avoid Firestore errors (ignoreUndefinedProperties
    // is set in firebaseService but this is a safety net)
    const payload = Object.fromEntries(
      Object.entries({ ...data }).filter(([, v]) => v !== undefined)
    );
    // Always stamp _id/id on full writes so documents are self-describing
    if (!opts.merge) {
      payload._id = id;
      payload.id = id;
    }
    await fs.collection(collection).doc(String(id)).set(payload, opts);
    return { _id: id, id, ...payload };
  } catch (err) {
    logger.error(`[FIRESTORE] setDoc failed for ${collection}/${id}:`, err.message || err);
    throw err;
  }
}

/**
 * Add a new document with auto-generated UUID as ID.
 * Returns the saved document including { _id, id }.
 */
async function addDoc(collection, data) {
  const id = uuidv4();
  try {
    return await setDoc(collection, id, data, { merge: false });
  } catch (err) {
    logger.error(`[FIRESTORE] addDoc failed for ${collection}:`, err.message || err);
    throw err;
  }
}

/**
 * Delete a document by ID.
 */
async function deleteDoc(collection, id) {
  const fs = ensureFirestore();
  try {
    await fs.collection(collection).doc(String(id)).delete();
    return { success: true, id };
  } catch (err) {
    logger.error(`[FIRESTORE] deleteDoc failed for ${collection}/${id}:`, err.message || err);
    throw err;
  }
}

/**
 * Query documents with optional filters, ordering, and limit.
 * @param {string} collection
 * @param {Array<[field, op, value]>} filters  e.g. [['status','==','active']]
 * @param {string|null} orderByField
 * @param {'asc'|'desc'} orderDir
 * @param {number|null} limitCount
 * @returns {Promise<Array>} array of { _id, id, ...data }
 */
async function queryDocs(collection, filters = [], orderByField = null, orderDir = 'asc', limitCount = null) {
  const fs = ensureFirestore();
  try {
    let query = fs.collection(collection);

    for (const [field, op, value] of filters) {
      query = query.where(field, op, value);
    }

    if (orderByField) {
      query = query.orderBy(orderByField, orderDir);
    }

    if (limitCount) {
      query = query.limit(limitCount);
    }

    const snapshot = await query.get();
    return snapshot.docs.map(doc => ({ _id: doc.id, id: doc.id, ...doc.data() }));
  } catch (err) {
    logger.error(`[FIRESTORE] queryDocs failed for ${collection}:`, err.message || err);
    throw err;
  }
}

/**
 * Get all documents in a collection (with optional limit).
 */
async function getAllDocs(collection, limitCount = null) {
  return queryDocs(collection, [], null, 'asc', limitCount);
}

/**
 * Get the count of documents in a collection using Firestore count() aggregation.
 * Much cheaper than fetching all docs.
 */
async function getCollectionCount(collection) {
  const fs = ensureFirestore();
  try {
    const snapshot = await fs.collection(collection).count().get();
    return snapshot.data().count;
  } catch (err) {
    logger.error(`[FIRESTORE] getCollectionCount failed for ${collection}:`, err.message || err);
    throw err;
  }
}

/**
 * Merge-set a document (safe partial update, no overwrite of missing fields).
 * Alias for setDoc with merge:true.
 */
async function batchSet(collection, id, data) {
  return setDoc(collection, id, data, { merge: true });
}

module.exports = {
  getDoc,
  setDoc,
  addDoc,
  deleteDoc,
  queryDocs,
  getAllDocs,
  getCollectionCount,
  batchSet,
};

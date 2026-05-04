// ============================================
// CloudIQ Backend - Admin Database Service
// ============================================
// Manages the 'admins' Cloudant database.
// Super admin (main_admin) defined in ADMIN_EMAILS env var.
// All other admins stored in Cloudant with their role.
//
// Role hierarchy (descending authority):
//   main_admin > co_admin > elder_admin > junior_admin

const cloudant = require('./cloudantClient');

const ADMINS_DB = 'admins';

// ─── Role hierarchy ───────────────────────────────────────────────────────────
const ROLE_RANK = {
  main_admin:   4,
  co_admin:     3,
  elder_admin:  2,
  junior_admin: 1,
};

function rankOf(role) {
  return ROLE_RANK[role] ?? 0;
}

// ─── DB bootstrapping ────────────────────────────────────────────────────────
async function ensureAdminsDb() {
  try {
    await cloudant.getDatabaseInformation({ db: ADMINS_DB });
    console.log('[AdminDB] ✔ admins database exists');
  } catch (err) {
    if (err.status === 404) {
      try {
        await cloudant.putDatabase({ db: ADMINS_DB });
        console.log('[AdminDB] ✚ admins database created');
      } catch (createErr) {
        console.error('[AdminDB] ✖ Failed to create admins database:', createErr.message);
      }
    } else {
      console.error('[AdminDB] ✖ Error checking admins database:', err.message);
    }
  }
}
ensureAdminsDb();

// ─── Super-admin (env var) helpers ───────────────────────────────────────────
function getSuperAdminEmails() {
  return (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.length > 0);
}

function isSuperAdmin(email) {
  if (!email) return false;
  return getSuperAdminEmails().includes(email.trim().toLowerCase());
}

// ─── Single-admin lookup ─────────────────────────────────────────────────────
async function getAdminDoc(email) {
  const id = email.trim().toLowerCase();
  try {
    const res = await cloudant.getDocument({ db: ADMINS_DB, docId: id });
    return res.result;
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

async function isAdminInDb(email) {
  const doc = await getAdminDoc(email);
  return doc !== null;
}

// ─── Authoritative admin check (used by middleware) ──────────────────────────
async function checkIsAdmin(email) {
  if (!email) return false;
  const n = email.trim().toLowerCase();
  if (isSuperAdmin(n)) return true;
  return isAdminInDb(n);
}

// ─── Get role of any admin ────────────────────────────────────────────────────
async function getAdminRole(email) {
  if (!email) return null;
  const n = email.trim().toLowerCase();
  if (isSuperAdmin(n)) return 'main_admin';
  const doc = await getAdminDoc(n);
  return doc ? (doc.role || 'junior_admin') : null;
}

// ─── Add admin ────────────────────────────────────────────────────────────────
async function addAdmin(newAdminEmail, role = 'junior_admin', addedByEmail) {
  if (!newAdminEmail) return { success: false, message: 'Email is required' };

  const validRoles = ['co_admin', 'elder_admin', 'junior_admin'];
  if (!validRoles.includes(role)) {
    return { success: false, message: `Invalid role. Choose from: ${validRoles.join(', ')}` };
  }

  const n = newAdminEmail.trim().toLowerCase();

  if (isSuperAdmin(n)) {
    return { success: false, message: 'This email is the main admin' };
  }

  // Permission check — only main_admin and co_admin can add
  if (addedByEmail) {
    const adderRole = await getAdminRole(addedByEmail);
    if (!['main_admin', 'co_admin'].includes(adderRole)) {
      return { success: false, message: 'Only main_admin or co_admin can add new admins' };
    }
  }

  const existing = await getAdminDoc(n);
  if (existing) {
    return { success: false, message: `${n} is already an admin` };
  }

  try {
    await cloudant.postDocument({
      db: ADMINS_DB,
      document: {
        _id:        n,
        email:      n,
        role,
        addedBy:    addedByEmail || 'system',
        created_at: new Date().toISOString(),
      },
    });
    console.log(`[AdminDB] ✅ Added admin: ${n} as ${role}`);
    return { success: true, message: `${n} added as ${role}` };
  } catch (err) {
    if (err.status === 409) return { success: false, message: `${n} is already an admin` };
    console.error('[AdminDB] Error adding admin:', err.message);
    return { success: false, message: 'Failed to add admin: ' + err.message };
  }
}

// ─── Remove admin ─────────────────────────────────────────────────────────────
async function removeAdmin(adminEmail, removedByEmail) {
  if (!adminEmail) return { success: false, message: 'Email is required' };

  const n = adminEmail.trim().toLowerCase();

  if (isSuperAdmin(n)) {
    return { success: false, message: 'Cannot remove the main admin' };
  }

  const targetRole  = await getAdminRole(n);
  if (!targetRole)  return { success: false, message: `${n} is not an admin` };

  // Permission enforcement
  if (removedByEmail) {
    const removerRole = await getAdminRole(removedByEmail);
    if (!removerRole) return { success: false, message: 'You are not an admin' };

    if (removerRole === 'junior_admin') {
      return { success: false, message: 'junior_admin cannot delete anyone' };
    }
    if (removerRole === 'elder_admin' && targetRole !== 'junior_admin') {
      return { success: false, message: 'elder_admin can only delete junior_admin' };
    }
    if (removerRole === 'co_admin' && targetRole === 'main_admin') {
      return { success: false, message: 'co_admin cannot delete main_admin' };
    }
  }

  try {
    const doc = await getAdminDoc(n);
    if (!doc) return { success: false, message: `${n} is not in the admin database` };
    await cloudant.deleteDocument({ db: ADMINS_DB, docId: n, rev: doc._rev });
    console.log(`[AdminDB] ✅ Removed admin: ${n}`);
    return { success: true, message: `${n} removed from admins` };
  } catch (err) {
    console.error('[AdminDB] Error removing admin:', err.message);
    return { success: false, message: 'Failed to remove admin: ' + err.message };
  }
}

// ─── Update role ──────────────────────────────────────────────────────────────
async function updateAdminRole(targetEmail, newRole, updatedByEmail) {
  const validRoles = ['co_admin', 'elder_admin', 'junior_admin'];
  if (!validRoles.includes(newRole)) {
    return { success: false, message: `Invalid role. Choose from: ${validRoles.join(', ')}` };
  }

  const n = targetEmail.trim().toLowerCase();
  if (isSuperAdmin(n)) {
    return { success: false, message: 'Cannot change main_admin role' };
  }

  const targetRole = await getAdminRole(n);
  if (!targetRole)  return { success: false, message: `${n} is not an admin` };

  // Permission enforcement
  if (updatedByEmail) {
    const updaterRole = await getAdminRole(updatedByEmail);
    if (!updaterRole) return { success: false, message: 'You are not an admin' };

    if (updaterRole === 'junior_admin') {
      return { success: false, message: 'junior_admin cannot update roles' };
    }
    if (updaterRole === 'elder_admin' && targetRole !== 'junior_admin') {
      return { success: false, message: 'elder_admin can only update junior_admin roles' };
    }
    if (updaterRole === 'co_admin' && targetRole === 'main_admin') {
      return { success: false, message: 'co_admin cannot update main_admin role' };
    }
  }

  try {
    const doc = await getAdminDoc(n);
    if (!doc) return { success: false, message: `${n} is not in the admin database` };
    const updated = { ...doc, role: newRole, updated_at: new Date().toISOString() };
    await cloudant.putDocument({ db: ADMINS_DB, docId: n, document: updated });
    console.log(`[AdminDB] ✅ Updated admin role: ${n} → ${newRole}`);
    return { success: true, message: `${n} role updated to ${newRole}` };
  } catch (err) {
    console.error('[AdminDB] Error updating admin role:', err.message);
    return { success: false, message: 'Failed to update role: ' + err.message };
  }
}

// ─── List all admins ──────────────────────────────────────────────────────────
async function listAdmins() {
  const result = [];

  // Include super admins first
  for (const email of getSuperAdminEmails()) {
    result.push({
      _id:        email,
      email,
      role:       'main_admin',
      isSuperAdmin: true,
      created_at: null,
    });
  }

  try {
    const response = await cloudant.postAllDocs({
      db:          ADMINS_DB,
      includeDocs: true,
    });
    const rows = response.result.rows || [];
    for (const row of rows) {
      if (row.doc && !row.doc._id.startsWith('_design')) {
        const email = row.doc.email || row.doc._id;
        if (!getSuperAdminEmails().includes(email)) {
          result.push({
            _id:        row.doc._id,
            email,
            role:       row.doc.role || 'junior_admin',
            isSuperAdmin: false,
            created_at: row.doc.created_at || row.doc.addedAt || null,
          });
        }
      }
    }
  } catch (err) {
    console.error('[AdminDB] Error listing admins:', err.message);
  }

  return result;
}

module.exports = {
  checkIsAdmin,
  addAdmin,
  removeAdmin,
  updateAdminRole,
  listAdmins,
  getAdminRole,
  isSuperAdmin,
  getSuperAdminEmails,
};

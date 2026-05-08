// ============================================
// CloudIQ Backend - In-Memory Cache Service
// ============================================
// Lightweight TTL cache to reduce redundant Cloudant reads.
// Designed for Lite-plan optimization:
//   - community docs (hot, read frequently)
//   - membership lookups (per-user per-community)
//   - admin role checks (per-email)
//
// NOT a replacement for Cloudant — just a read-through buffer.
// All writes still go directly to Cloudant; cache is invalidated on mutation.

class TTLCache {
  /**
   * @param {number} defaultTTL — milliseconds before entries expire
   * @param {number} maxEntries — evict oldest when exceeded
   */
  constructor(defaultTTL = 60_000, maxEntries = 500) {
    this._store = new Map();
    this._defaultTTL = defaultTTL;
    this._maxEntries = maxEntries;

    // Periodic sweep every 30s to prevent unbounded growth
    this._sweepInterval = setInterval(() => this._sweep(), 30_000);
    if (this._sweepInterval.unref) this._sweepInterval.unref();
  }

  get(key) {
    const entry = this._store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this._store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key, value, ttl) {
    // Enforce max size — evict oldest
    if (this._store.size >= this._maxEntries) {
      const oldest = this._store.keys().next().value;
      this._store.delete(oldest);
    }
    this._store.set(key, {
      value,
      expiresAt: Date.now() + (ttl ?? this._defaultTTL),
    });
  }

  delete(key) {
    this._store.delete(key);
  }

  /** Delete all keys matching a prefix */
  invalidatePrefix(prefix) {
    for (const key of this._store.keys()) {
      if (key.startsWith(prefix)) this._store.delete(key);
    }
  }

  clear() {
    this._store.clear();
  }

  get size() {
    return this._store.size;
  }

  _sweep() {
    const now = Date.now();
    for (const [key, entry] of this._store) {
      if (now > entry.expiresAt) this._store.delete(key);
    }
  }
}

// ─────────────────────────────────────────────
// Shared cache instances (module-level singletons)
// ─────────────────────────────────────────────

/** Community documents — TTL 2 min (communities change rarely) */
const communityCache = new TTLCache(120_000, 200);

/** Membership status — TTL 90s (join/leave invalidates immediately) */
const membershipCache = new TTLCache(90_000, 1000);

/** Admin role results — TTL 5 min (admin list changes very rarely) */
const adminCache = new TTLCache(300_000, 100);

/** Channel lists per community — TTL 2 min */
const channelCache = new TTLCache(120_000, 200);

module.exports = {
  TTLCache,
  communityCache,
  membershipCache,
  adminCache,
  channelCache,
};

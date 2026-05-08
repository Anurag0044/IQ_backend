// ============================================
// CloudIQ Backend - Stats Broadcaster
// ============================================
// Optimized for Cloudant Lite plan:
//   - Stats (online, posts, members, communities) use getDatabaseInformation (O(1), no doc reads)
//   - Trending topics computed ONCE every 5 minutes (not 15s) using a smaller sample
//   - New connections receive cached state immediately (zero reads)

const cloudant = require('./cloudantClient');

let ioInstance = null;
let lastStats = null;
let lastTrending = null;
let trendingInterval = null;
let statsInterval = null;

// ─── Hashtag extractor ──────────────────────────────────────────────────────
function extractHashtags(text) {
  if (!text) return [];
  const regex = /#[\w-]+/g;
  const matches = text.match(regex);
  return matches ? matches.map(m => m.substring(1).toLowerCase()) : [];
}

// ─── Stats: uses getDatabaseInformation only (O(1) per DB — no doc reads) ──
async function computeStats() {
  if (!ioInstance) return;

  try {
    const onlineCount = ioInstance.engine?.clientsCount || 0;

    let postsCount = 0;
    let membersCount = 0;
    let communitiesCount = 0;

    // getDatabaseInformation returns doc_count in O(1) — zero doc reads
    try {
      const info = await cloudant.getDatabaseInformation({ db: 'posts' });
      postsCount = info.result.doc_count || 0;
    } catch (e) {}

    try {
      const info = await cloudant.getDatabaseInformation({ db: 'community_memberships' });
      membersCount = info.result.doc_count || 0;
    } catch (e) {}

    try {
      const info = await cloudant.getDatabaseInformation({ db: 'communities' });
      communitiesCount = info.result.doc_count || 0;
    } catch (e) {}

    const stats = {
      online: onlineCount,
      posts: postsCount,
      members: membersCount,
      totalCommunities: communitiesCount,
    };

    lastStats = stats;
    ioInstance.emit('stats_update', stats);
  } catch (err) {
    console.warn('[STATS] Failed to compute stats:', err.message);
  }
}

// ─── Trending: runs ONCE every 5 minutes (was: every 15s!) ─────────────────
// Uses postView with limit instead of postFind to reduce read costs.
async function computeTrending() {
  if (!ioInstance) return;

  try {
    const tagCounts = {};

    // Fetch only 20 recent posts (was 50)
    try {
      const res = await cloudant.postView({
        db: 'posts',
        ddoc: 'posts',
        view: 'by_created_at',
        descending: true,
        includeDocs: true,
        limit: 20,
      });
      for (const row of (res.result.rows || [])) {
        const p = row.doc;
        if (!p || p._id.startsWith('_design')) continue;
        const tags = extractHashtags((p.content || '') + ' ' + (p.title || ''));
        if (p.tags && Array.isArray(p.tags)) {
          p.tags.forEach(t => tags.push(t.toLowerCase()));
        }
        for (const tag of tags) {
          tagCounts[tag] = (tagCounts[tag] || 0) + 1;
        }
      }
    } catch (e) {}

    // Skip messages entirely for trending — they're chat noise, not topics.
    // This alone saves 200 doc reads every cycle.

    // Fallback defaults if nothing found
    if (Object.keys(tagCounts).length === 0) {
      const defaults = ['watsonx', 'serverless', 'cloud', 'ibm', 'ai', 'kubernetes'];
      for (const dt of defaults) {
        tagCounts[dt] = Math.floor(Math.random() * 5) + 1;
      }
    }

    const sortedTags = Object.keys(tagCounts)
      .map(tag => ({
        tag: tag.charAt(0).toUpperCase() + tag.slice(1),
        posts: tagCounts[tag],
      }))
      .sort((a, b) => b.posts - a.posts)
      .slice(0, 5);

    lastTrending = sortedTags;
    ioInstance.emit('trending_update', sortedTags);
  } catch (err) {
    console.warn('[STATS] Failed to compute trending:', err.message);
  }
}

function startStatsBroadcaster(io, statsIntervalMs = 30000, trendingIntervalMs = 300000) {
  ioInstance = io;

  // Emit cached state to newly connected clients (zero reads)
  io.on('connection', (socket) => {
    if (lastStats) socket.emit('stats_update', lastStats);
    if (lastTrending) socket.emit('trending_update', lastTrending);
  });

  // Stats every 30s (was 15s) — uses O(1) getDatabaseInformation only
  statsInterval = setInterval(computeStats, statsIntervalMs);

  // Trending every 5 min (was 15s) — reads only 20 posts max
  trendingInterval = setInterval(computeTrending, trendingIntervalMs);

  // Initial computation after 2s
  setTimeout(computeStats, 2000);
  setTimeout(computeTrending, 3000);
}

module.exports = { startStatsBroadcaster };

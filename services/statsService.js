// ============================================
// CloudIQ Backend - Stats Broadcaster
// ============================================

const db = require('./firestoreClient');

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

async function computeStats() {
  if (!ioInstance) return;

  try {
    const onlineCount = ioInstance.engine?.clientsCount || 0;

    let postsCount = 0;
    let membersCount = 0;
    let communitiesCount = 0;

    try {
      postsCount = await db.getCollectionCount('posts');
    } catch (e) {}

    try {
      membersCount = await db.getCollectionCount('community_memberships');
    } catch (e) {}

    try {
      communitiesCount = await db.getCollectionCount('communities');
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

async function computeTrending() {
  if (!ioInstance) return;

  try {
    const tagCounts = {};

    try {
      const posts = await db.queryDocs('posts', [], 'created_at', 'desc', 20);
      for (const p of posts) {
        const tags = extractHashtags((p.content || '') + ' ' + (p.title || ''));
        if (p.tags && Array.isArray(p.tags)) {
          p.tags.forEach(t => tags.push(t.toLowerCase()));
        }
        for (const tag of tags) {
          tagCounts[tag] = (tagCounts[tag] || 0) + 1;
        }
      }
    } catch (e) {}

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

  io.on('connection', (socket) => {
    if (lastStats) socket.emit('stats_update', lastStats);
    if (lastTrending) socket.emit('trending_update', lastTrending);
  });

  statsInterval = setInterval(computeStats, statsIntervalMs);
  trendingInterval = setInterval(computeTrending, trendingIntervalMs);

  setTimeout(computeStats, 2000);
  setTimeout(computeTrending, 3000);
}

module.exports = { startStatsBroadcaster };

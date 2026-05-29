const redisClient = require('../redisClient');

/*
  Thin wrapper over redisClient that auto-JSON, auto-TTL, and — critically —
  never throws out into a request handler. If Redis is down, get() returns
  null and set() / delByPrefix() are no-ops; the request just goes to the DB.
*/

async function get(key) {
  try {
    const value = await redisClient.get(key);
    return value ? JSON.parse(value) : null;
  } catch (err) {
    console.warn('[cache.get]', key, err.message);
    return null;
  }
}

async function set(key, value, ttlSeconds) {
  try {
    await redisClient.set(key, JSON.stringify(value), { EX: ttlSeconds });
  } catch (err) {
    console.warn('[cache.set]', key, err.message);
  }
}

async function delByPrefix(prefix) {
  try {
    const keys = await redisClient.keys(prefix);
    if (keys.length > 0) await redisClient.del(keys);
  } catch (err) {
    console.warn('[cache.delByPrefix]', prefix, err.message);
  }
}

/*
  Set HTTP Cache-Control on a response so the browser HTTP cache (and any
  reverse proxy / CDN configured to honor origin headers) can return the
  next call without touching the API at all.

  - maxAge          how long the response is "fresh" (served from cache w/o
                    revalidation)
  - staleWhile…     after maxAge, browser may still serve the cached copy
                    while it refetches in the background — perfect for
                    listings where slightly-stale data is fine
*/
function httpCache(res, maxAgeSeconds, staleWhileRevalidate = maxAgeSeconds * 4) {
  res.set(
    'Cache-Control',
    `public, max-age=${maxAgeSeconds}, stale-while-revalidate=${staleWhileRevalidate}`
  );
}

module.exports = { get, set, delByPrefix, httpCache };

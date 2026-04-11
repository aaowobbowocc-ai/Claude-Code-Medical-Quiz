/**
 * In-memory response cache middleware with ETag + 304 support.
 * Caches JSON responses keyed by full URL (including query string).
 */

function simpleHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

function createCache(ttlMs = 300_000) {
  const store = new Map();

  function middleware(req, res, next) {
    if (req.method !== 'GET') return next();

    const key = req.originalUrl;
    const cached = store.get(key);

    if (cached && Date.now() - cached.time < ttlMs) {
      if (req.headers['if-none-match'] === cached.etag) {
        return res.status(304).end();
      }
      res.set({
        'Content-Type': 'application/json',
        'ETag': cached.etag,
        'X-Cache': 'HIT',
      });
      return res.send(cached.body);
    }

    // Intercept res.json to capture and cache the response
    const origJson = res.json.bind(res);
    res.json = (data) => {
      const body = JSON.stringify(data);
      const etag = `"${simpleHash(body)}"`;
      store.set(key, { body, etag, time: Date.now() });
      res.set({ 'ETag': etag, 'X-Cache': 'MISS' });
      return origJson(data);
    };
    next();
  }

  middleware.clear = () => store.clear();
  middleware.size = () => store.size;

  return middleware;
}

module.exports = { createCache };

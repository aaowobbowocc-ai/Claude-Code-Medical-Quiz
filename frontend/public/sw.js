const CACHE_NAME = 'medical-quiz-v2'
const SHARED_BANKS_CACHE = 'shared-banks-v1'
const PRECACHE = [
  '/',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
]

// Install: precache shell
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(PRECACHE))
  )
  self.skipWaiting()
})

// Activate: clean old caches (keep current + shared-banks)
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== CACHE_NAME && k !== SHARED_BANKS_CACHE)
          .map(k => caches.delete(k))
      )
    )
  )
  self.clients.claim()
})

// Message: allow clients to invalidate a specific shared bank when bankVersion changes
self.addEventListener('message', (e) => {
  if (e.data?.type === 'invalidate-shared-bank' && e.data.bankId) {
    caches.open(SHARED_BANKS_CACHE).then(cache =>
      cache.keys().then(keys =>
        Promise.all(
          keys
            .filter(req => req.url.includes(`/shared-banks/${e.data.bankId}`))
            .map(req => cache.delete(req))
        )
      )
    )
  }
})

// Fetch: network-first for HTML, cache-first for assets, cache-first for shared banks
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url)

  if (e.request.method !== 'GET') return

  // Shared banks: cross-origin allowed, cache-first, offline-friendly
  if (url.pathname.match(/\/shared-banks\/[^/]+\.json$/)) {
    e.respondWith(
      caches.open(SHARED_BANKS_CACHE).then(cache =>
        cache.match(e.request).then(cached => {
          if (cached) return cached
          return fetch(e.request).then(res => {
            if (res.ok) cache.put(e.request, res.clone())
            return res
          }).catch(() => cached || new Response('{"offline":true}', {
            status: 503,
            headers: { 'Content-Type': 'application/json' },
          }))
        })
      )
    )
    return
  }

  if (url.origin !== self.location.origin) return

  // HTML navigation: network-first
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          const clone = res.clone()
          caches.open(CACHE_NAME).then(c => c.put(e.request, clone))
          return res
        })
        .catch(() => caches.match('/'))
    )
    return
  }

  // Static assets (js, css, images): cache-first
  if (url.pathname.match(/\.(js|css|png|jpg|svg|webp|woff2?)$/)) {
    e.respondWith(
      caches.match(e.request).then(cached =>
        cached || fetch(e.request).then(res => {
          const clone = res.clone()
          caches.open(CACHE_NAME).then(c => c.put(e.request, clone))
          return res
        })
      )
    )
    return
  }
})

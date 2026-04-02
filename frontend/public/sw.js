const CACHE_NAME = 'medical-quiz-v1'
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

// Activate: clean old caches
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  )
  self.clients.claim()
})

// Fetch: network-first for API, cache-first for assets
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url)

  // Skip non-GET and cross-origin API requests
  if (e.request.method !== 'GET') return
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
  if (url.pathname.match(/\.(js|css|png|jpg|svg|woff2?)$/)) {
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

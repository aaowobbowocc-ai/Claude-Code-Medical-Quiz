import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import './index.css'
import { usePlayerStore } from './store/gameStore'

// Apply saved dark mode before render (avoid flash)
try {
  const stored = JSON.parse(localStorage.getItem('medical-quiz-player') || '{}')
  if (stored.state?.darkMode) {
    document.documentElement.classList.add('dark')
    const meta = document.querySelector('meta[name="theme-color"]')
    if (meta) meta.content = '#1a1714'
  }
} catch {}

// Wait for zustand persist to rehydrate from localStorage, then sync with Supabase.
// (If we synced before persist finished, we'd upload empty defaults instead of the user's real local state.)
function syncProfile() {
  usePlayerStore.getState().hydrateFromCloud()
}
if (usePlayerStore.persist.hasHydrated()) {
  syncProfile()
} else {
  const unsub = usePlayerStore.persist.onFinishHydration(() => {
    syncProfile()
    unsub()
  })
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <BrowserRouter>
    <App />
  </BrowserRouter>
)

// Register service worker for PWA offline support
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {})
  })
}

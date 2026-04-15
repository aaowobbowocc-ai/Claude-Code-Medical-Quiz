import React, { Suspense, lazy, useState, useEffect, useLayoutEffect } from 'react'
import { Routes, Route, Navigate, useNavigate, useLocation, useParams } from 'react-router-dom'
import Home from './pages/Home'
import { useSocket, getSocket } from './hooks/useSocket'
import { useDocumentMeta } from './hooks/useDocumentMeta'
import { supabase, consumeOAuthReturnPath } from './lib/supabase'
import { usePlayerStore, useGameStore } from './store/gameStore'
import SplashScreen from './components/SplashScreen'
import ErrorBoundary from './components/ErrorBoundary'
import FixedBottomAd from './components/FixedBottomAd'
import { initRegistry, getRegistry, getExamConfig } from './config/examRegistry'

// Pre-fetch exam registry as early as possible
const registryPromise = initRegistry()

// Lazy-load non-critical pages
const Lobby    = lazy(() => import('./pages/Lobby'))
const Game     = lazy(() => import('./pages/Game'))
const Results  = lazy(() => import('./pages/Results'))
const Map      = lazy(() => import('./pages/Map'))
const Browse   = lazy(() => import('./pages/Browse'))
const Favorites = lazy(() => import('./pages/Favorites'))
const Practice = lazy(() => import('./pages/Practice'))
const History  = lazy(() => import('./pages/History'))
const Review       = lazy(() => import('./pages/Review'))
const Leaderboard  = lazy(() => import('./pages/Leaderboard'))
const Weakness = lazy(() => import('./pages/Weakness'))
const MockExam       = lazy(() => import('./pages/MockExam'))
const Board          = lazy(() => import('./pages/Board'))
const Notes          = lazy(() => import('./pages/Notes'))
const Privacy        = lazy(() => import('./pages/Privacy'))
const Terms          = lazy(() => import('./pages/Terms'))
const Contact        = lazy(() => import('./pages/Contact'))
const Changelog      = lazy(() => import('./pages/Changelog'))

// Path-based exam landing route. Rendered for URLs like /doctor1/ or
// /civil-senior-general/ served from prerendered HTML shells (see
// scripts/generate-shells.cjs). On mount, set the active exam in the
// store so Home renders the correct dashboard; keep the URL unchanged
// so the canonical href matches what Google indexed.
function ExamLandingRoute() {
  const { examSlug } = useParams()
  useLayoutEffect(() => {
    if (!examSlug) return
    const cfg = getExamConfig(examSlug)
    if (cfg) usePlayerStore.getState().setExam(examSlug)
  }, [examSlug])
  return <Home />
}

function PageLoader() {
  return (
    <div className="flex flex-col min-h-dvh bg-medical-ice">
      <div className="h-32 grad-header animate-pulse" />
      <div className="flex flex-col gap-3 px-4 py-4">
        {[0,1,2,3].map(i => (
          <div key={i} className="bg-white rounded-2xl p-4 shadow-sm animate-pulse">
            <div className="h-4 bg-gray-200 rounded w-3/4 mb-3" />
            <div className="h-3 bg-gray-200 rounded w-full mb-2" />
            <div className="h-3 bg-gray-200 rounded w-5/6" />
          </div>
        ))}
      </div>
    </div>
  )
}

function AppRoutes() {
  useSocket() // Mount socket listener globally
  useDocumentMeta() // Sync <title>/<meta>/<canonical> with active exam
  const navigate = useNavigate()
  const location = useLocation()

  // Deep-link handler: ?exam=…&mode=…&subject=…&from=share
  // Priority: URL Param > localStorage activeExam > Stage 1 picker.
  // Runs once on mount (registry is ready because <App> gates on it).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const examParam = params.get('exam')
    if (!examParam) return
    const cfg = getExamConfig(examParam)
    if (!cfg) return // unknown exam id — silently ignore, don't clobber state

    usePlayerStore.getState().setExam(examParam)
    try { sessionStorage.setItem('deep-link-exam', examParam) } catch {}

    const modeParam = params.get('mode')
    if (modeParam === 'pure' || modeParam === 'reservoir') {
      try { localStorage.setItem(`practice-source-mode:${examParam}`, modeParam) } catch {}
    }

    const subjectParam = params.get('subject')
    if (subjectParam) {
      try { localStorage.setItem(`practice-default-subject:${examParam}`, subjectParam) } catch {}
    }

    if (params.get('from') === 'share' && typeof window.gtag === 'function') {
      try {
        window.gtag('event', 'share_link_landing', {
          exam: examParam,
          subject: subjectParam || null,
        })
      } catch {}
    }

    // Strip deep-link params from URL so F5 / share-back doesn't repeatedly rewrite state
    const preservedKeys = new Set(['exam', 'mode', 'subject', 'from'])
    const preserved = new URLSearchParams()
    for (const [k, v] of params.entries()) {
      if (!preservedKeys.has(k)) preserved.append(k, v)
    }
    const qs = preserved.toString()
    navigate(location.pathname + (qs ? `?${qs}` : ''), { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Invite-link handler: ?join=<roomCode> ────────────────────────────
  // Flow: capture roomCode into sessionStorage, strip from URL. If user already
  // has a name, fire join_room immediately; otherwise Home.jsx prompts for name
  // and the second effect below completes the join once name is set.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const joinCode = params.get('join')
    if (!joinCode) return
    const normalized = joinCode.trim().toUpperCase()
    if (!/^[A-Z0-9]{3,8}$/.test(normalized)) return

    // Strip the ?join= param first so refresh doesn't loop
    const clean = new URLSearchParams(params)
    clean.delete('join')
    const qs = clean.toString()
    navigate(location.pathname + (qs ? `?${qs}` : ''), { replace: true })

    // Self-invite guard: if the user is already in this same room (usually the
    // host tapping their own share link), don't re-emit join_room — that would
    // reset their own player entry on the backend. Just bounce them to /lobby.
    if (useGameStore.getState().roomCode === normalized) {
      navigate('/lobby', { replace: true })
      return
    }

    try { sessionStorage.setItem('pending-join-room', normalized) } catch {}

    // If we already have a name, short-circuit: connect + emit immediately.
    const state = usePlayerStore.getState()
    if (state.name) {
      const s = getSocket()
      try { s.connect() } catch {}
      s.emit('join_room', { code: normalized, playerName: state.name, playerAvatar: state.avatar })
      try { sessionStorage.removeItem('pending-join-room') } catch {}
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Watcher: when name becomes available (user just submitted the no-name form),
  // consume the pending join code and auto-emit join_room. useSocket's room_joined
  // listener handles the navigate('/lobby') for us.
  const name = usePlayerStore(s => s.name)
  useEffect(() => {
    if (!name) return
    let pending = null
    try { pending = sessionStorage.getItem('pending-join-room') } catch {}
    if (!pending) return
    const state = usePlayerStore.getState()
    const s = getSocket()
    try { s.connect() } catch {}
    s.emit('join_room', { code: pending, playerName: state.name, playerAvatar: state.avatar })
    try { sessionStorage.removeItem('pending-join-room') } catch {}
  }, [name])

  // Post-OAuth: when Google sign-in completes, force-rehydrate the profile
  // (main.jsx already hydrated the pre-OAuth anon user) and navigate back to
  // whatever page the user was on when they tapped the bind button.
  useEffect(() => {
    if (!supabase) return
    const { data } = supabase.auth.onAuthStateChange(async (evt, session) => {
      if (evt !== 'SIGNED_IN') return
      const user = session?.user
      if (!user || user.is_anonymous) return
      const hasGoogle = user.identities?.some(i => i.provider === 'google')
      if (!hasGoogle) return
      try { await usePlayerStore.getState().hydrateFromCloud(true) } catch {}
      const returnPath = consumeOAuthReturnPath()
      if (returnPath) {
        const current = location.pathname + location.search
        if (returnPath !== current) navigate(returnPath, { replace: true })
      }
    })
    return () => { try { data?.subscription?.unsubscribe() } catch {} }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="phone-frame shadow-2xl">
      <Suspense fallback={<PageLoader />}>
        <Routes>
          <Route path="/"          element={<Home />} />
          <Route path="/map"       element={<Map />} />
          <Route path="/browse"    element={<Browse />} />
          <Route path="/favorites" element={<Favorites />} />
          <Route path="/practice"  element={<Practice />} />
          <Route path="/lobby"     element={<Lobby />} />
          <Route path="/game"      element={<Game />} />
          <Route path="/results"   element={<Results />} />
          <Route path="/history"   element={<History />} />
          <Route path="/review"       element={<Review />} />
          <Route path="/leaderboard"  element={<Leaderboard />} />
          <Route path="/weakness"     element={<Weakness />} />
          <Route path="/mock-exam"    element={<MockExam />} />
          <Route path="/board"       element={<Board />} />
          <Route path="/notes"      element={<Notes />} />
          <Route path="/privacy"    element={<Privacy />} />
          <Route path="/tos"        element={<Terms />} />
          <Route path="/contact"    element={<Contact />} />
          <Route path="/changelog"  element={<Changelog />} />
          {/* Per-exam landing: served from prerendered dist/<id>/index.html
              with baked SEO meta so Googlebot indexes each exam distinctly.
              React Router ranks static segments above params, so all the
              routes above still win — only unknown one-segment paths fall
              through here. */}
          <Route path="/:examSlug"  element={<ExamLandingRoute />} />
          <Route path="*"          element={<Navigate to="/" />} />
        </Routes>
      </Suspense>
      <FixedBottomAd />
    </div>
  )
}

export default function App() {
  const [splashDone, setSplashDone] = useState(false)
  // Block render until exam registry is loaded — first-load on a fresh device has no
  // localStorage cache, so getExamTypes() returns [] until fetch completes, which crashes
  // pages that read currentExam.icon. Cached visits resolve synchronously so this is a no-op.
  const [registryReady, setRegistryReady] = useState(() => !!getRegistry())
  useEffect(() => {
    if (registryReady) return
    let cancelled = false
    registryPromise.then(() => { if (!cancelled) setRegistryReady(true) })
    // Failsafe: even if fetch hangs, unblock after 8s — fallback components handle missing data
    const t = setTimeout(() => { if (!cancelled) setRegistryReady(true) }, 8000)
    return () => { cancelled = true; clearTimeout(t) }
  }, [registryReady])

  return (
    <ErrorBoundary>
      {!splashDone && <SplashScreen onDone={() => setSplashDone(true)} />}
      {registryReady ? <AppRoutes /> : <PageLoader />}
    </ErrorBoundary>
  )
}

import React, { Suspense, lazy, useState, useEffect } from 'react'
import { Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom'
import Home from './pages/Home'
import { useSocket } from './hooks/useSocket'
import { supabase, consumeOAuthReturnPath } from './lib/supabase'
import { usePlayerStore } from './store/gameStore'
import SplashScreen from './components/SplashScreen'
import ErrorBoundary from './components/ErrorBoundary'
import FixedBottomAd from './components/FixedBottomAd'
import { initRegistry, getRegistry } from './config/examRegistry'

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
  const navigate = useNavigate()
  const location = useLocation()

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

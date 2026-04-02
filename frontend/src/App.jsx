import React, { Suspense, lazy, useState } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import Home from './pages/Home'
import { useSocket } from './hooks/useSocket'
import SplashScreen from './components/SplashScreen'

// Lazy-load non-critical pages
const Lobby    = lazy(() => import('./pages/Lobby'))
const Game     = lazy(() => import('./pages/Game'))
const Results  = lazy(() => import('./pages/Results'))
const Map      = lazy(() => import('./pages/Map'))
const Browse   = lazy(() => import('./pages/Browse'))
const Practice = lazy(() => import('./pages/Practice'))
const History  = lazy(() => import('./pages/History'))
const Review   = lazy(() => import('./pages/Review'))

function PageLoader() {
  return (
    <div className="flex items-center justify-center min-h-dvh" style={{ background: '#F0F4F8' }}>
      <span className="text-4xl animate-bounce">⚕️</span>
    </div>
  )
}

function AppRoutes() {
  useSocket() // Mount socket listener globally

  return (
    <div className="phone-frame shadow-2xl">
      <Suspense fallback={<PageLoader />}>
        <Routes>
          <Route path="/"          element={<Home />} />
          <Route path="/map"       element={<Map />} />
          <Route path="/browse"    element={<Browse />} />
          <Route path="/practice"  element={<Practice />} />
          <Route path="/lobby"     element={<Lobby />} />
          <Route path="/game"      element={<Game />} />
          <Route path="/results"   element={<Results />} />
          <Route path="/history"   element={<History />} />
          <Route path="/review"    element={<Review />} />
          <Route path="*"          element={<Navigate to="/" />} />
        </Routes>
      </Suspense>
    </div>
  )
}

export default function App() {
  const [splashDone, setSplashDone] = useState(false)

  return (
    <>
      {!splashDone && <SplashScreen onDone={() => setSplashDone(true)} />}
      <AppRoutes />
    </>
  )
}

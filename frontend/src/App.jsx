import React, { Suspense, lazy, useState } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import Home from './pages/Home'
import { useSocket } from './hooks/useSocket'
import SplashScreen from './components/SplashScreen'
import ErrorBoundary from './components/ErrorBoundary'
import FixedBottomAd from './components/FixedBottomAd'

// Lazy-load non-critical pages
const Lobby    = lazy(() => import('./pages/Lobby'))
const Game     = lazy(() => import('./pages/Game'))
const Results  = lazy(() => import('./pages/Results'))
const Map      = lazy(() => import('./pages/Map'))
const Browse   = lazy(() => import('./pages/Browse'))
const Practice = lazy(() => import('./pages/Practice'))
const History  = lazy(() => import('./pages/History'))
const Review       = lazy(() => import('./pages/Review'))
const Leaderboard  = lazy(() => import('./pages/Leaderboard'))
const MockExam       = lazy(() => import('./pages/MockExam'))
const Board          = lazy(() => import('./pages/Board'))
const Notes          = lazy(() => import('./pages/Notes'))
const Privacy        = lazy(() => import('./pages/Privacy'))
const Terms          = lazy(() => import('./pages/Terms'))
const Contact        = lazy(() => import('./pages/Contact'))

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
          <Route path="/review"       element={<Review />} />
          <Route path="/leaderboard"  element={<Leaderboard />} />
          <Route path="/mock-exam"    element={<MockExam />} />
          <Route path="/board"       element={<Board />} />
          <Route path="/notes"      element={<Notes />} />
          <Route path="/privacy"    element={<Privacy />} />
          <Route path="/tos"        element={<Terms />} />
          <Route path="/contact"    element={<Contact />} />
          <Route path="*"          element={<Navigate to="/" />} />
        </Routes>
      </Suspense>
      <FixedBottomAd />
    </div>
  )
}

export default function App() {
  const [splashDone, setSplashDone] = useState(false)

  return (
    <ErrorBoundary>
      {!splashDone && <SplashScreen onDone={() => setSplashDone(true)} />}
      <AppRoutes />
    </ErrorBoundary>
  )
}

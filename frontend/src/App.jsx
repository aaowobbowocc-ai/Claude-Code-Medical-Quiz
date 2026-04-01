import React, { useState } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import Home from './pages/Home'
import Lobby from './pages/Lobby'
import Game from './pages/Game'
import Results from './pages/Results'
import Map from './pages/Map'
import Browse from './pages/Browse'
import Practice from './pages/Practice'
import History from './pages/History'
import Review from './pages/Review'
import { useSocket } from './hooks/useSocket'
import SplashScreen from './components/SplashScreen'

function AppRoutes() {
  useSocket() // Mount socket listener globally

  return (
    <div className="phone-frame shadow-2xl">
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

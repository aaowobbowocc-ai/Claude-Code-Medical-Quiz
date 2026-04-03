import { useGameStore } from '../store/gameStore'

export default function ConnectionStatus() {
  const connected = useGameStore(s => s.socketConnected)
  const roomCode = useGameStore(s => s.roomCode)

  if (connected || !roomCode) return null

  return (
    <div className="fixed top-0 left-0 right-0 z-50 flex justify-center">
      <div className="bg-red-500 text-white text-xs font-bold px-4 py-2 rounded-b-xl shadow-lg flex items-center gap-2 animate-pulse">
        <span className="w-2 h-2 rounded-full bg-white/60" />
        連線中斷，重新連線中…
      </div>
    </div>
  )
}

import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { usePlayerStore } from '../store/gameStore'

const BACKEND = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001'

export default function CoinGrantModal() {
  const [grant, setGrant] = useState(null)
  const [claiming, setClaiming] = useState(false)
  const hydrated = usePlayerStore(s => s.hydrated)

  useEffect(() => {
    if (!supabase || !hydrated) return
    let cancelled = false
    ;(async () => {
      const { data: { session } } = await supabase.auth.getSession()
      const user = session?.user
      if (!user || user.is_anonymous) return
      const { data, error } = await supabase
        .from('user_coin_grants')
        .select('id, coins, reason, from_name, created_at')
        .eq('user_id', user.id)
        .is('claimed_at', null)
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle()
      if (cancelled || error || !data) return
      setGrant(data)
    })()
    return () => { cancelled = true }
  }, [hydrated])

  const claim = async () => {
    if (!grant || claiming) return
    setClaiming(true)
    try {
      // Atomic server-side claim — 避免 fire-and-forget 導致金幣丟失 bug
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) throw new Error('No session')
      const res = await fetch(`${BACKEND}/api/grants/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ grant_id: grant.id }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || `HTTP ${res.status}`)
      }
      const { coins } = await res.json()
      // Sync local store with server-authoritative coin balance
      usePlayerStore.setState({ coins })
      setGrant(null)
    } catch (e) {
      console.error('[coin-grant] claim failed:', e.message)
    } finally {
      setClaiming(false)
    }
  }

  if (!grant) return null

  return (
    <div className="sheet-overlay" style={{ zIndex: 9999 }}>
      <div className="sheet-panel" style={{ maxWidth: 420, margin: 'auto', padding: '28px 24px', textAlign: 'center' }}>
        <div style={{ fontSize: 48, marginBottom: 8 }}>🎁</div>
        <div style={{ fontSize: 22, fontWeight: 700, marginBottom: 4 }}>
          你收到 <span style={{ color: '#F59E0B' }}>{grant.coins.toLocaleString()}</span> 金幣
        </div>
        {grant.from_name && (
          <div style={{ fontSize: 13, color: '#64748B', marginBottom: 12 }}>來自：{grant.from_name}</div>
        )}
        <div style={{
          background: 'var(--bg-subtle, #F8FAFC)',
          borderRadius: 10,
          padding: '14px 16px',
          margin: '16px 0',
          fontSize: 15,
          lineHeight: 1.6,
          whiteSpace: 'pre-wrap',
          textAlign: 'left',
        }}>
          {grant.reason}
        </div>
        <button
          onClick={claim}
          disabled={claiming}
          style={{
            width: '100%',
            padding: '12px 20px',
            fontSize: 16,
            fontWeight: 600,
            background: claiming ? '#94A3B8' : '#F59E0B',
            color: 'white',
            border: 'none',
            borderRadius: 10,
            cursor: claiming ? 'default' : 'pointer',
          }}
        >
          {claiming ? '領取中…' : '領取'}
        </button>
      </div>
    </div>
  )
}

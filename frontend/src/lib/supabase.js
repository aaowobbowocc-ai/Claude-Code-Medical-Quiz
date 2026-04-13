import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!url || !anonKey) {
  console.warn('[supabase] VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY missing — auth disabled')
}

export const supabase = url && anonKey ? createClient(url, anonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    storageKey: 'medking-auth',
  },
}) : null

export const isAuthEnabled = !!supabase

/**
 * Ensure the user has a session. If none exists, sign in anonymously.
 * Returns the user object, or null if auth is disabled.
 */
export async function ensureSession() {
  if (!supabase) return null
  const { data: { session } } = await supabase.auth.getSession()
  if (session?.user) return session.user
  const { data, error } = await supabase.auth.signInAnonymously()
  if (error) {
    console.error('[supabase] anonymous sign-in failed:', error.message)
    return null
  }
  return data.user
}

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

/**
 * Link Google identity to the current user.
 * - If current user is anon and Google is unlinked → upgrades anon to permanent (keeps user_id + profile data)
 * - If Google is already linked to another supabase user → falls back to signInWithOAuth (switches to that account)
 *
 * Both paths trigger a redirect; nothing happens after this call returns until Supabase processes the callback.
 */
export async function linkOrSignInGoogle() {
  if (!supabase) return { error: 'auth-disabled' }
  const redirectTo = window.location.origin
  const { data: { user } } = await supabase.auth.getUser()

  // Already linked? Just return identity info.
  if (user?.identities?.some(i => i.provider === 'google')) {
    return { alreadyLinked: true }
  }

  // Try link first (preserves current anon user_id + profile)
  if (user && user.is_anonymous) {
    const { error } = await supabase.auth.linkIdentity({
      provider: 'google',
      options: { redirectTo },
    })
    if (!error) return { linking: true }
    console.warn('[supabase] linkIdentity failed, falling back to signIn:', error.message)
  }

  // Fallback: full OAuth sign-in (used on new devices where Google already exists)
  const { error: signErr } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo },
  })
  if (signErr) return { error: signErr.message }
  return { signingIn: true }
}

/**
 * Force a Google account picker and switch to whichever account the user picks.
 * Used by the "換綁 Google" button — replaces current session entirely.
 */
export async function switchGoogleAccount() {
  if (!supabase) return { error: 'auth-disabled' }
  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: window.location.origin,
      queryParams: { prompt: 'select_account' }, // force account picker even if already signed in
    },
  })
  if (error) return { error: error.message }
  return { switching: true }
}

/** Get current user's email + provider info, or null if anon. */
export function getLinkedIdentity(user) {
  if (!user) return null
  const google = user.identities?.find(i => i.provider === 'google')
  if (google) return { provider: 'google', email: user.email || google.identity_data?.email }
  return null
}

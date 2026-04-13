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
 *
 * IMPORTANT: After Google OAuth redirect, the URL contains `?code=...` (PKCE flow)
 * and Supabase needs to async-exchange it for a session. If we call signInAnonymously
 * before that exchange finishes, we'd clobber the just-linked Google session with a
 * fresh anon user. So we wait for the SIGNED_IN event when an OAuth callback is detected.
 */
export async function ensureSession() {
  if (!supabase) return null

  // Detect mid-flight OAuth callback (PKCE: ?code=, implicit: #access_token=)
  const url = typeof window !== 'undefined' ? window.location : null
  const hasOAuthCallback = url && (
    /[?&]code=/.test(url.search) ||
    /access_token=/.test(url.hash)
  )

  if (hasOAuthCallback) {
    // Wait up to 5s for Supabase to finish processing the OAuth callback
    const session = await new Promise(resolve => {
      const timeout = setTimeout(async () => {
        sub.subscription.unsubscribe()
        const { data: { session: s } } = await supabase.auth.getSession()
        resolve(s)
      }, 5000)
      const sub = supabase.auth.onAuthStateChange((evt, s) => {
        if (evt === 'SIGNED_IN' || evt === 'INITIAL_SESSION') {
          clearTimeout(timeout)
          sub.subscription.unsubscribe()
          resolve(s)
        }
      })
    })
    if (session?.user) return session.user
    // Fall through to anon if OAuth failed — at least don't leave the user session-less
  }

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
 * Sign in with Google. If the user already has a Google-linked account, restores it.
 * If this is a brand-new Google sign-in, hydrateFromCloud uploads current zustand
 * state (anon progress) as the new profile, so first-time linkers don't lose data.
 *
 * NOTE: previously used linkIdentity for anon users to preserve user_id, but that
 * fails silently on a second device — linkIdentity tries to attach Google to the
 * fresh anon user, hits "identity already linked elsewhere" async during OAuth
 * callback (no sync error so our fallback never triggered), and the user lands on
 * a stuck anon session that looks like a brand-new account. signInWithOAuth always
 * signs in to the user that owns the Google identity, which is correct "bind"
 * semantics.
 */
export async function linkOrSignInGoogle() {
  if (!supabase) return { error: 'auth-disabled' }
  const { data: { user } } = await supabase.auth.getUser()

  if (user?.identities?.some(i => i.provider === 'google')) {
    return { alreadyLinked: true }
  }

  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.origin },
  })
  if (error) return { error: error.message }
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

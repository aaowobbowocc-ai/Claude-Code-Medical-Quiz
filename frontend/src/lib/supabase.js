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
 * IMPORTANT: After Google OAuth redirect, Supabase async-processes ?code= in the
 * background. The URL gets cleared early (before the API exchange returns), so a
 * URL-only check races against the exchange and can wrongly fall through to
 * signInAnonymously, clobbering the pending Google session with a fresh anon user.
 * linkOrSignInGoogle/switchGoogleAccount set a sessionStorage flag right before
 * redirecting; if that flag is present we wait for a non-anon session before
 * giving up.
 */
const OAUTH_PENDING_KEY = 'medking-oauth-pending'

export async function ensureSession() {
  if (!supabase) return null

  const url = typeof window !== 'undefined' ? window.location : null
  const urlHasCallback = url && (
    /[?&]code=/.test(url.search) ||
    /access_token=/.test(url.hash)
  )
  const oauthPending = typeof sessionStorage !== 'undefined' &&
    sessionStorage.getItem(OAUTH_PENDING_KEY) === '1'

  if (urlHasCallback || oauthPending) {
    if (oauthPending) sessionStorage.removeItem(OAUTH_PENDING_KEY)

    // Wait up to 8s for a real (non-anon) session to appear. Resolves on
    // SIGNED_IN/INITIAL_SESSION events OR if getSession already has one.
    // NOTE: supabase-js v2 returns onAuthStateChange as { data: { subscription } } —
    // calling sub.subscription.unsubscribe() throws and silently breaks the whole
    // hydrate flow, leaving the user stuck on the empty-name screen until refresh.
    const session = await new Promise(resolve => {
      let done = false
      let subscription = null
      const finish = (s) => {
        if (done) return
        done = true
        clearTimeout(timeout)
        try { subscription?.unsubscribe() } catch {}
        resolve(s)
      }
      const timeout = setTimeout(async () => {
        try {
          const { data: { session: s } } = await supabase.auth.getSession()
          finish(s)
        } catch { finish(null) }
      }, 8000)
      const { data } = supabase.auth.onAuthStateChange((evt, s) => {
        if ((evt === 'SIGNED_IN' || evt === 'INITIAL_SESSION') && s?.user && !s.user.is_anonymous) {
          finish(s)
        }
      })
      subscription = data?.subscription
      // Also poll getSession immediately in case the exchange already completed
      supabase.auth.getSession().then(({ data: { session: s } }) => {
        if (s?.user && !s.user.is_anonymous) finish(s)
      }).catch(() => {})
    })
    if (session?.user) return session.user
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

  // CRITICAL: sign out the current anon session before OAuth. With an active
  // anon session, Supabase treats signInWithOAuth as "attach this OAuth identity
  // to the current anon user" rather than "sign in to the user that owns this
  // identity" — so a fresh anon user gets created on every device instead of
  // restoring the existing Google-linked profile. Signing out first forces the
  // OAuth flow to resolve to the existing user_id that owns the Google identity.
  if (user) {
    await supabase.auth.signOut({ scope: 'local' })
  }

  // Mark OAuth in-flight so ensureSession on the post-redirect page knows to
  // wait for the real session instead of racing into signInAnonymously
  sessionStorage.setItem(OAUTH_PENDING_KEY, '1')

  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.origin },
  })
  if (error) {
    sessionStorage.removeItem(OAUTH_PENDING_KEY)
    return { error: error.message }
  }
  return { signingIn: true }
}

/**
 * Force a Google account picker and switch to whichever account the user picks.
 * Used by the "換綁 Google" button — replaces current session entirely.
 */
export async function switchGoogleAccount() {
  if (!supabase) return { error: 'auth-disabled' }
  sessionStorage.setItem(OAUTH_PENDING_KEY, '1')
  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: window.location.origin,
      queryParams: { prompt: 'select_account' }, // force account picker even if already signed in
    },
  })
  if (error) {
    sessionStorage.removeItem(OAUTH_PENDING_KEY)
    return { error: error.message }
  }
  return { switching: true }
}

/** Get current user's email + provider info, or null if anon. */
export function getLinkedIdentity(user) {
  if (!user) return null
  const google = user.identities?.find(i => i.provider === 'google')
  if (google) return { provider: 'google', email: user.email || google.identity_data?.email }
  return null
}

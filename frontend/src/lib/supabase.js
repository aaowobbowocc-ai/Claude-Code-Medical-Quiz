import { createClient } from '@supabase/supabase-js'
import { Capacitor } from '@capacitor/core'
import { App as CapApp } from '@capacitor/app'
import { Browser } from '@capacitor/browser'

const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!url || !anonKey) {
  console.warn('[supabase] VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY missing — auth disabled')
}

const NATIVE = Capacitor.isNativePlatform()

// 原生 App 的 Capacitor webview 上 navigator.locks 會把 Supabase 的 auth lock 卡死
// → getSession / getUser / signInWithOAuth 全部 hang（這正是匿名 session 建不起來、
// Google 登入一直「連線中…」的根因）。原生改用 pass-through lock 關掉鎖；web 維持
// 預設（跨分頁鎖）。詳見 [[feedback_supabase_no_getsession]]。
const passThroughLock = async (_name, _acquireTimeout, fn) => fn()

export const supabase = url && anonKey ? createClient(url, anonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    storageKey: 'medking-auth',
    ...(NATIVE ? { lock: passThroughLock } : {}),
  },
}) : null

export const isAuthEnabled = !!supabase

// ─────────────────────────────────────────────────────────────────────────
// 原生 App 的 Google OAuth（deep-link 版）
// web 的 redirectTo=origin 在原生回不來（origin 是 https://localhost）。改用自訂
// scheme：登完 Supabase 轉址到 tw.examking.app://auth-callback，OS 經 AndroidManifest
// intent-filter / iOS URL scheme 把 App 叫回前景，appUrlOpen 觸發 → 換 session。
// ─────────────────────────────────────────────────────────────────────────
export const NATIVE_OAUTH_REDIRECT = 'tw.examking.app://auth-callback'

async function completeNativeOAuth(rawUrl) {
  let ok = false
  try {
    const u = new URL(rawUrl)
    const code = u.searchParams.get('code')
    if (code) {
      await supabase.auth.exchangeCodeForSession(code)
      ok = true
    } else if (u.hash && u.hash.includes('access_token')) {
      const p = new URLSearchParams(u.hash.replace(/^#/, ''))
      const access_token = p.get('access_token')
      const refresh_token = p.get('refresh_token')
      if (access_token && refresh_token) {
        await supabase.auth.setSession({ access_token, refresh_token })
        ok = true
      }
    }
    try { sessionStorage.removeItem(OAUTH_PENDING_KEY) } catch {}
  } catch (e) {
    console.error('[supabase] native OAuth callback failed:', e?.message)
  } finally {
    try { await Browser.close() } catch {}
  }
  // 登入成功後強制重整：native deep-link 回來時 onAuthStateChange 不一定能即時讓
  // 名字/頭像/金幣更新（要手動重整才會）。重整後 App 用新 session 重新 hydrate →
  // 立即顯示綁定帳號的資料。session 已 persist 到 localStorage，重整不會掉。
  if (ok) {
    setTimeout(() => { try { window.location.reload() } catch {} }, 200)
  }
}

if (NATIVE && supabase) {
  CapApp.addListener('appUrlOpen', ({ url: openedUrl }) => {
    if (openedUrl && openedUrl.startsWith(NATIVE_OAUTH_REDIRECT)) {
      completeNativeOAuth(openedUrl)
    }
  })
}

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
const OAUTH_RETURN_PATH_KEY = 'medking-oauth-return-path'

export function consumeOAuthReturnPath() {
  try {
    const p = sessionStorage.getItem(OAUTH_RETURN_PATH_KEY)
    if (p) sessionStorage.removeItem(OAUTH_RETURN_PATH_KEY)
    return p || null
  } catch { return null }
}

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

  // Remember where the user was before OAuth so App.jsx can restore it after
  // the post-redirect hydrate completes. redirectTo must stay = origin because
  // Supabase validates against the dashboard allow-list.
  try {
    sessionStorage.setItem(OAUTH_RETURN_PATH_KEY, window.location.pathname + window.location.search)
  } catch {}
  // Mark OAuth in-flight so ensureSession on the post-redirect page knows to
  // wait for the real session instead of racing into signInAnonymously
  sessionStorage.setItem(OAUTH_PENDING_KEY, '1')

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: NATIVE ? NATIVE_OAUTH_REDIRECT : window.location.origin,
      skipBrowserRedirect: NATIVE,
    },
  })
  if (error) {
    sessionStorage.removeItem(OAUTH_PENDING_KEY)
    return { error: error.message }
  }
  // 原生：signInWithOAuth 不會自己跳轉，拿 data.url 用系統瀏覽器開；登完 deep-link
  // 回 appUrlOpen → completeNativeOAuth 換 session。
  if (NATIVE && data?.url) {
    try { await Browser.open({ url: data.url }) }
    catch (e) { sessionStorage.removeItem(OAUTH_PENDING_KEY); return { error: e?.message || 'browser open failed' } }
  }
  return { signingIn: true }
}

/**
 * Force a Google account picker and switch to whichever account the user picks.
 * Used by the "換綁 Google" button — replaces current session entirely.
 */
export async function switchGoogleAccount() {
  if (!supabase) return { error: 'auth-disabled' }
  try {
    sessionStorage.setItem(OAUTH_RETURN_PATH_KEY, window.location.pathname + window.location.search)
  } catch {}
  sessionStorage.setItem(OAUTH_PENDING_KEY, '1')
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: NATIVE ? NATIVE_OAUTH_REDIRECT : window.location.origin,
      skipBrowserRedirect: NATIVE,
      queryParams: { prompt: 'select_account' }, // force account picker even if already signed in
    },
  })
  if (error) {
    sessionStorage.removeItem(OAUTH_PENDING_KEY)
    return { error: error.message }
  }
  if (NATIVE && data?.url) {
    try { await Browser.open({ url: data.url }) }
    catch (e) { sessionStorage.removeItem(OAUTH_PENDING_KEY); return { error: e?.message || 'browser open failed' } }
  }
  return { switching: true }
}

/**
 * Read user_id and access_token directly from localStorage.
 * Synchronous, never hangs on Supabase auth lock — used by feedback/report
 * forms so user_id is captured even before hydrateFromCloud completes (which
 * is in-memory and lost on every page refresh).
 *
 * Supabase v2 sometimes splits session.user into a separate 'medking-auth-user'
 * key (legacy userStorage mode), so we check both keys.
 *
 * Last-resort: scan all localStorage keys for any access_token / sub claim,
 * since some browser-state quirks can stash auth under unexpected keys.
 *
 * Returns { user_id, token } where either may be null.
 */
export function readAuthFromStorage() {
  let user_id = null
  let token = null
  try {
    const raw = localStorage.getItem('medking-auth')
    if (raw) {
      const parsed = JSON.parse(raw)
      const session = parsed?.currentSession || parsed
      user_id = session?.user?.id || null
      token = session?.access_token || null
    }
  } catch {}
  if (!user_id) {
    try {
      const userRaw = localStorage.getItem('medking-auth-user')
      if (userRaw) {
        const parsed = JSON.parse(userRaw)
        user_id = parsed?.user?.id || parsed?.id || null
      }
    } catch {}
  }
  // Last resort: decode JWT sub claim from token
  if (!user_id && token) {
    try {
      const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))
      user_id = payload?.sub || null
    } catch {}
  }
  // Last-last resort: scan all localStorage keys for sb-*-auth-token (default key pattern)
  if (!user_id || !token) {
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i)
        if (!k || k === 'medking-auth' || k === 'medking-auth-user') continue
        if (!/auth.*token|sb-.*-auth/i.test(k)) continue
        const v = localStorage.getItem(k)
        if (!v) continue
        try {
          const p = JSON.parse(v)
          const s = p?.currentSession || p
          if (!user_id) user_id = s?.user?.id || p?.user?.id || null
          if (!token) token = s?.access_token || p?.access_token || null
          if (user_id && token) break
        } catch {}
      }
    } catch {}
  }
  return { user_id, token }
}

/** Get current user's email + provider info, or null if anon. */
export function getLinkedIdentity(user) {
  if (!user) return null
  const google = user.identities?.find(i => i.provider === 'google')
  if (google) return { provider: 'google', email: user.email || google.identity_data?.email }
  return null
}

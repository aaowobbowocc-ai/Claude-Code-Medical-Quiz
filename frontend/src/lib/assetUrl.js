import { isNativeApp } from './admob'

// 題目圖片資產（question-images ~261MB + signs ~14MB）在原生 App build 時會被
// 排除，不打包進 APK/IPA（見 codemagic.yaml 的 strip 步驟），否則 App 會肥到
// 300MB+。原生環境改從 web host 載入這些圖（App 本來就要連網抓題目，一致）。
//
// Web 版：照舊回傳相對路徑，由 Vercel 直接服務 public/ 下的檔案。
const REMOTE_ASSET_BASE = 'https://examking.tw'

// 只重寫「原生 App build 排除掉的資料夾」，其餘本機資產（avatars/sounds 等仍打包）
// 保持相對路徑、載入更快。
const STRIPPED_PREFIX = /^\/(question-images|signs)\//

export function assetUrl(src) {
  if (isNativeApp() && typeof src === 'string' && STRIPPED_PREFIX.test(src)) {
    return REMOTE_ASSET_BASE + src
  }
  return src
}

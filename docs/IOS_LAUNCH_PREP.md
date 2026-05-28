# iOS App 上架準備（App Store）

## 前置需求

| 項目 | 必要程度 | 取得方式 |
|------|---------|---------|
| **Mac 電腦**（macOS 13+）| ⭐⭐⭐ 必須 | 借 / 買 / 雲端 Mac 服務（MacInCloud / MacStadium ~$30/月） |
| **Xcode 15+** | ⭐⭐⭐ 必須 | Mac App Store 免費下載（~10 GB）|
| **CocoaPods** | ⭐⭐⭐ 必須 | Terminal: `sudo gem install cocoapods` |
| **Apple Developer 帳號** | ⭐⭐⭐ 必須 | $99/年 USD（NT$3,200）— 用個人 Apple ID 註冊 |
| iPhone / iPad（實機測試）| ⭐⭐ 強烈建議 | 用既有的就好，借朋友也行 |

⚠️ **沒有 Mac 完全做不了 iOS。** 雲端 Mac 服務最便宜的方案如：
- [MacInCloud](https://www.macincloud.com/) — Pay-As-You-Go $1/小時、Managed Server $30/月
- [MacStadium](https://www.macstadium.com/) — $79/月起
- [Codemagic CI/CD](https://codemagic.io/) — 免費 500 build minutes/月

---

## 階段 1：AdMob iOS App + Rewarded Ad Unit

跟 Android 一樣的流程：

1. 開 [AdMob console](https://admob.google.com/v2/home/apps)
2. **Add app** → Platform: **iOS** → **The app is not listed**
3. App name: **國考知識王**
4. 拿到 iOS App ID（格式 `ca-app-pub-3134321405509741~XXXXXXXXXX`）
5. **Add ad unit** → Rewarded → 名稱 `coin_reward_ios`
6. 拿到 Ad Unit ID（格式 `ca-app-pub-3134321405509741/YYYYYYYYYY`）

**告訴開發者**這兩個 ID，會寫進 `src/lib/admob.js` 的 `PROD_AD_UNITS.ios`。

---

## 階段 2：Apple Developer 註冊

1. 到 [developer.apple.com](https://developer.apple.com/programs/)
2. 點 **Enroll**
3. 用個人 Apple ID 登入（建議用你習慣的 Apple ID，避免後續維護兩個帳號）
4. 選 **Individual / Sole Proprietor**（個人開發者）
5. 填基本資訊（真名、聯絡電話、地址）
6. 信用卡刷 **$99 USD**
7. ⚠️ **24-48 小時內 Apple 會驗證身份**（可能透過 email 或電話）
8. 通過後 App Store Connect 才能用

⚠️ **跟 Google Play 一樣，個人帳號 App Store 公開頁會顯示「真名」**。若要顯示公司名 → 需先申請 D-U-N-S Number 改 Organization 帳號（$99/年 + DUNS 費用）。

---

## 階段 3：在 Mac 上 add iOS platform

把專案搬到 Mac（複製 `C:\Projects\examking\` 整個資料夾，或 `git clone` 一份）：

```bash
cd ~/examking/frontend
npm install
npm run build
npx cap add ios          # 需要 cocoapods
npx cap sync ios
```

會在 `frontend/` 下生成 `ios/` 資料夾，結構類似 Android：
- `ios/App/App/Info.plist` ← 主要設定檔
- `ios/App/App.xcworkspace` ← Xcode 用這個（不是 .xcodeproj）

---

## 階段 4：iOS 專用設定

### 4.1 編輯 `ios/App/App/Info.plist`

加入以下兩段（在 `<dict>` 內，任何位置）：

```xml
<!-- AdMob App ID — 必填，缺了 crash on init -->
<key>GADApplicationIdentifier</key>
<string>ca-app-pub-3134321405509741~YOUR_IOS_APP_ID</string>

<!-- ATT (App Tracking Transparency) 廣告追蹤同意說明 — iOS 14+ 必需 -->
<key>NSUserTrackingUsageDescription</key>
<string>讓我們投放更相關的廣告，並維持平台免費。</string>

<!-- SKAdNetwork — Apple 強制要求 AdMob 廣告主整合 -->
<key>SKAdNetworkItems</key>
<array>
  <!-- AdMob's full list: https://developers.google.com/admob/ios/quick-start#skadnetwork -->
  <!-- 列出 Google 官方提供的 60+ SKAdNetwork identifiers -->
  <!-- 因為太多，建議直接從 https://github.com/googleads/googleads-mobile-ios-mediation/blob/main/SKAdNetworks.plist 複製 -->
</array>
```

### 4.2 啟用 ATT 提示

App 第一次啟動時應該跳「允許追蹤」對話框。Capacitor AdMob 6+ 內建支援，但需手動呼叫：

`frontend/src/lib/capacitor-init.js` 加：

```js
// iOS App Tracking Transparency — 第一次啟動跳同意對話框
if (Capacitor.getPlatform() === 'ios') {
  try {
    const { AdMob } = await import('@capacitor-community/admob')
    const trackingInfo = await AdMob.trackingAuthorizationStatus()
    if (trackingInfo.status === 'notDetermined') {
      await AdMob.requestTrackingAuthorization()
    }
  } catch (e) {
    console.warn('[ios] ATT request failed:', e.message)
  }
}
```

### 4.3 iOS UI 微調

- Status bar 樣式：已在 capacitor.config.json 設好（`style: DARK`）
- Safe area：已在 index.css 設好 `env(safe-area-inset-*)`
- 瀏海手機（iPhone X+）會自動套用

---

## 階段 5：金幣商店 iOS 處理（**重要**）

Apple App Store Review Guidelines 4.0 規定：「App 內購買數位內容必須走 IAP」**比 Google 更嚴格**。

我們 Day 4 已經做了 `isNativeApp()` 判斷讓 App 內隱藏付費入口，但要確認 iOS 也吃到這條：

- ✅ `isNativeApp()` 用 `Capacitor.isNativePlatform()`，iOS 也回 true
- ✅ CoinShopSheet 會自動顯示「請從電腦版贊助」訊息

無額外處理。但 App Store 審查員會仔細看，必要時：
- 完全移除 App 版的「贊助按鈕」（不只是替換訊息）
- 連 RewardAdSheet 中的「金幣商店」入口也藏

---

## 階段 6：App Store Connect 上架資料

開 [App Store Connect](https://appstoreconnect.apple.com)：

1. **My Apps** → **+ New App**
2. Platform: **iOS**
3. Name: **國考知識王**
4. Bundle ID: 選 `tw.examking.app`（如果沒有，要去 [Identifiers](https://developer.apple.com/account/resources/identifiers/list) 先建）
5. SKU: `examking-ios-2026`
6. Primary Language: **繁體中文（台灣）**

### 6.1 App Information

| 欄位 | 填法 |
|------|------|
| Subtitle | `國考考古題練習・AI 解說・對戰` |
| Category | **Education** |
| Content Rights | I do not have rights to display third-party content（如果你的題目來自考選部公開資訊，這條 OK；如果是改編內容、勾「I have rights」）|

### 6.2 Pricing
- Price: **Free**
- Availability: Taiwan + 其他繁體中文地區（香港、新加坡等可勾）

### 6.3 App Privacy

依 [Privacy.jsx](frontend/src/pages/Privacy.jsx) 內容填問卷：

| Data Collected | Purpose | Linked to user |
|----------------|---------|----------------|
| Advertising Data（AdMob 用）| Third-Party Advertising | Yes |
| Identifiers / Device ID | Analytics, Advertising | Yes |
| Usage Data | Analytics | No |

**No data collected for tracking across other companies' apps** ← **這項要勾 Yes if you use AdMob**（AdMob 算 tracking）

### 6.4 Description + Screenshots

用 [`docs/GOOGLE_PLAY_LISTING.md`](docs/GOOGLE_PLAY_LISTING.md) 同樣內容（4000 字 description 同個）。

**iOS Screenshot 規格**（Play Store 用的可能要重拍）：
- 6.7" Display（iPhone 14/15 Pro Max）：1290 × 2796
- 6.5" Display（iPhone 11 Pro Max）：1242 × 2688
- 5.5" Display（iPhone 8 Plus）：1242 × 2208（**已廢棄但部分舊裝置仍要**）

建議：在 Xcode 內建模擬器跑 iPhone 14 Pro Max 截圖即可。

---

## 階段 7：Build + Archive + Upload

在 Mac Xcode 內：

1. 開 `ios/App/App.xcworkspace`
2. 上方裝置選 **「Any iOS Device」**
3. 選單 **Product → Archive**（會 build 出 .ipa）
4. Archive 完跳「Distribute App」對話框
5. 選 **App Store Connect → Upload**
6. 等 5-10 分鐘 Apple 處理
7. App Store Connect 內看到 Build 出現
8. 把 Build 綁到剛建的 App 版本
9. **Submit for Review**

審查時間：**24-72 小時**（首次審查可能拖到 7 天）。

---

## 階段 8：審查時可能被退件的點（**先預防**）

| 退件原因 | 預防 |
|---------|------|
| Guideline 4.0：站內購買必須走 IAP | ✅ 我們已隱藏付費入口 |
| Guideline 5.1.1：用 user-tracking 但沒 ATT 提示 | ✅ ATT 已加入 capacitor-init.js |
| Guideline 2.5.4：包含 broken links | 檢查 changelog / about / contact 連結 |
| Guideline 2.1：App crash on launch | 在實機測試過再送 |
| Guideline 4.2.6：太多重複「題庫 App」（spam） | 我們有獨特功能：AI 解說、即時對戰、52 個考試 |
| Guideline 1.4.1：醫療/藥品宣稱效果 | ✅ disclaimer 寫了「僅供練習，不代表醫療建議」|

---

## 時程估算

| 階段 | 工時 |
|------|------|
| AdMob iOS 申請 | 5 分鐘 |
| Apple Developer 註冊 + 驗證 | 24-48 小時 wait |
| Mac 上 add iOS + Info.plist 設定 | 1-2 小時 |
| Xcode 編譯 + 處理錯誤 | 2-4 小時（首次）|
| Screenshots + Store assets | 2-3 小時 |
| Submit + 審查 | 24-72 小時 wait |
| **合計實作時間** | **~10 小時**（+ Apple 審查 wait） |

---

## 總帳

| 項目 | NT$/USD |
|------|---------|
| Apple Developer Program | **$99 USD/年** = NT$3,200 |
| 雲端 Mac（如果沒實體 Mac，建議 MacInCloud Managed Server）| **$30/月** ≈ NT$960 |
| 一次性開發成本（Mac + Apple Dev）| ≈ NT$4,200 |
| 月經常成本 | **$0**（除非租 Mac）|

**回本估算**：iOS 用戶平均 ARPU 比 Android 高 50%。如果 Android 月收 NT$10,000，iOS 上線後同流量級可加 NT$5,000-15,000/月。

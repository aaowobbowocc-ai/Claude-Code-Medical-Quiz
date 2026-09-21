# ─────────────────────────────────────────────────────────────
# R8 / ProGuard 規則
#
# 為什麼要開混淆：Play Console 的「DEX 程式碼最佳化」指標，模糊化低於 25%
# 會影響曝光度與發布資格。Capacitor 專案預設 minifyEnabled false，混淆度只有 2%。
#
# 為什麼需要下面這些 keep：Capacitor 是**用反射按類名載入外掛**的，
# 類名被混淆掉就整個載入失敗——而且只有在真機跑起來才會炸，編譯階段看不出來。
# ─────────────────────────────────────────────────────────────

# ── Capacitor 核心與外掛 ──────────────────────────────────────
# Bridge 以類名反射註冊外掛，這些不能改名
-keep class com.getcapacitor.** { *; }
-keep @com.getcapacitor.annotation.CapacitorPlugin class * { *; }
-keep class * extends com.getcapacitor.Plugin { *; }
# @PluginMethod 標註的方法是 JS 呼叫進來的入口
-keepclassmembers class * {
    @com.getcapacitor.PluginMethod public <methods>;
}

# ── Cordova 相容層（capacitor-cordova-android-plugins）──────────
-keep class org.apache.cordova.** { *; }

# ── WebView 的 JS 介面 ────────────────────────────────────────
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# ── 本專案實際使用的外掛 ──────────────────────────────────────
# AdMob（獎勵式廣告）
-keep class com.google.android.gms.ads.** { *; }
-keep class com.getcapacitor.community.admob.** { *; }
# RevenueCat（金幣 IAP）
-keep class com.revenuecat.purchases.** { *; }
# Google Play Billing（RevenueCat 底層）
-keep class com.android.billingclient.** { *; }
# App / Browser / SplashScreen / StatusBar
-keep class com.capacitorjs.plugins.** { *; }

# ── 反射與序列化需要的中繼資料 ────────────────────────────────
-keepattributes *Annotation*, Signature, InnerClasses, EnclosingMethod, Exceptions

# ── 讓當機堆疊還原得回來（配合 Play Console 上傳 mapping.txt）──
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile

# ── 壓掉編譯期警告（外掛常引用選用相依）────────────────────────
-dontwarn org.apache.cordova.**
-dontwarn com.google.android.gms.**
-dontwarn com.revenuecat.purchases.**

# 司法／公職題庫重整計畫

> 目標：把目前雜亂的司法／公職考試，改成「**先分類科、再分等級**」的乾淨結構，
> 並讓題目透過 shared bank 在類科間共用。本文件為規劃，未動任何資料。

---

## 1. 現況問題

目前 `civil-service` + `law-professional` 分類下的 exam：

| exam id | 模型 | 題數 | 問題 |
|---|---|---|---|
| `civil-senior` | questionsFile | 1188 | ⚠️ 與 `civil-senior-general` **重複**（都是高考三等一般行政）|
| `civil-senior-general` | shell（7 banks）| 3328 | 高考三等一般行政 |
| `civil-junior-general` | shell（9 banks）| 2347 | 普考一般行政 |
| `civil-junior-civil-affairs` | shell（9 banks）| 2422 | 普考一般民政 |
| `civil-elementary-general` | shell（4 banks）| 2009 | 初等一般行政 |
| `judicial` | questionsFile | 450 | ⚠️ 大鍋飯：只有共同科目法學知識，未分類科×等級 |
| `customs` | questionsFile | 959 | ⚠️ 同上：法學知識／英文／國文 |
| `police` / `police4` | questionsFile+banks | 935 / 1475 | ⚠️ 混合模型，未分類科 |
| `lawyer1` | questionsFile | 2968 | 律師一試（綜合法學）|

**三個結構性毛病：**
1. **重複** — `civil-senior` 與 `civil-senior-general` 是同一個東西的兩種做法。
2. **大鍋飯** — `judicial`／`customs`／`police` 把多類科多等級的題目混在一個 exam，使用者無法依自己的類科練習。
3. **兩種模型並存** — questionsFile（自有題庫）vs shell（純 sharedBanks），規則不一致。

---

## 2. 目標結構：類科 × 等級

**主軸 = 類科**（使用者認同「我考財稅行政」），**次軸 = 等級**。

```
類科（一般行政）
 ├─ 高考三級   exam: civil-general-admin-senior
 ├─ 普考       exam: civil-general-admin-junior
 └─ 初等       exam: civil-general-admin-elementary
類科（財稅行政）
 ├─ 高考三級   exam: civil-tax-senior
 └─ 普考       exam: civil-tax-junior
司法體系（書記官）
 ├─ 三等       exam: judicial-clerk-senior
 ├─ 四等       exam: judicial-clerk-junior
 └─ 五等       exam: judicial-clerk-elementary
```

**命名規範：**
- 高普考行政：`civil-<類科slug>-<等級>`，等級 = `senior`(高考三級) / `junior`(普考) / `elementary`(初等)
- 司法特考：`judicial-<職務slug>-<等級>`，等級 = `senior`(三等) / `junior`(四等) / `elementary`(五等)
- 律師、警察維持既有 id（暫不拆）

**每個 exam config：**
- 一律用 **shell 模型**：`questionsFile: null` + `sharedBanks: [...]`
- `sharedScope` 控制 level 過濾（高考撈 senior、普考撈 junior、初等撈 elementary）
- 類科獨有且爬得到測驗題的科目 → 開新 shared bank（不要再用 questionsFile）

---

## 3. 題目共用設計（核心）

**原則：題目按「科目」存一份，類科按「科目組合」引用。**

```
shared bank（按科目）          被哪些類科×等級引用
────────────────────────────  ──────────────────────────────
common_constitution（憲法）    幾乎所有公職
common_law_basics（法學緒論）   幾乎所有公職
common_english（英文）          幾乎所有公職
common_chinese（國文）          幾乎所有公職
common_admin_law（行政法）      一般行政/民政/人事/戶政/法廉… 高考
common_admin_law_junior         同上 普考版（行政法概要）
common_admin_studies（行政學）   一般行政/民政/人事… 高考
common_politics（政治學）        一般行政/民政 高/普
common_local_gov（地方自治）     一般民政
common_civil_law（民法）★新      戶政/法廉/書記官/律師…
common_criminal_law（刑法）★新   法廉/監所/觀護/書記官…
common_public_finance（財政學）★新  財稅行政
common_accounting（會計學）★新   財稅行政/會計
…
```
（★ = 尚未建立、需新爬的 bank）

**機制：**
1. 行政法只爬一次 → `common_admin_law`，每題 `subject_tags:["admin_law"]` + `level`。
2. 任何「考行政法」的類科，exam config 把 `common_admin_law` 放進 `sharedBanks`。
3. server `getSharedQuestionsForExam` 從該 exam 的 banks 撈題、依 `level` 過濾。
4. 同一題一個 `id`、存一份，N 個類科都指向它，**不重複存**。

**省工點：** 類科之間的差異只是「sharedBanks 清單組合不同」。共同科目＋常見專業科目（行政法/憲法/民法…）爬一次共用，只有類科獨有科目要新爬。

---

## 4. metadata 欄位（存 DB、前端先不顯示）

每個 exam config 新增 `meta` 物件，記錄但**前端不渲染**：

```json
"meta": {
  "officialSystem": "公務高普考",  // 考選部正式體系（見下）
  "essayRatio": 0.55,        // 該考試申論題佔比（考選部實際卷面）
  "lawRatio": 0.40,          // 法律科目佔比
  "scrapableMcqRatio": 0.45, // 可爬成選擇題的比例（= 1 - 申論 - 不可得）
  "officialSubjectCount": 8  // 考選部該考試科目數
}
```

- `officialSystem` 取值：`"公務高普考"`（高考普考）/`"地方特考"`/`"司法特考"`/`"專技高考"`（律師等）/`"關務特考"`/`"警察特考"`/`"國營聯招"`。
- **用途**：規劃 ROI（高 lawRatio → shared bank 重用度高）、誠實標示覆蓋率、保留考選部正式分類精確性（UI 分群為考生視角、`meta` 為官方精確值）、未來若要顯示再開。
- **數字來源**：由我們從考選部簡章的卷面結構**自行計算**（哪些卷是申論、哪些是法律科目），**不複製 lawplayer 的數據**（著作權／資料來源原則）。
- **前端**：本階段 `meta` 完全不顯示，純資料層。examRegistry／Coverage 不讀它。

---

## 5. 現有 exam 的處置

| 現有 exam | 處置 |
|---|---|
| `civil-senior` | 題目（行政學/行政法/國文/法緒）migrate 進對應 shared banks → **retire**，id 設別名重導至 `civil-general-admin-senior` |
| `civil-senior-general` | 改名 `civil-general-admin-senior`（或保留 id、僅補 meta）|
| `civil-junior-general` | → `civil-general-admin-junior` |
| `civil-junior-civil-affairs` | → `civil-civil-affairs-junior` |
| `civil-elementary-general` | → `civil-general-admin-elementary` |
| `judicial` | 共同科目題 migrate 進 `common_law_knowledge` 等 → 拆成 `judicial-*-senior` 等類科 shell |
| `customs` | 同上，拆 `customs-*`（或併入公職類科）|
| `police` / `police4` | **不拆類科**（決定）；只統一成 shell 模型。理由：警察專業科目高度申論化、各類科差異大，可爬的只有共同科目，拆了會產生一堆雷同 exam。`meta.officialSystem:"警察特考"` |
| `customs` | `meta.officialSystem:"關務特考"` |
| `lawyer1` | 維持（律師一試綜合法學）。`meta.officialSystem:"專技高考"`（律師為專技高考，非司法特考）|

> exam id **不真的改名**（決定）：保留舊 id，只改 `name` 顯示名稱。
> 理由：改 id 會牽動 9 個接線點 + 斷使用者 localStorage 進度 + 斷 SEO 連結。
> 重整靠「UI 分群 + 顯示名稱 + `meta`」達成，不動 id。

---

## 6. 分階段執行

| 階段 | 內容 | 風險 |
|---|---|---|
| **P0** | 定案命名規範、`meta` schema；本文件 review | 無（純規劃）|
| **P1** | shared bank 標準化盤點；`civil-senior` 題目併入 banks、retire；補 `meta` 欄位到現有 configs | 低 |
| **P2** | 拆 `judicial`／`customs`：共同科目題併 banks → 建類科×等級 shell | 中（接線多）|
| **P3** | 新類科擴充：人事行政、財稅行政、戶政（先 probe 確認測驗題卷）| 中 |
| **P4** | UI：Coverage + 首頁字卡改「類科分組、點進選等級」| 中（前端）|

每階段獨立可部署、可回滾。P3 每個類科都先 probe 考選部確認「有幾卷測驗題」再動工（B2 教訓：高考專業科目多為申論）。

---

## 7. 已定案決議（2026-05）

1. **exam id 不改名** — 保留舊 id，只改顯示名稱 + UI 分群 + `meta`。不斷進度與連結。
2. **警察特考不拆類科** — police/police4 維持，僅統一 shell 模型。
3. **UI 分組自訂、按考選部「考試體系」** — 不照 lawplayer 的「法律佔比」視角（lawplayer 是法律專站、客群不同）。頂層分群：

   ```
   高普考／地方特考   civil-* 各類科（一般行政、民政、人事、財稅、戶政…）
   司法．法律        lawyer1（律師）、judicial（司法特考各職務）、未來司法官
   警察特考          police / police4
   關務特考          customs
   國營事業          state-mgmt / state-hr / state-finance / state-it
   ```
   - 「司法．法律」群刻意把律師＋司法放一起（考生視角同源、律師一試與司法官一試**採同一試題**），但群名**不叫「司法特考」**（律師為專技高考，叫司法特考不精確）。官方體系精確值記在各 exam 的 `meta.officialSystem`。
4. **P3 新類科優先序**：人事行政 → 戶政 → 財稅行政（待 P3 時逐一 probe 確認測驗題卷）。

## 8. 關鍵事實（查證考選部）

- **律師 = 專門職業及技術人員高等考試律師考試**（專技高考），非司法特考；司法官為公務人員性質考試、國家分發。
- **律師一試與司法官一試採同一份試題** → 我們的 `lawyer1` 題庫即等同司法官一試題庫；未來開「司法官」考試，第一試題完全共用 `lawyer1`，免重爬。
- 「專技高考」不可當頂層分群 — 醫師／護理師／藥師等醫事考試本身就是專技高考，會與「醫事人員」群衝突。

---

## 9. P1 執行紀錄（2026-05）

### 9.1 shared bank 盤點（現況 13 個 bank）

| bank | 題數 | levels | 來源 exam |
|---|---|---|---|
| common_admin_law | 300 | senior | civil-senior, police |
| common_admin_law_junior | 499 | junior | civil-junior-general |
| common_admin_studies | 386 | senior | civil-senior, police |
| common_admin_studies_junior | 649 | junior | civil-junior-general |
| common_chinese | 167 | senior | civil-senior, customs |
| common_constitution | 466 | senior | civil-senior, customs, judicial |
| common_english | 573 | senior | civil-senior, customs, judicial |
| common_law_basics | 884 | elementary, senior | civil-elementary-general, civil-senior, customs, judicial |
| common_law_knowledge | 788 | elementary, junior, senior | civil-senior-general, civil-junior-general, 地特, 原民, 客家 |
| common_local_gov | 325 | junior | civil-junior-general, civil-junior-civil-affairs |
| common_politics | 325 | junior | civil-junior-general |
| common_public_mgmt | 250 | junior | civil-junior-general |
| common_state_english | 240 | state | taipower |

命名一致（`common_<科目>` + `_junior` 變體）。未來新類科需新增的 bank：`common_civil_law`、`common_criminal_law`、`common_public_finance`、`common_accounting` 等。

### 9.2 meta.officialSystem 已補（14 configs）

已對所有 civil/judicial/customs/police/lawyer1/state 共 14 個 config 補 `meta.officialSystem`（backend + snapshot 同步）。essayRatio/lawRatio 等比率欄位**留待各 exam 細部處理時逐一計算**（不填估計值，避免假資料）。

### 9.3 civil-senior 收斂 — 已完成（含修復資料污染）

**深查發現的真正問題：** `questions-civil-senior.json`（舊 `scrape-civil-senior.js` pdfjs 解析）**選項位移損壞** —— 同題比對 `common_law_knowledge` 的正確版，發現 questions-civil-senior.json 的選項被切斷／位移、**答案因此指錯**。粗估 ~228+ 題（19%）受損。且 `common_admin_law`／`common_admin_studies` 的 civil-senior 部分是用 `ingest-shared-banks.js` 從這個污染檔匯入 → civil-senior-general 也被污染。

**處置（已執行）：**
1. 新腳本 `rebuild-civil-senior-banks.js` —— 用 `parseColumnAware`（與 civil-senior-general 114 同條好 parser）**重爬 高考三等一般行政 103-114** 的 行政學／行政法／法學知識與英文 → 直接寫入 banks，共 967 題乾淨資料。
2. 清掉污染：移除 constitution／law_basics／english 的舊 civil-senior 誤拆 rows、common_law_knowledge 的舊 partial rows。法學知識與英文改**整卷存進 common_law_knowledge**（law_knowledge_combined），不再題號硬拆。
3. `ingest-shared-banks.js` 移除 civil-senior SOURCES（防止再污染）。
4. `civil-senior` config 改為 **shell**（questionsFile→null、sharedBanks=7 銀行、level_3_common），與 civil-senior-general 同源乾淨資料。
5. **刪除** `questions-civil-senior.json`（污染檔）、cdnQuestions.js 移除其對應。examRegistry CACHE_KEY → v23。

**殘留缺口（待 vision/PUA 補）：** 重爬有 16 處小缺口 ~118 題（行政學/法的 PUA 單位數題、法緒英文的英文段、國文整卷未重爬仍為舊資料）。屬可補的小尾巴，非污染。

---

*狀態：P1 完成（盤點 + meta + civil-senior 收斂含污染修復）。下一步 P2（拆 judicial/customs）。*

# 國考知識王 — 開發指南

## Claude 工作守則

### Model 選擇

- **Subagent 派遣**：雜活（搜尋、grep、讀檔、爬蟲）自動用 `model: "sonnet"`；腦力活（架構設計、複雜 refactor、多檔聯動邏輯）自動用 `model: "opus"`
- **複雜架構任務前**：主動提示使用者「建議切 `/model opus` 再繼續」，不要默默用 Sonnet 硬做
- **完成後**：提醒使用者切回 `sonnet`（`/model sonnet`）以節省費用

### Code Review

每次完成實作後，主動對**本次改動的檔案**跑一輪 code review：
- 邏輯錯誤、off-by-one、null/undefined 風險
- 安全漏洞（XSS、注入、敏感資料外洩）
- 效能問題（不必要的全量讀取、缺少 cache）
- 與現有慣例不一致之處

Review 結果：有問題直接修，無問題一行說明「已 review，無異常」。

---

## 專案架構

```
backend/
  server.js          — Express + Socket.IO 主伺服器
  questions-api.js   — 題目相關 REST API（已解耦，通用 resolve() helper）
  ai.js              — AI 解說（Claude Haiku）
  exam-configs/      — 各考試設定 JSON（config-driven 架構）
  questions-*.json   — 各考試題庫 JSON
  scripts/
    scrape-moex.js   — 考選部國考題庫爬蟲

frontend/
  src/
    store/gameStore.js    — 前端核心 state（考試選擇、對戰）
    pages/Home.jsx        — 首頁 + SEO 內容
    pages/MockExam.jsx    — 模擬考（歷屆 + 隨機）
    pages/Practice.jsx    — 練習模式
    pages/Browse.jsx      — 題庫瀏覽
    pages/Game.jsx        — PvP 對戰
    components/Footer.jsx — 頁尾（含考試平台名稱）
```

---

## 新增考試題庫的完整流程

### 第一步：建立考試設定檔

建立 `backend/exam-configs/{examId}.json`，必要欄位：

```json
{
  "id": "nursing",
  "name": "護理師",
  "short": "護理",
  "icon": "👩‍⚕️",
  "category": "nursing",
  "questionsFile": "questions-nursing.json",
  "totalQ": 400,
  "passScore": 240,
  "passRate": 0.6,
  "papers": [
    {
      "id": "paper1",
      "name": "基礎醫學",          // 顯示用短名
      "subject": "基礎醫學",        // 對應 questions JSON 的 subject 欄位（必須完全一致）
      "subjects": "解剖、生理...",   // 說明文字
      "count": 80                   // 每卷題數
    }
  ],
  "stages": [{ "id": 0, "tag": "all", "name": "全部" }],
  "ui": { "tagNames": {}, "stageStyles": {}, "subjectColors": {} },
  "seo": { ... }
}
```

### 第二步：爬取題庫

```bash
# 先 dry-run 確認 URL 正確
node scripts/scrape-moex.js --exam nursing --dry-run

# 爬取單一年度測試
node scripts/scrape-moex.js --exam nursing --year 115

# 爬取全部年度
node scripts/scrape-moex.js --exam nursing
```

### 第三步：驗證

必須確認以下事項（缺一不可）：

1. **subject 欄位 = config papers[].subject**
   - `exam-years` API 用 `q.subject` 分卷 → mock exam 按 index 對應 `PAPERS[pi]`
   - 若 subject 名稱不一致，模擬考卷別會錯亂
   - 範例：dental2 的 subject="卷一", doctor1 的 subject="醫學(一)"

2. **subject_tag 欄位 = config ui.tagNames 的 key**
   - 前端用 tagNames[subject_tag] 顯示中文名稱
   - 若 tag 不在 tagNames 裡，會直接顯示英文 tag

3. **subject_tag 欄位 = config ui.stageStyles 的 key**
   - Practice/Lobby 的科目選擇器用 stageStyles 取圖示和顏色

4. **每卷題數合理**
   - 每科每年通常 80 題（部分考試 40 或 50 題）
   - 答案數量應 = 題目數量（差異 > 5 題要調查）

5. **JSON 裡的 paper 排序正確**
   - mock exam 用 index 對應，不是用名稱對應
   - 爬蟲按 subjects 陣列順序產生題目，所以 EXAM_DEFS 裡的 subjects 順序 = config papers 順序

6. **session 標籤正確**
   - 必須是 "第一次" 或 "第二次"（前端顯示用）

7. **seo.totalQ 更新**
   - 爬完後要更新 config 裡的 seo.totalQ = 實際題數

### 第四步：後端驗證

```bash
# 啟動 backend，確認 /exam-registry 回傳新考試
node server.js

# 測試 exam-years API
curl "http://localhost:3001/questions/exam-years?exam=nursing"
```

### 第五步：前端全功能測試

切換到新考試後測試：
- Practice 練習模式：科目選擇器正確、可作答
- MockExam 模擬考：歷屆考題卷別正確、隨機模考可出題
- Browse 題庫瀏覽：題目可篩選
- PvP 對戰：房間可建立
- BossChallenge：可進入

---

## 題目 JSON Schema

```json
{
  "id": "110030_1",        // 唯一 ID（exam_code + _ + 序號）
  "roc_year": "110",       // 民國年（字串）
  "session": "第一次",      // "第一次" | "第二次"
  "exam_code": "110030",   // 考選部場次代碼
  "subject": "基礎醫學",    // ★ 卷別名稱（必須 match config papers[].subject）
  "subject_tag": "basic_medicine",  // ★ 科目 tag（必須 match config ui.tagNames key）
  "subject_name": "基礎醫學",       // 科目全名（顯示用）
  "stage_id": 0,           // 階段 ID（新考試統一用 0）
  "number": 1,             // 題號（1-80）
  "question": "題目文字",
  "options": { "A": "...", "B": "...", "C": "...", "D": "..." },
  "answer": "A",           // 正確答案（A/B/C/D）
  "explanation": "",       // AI 解說（爬蟲不填，後續 AI 生成）
  "disputed": true         // 爭議題（送分題）— 選填
}
```

**關鍵規則**：
- `subject` 是「卷別名稱」不是「科目名稱」
  - 多科同一卷時：subject="卷一", subject_name="口腔顎面外科" (dental2 的做法)
  - 一科一卷時：subject="基礎醫學", subject_name="基礎醫學" (nursing 的做法)
- `id` 必須全域唯一（跨年度不重複）

---

## 考選部爬蟲 — 踩過的坑與避錯指南

### 1. Subject code 是 4 碼，不是 2 碼
- **錯誤**：用 `s=11` 下載 → 回傳 "not found"
- **正確**：用 `s=0101` 下載
- **如何避免**：去考選部搜尋頁面 HTML 的 `<option>` 裡找實際代碼，不要猜

### 2. Class code 對應要正確
- 護理師 = 101, 營養師 = 102（容易搞反）
- 醫檢師 = 308, 物治師 = 311, 職治師 = 312
- **如何避免**：從考選部搜尋頁面的類科下拉選單確認

### 3. 答案 PDF 格式：全形連續字母
- **錯誤假設**：答案格式是 `1.C 2.A 3.B`
- **實際格式**：`答案ＣＡＡＣＢＤ...`（全形 ＡＢＣＤ 連續排列，每 20 題一行）
- 解析時用 regex `/答案\s*([ＡＢＣＤ]+)/g`，逐字元拆分
- **如何避免**：先手動下載一份 PDF 確認格式再寫 parser

### 4. pdf-parse 版本
- v2.x 是 class API（`new PDFParse()`），v1.1.1 是 function API（`pdfParse(buffer)`）
- 本專案用 v1.1.1：`const pdfParse = require('pdf-parse')`
- **如何避免**：`package.json` 鎖定 `"pdf-parse": "1.1.1"`

### 5. 考選部 302 重導向陷阱
- 查無資料時回傳 `302 → /htmNotFoundPage.htm?...`（相對路徑）
- Node.js `https.get` 無法解析相對重導向 URL → 程式崩潰
- **修正**：偵測 `location` 不以 `http` 開頭時直接 reject
- **如何避免**：所有 HTTP 下載函式都要處理非標準重導向

### 6. 場次代碼不可猜測
- 每年場次代碼不規律：110 年第二次是 110080，111 年起是 111090
- 030 系列的第二次場次代碼尤其不穩定（113080? 114080? 不確定）
- **如何避免**：必須從考選部搜尋頁面下拉選單確認實際代碼，或用 dry-run 測試

### 7. 每科 subject code 可能隨場次不同
- 醫檢師的「臨床生理學與病理學」：020 場次用 0107，090 場次用 0103
- **解法**：scrape-moex.js 用 `subjectsByCode` 結構分場次定義
- **如何避免**：每個場次都要個別確認 subject code

### 8. 更正答案（corrections）
- t=M 的 PDF 包含「送分」和「更正答案」
- 送分題用 `disputed: true` 標記，保留原答案
- 更正答案直接覆蓋 answers

### 9. Class code 非全域唯一 — 隨年度/場次不同
- **錯誤假設**：c=101 永遠是護理師
- **事實**：110 年 030 系列 c=101 是「中醫師」，114 年才是「護理師」
- PDF 會正常下載，但內容是不同考試 → parser 回傳 0 題（格式不同）
- **如何避免**：下載後檢查 PDF 文字第一行的「類科名稱」是否正確

### 10. 題號跟內容在不同行 + 藥品劑量干擾
- 部分 PDF 格式：`1.\n題目文字`（題號和文字分兩行）
- 選項內出現 `1.0`, `2.5` 等數字會被誤認為題號
- **修正**：regex 改為不允許題號後接數字 `^(\d{1,2})[.、．]\s*([^\d].*)$`
- 且不允許已開始解析後重設回第 1 題

### 11. exam-years API 卷別排序
- `Object.entries()` 的順序取決於題目在 JSON 裡的插入順序
- 前端 MockExam 用 index 對應 config `PAPERS[pi]`
- **必須**在 API 端按 config paper 順序排序，否則卷別會錯配

### 12. 各考試實際可用年度（考選部電子系統）
- 護理師 (c=101, 030)：114, 115（110-112 的 c=101 是中醫師）
- 營養師 (c=102, 030)：112, 114, 115
- 物治師 (c=311, 020+090)：114, 115（020）+ 114（090）
- 職治師 (c=312, 090)：114
- 醫檢師 (c=308, 020+090)：114, 115（020）+ 114（090）
- 舊年度可能用不同 class code 或未上線電子系統

---

## 100-105 年爬蟲（scrape-100-105.js）

100-105 年的考選部系統跟 106 年以後**完全不同**，有獨立的爬蟲腳本。

### 爬蟲腳本

| 腳本 | 用途 |
|------|------|
| `scripts/scrape-100-105.js` | 主爬蟲，126 個 target，支援 `--exam`/`--year`/`--dry-run` |
| `scripts/fix-answers-100-105.js` | 答案修正，用 pdfjsLib 位置解析重新比對 |
| `scripts/probe-old-years.js` | 第一輪探測：場次代碼 × class code |
| `scripts/probe-old-years-2.js` | 第二輪探測：驗證 PDF 類科名稱 |
| `scripts/probe-old-years-3.js` | 第三輪探測：下載 PDF 取類科+科目名 |
| `scripts/probe-subjects.js` | 探測每個 class code 有哪些 subject code |
| `scripts/probe-subject-names.js` | 取 subject 全名，對應到 paper 結構 |

### 100-105 年 vs 106+ 年的關鍵差異

1. **Class code 完全重新洗牌**
   - 100 年 c=101=醫師，104 年 c=101=中醫師，114 年 c=101=護理師
   - 同一個 class code 在不同年度代表不同考試，絕對不能假設

2. **兩套場次代碼格式**
   - 030 系列（4 碼 subject code：s=0101, 0201…）：醫師/藥師/醫檢/物治/中醫/護理/營養/社工
   - 020 系列（2 碼 subject code：s=11, 22…）：牙醫/職治/放射/物治(101+)/醫檢(102+)/藥師(103+)

3. **PDF 沒有 (A)(B)(C)(D) 選項標記**
   - 106+ 年的 PDF 選項有 `(A)` `(B)` `(C)` `(D)` 前綴，text parser 可直接抓
   - 100-105 年選項是純文字，靠欄位位置區分 → 必須用 mupdf column-aware parser
   - `scripts/lib/moex-column-parser.js` 的 `parseColumnAware(buf)` 處理這種格式

4. **答案 PDF 格式差異**
   - 106+ 年：全形 `答案ＡＢＣＤ…`
   - 100-105 年：半形 `答案ABCD…`（每 20 題一組，連續排列）
   - 更正答案用 `#` 或 `＃` 標記被更正的題號位置
   - 必須同時處理全形和半形格式

5. **答案 PDF URL 差異**
   - 106+ 年：`t=S` 取答案
   - 100 年部分科目：`t=S` 回 302，要用 `t=A`（合併答案 PDF，一個檔案含全部科目）
   - `t=A` 的答案 PDF 含 3000+ 個答案（全部科目混在一起），text parser 會抓錯偏移量
   - **修正答案必須用 pdfjsLib 位置解析**，不能用 text parser

### 100-105 年 class code 對照表

**030 系列：**

| 年度 | c=101 | c=102 | c=103 | c=104 | c=105 | c=106 | c=107 |
|------|-------|-------|-------|-------|-------|-------|-------|
| 100 | 醫師 | — | 藥師 | 醫檢師 | 護理師 | — | 中醫師 |
| 101 | 醫師 | 醫師二階 | 藥師 | 醫檢師 | 護理師 | 中醫師 | 營養師 |
| 102-103 | (unknown) | — | 中醫師? | 中醫師? | — | — | 護理師 |
| 104 | 中醫師(一) | 中醫師(二) | 營養師 | — | — | 護理師 | 社工師 |
| 105 | 中醫師(一) | 中醫師(二) | 營養師 | — | — | 護理師 | 社工師 |

⚠️ **Years 102-103 nutrition: class code unknown.** Previous assumption c=103 was wrong (that's TCM). Nutrition 102-103 data has been removed from questions-nutrition.json. If these years exist on MoEX, they need further investigation.

**020 系列：**

| c code | 考試 | 可用年度 |
|--------|------|---------|
| 301 | 牙醫師(一) | 100-104 |
| 305 | 職能治療師 | 101-104 |
| 308 | 醫事放射師 | 100-104 |
| 309 | 物理治療師 | 101-104 |
| 311 | 醫事檢驗師 | 102-104 |
| 312 | 藥師一階 | 103-104 |

### 場次代碼對照表

| 年度 | 030 系列 | 020 系列 | 其他 |
|------|---------|---------|------|
| 100 | 100030 | 100020 | — |
| 101 | 101030 | 101010 (一次), 101100 (二次) | — |
| 102 | — | 102020 (一次), 102100 (二次) | — |
| 103 | — | 103020 (一次), 103090 (二次) | — |
| 104 | 104100 | 104020 | — |
| 105 | 105030 (一次), 105090 (二次) | — | — |

### 已知限制

- **105 年護理師/營養師**：PDF 選項完全沒有 ABCD 標記且排版混亂，column parser 只取到 B/D 選項，A/C 為空 → 已標記 `incomplete: true`（約 425+80 題）
- **100 年醫師一階**：答案 PDF 不存在（t=S 回 302），從 t=A 合併答案 PDF 取得，再用 pdfjsLib 位置解析修正
- **102 年職治師 小兒疾病**：text/column parser 都只解出 6/80 題，PDF 格式特殊
- **年度缺口**：醫師一階只有 100-101（102-105 不在線上系統）、藥師二階只有 100-101、社工師從 104 開始

### 題庫現況（2026-04-17 更新）

| 考試 | 題數 | 年度範圍 | 不完整題 |
|------|------|---------|---------|
| 物治師 | 13,918 | 100-115 | 113 |
| 放射師 | 13,906 | 100-115 | 266 |
| 醫檢師 | 12,951 | 100-115 | 675 |
| 職治師 | 10,966 | 100-114 | 133 |
| 護理師 | 9,094 | 100-115 | 543 |
| 醫師二階 | 8,902 | 100-115 | 218 |
| 中醫師(二) | 8,228 | 100-115 | 75 |
| 牙醫師(二) | 7,920 | 100-115 | 116 |
| 藥師一階 | 6,897 | 100-115 | 201 |
| 營養師 | 5,666 | 101,104-115 | 245 |
| 藥師二階 | 5,589 | 100-115 | 313 |
| 醫師一階 | 4,584 | 100-115 | 44 |
| 牙醫師(一) | 4,319 | 100-115 | 116 |
| 中醫師(一) | 4,139 | 100-115 | 48 |
| 社工師 | 2,622 | 104-115 | 63 |
| 司法特考三等 | 444 | 106-114 | — |

注意：
- 營養師 100/102/103 年題目已移除（原為錯誤的中醫師 class code 資料）
- 社工師 112-114 第二次（112110, 113100, 114100, c=103）已於 2026-04-17 新增
- 職治師/獸醫師 110年起只有第二次（第一次考試停辦），非資料缺口
- 醫師一階 105年、106-107年第一次：無法取得（CBT 電腦化考試，非 PDF，MoEX 無存档）

---

## 考選部 URL 結構

```
https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx
  ?t=Q          # Q=試題, S=答案, M=更正答案
  &code=114030  # 場次代碼（民國年 + 序號 + 0）
  &c=101        # 類科代碼
  &s=0101       # 科目代碼（4碼）
  &q=1          # 固定值
```

場次代碼系列：
- `030` 系列：護理師(101)、營養師(102)、社工師(103)의 **第一次**
- `090`/`100`/`110`/`111` 系列：030 系列考試的 **第二次**（年度不同代碼不同，見下表）
- `020` 系列：醫師/牙醫/藥師/醫檢師/放射師/物治師 第一次（106年起）
- `100`/`090` 系列：020 系列考試的 **第二次**
- `120` 系列：司法特考（113-114 年）
- `130` 系列：司法特考（106-112 年）

**護理/營養/社工 第二次 session code 對照（c=101/102/103）**：

| 年度 | 第一次 | 第二次 |
|------|--------|--------|
| 105 | 105030 | 105090 |
| 106 | 106030 | 106110 |
| 107 | 107030 | 107110 |
| 108 | 108020 | 108110 |
| 109 | 109030 | 109110 |
| 110 | 110030 | 110111 |
| 111 | 111030 | 111110 |
| 112 | 112030 | 112110 |
| 113 | 113030 | 113100 |
| 114 | 114030 | 114100 |
| 115 | 115030 | — |

**司法特考三等 法學知識與英文 s code 對照（c=101）**：

| 年度 | session code | s code |
|------|-------------|--------|
| 106 | 106130 | 0415 |
| 107 | 107130 | 0414 |
| 108 | 108130 | 0414 |
| 109 | 109130 | 0412 |
| 110 | 110130 | 0315 |
| 111 | 111130 | 0315 |
| 112 | 112130 | 0313 |
| 113 | 113120 | 0309 |
| 114 | 114120 | 0309 |

---

## 已知題庫缺口（2026-04-18 審計）

### 無法修復（嵌圖片 / 格式特殊）
- 醫師二階 103年 第一/二次 醫學(四)：各缺 16/18 題，題目嵌入圖片
- 職治師 102年 第二次 小兒疾病：6/80 題，PDF 格式特殊，column parser 失敗

### 假性缺口（申論題）
- 護理師 102-103年 各科：40/50 題 — 每科 10 申論題正常排除
- 營養師 101, 104-112年 各科：40/50 題 — 同上
- 藥師二階 法規 102-104年：50/80 題 — 該科考試本身只有 50 題，config count 標示有誤

### 複選題結構差異
- 律師一試 105/106年 民法/民訴：74 題（62單選 + 12複選），非 80 題缺口，config count 標示有誤

### 散落圖片題（需 OCR 補入）
- 中醫師(一) 109年 第一次 基礎(二)：72/80，散落 8 題（Q7,9,10,12,14,21,27,28）
- 中醫師(二) 109年 第一次 臨床(三)：71/80，散落 9 題
- 中醫師(二) 109年 第一次 臨床(四)：70/80，散落 10 題

### 解析失敗（關務特考 PDF 格式不同）
- 關務特考 108/111/112/113年 法學知識：各缺 6-12 題，散落缺口，考選部三等/四等分級嵌入PDF中段

### class code 錯誤（已移除污染資料，待重爬）
- 藥師一階 104年 第二次：全部 3 卷 180 題已移除（原為護理內容）
  - 正確 session/class 未知，需瀏覽器查考選部確認
- 藥師二階 104年 第二次 調劑/藥治：130 題已移除
- 藥師二階 105年 第一/二次 調劑/藥治：各 130 題已移除（共 390 題）
  - 105020/105100 的 c=310 s=33/55 返回護理或遺傳題內容
  - 正確 class code 需透過 mupdf column parser 比對或瀏覽器查 MoEX 確認

### 放射師 111年 第二次 器材學
- 69/80 題，後 11 題疑似 PDF 截斷
- 111100 session 的全部 URL 目前返回 302（可能暫時被限速）

---

## Mock Exam 卷別邏輯

`/questions/exam-years` API 回傳各年度的卷別結構：
1. 按 `q.subject` 欄位分組 → 每個 unique subject = 一卷
2. 統計每卷內各 `subject_tag` 的題數（distribution）
3. 前端 MockExam.jsx 用 **index** 對應 config 的 `PAPERS[pi]`

**關鍵**：papers 的順序由 JSON 檔裡題目的出現順序決定（JS `Object.entries` 保持插入序）。所以爬蟲產生的題目順序 = config papers 的順序。

---

## 部署注意事項

- 前端部署在 Vercel（自動 deploy from git push）
- 後端部署在 Render
- 改了 backend 的題庫 JSON 或 exam-configs 後必須重新部署 backend
- 改了 frontend 的 code 後 push 即自動部署

---

## 開發慣例

- 考試 ID 命名：`doctor1`, `doctor2`, `dental1`, `dental2`, `pharma1`, `pharma2`, `nursing`, `nutrition`, `pt`, `ot`, `medlab`
- 題庫檔案命名：`questions-{examId}.json`（doctor1 例外，用 `questions.json`）
- Config 檔案命名：`exam-configs/{examId}.json`
- 所有年份用民國年字串："110", "111", ..., "115"
- session 只有兩種值："第一次", "第二次"

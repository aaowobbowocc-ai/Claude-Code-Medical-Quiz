# 國考知識王 — 開發指南

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
- `030` 系列：護理師(101)、營養師(102)
- `020` 系列：醫檢師(308)、物治師(311)
- `090` 系列：職治師(312)；也有醫檢師(308)、物治師(311) 的第二次

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

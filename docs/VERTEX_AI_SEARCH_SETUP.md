# Vertex AI Search 建置流程

把 216,685 題題庫灌進 Vertex AI Search，作為三個新功能的後端：

- **#2 題庫全文搜尋** — 使用者輸入關鍵字（藥名、條文、症狀）找出所有相關題目
- **#3 RAG retrieval** — `/explain` 把命中的相關題目當 context 送進 LLM（取代 pgvector）
- **#4 找類似題** — 答錯一題後 semantic search 找出 5 題類似的練習

**這 3 個功能都被 `Trial credit for GenAI App Builder` 抵免額 ($31,527) 覆蓋。**

---

## 階段 0：前置（一次）

1. 確認專案：`gen-lang-client-0502672630`
2. 啟用 API：
   ```bash
   gcloud services enable discoveryengine.googleapis.com \
       --project=gen-lang-client-0502672630
   ```
3. 確認 ADC 認證（同 `ai.js` / `rag.js` 用的那組）：
   ```bash
   gcloud auth application-default login
   ```

---

## 階段 1：匯出題庫 JSONL

已寫好腳本，直接跑：

```bash
cd 醫師知識王/backend
node scripts/export-questions-for-vertex-search.js
```

輸出：`backend/_tmp/vertex-search/questions.jsonl`（216,685 行、~132 MB）

每行一個 doc：

```json
{
  "id": "doctor1_1150203963",
  "content": "下列有關短小包膜絛蟲...\nA. ①吞食蟲卵為唯一的感染途徑\n...",
  "structData": {
    "exam_id": "doctor1",
    "exam_name": "醫師一階",
    "question_id": "1150203963",
    "roc_year": "103",
    "session": "第一次",
    "subject_name": "寄生蟲學",
    "number": 54,
    "answer": "B",
    "disputed": false
  }
}
```

---

## 階段 2：上傳 JSONL 到 GCS

Vertex AI Search 從 GCS 讀資料。

```bash
# 建 bucket（一次）
gsutil mb -p gen-lang-client-0502672630 -l us-central1 \
    gs://quiz-vertex-search-corpus

# 上傳 JSONL
gsutil cp backend/_tmp/vertex-search/questions.jsonl \
    gs://quiz-vertex-search-corpus/questions.jsonl
```

GCS 儲存費用 ~$0.003/月（132 MB）— 不在抵免額範圍但金額可忽略。

---

## 階段 3：建立 Data Store

兩條路：A 用 Console（推薦，首次最直觀）/ B 用 CLI。

### A. Console 路徑

1. 開 [Vertex AI Search Console](https://console.cloud.google.com/gen-app-builder/data-stores)
2. **CREATE DATA STORE**
3. Source: **Cloud Storage**
4. URI: `gs://quiz-vertex-search-corpus/questions.jsonl`
5. Data type: **Structured data**
6. 命名：`quiz-questions`（會自動加 random suffix → `quiz-questions_1234567890`）
7. Location: `global`
8. **CREATE** → 等 15-60 分鐘索引

### B. CLI 路徑

```bash
DATASTORE_ID="quiz-questions-$(date +%s)"
curl -X POST -H "Authorization: Bearer $(gcloud auth print-access-token)" \
  -H "Content-Type: application/json" \
  "https://discoveryengine.googleapis.com/v1/projects/gen-lang-client-0502672630/locations/global/collections/default_collection/dataStores?dataStoreId=$DATASTORE_ID" \
  -d '{
    "displayName":"quiz-questions",
    "industryVertical":"GENERIC",
    "solutionTypes":["SOLUTION_TYPE_SEARCH"],
    "contentConfig":"NO_CONTENT"
  }'

# Trigger import
curl -X POST -H "Authorization: Bearer $(gcloud auth print-access-token)" \
  -H "Content-Type: application/json" \
  "https://discoveryengine.googleapis.com/v1/projects/gen-lang-client-0502672630/locations/global/collections/default_collection/dataStores/$DATASTORE_ID/branches/0/documents:import" \
  -d '{
    "gcsSource":{
      "inputUris":["gs://quiz-vertex-search-corpus/questions.jsonl"],
      "dataSchema":"document"
    },
    "reconciliationMode":"FULL"
  }'
```

完成後 console 應該看得到 ~216k docs 進去。

---

## 階段 4：建立 Search Engine

Data store 是資料倉，Search Engine 是查詢接口。

Console：[Search Apps](https://console.cloud.google.com/gen-app-builder/engines) → **CREATE APP** → **Search** → 綁剛才的 data store → **CREATE**

記下 engine ID（如 `quiz-search_1234567890`）。

---

## 階段 5：設定 backend env

把 IDs 加進 backend `.env`：

```bash
VERTEX_SEARCH_DATASTORE_ID=quiz-questions_1234567890
VERTEX_SEARCH_ENGINE_ID=quiz-search_1234567890
VERTEX_SEARCH_LOCATION=global
```

並把同樣兩條設到 Oracle 的環境變數（production）。

---

## 階段 6：啟用 search 後端

`backend/search.js` 已備好（next step），等 env 配好直接：

```bash
# Smoke test
curl -X POST localhost:3001/search/questions \
  -H "Content-Type: application/json" \
  -d '{"q":"fomepizole","limit":10}'
```

---

## 帳單預期

| SKU | 估算用量/月 | 估算金額 |
|-----|-----------|---------|
| `Vertex AI Search: Search API Request Count - Standard` | 30k queries（1k/天）| ~$120 |
| `VAIS Configurable Pricing: indexing core` | one-time 216k docs | ~$10（首次）|
| `VAIS Configurable Pricing: Embedding Storage` | 216k embeddings | ~$5/月 |

**月支出約 $130，年 $1,560 → 全部進 $31,527 抵免額**，到 2027/5/4 過期還剩 $29,000+ 用不完。

---

## 故障排除

| 症狀 | 原因 |
|------|------|
| Data store 建好但 docs=0 | JSONL 格式錯誤；用 `head -1 questions.jsonl \| jq .` 驗 |
| Import 卡 4 hr | 結構化資料 schema 推導失敗；改用 generic 文件型 |
| Search 回空 | engine 還沒 ready（indexing），等 30 分鐘再試 |
| `403 PERMISSION_DENIED` | ADC 帳號沒 `Discovery Engine Admin` role，去 IAM 加 |
| 帳單意外暴增 | 看 SKU 拆解確認是 Search API 而非 Healthcare API（後者貴 10 倍）|

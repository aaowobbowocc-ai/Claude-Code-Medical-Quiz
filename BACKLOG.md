# BACKLOG — 待辦事項與已知議題

未排程進當前 sprint 的工作。建立日期：2026-04-15。

---

## 醫事題庫品質優化專案

當前焦點是擴張到法律/公職領域（Plan Part C/D/E），這幾項屬於既有醫事題庫的細節改善，刻意延後到擴張站穩後再回頭處理。

### 1. PUA 字型造成的空括號（system-wide）

**症狀**：題目敘述出現 `（）`、`（  ）` 等空括號，常見於 doctor1 生理學題目（P_O2、P_CO2、Cosm、V_A 等下標符號）。

**原因**：考選部 PDF 用 PUA（Private Use Area）字型編碼下標/上標，scrape pipeline 的 `stripPUA` 把這些字元剝掉後留下空括號殼。

**範例**：
- [questions.json](醫師知識王/backend/questions.json) `110101_1_64`
- [questions.json](醫師知識王/backend/questions.json) `113020_1_62`
- [questions.json](醫師知識王/backend/questions.json) `115020_1_62` 的選項 A-D 都有 `（）`

**未來處理方向**：
- **方案 A**：對 PUA 字元做查表式 mapping（用 mupdf 的 ToUnicode 或字型 CMap），把 P_{O_2} 解碼成 LaTeX-style 字串
- **方案 B**：前端引入 KaTeX/MathJax 渲染，題目儲存 LaTeX，渲染時轉成數學符號
- **方案 C**：降階方案，掃描題庫把 `（）` 替換成題目意義上的純文字（如 `（PO2）`），手動審核

**為何延後**：影響閱讀但不影響答題正確性；需先確認是否值得引入 KaTeX 才能決定方案。

### 2. 醫檢圖片題闕漏 / 圖片標錯

**症狀**：C6 在 2026-04-14 回報「醫檢圖片闕漏錯誤特別嚴重 很多提標註圖片可能沒辦法顯示 但是現在應該都要有或者標錯了」。

**範圍**：[questions-medlab.json](醫師知識王/backend/questions-medlab.json)、可能也涵蓋部分 [questions-tcm2.json](醫師知識王/backend/questions-tcm2.json) 舌診題（如 `1941`，已標 `incomplete`）。

**未來處理方向**：
- 用 mupdf 的圖片提取功能掃過所有 medlab PDF，產出 `image-test/` 目錄做 ground truth
- 建立 `image_id → question_id` 對照表，與現有 `q.image_url` 欄位 reconcile
- 圖片重抓走 [scripts/fix-images.js](醫師知識王/backend/scripts/fix-images.js) / [scripts/fix-nursing-images-2026.js](醫師知識王/backend/scripts/fix-nursing-images-2026.js) 的 pattern

**為何延後**：等醫檢師回報量變多時再針對性處理；目前單一回報不值得整批 audit。

### 3. 舊格式 PDF 無法 parse（少量殘留）

**症狀**：110 年第一次 PDF 部分使用「題號獨立行 + 選項無 A/B/C/D 標記」的舊格式，現有 column-aware parser 處理不了。

**已標 incomplete 的範例**：
- [questions-nursing.json](醫師知識王/backend/questions-nursing.json) `110030_0301_20`（CO2 血液運送題）
- [questions-tcm2.json](醫師知識王/backend/questions-tcm2.json) `1941`（舌診圖片題）

**未來處理方向**：
- 寫一個專門的舊格式 parser：題號 detection 改用 standalone digit + lookahead，選項用 position-based（Y-coordinate clusters）而非標記
- 或乾脆人工從 PDF 補這 2 題（規模太小，自動化不划算）

**為何延後**：規模 2 題，已 mark incomplete 從 practice/PvP 排除，UI 還能在 Browse 看到，影響可控。

---

## 修復歷程備忘（2026-04-15）

供未來 audit 時參考踩過的坑：

- **C6 回報的 `112100_1_63`** + 同類 cluster 共 19 題 → [scripts/fix-c6-batch-2026-04-15.js](醫師知識王/backend/scripts/fix-c6-batch-2026-04-15.js)
- **medlab/pt/vet** 26 題 → [scripts/fix-medlab-pt-vet-batch.js](醫師知識王/backend/scripts/fix-medlab-pt-vet-batch.js)
- **殘留 8 題（doctor2/ot/pharma1/doctor1）** → [scripts/fix-residual-batch-3.js](醫師知識王/backend/scripts/fix-residual-batch-3.js)

**parser 三個關鍵修正**（這些在新 parser 都要套）：

1. **單欄/雙欄偵測**：若任何 line 起點落在 x ∈ (200, 320)，視為單欄；否則 x=300 對切兩欄
2. **Span overlap dedupe**：mupdf 把單視覺行拆成多 span 時，相鄰 span 邊界會出現「下列列何者」這種重複字，用 longest suffix-prefix overlap 修
3. **頁面 furniture 過濾**：忽略含「座號 / 准考證 / 姓名 / 代號： / 頁次：」的 line，避免污染選項

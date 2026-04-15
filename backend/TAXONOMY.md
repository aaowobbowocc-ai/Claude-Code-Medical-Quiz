# 國考知識王 — 考試分類規範（Taxonomy）

> 這份文件是給 **Claude / 維護者** 看的正式分類規範。所有新增考試都必須依此填欄位。
> 目的：讓未來的開發者（包括 Claude 自己）不必每次重新解釋「高考三等 vs 司法三等 vs 律師一試」差在哪裡。

---

## 一、五大 Category（大類）

| `category` 值 | 中文 | 性質 | 包含考試 |
|---|---|---|---|
| `medical` | 醫事人員 | 專技執照、及格制 | 醫師、牙醫師、藥師、中醫師、獸醫師、護理師、營養師、物理治療師、職能治療師、醫事檢驗師 |
| `law-professional` | 法律專技 | 專技執照、及格制 | 律師（一試 / 二試）、（司法官 — 若歸屬此類） |
| `civil-service` | 公職任用 | 名額制（quota） | 高考三等、普考、初等考試、各類特考、司法特考 |
| `common-subjects` | 共同科目 | **不是獨立考試**，是跨 exam 共用的題庫 | 憲法、法學緒論、國文、英文等 shared banks |
| `independent` | 獨立非國考 | — | 駕照筆試、多益、全民英檢（**目前未實作**，保留槽位） |

**重要**：`common-subjects` 不對應任何 exam-config，它在 UI 中是 Stage-1 大卡之一，點進去直接顯示 shared banks 清單。

---

## 二、四個分類軸（exam-config 欄位）

每個 `backend/exam-configs/*.json` 都必須有以下四個欄位：

| 軸 | 欄位 | 值域 | 說明 |
|---|---|---|---|
| 大類 | `category` | `medical` / `law-professional` / `civil-service` / `independent` | 上表的五大類其一（`common-subjects` 不在 exam-config 出現） |
| 中類 | `subCategory` | 中文，例 `醫師`, `律師`, `高考三等`, `司法四等` | UI Stage-2 分組依據；同 subCategory 的 exam 會在 Stage-2 內歸成一組 |
| 等級 | `level` | `license` / `senior` / `junior` / `elementary` | `license` = 執照及格制；`senior` = 三等；`junior` = 四等／普考；`elementary` = 五等／初考 |
| 選拔 | `selectionType` | `license` / `quota` | `license` = 及格即給；`quota` = 前 N 名錄取 |

### subCategory 命名規則

- **同一專業的多階段考試共用同一 subCategory**：`doctor1` 與 `doctor2` 都是 `subCategory: "醫師"`；`dental1` + `dental2` → `牙醫師`；`pharma1` + `pharma2` → `藥師`；`tcm1` + `tcm2` → `中醫師`
- **公職類用「等級 + 類組」**：`高考三等-一般行政`, `普考-一般行政`, `初等-一般行政`
- **法律類用考試名稱**：`律師-一試`, `律師-二試`

---

## 三、Persona Tags（給 UX 用）

每個 exam 可宣告多個 persona，供首次進站的使用者引導推薦。白名單：

| Tag | 中文 | 對應 exam |
|---|---|---|
| `medical-student` | 醫學生 | doctor1, doctor2 |
| `dentistry-student` | 牙醫學生 | dental1, dental2 |
| `pharmacy-student` | 藥學生 | pharma1, pharma2 |
| `nursing-student` | 護理學生 | nursing |
| `tcm-student` | 中醫學生 | tcm1, tcm2 |
| `vet-student` | 獸醫學生 | vet |
| `nutrition-student` | 營養學生 | nutrition |
| `rehab-student` | 復健 / 治療學生 | pt, ot |
| `medlab-student` | 醫檢學生 | medlab |
| `law-student` | 法律系學生 | （未來：律師、司法特考） |
| `judicial-exam` | 司法考試考生 | （未來：司法特考、律師） |
| `civil-exam-prep` | 公職應屆考生 | （未來：高考、普考、初考） |
| `career-changer` | 轉職應考者 | 跨類；高普考、初考、共同科目 |
| `elementary-seeker` | 五等／初考應考者 | 初等考試 |

---

## 四、Shared Banks（共用題庫）宣告

每個 exam-config 可宣告 `sharedBanks`，server 會在該 exam 的 `/meta`、`/questions` 回應中自動把 shared bank 的題目併入。

```json
{
  "sharedBanks": ["common_constitution", "common_law_basics"],
  "sharedScope": "level_3_common"
}
```

**`sharedScope` 值域**：
- `level_3_common` — 只併入 `level: senior` 的共享題（高考三等、律師等）
- `level_4_common` — 只併入 `level: junior` 的共享題（普考、四等特考）
- `level_5_common` — 只併入 `level: elementary` 的共享題（初等考試）
- `none`（或省略） — 不併入任何共享題（醫事類預設）

### Bank 命名慣例

- bank id：`common_<subject>`（小寫底線），例 `common_constitution`, `common_law_basics`, `common_chinese`, `common_english`
- bank 檔案：`backend/shared-banks/<bankId>.json`
- 每個 bank 對應一個 `subject_tag`（白名單見 `shared-banks/schema.md`）

### 共同科目跨考試對照表（規劃中）

| Bank | 高考三等 | 普考 | 初考 | 律師一試 | 司法特考 |
|---|:---:|:---:|:---:|:---:|:---:|
| `common_constitution`（憲法） | ✓ | ✓ | ✓ | ✓ | ✓ |
| `common_law_basics`（法學緒論） | ✓ | ✓ | ✓ | — | ✓ |
| `common_chinese`（國文） | ✓ | ✓ | ✓ | — | ✓ |
| `common_english`（英文） | ✓ | ✓ | ✓ | — | — |

> **注意**：本表是規劃，實際宣告以各 exam-config 的 `sharedBanks` 為準。律師一試只考憲法、不考國文/英文/法緒。

---

## 五、命名慣例總結

| 物件 | 命名規則 | 範例 |
|---|---|---|
| exam-config id | 小寫-dash | `civil-senior-general`, `lawyer-1st`, `judicial-3rd` |
| shared bank id | `common_<subject>`（小寫底線） | `common_constitution` |
| shared bank 檔案 | `backend/shared-banks/<bankId>.json` | `backend/shared-banks/common_constitution.json` |
| subject_tag | 小寫底線英文（見 `schema.md`） | `constitution`, `civil_law`, `admin_law` |

---

## 六、現有 14 個醫事 exam 的填值（migrate-add-taxonomy.js 會自動寫入）

| examId | category | subCategory | level | selectionType | persona |
|---|---|---|---|---|---|
| `doctor1` | medical | 醫師 | license | license | medical-student |
| `doctor2` | medical | 醫師 | license | license | medical-student |
| `dental1` | medical | 牙醫師 | license | license | dentistry-student |
| `dental2` | medical | 牙醫師 | license | license | dentistry-student |
| `pharma1` | medical | 藥師 | license | license | pharmacy-student |
| `pharma2` | medical | 藥師 | license | license | pharmacy-student |
| `nursing` | medical | 護理師 | license | license | nursing-student |
| `nutrition` | medical | 營養師 | license | license | nutrition-student |
| `pt` | medical | 物理治療師 | license | license | rehab-student |
| `ot` | medical | 職能治療師 | license | license | rehab-student |
| `medlab` | medical | 醫事檢驗師 | license | license | medlab-student |
| `tcm1` | medical | 中醫師 | license | license | tcm-student |
| `tcm2` | medical | 中醫師 | license | license | tcm-student |
| `vet` | medical | 獸醫師 | license | license | vet-student |

**所有醫事 exam 都會：**
- `sharedBanks: []`
- `uxHints.defaultMode: "pure"`
- `uxHints.longText: false`

---

## 七、UX Hints

```json
{
  "uxHints": {
    "defaultMode": "pure" | "reservoir",
    "longText": true | false
  }
}
```

- `defaultMode` — 首次進該 exam 時，Practice/Browse 的預設純度模式
  - 醫事類 → `pure`（只練該考試自己的題）
  - 公職類 → `reservoir`（預設併入共享題庫，加強刷題量）
- `longText` — true 時：
  - PvP 對戰模式自動調高思考秒數
  - Practice/Browse 啟用「閱讀模式齒輪」外露於題目右上角（行高 / 字級 / 段距）
  - 題目敘述區塊套用 `max-height: 40vh; overflow-y: auto` + 收合/展開按鈕

---

## 八、選拔機制（selectionType）對 UI 的影響

| selectionType | 結算頁主視覺 | 排行榜顯示 |
|---|---|---|
| `license` | 大大的分數 + 「距離及格 X 分」 | 分數 + 排名 |
| `quota` | **PR 值（百分位）+ 排名** + 輔以分數 | **PR 值** + 排名 |

醫事類全部 `license`；公職類全部 `quota`；律師類全部 `license`（及格制）。

---

## 九、未來新增考試的 SOP

1. 在 `backend/exam-configs/` 建立 `<examId>.json`，必填欄位：
   - `id, name, short, icon`
   - `category, subCategory, level, selectionType`（依本文件填）
   - `persona`（陣列，至少一個）
   - `sharedBanks, sharedScope`（若該 exam 共考共同科目）
   - `uxHints.defaultMode, uxHints.longText`
   - `papers`（卷別清單）
   - `seo`（SEO meta）
2. 若該 exam 屬於 `civil-service` / `law-professional`：
   - 用 `node scripts/scrape-moex.js --shared-bank common_<subject> --level <senior|junior|elementary> --source-exam-name "..."` 爬共同科目進 shared bank
   - 用 `node scripts/scrape-moex.js --exam <examId>` 爬該 exam 自己的專業科目
3. 重啟 server，確認 `/exam-registry` 與 `/meta?exam=<examId>` 回應正確
4. 在 `frontend/src/config/examRegistry.js` 不必改動（自動從 `/exam-registry` 拉）
5. 全功能測試：Practice、Browse、MockExam、PvP、Boss、Leaderboard

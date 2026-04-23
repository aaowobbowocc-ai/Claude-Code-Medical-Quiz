# Shared Banks — subject_tag 白名單與正規化規則

> 這份文件**同時是規範與運行時白名單**。爬蟲 `scrape-moex.js --shared-bank` 啟動時會載入這份文件解析白名單區塊，所有 `--subject-tags` 必須落在白名單內否則拒跑。
>
> 修改本文件的「## Tag 白名單」章節時請保持機器可讀格式（每行一個 tag）。

---

## 為什麼需要這份文件

考選部 (MoEX) 的科目中文名稱會在不同年份／不同考試之間微調：

- 高考叫「憲法」
- 司法特考可能叫「憲法與法學緒論」
- 律師一試可能合併考為「憲法與行政法」

如果直接用中文 `subject` 做 join key，shared bank 的合併邏輯會被中文 alias 切碎。所以：

1. 每個共享題必須有 `subject_tags: string[]`（陣列）— 用英文 tag 而不是中文
2. 每個 tag 對應一份「允許的中文別名清單」（alias map）
3. 爬蟲在寫入 shared bank 時，根據抓到的中文 `subject_name` 反查 alias map 推出 tag
4. server.js 在合併 reservoir 時用 `subject_tags` 做 intersection 比對
5. 一題可同時擁有多個 tag（例：訴訟法合考時 `['civil_procedure', 'criminal_procedure']`）

---

## Tag 白名單

> 機器可讀區塊。新增 tag 時請維持 `- tag_name` 格式（爬蟲解析依此）。

### 法律共同科目

- constitution
- law_basics
- admin_law
- civil_law
- criminal_law
- civil_procedure
- criminal_procedure
- commercial_law
- administrative_procedure
- international_law
- intellectual_property
- law_knowledge_combined

### 一般共同科目

- chinese
- english
- current_affairs

### 公職專業科目（拓荒中，先列槽位）

- public_admin
- admin_studies
- public_finance
- statistics
- economics
- accounting
- politics
- sociology
- psychology

### 司法 / 律師專業科目

- jurisprudence
- legal_history
- evidence_law
- enforcement_law

---

## 中文別名對照（Alias Map）

爬蟲遇到中文 `subject_name` 時，依此表反查推出 `subject_tags`。比對方式為「子字串包含」（`subject_name.includes(alias)`），第一個命中就採用。一題可多 tag。

| Tag | 允許的中文別名（依此順序比對） |
|---|---|
| `constitution` | 憲法、中華民國憲法、憲法與增修條文 |
| `law_basics` | 法學緒論、法學知識、法學大意、法律常識 |
| `admin_law` | 行政法、行政法概要、行政程序法 |
| `civil_law` | 民法、民法概要、民法總則、民法債編、民法物權 |
| `criminal_law` | 刑法、刑法概要、刑法分則 |
| `civil_procedure` | 民事訴訟法、民訴 |
| `criminal_procedure` | 刑事訴訟法、刑訴 |
| `commercial_law` | 商事法、公司法、票據法、保險法 |
| `administrative_procedure` | 行政程序法、行政罰法、行政執行法 |
| `international_law` | 國際法、國際公法、國際私法 |
| `intellectual_property` | 智慧財產權、智財法、著作權法、專利法、商標法 |
| `chinese` | 國文、本國語文 |
| `english` | 英文、外國語文、英語 |
| `current_affairs` | 公民、公民與英文、時事 |
| `public_admin` | 行政學、公共行政 |
| `public_finance` | 財政學、公共財政 |
| `statistics` | 統計學、統計 |
| `economics` | 經濟學、總體經濟、個體經濟 |
| `accounting` | 會計學、會計 |
| `politics` | 政治學、政治 |
| `sociology` | 社會學 |
| `psychology` | 心理學 |
| `jurisprudence` | 法理學、法律倫理 |
| `legal_history` | 法制史、中國法制史 |
| `evidence_law` | 證據法 |
| `enforcement_law` | 強制執行法 |
| `law_knowledge_combined` | （不自動推斷，必須透過 `--subject-tags law_knowledge_combined` 顯式指定） |

> **`law_knowledge_combined` 使用時機**：高考三級 / 普考的「法學知識與英文（包括中華民國憲法、法學緒論、英文）」是一卷 50 題的合卷，憲法/法緒/英文題目混排、無子卷界線。若讓 alias map 自動推出 `[constitution, law_basics, english]` 會讓同一題被三個 bank 各自收一次、破壞 reservoir 題數統計。統一用 `law_knowledge_combined` 這個 umbrella tag 收進 `common_law_knowledge`，未來若要精細化再對每題人工分類。

### 合考處理規則

當中文 `subject_name` 同時包含多個 tag 的別名時，`subject_tags` 應同時包含這些 tag。範例：

| 中文 `subject` | 推出的 `subject_tags` |
|---|---|
| 「憲法」 | `["constitution"]` |
| 「憲法與法學緒論」 | `["constitution", "law_basics"]` |
| 「民法與民事訴訟法」 | `["civil_law", "civil_procedure"]` |
| 「刑法與刑事訴訟法」 | `["criminal_law", "criminal_procedure"]` |
| 「行政法（含行政程序法）」 | `["admin_law", "administrative_procedure"]` |

### 不在白名單怎麼辦

- 爬蟲遇到無法 match 任何 tag 的 `subject_name` 時：
  - `--shared-bank` 模式 → **拒跑**並印出 `unknown subject "<name>"; add to backend/shared-banks/schema.md or pass --subject-tags explicitly`
  - 一般 `--exam` 模式（醫事）→ 不影響，因為醫事題不用 tag

---

## bank ↔ tag 對應

每個 shared bank 宣告它要收集哪個 tag 的題目。現有 banks：

| Bank | 收集的 tags |
|---|---|
| `common_constitution` | `constitution` |
| `common_law_basics` | `law_basics` |
| `common_chinese` | `chinese` |
| `common_english` | `english` |
| `common_admin_law` | `admin_law` |
| `common_admin_law_junior` | `admin_law` |
| `common_admin_studies` | `admin_studies` |
| `common_admin_studies_junior` | `admin_studies` |
| `common_civil_law` | `civil_law` |
| `common_criminal_law` | `criminal_law` |
| `common_law_knowledge` | `law_knowledge_combined` |

合併邏輯：bank 收 tag X → 任何 `subject_tags` 含 X 的題都會進這個 bank。所以一題「憲法與法學緒論」會同時出現在 `common_constitution` 與 `common_law_basics` 兩個 bank 的 reservoir 結果中（若 exam 同時宣告兩個 bank）。

---

## 爬蟲使用範例

```bash
# 自動推斷 tag（從 subject_name match alias map）
node scripts/scrape-moex.js \
  --shared-bank common_constitution \
  --level senior \
  --source-exam-name "114 年高考三等一般行政" \
  --year 114 --paper 憲法

# 強制指定 tag（合考或別名表沒涵蓋時）
node scripts/scrape-moex.js \
  --shared-bank common_civil_law \
  --subject-tags civil_law,civil_procedure \
  --level senior \
  --source-exam-name "114 年律師一試" \
  --year 114 --paper "民法與民事訴訟法"
```

`--subject-tags` 為 comma-separated；爬蟲啟動時會逐個檢查是否落在白名單內，否則拒跑。

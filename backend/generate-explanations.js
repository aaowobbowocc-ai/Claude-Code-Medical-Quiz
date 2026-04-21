const Anthropic = require("@anthropic-ai/sdk");
const fs = require("fs");
const path = require("path");

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  console.error("Missing ANTHROPIC_API_KEY");
  process.exit(1);
}

const client = new Anthropic({ apiKey: API_KEY });
const DATA_PATH = path.join(__dirname, "questions.json");
const BATCH_SIZE = 1; // questions per API call (1 = most reliable parsing)
const CONCURRENCY = 5; // parallel API calls
const MODEL = "claude-haiku-4-5-20251001"; // cheap & fast

function loadData() {
  return JSON.parse(fs.readFileSync(DATA_PATH, "utf-8"));
}

function saveData(data) {
  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2), "utf-8");
}

function buildPrompt(questions) {
  const blocks = questions.map((q, i) => {
    const opts = Object.entries(q.options)
      .map(([k, v]) => `${k}. ${v}`)
      .join("\n");
    return `【題目 ${i + 1}】ID: ${q.id}
科目: ${q.subject_name || q.subject}
題目: ${q.question}
${opts}
正確答案: ${q.answer}`;
  });

  return `你是醫學國考的解題專家。請為以下每題寫參考解答。

格式要求（每題都要）：
**✅ 為什麼答案是 X**
（用 2-4 句話解釋正確答案為何正確）

**❌ 排除其他選項**
（每個錯誤選項各用 1 句話說明為何錯誤）

**🧠 記憶關鍵字**
（一句話幫助記憶的口訣或關鍵概念）

注意：
- 用繁體中文
- 內容要正確、專業
- 每題用 === 分隔
- 第一行寫 ID: xxx

${blocks.join("\n\n")}`;
}

function parseResponse(text, ids) {
  const result = {};

  // For single-question batches, just use the whole response
  if (ids.length === 1) {
    const cleaned = text.replace(/^.*ID:\s*\S+.*\n?/, "").trim();
    if (cleaned.length > 50) {
      result[ids[0]] = cleaned;
    }
    return result;
  }

  // For multi-question batches, split by === or by ID markers
  const sections = text.split(/={3,}|(?=ID:\s*\d+_\d+)/);
  for (const section of sections) {
    const trimmed = section.trim();
    if (!trimmed) continue;
    const idMatch = trimmed.match(/ID:\s*(\S+)/);
    if (idMatch && ids.includes(idMatch[1])) {
      const explanation = trimmed.replace(/^.*ID:\s*\S+.*\n?/, "").trim();
      result[idMatch[1]] = explanation;
    }
  }
  return result;
}

async function generateBatch(questions) {
  const ids = questions.map((q) => q.id);
  const prompt = buildPrompt(questions);

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await client.messages.create({
        model: MODEL,
        max_tokens: 4096,
        messages: [{ role: "user", content: prompt }],
      });

      const text = response.content[0].text;
      const parsed = parseResponse(text, ids);
      return parsed;
    } catch (err) {
      if (err.status === 429) {
        console.log("  Rate limited, waiting 30s...");
        await new Promise((r) => setTimeout(r, 30000));
      } else {
        console.error(`  Error: ${err.message}`);
        if (attempt === 2) return {};
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }
  return {};
}

async function main() {
  const data = loadData();
  const missing = data.questions.filter(
    (q) => !q.explanation || !q.explanation.trim()
  );
  console.log(`Total missing: ${missing.length}`);

  let generated = 0;
  let failed = 0;

  // Process in batches with concurrency
  for (let i = 0; i < missing.length; i += BATCH_SIZE * CONCURRENCY) {
    const batchGroup = [];
    for (let j = 0; j < CONCURRENCY; j++) {
      const start = i + j * BATCH_SIZE;
      const batch = missing.slice(start, start + BATCH_SIZE);
      if (batch.length > 0) batchGroup.push(batch);
    }

    const results = await Promise.all(batchGroup.map(generateBatch));

    // Apply results
    for (const parsed of results) {
      for (const [id, explanation] of Object.entries(parsed)) {
        const q = data.questions.find((x) => x.id === id);
        if (q && explanation.length > 50) {
          q.explanation = explanation;
          generated++;
        } else {
          failed++;
        }
      }
    }

    // Save periodically
    if (generated % 50 < BATCH_SIZE * CONCURRENCY || i + BATCH_SIZE * CONCURRENCY >= missing.length) {
      saveData(data);
    }

    const progress = Math.min(i + BATCH_SIZE * CONCURRENCY, missing.length);
    console.log(
      `Progress: ${progress}/${missing.length} | Generated: ${generated} | Failed: ${failed}`
    );
  }

  // Final save
  saveData(data);
  console.log(`\nDone! Generated: ${generated}, Failed: ${failed}`);

  // Check remaining
  const stillMissing = data.questions.filter(
    (q) => !q.explanation || !q.explanation.trim()
  ).length;
  console.log(`Still missing: ${stillMissing}`);
}

main().catch(console.error);

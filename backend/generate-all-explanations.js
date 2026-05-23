/**
 * generate-all-explanations.js
 * 為全部 5 個考試題庫生成參考解答（Vertex AI Gemini Flash via ADC）
 * 用法: node generate-all-explanations.js
 *
 * Migrated 2026-05-23 from generativelanguage.googleapis.com (paid Gemini API,
 * no credit coverage) to Vertex AI Gemini (billed under "Vertex API - Gemini
 * 2.x SKUs"). ADC auth — no API key needed; relies on the same GoogleAuth
 * setup as ai.js / pregen-explanations.js.
 */
require("dotenv").config();
const https = require("https");
const fs = require("fs");
const path = require("path");
const { GoogleAuth } = require("google-auth-library");

const VERTEX_PROJECT = process.env.VERTEX_PROJECT || "gen-lang-client-0502672630";
const VERTEX_REGION = process.env.VERTEX_REGION || "us-central1";
const VERTEX_MODEL = "gemini-2.0-flash";
const vertexAuth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
const CONCURRENCY = 1; // sequential to keep rate gentle
const SAVE_EVERY = 25;

const EXAM_FILES = [
  "questions-doctor2.json",
  "questions-dental1.json",
  "questions-dental2.json",
  "questions-pharma1.json",
  "questions-pharma2.json",
];

const EXAM_CONTEXT = {
  "questions-doctor2.json": "醫師國考第二階段（臨床醫學）",
  "questions-dental1.json": "牙醫師國考第一階段（基礎牙醫學）",
  "questions-dental2.json": "牙醫師國考第二階段（臨床牙醫學）",
  "questions-pharma1.json": "藥師國考第一階段（基礎藥學）",
  "questions-pharma2.json": "藥師國考第二階段（臨床藥學與法規）",
};

function loadData(filename) {
  const filepath = path.join(__dirname, filename);
  return JSON.parse(fs.readFileSync(filepath, "utf-8"));
}

function saveData(filename, data) {
  const filepath = path.join(__dirname, filename);
  fs.writeFileSync(filepath, JSON.stringify(data, null, 2), "utf-8");
}

function buildPrompt(question, examContext) {
  const opts = Object.entries(question.options)
    .map(([k, v]) => `${k}. ${v}`)
    .join("\n");

  return `你是${examContext}的解題專家。請為以下題目寫參考解答。

題目: ${question.question}
${opts}
正確答案: ${question.answer}
科目: ${question.subject_name || ""}

格式要求：
**✅ 為什麼答案是 ${question.answer}**
（用 2-4 句話解釋正確答案為何正確）

**❌ 排除其他選項**
（每個錯誤選項各用 1 句話說明為何錯誤）

**🧠 記憶關鍵字**
（一句話幫助記憶的口訣或關鍵概念）

注意：用繁體中文、內容要正確專業、直接開始寫不要重複題目`;
}

function vertexGenerate(prompt) {
  return new Promise(async (resolve, reject) => {
    let token;
    try { token = await vertexAuth.getAccessToken(); }
    catch (e) { return reject(Object.assign(new Error("auth: " + e.message), { status: 401 })); }
    const body = JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 600, temperature: 0.3 },
    });
    const req = https.request({
      hostname: `${VERTEX_REGION}-aiplatform.googleapis.com`,
      path: `/v1/projects/${VERTEX_PROJECT}/locations/${VERTEX_REGION}/publishers/google/models/${VERTEX_MODEL}:generateContent`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        Authorization: `Bearer ${token}`,
      },
    }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        if (res.statusCode !== 200) {
          return reject(Object.assign(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`), { status: res.statusCode }));
        }
        try {
          const parsed = JSON.parse(data);
          const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
          if (!text) return reject(new Error("empty response"));
          resolve(text);
        } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function generateOne(question, examContext) {
  const prompt = buildPrompt(question, examContext);

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const text = (await vertexGenerate(prompt)).trim();
      if (text.length > 50) return text;
      return null;
    } catch (err) {
      const status = err.status || err.httpStatusCode;
      if (status === 429) {
        const wait = Math.min(120, 20 * (attempt + 1));
        console.log(`\n    Rate limited, waiting ${wait}s...`);
        await new Promise((r) => setTimeout(r, wait * 1000));
      } else if (status === 503) {
        console.log("\n    API overloaded, waiting 60s...");
        await new Promise((r) => setTimeout(r, 60000));
      } else {
        console.error(`\n    Error: ${err.message}`);
        if (attempt === 2) return null;
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }
  return null;
}

async function processExam(filename) {
  const examContext = EXAM_CONTEXT[filename] || "國家考試";
  const data = loadData(filename);
  const questions = data.questions;
  const missing = questions.filter(
    (q) => !q.explanation || !q.explanation.trim()
  );

  console.log(`\n${"=".repeat(60)}`);
  console.log(`  ${filename} — ${examContext}`);
  console.log(`  Total: ${questions.length}, Missing: ${missing.length}`);
  console.log(`${"=".repeat(60)}`);

  if (missing.length === 0) {
    console.log("  All done!");
    return { generated: 0, failed: 0 };
  }

  let generated = 0;
  let failed = 0;

  for (let i = 0; i < missing.length; i += CONCURRENCY) {
    const batch = missing.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map((q) => generateOne(q, examContext))
    );

    for (let j = 0; j < batch.length; j++) {
      if (results[j]) {
        batch[j].explanation = results[j];
        generated++;
      } else {
        failed++;
      }
    }

    // Save periodically
    if (generated % SAVE_EVERY < CONCURRENCY || i + CONCURRENCY >= missing.length) {
      saveData(filename, data);
    }

    const progress = Math.min(i + CONCURRENCY, missing.length);
    const pct = ((progress / missing.length) * 100).toFixed(1);
    process.stdout.write(
      `\r  Progress: ${progress}/${missing.length} (${pct}%) | OK: ${generated} | Fail: ${failed}`
    );

    // Pace requests to stay under free tier RPM limit (15 RPM = 4s/req)
    await new Promise((r) => setTimeout(r, 5000));
  }

  // Final save
  saveData(filename, data);
  console.log(
    `\n  ✓ Done: ${generated} generated, ${failed} failed`
  );

  return { generated, failed };
}

async function main() {
  console.log(`Starting at ${new Date().toLocaleString("zh-TW")}`);
  console.log(`Model: Vertex ${VERTEX_MODEL} (ADC), Concurrency: ${CONCURRENCY}`);
  console.log(`Files: ${EXAM_FILES.length} exams`);

  const totals = { generated: 0, failed: 0 };

  for (const file of EXAM_FILES) {
    const result = await processExam(file);
    totals.generated += result.generated;
    totals.failed += result.failed;
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`  ALL DONE`);
  console.log(`  Generated: ${totals.generated}, Failed: ${totals.failed}`);
  console.log(`  Finished at ${new Date().toLocaleString("zh-TW")}`);
  console.log(`${"=".repeat(60)}`);
}

main().catch(console.error);

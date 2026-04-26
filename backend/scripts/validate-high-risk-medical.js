#!/usr/bin/env node
/**
 * 驗證高風險醫學題目
 * 重點：內分泌、解剖、神經系統、病理生理
 */

const fs = require("fs");
const path = require("path");
const Anthropic = require("@anthropic-ai/sdk");

const client = new Anthropic.Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const ROOT = path.join(__dirname, "..");

// 高風險科目標籤
const HIGH_RISK_TAGS = [
  "endocrinology",
  "anatomy",
  "neurology",
  "pathophysiology",
  "neuro_anatomy",
  "internal_medicine",
  "clinical_physiology",
];

/**
 * 識別需要驗證的題目
 */
function identifyHighRiskQuestions(questions) {
  return questions
    .filter(
      (q) =>
        HIGH_RISK_TAGS.some((tag) =>
          q.subject_tag?.includes(tag)
        ) ||
        // 關鍵詞檢測
        /(激素|hormone|PVN|下視丘|分泌|神經|nerve|解剖|anatomy|腺體)/.test(
          q.question
        )
    )
    .slice(0, 20); // 樣本限制
}

/**
 * 驗證單題
 */
async function validateQuestion(question) {
  const correctOption = question.options[question.answer];

  const prompt = `醫學題目驗證。評估此題的答案醫學正確性。

【題目】
${question.question.substring(0, 300)}

【選項】
A) ${question.options.A?.substring(0, 80)}
B) ${question.options.B?.substring(0, 80)}
C) ${question.options.C?.substring(0, 80)}
D) ${question.options.D?.substring(0, 80)}

【標示正答】
答案：${question.answer} (${correctOption?.substring(0, 80)})

【驗證任務】
1. 答案在醫學上是否正確？(correct/incorrect/unclear)
2. 信心度 (high/medium/low)
3. 如有誤，提供正確信息來源（教科書/指南名稱）
4. 需要人工審查嗎？(true/false)

回傳 JSON：
{
  "verdict": "correct",
  "confidence": "high",
  "rationale": "簡述為何此答案正確",
  "source": "參考來源（如：Guyton & Hall, PubMed ID: xxxx）",
  "needsReview": false,
  "notes": "任何其他觀察"
}`;

  try {
    const message = await client.messages.create({
      model: "claude-opus-4-7",
      max_tokens: 400,
      messages: [{ role: "user", content: prompt }],
    });

    const text =
      message.content[0].type === "text" ? message.content[0].text : "";
    const match = text.match(/\{[\s\S]*?\}/);
    const result = match ? JSON.parse(match[0]) : null;

    return {
      questionId: question.id,
      number: question.number,
      year: question.roc_year,
      subject: question.subject_tag,
      verification: result,
      timestamp: new Date().toISOString(),
    };
  } catch (err) {
    console.error(`Error validating Q${question.number}:`, err.message);
    return null;
  }
}

/**
 * 主程序
 */
async function main() {
  console.log("=== 醫學題目驗證系統 ===\n");

  // 讀取醫師題庫
  const doctor1Path = path.join(ROOT, "questions.json");
  const doctor1Data = JSON.parse(fs.readFileSync(doctor1Path, "utf-8"));
  const doctor1Questions = doctor1Data.questions || doctor1Data;

  console.log(`doctor1 總題數：${doctor1Questions.length}`);

  // 識別高風險題目
  const highRisk = identifyHighRiskQuestions(doctor1Questions);
  console.log(`高風險題目：${highRisk.length} 題\n`);

  // 驗證樣本
  const results = [];
  console.log("開始驗證高風險題目...\n");

  for (let i = 0; i < highRisk.length; i++) {
    const q = highRisk[i];
    console.log(`[${i + 1}/${highRisk.length}] Q${q.number} (${q.roc_year}): `, {
      end: "",
    });

    const result = await validateQuestion(q);
    if (result) {
      results.push(result);
      const status = result.verification?.needsReview ? "⚠️ 需審查" : "✓";
      console.log(
        `${status} ${result.verification?.verdict || "unknown"} (${result.verification?.confidence || "?"})`
      );
    } else {
      console.log("ERROR");
    }

    // 速率限制
    if ((i + 1) % 3 === 0) {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  // 統計報告
  const needsReview = results.filter((r) => r.verification?.needsReview);
  const incorrect = results.filter((r) => r.verification?.verdict === "incorrect");

  console.log("\n=== 驗證報告 ===");
  console.log(`總驗證：${results.length} 題`);
  console.log(`需要審查：${needsReview.length} 題`);
  console.log(`可能有誤：${incorrect.length} 題`);

  if (incorrect.length > 0) {
    console.log("\n⚠️ 可能有誤的題目：");
    incorrect.forEach((r) => {
      console.log(
        `  Q${r.number} (${r.year}): ${r.verification?.rationale || "待審查"}`
      );
      if (r.verification?.source) {
        console.log(`    來源：${r.verification.source}`);
      }
    });
  }

  // 保存結果
  const reportPath = path.join(ROOT, "_tmp", "medical-validation-report.json");
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(results, null, 2), "utf-8");
  console.log(`\n報告已保存：${reportPath}`);
}

main().catch(console.error);

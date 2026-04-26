#!/usr/bin/env node
/**
 * 醫學解說增強系統
 * 為空的 explanation 欄位生成臨床級別的解說
 * - 提取題目核心概念
 * - 用醫學知識生成解釋
 * - 標記參考來源
 */

const fs = require("fs");
const path = require("path");
const Anthropic = require("@anthropic-ai/sdk");

const client = new Anthropic.Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const ROOT = path.join(__dirname, "..");

/**
 * 生成臨床級別的解說
 * @param {object} question 題目對象
 * @returns {Promise<string>} 解說文本
 */
async function generateExplanation(question) {
  const correctOption = question.options[question.answer];
  const wrongOptions = Object.entries(question.options)
    .filter(([key]) => key !== question.answer)
    .map(([key, val]) => `${key}) ${val}`)
    .join("\n  ");

  const prompt = `為醫學考試題目生成臨床解說。

【題目】
${question.question}

【正確答案】
${question.answer}) ${correctOption}

【其他選項】
  ${wrongOptions}

【解說需求】
1. 簡述為何答案正確（2-3 句）
2. 解釋其他選項為何錯誤（1-2 句）
3. 提及相關臨床意義或應用
4. 難度較高的題目加入病理生理機制

格式：
- 簡潔、臨床導向、适合住院医师
- 如涉及激素/解剖，提及解剖位置或生理機制
- 用中文，避免過度縮寫

生成解說（不含「解說：」前綴）：`;

  try {
    const message = await client.messages.create({
      model: "claude-opus-4-7",
      max_tokens: 350,
      messages: [{ role: "user", content: prompt }],
    });

    return message.content[0].type === "text"
      ? message.content[0].text.trim()
      : "";
  } catch (err) {
    console.error(`Error generating explanation for Q${question.number}:`, err.message);
    return "";
  }
}

/**
 * 批量生成解說
 */
async function enhanceBatch(questionsFile, examName, options = {}) {
  const { sampleSize = 30, targetSubjects = [] } = options;

  console.log(`\n=== ${examName} 解說生成 ===`);

  // 讀取題庫
  const filePath = path.join(ROOT, questionsFile);
  const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  const questions = data.questions || data;

  // 篩選目標（無解說 + 可選特定科目）
  let targets = questions.filter(
    (q) => !q.explanation || q.explanation.trim() === ""
  );

  if (targetSubjects.length > 0) {
    targets = targets.filter((q) =>
      targetSubjects.some((subj) => q.subject_tag?.includes(subj))
    );
  }

  // 樣本限制
  targets = targets.slice(0, sampleSize);
  console.log(`待生成：${targets.length} 題（無解說題目）`);

  const updated = [];
  for (let i = 0; i < targets.length; i++) {
    const q = targets[i];
    console.log(
      `[${i + 1}/${targets.length}] Q${q.number} (${q.roc_year}/${q.subject_tag}): `,
      { end: "" }
    );

    const explanation = await generateExplanation(q);
    if (explanation) {
      q.explanation = explanation;
      updated.push(q.id);
      console.log("✓");
    } else {
      console.log("FAIL");
    }

    // 速率限制
    if ((i + 1) % 5 === 0) {
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  // 保存
  if (updated.length > 0) {
    if (data.questions) {
      data.questions = questions;
    }
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
    console.log(`\n✓ 已更新 ${updated.length} 個解說`);
  }

  return updated.length;
}

/**
 * 主程序
 */
async function main() {
  console.log("=== 醫學解說增強系統 ===");

  // 優先順序：內分泌/解剖 > 其他
  const doctor1Updated = await enhanceBatch(
    "questions.json",
    "doctor1",
    {
      sampleSize: 20,
      targetSubjects: ["endocrinology", "anatomy", "neuro"],
    }
  );

  const doctor2Updated = await enhanceBatch(
    "questions-doctor2.json",
    "doctor2",
    {
      sampleSize: 20,
      targetSubjects: ["internal_medicine", "clinical_physiology"],
    }
  );

  console.log("\n=== 完成 ===");
  console.log(`doctor1: +${doctor1Updated} 解說`);
  console.log(`doctor2: +${doctor2Updated} 解說`);
}

main().catch(console.error);

/**
 * Medical Answer Validator
 * 驗證醫學題目答案的正確性
 * - 從題目和答案提取關鍵概念
 * - 用 Gemini 查詢醫學知識
 * - 標記需要人工審查的題目
 */

const Anthropic = require("@anthropic-ai/sdk");

const client = new Anthropic.Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

/**
 * 從題目提取驗證關鍵詞
 * @param {string} question 題目文本
 * @param {string} answer 正確答案字母(A/B/C/D)
 * @param {object} options 選項對象 {A, B, C, D}
 * @returns {Promise<object>} {keywords, context, correctOption}
 */
async function extractValidationKeywords(question, answer, options) {
  const prompt = `醫學題目分析。提取驗證此題所需的關鍵概念。

題目：${question.substring(0, 200)}
正答：${answer} (${options[answer]})

任務：
1. 列出 3-5 個醫學關鍵詞/概念（如：PVN、CRH、內分泌、下視丘）
2. 識別題目的臨床背景（如：內分泌系統、神經解剖、病理生理）
3. 簡述為什麼該答案是正確的（1-2 句）

回傳 JSON：
{
  "keywords": ["詞1", "詞2"],
  "background": "臨床背景說明",
  "rationale": "答案正確的原因"
}`;

  const message = await client.messages.create({
    model: "claude-opus-4-7",
    max_tokens: 300,
    messages: [{ role: "user", content: prompt }],
  });

  const text = message.content[0].type === "text" ? message.content[0].text : "";
  try {
    const match = text.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : null;
  } catch {
    return null;
  }
}

/**
 * 用 Gemini 驗證醫學概念
 * @param {object} extractedInfo 從題目提取的信息
 * @param {string} correctAnswer 正確答案文本
 * @returns {Promise<object>} {verified, confidence, notes}
 */
async function verifyMedicalConcept(extractedInfo, correctAnswer) {
  if (!extractedInfo) return null;

  const prompt = `驗證醫學知識正確性。

關鍵詞：${(extractedInfo.keywords || []).join(", ")}
背景：${extractedInfo.background || ""}
聲稱：${extractedInfo.rationale || ""}
正確答案內容：${correctAnswer}

根據標準醫學教科書和臨床指南，評估：
1. 陳述是否醫學上正確？(true/false)
2. 信心度 (high/medium/low)
3. 如有誤，指出正確概念

回傳 JSON：
{
  "verified": true,
  "confidence": "high",
  "notes": "醫學正確性評估"
}`;

  // 使用 Gemini（免費層）進行醫學驗證
  try {
    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          safetySettings: [
            { category: "HARM_CATEGORY_UNSPECIFIED", threshold: "BLOCK_NONE" },
          ],
        }),
      }
    );

    const data = await response.json();
    if (!data.candidates?.[0]?.content?.parts?.[0]?.text) return null;

    const text = data.candidates[0].content.parts[0].text;
    const match = text.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : null;
  } catch (e) {
    console.error("Gemini verification error:", e.message);
    return null;
  }
}

/**
 * 完整驗證流程
 * @param {object} question 題目對象
 * @param {string} geminiKey Gemini API key
 * @returns {Promise<object>} 驗證結果
 */
async function validateQuestion(question, geminiKey) {
  try {
    // 1. 提取驗證關鍵詞
    const keywords = await extractValidationKeywords(
      question.question,
      question.answer,
      question.options
    );

    // 2. 用 Gemini 驗證
    const verification = await verifyMedicalConcept(
      keywords,
      question.options[question.answer]
    );

    return {
      questionId: question.id,
      questionNumber: question.number,
      examYear: question.roc_year,
      extracted: keywords,
      verification: verification,
      needsReview: verification && verification.confidence === "low",
      timestamp: new Date().toISOString(),
    };
  } catch (e) {
    console.error(`Error validating Q${question.number}:`, e.message);
    return null;
  }
}

/**
 * 批量驗證多個題目
 * @param {array} questions 題目陣列
 * @param {object} options {batchSize, delayMs, geminiKey}
 * @returns {Promise<array>} 驗證結果陣列
 */
async function validateBatch(questions, options = {}) {
  const { batchSize = 5, delayMs = 2000, sampleOnly = 20 } = options;

  // 只驗證樣本（減少成本）
  const sample = questions.slice(0, sampleOnly);
  const results = [];

  for (let i = 0; i < sample.length; i++) {
    const result = await validateQuestion(sample[i]);
    if (result) results.push(result);

    // 進度報告
    if ((i + 1) % batchSize === 0) {
      console.log(`[${i + 1}/${sample.length}] validated, ${result?.needsReview ? "⚠️ needs review" : "✓"}`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  return results;
}

module.exports = {
  extractValidationKeywords,
  verifyMedicalConcept,
  validateQuestion,
  validateBatch,
};

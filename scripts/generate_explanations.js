#!/usr/bin/env node
/**
 * 用 Groq (llama-3.1-8b-instant) 為每題生成參考解答
 * 結果存入 backend/questions.json 的 explanation 欄位
 * 限速：每分鐘最多 30 題（Groq 免費 30 RPM）
 */

const fs = require('fs');
const https = require('https');
const path = require('path');

const GROQ_API_KEY = process.env.GROQ_API_KEY || ''; // 設定環境變數 GROQ_API_KEY
const QUESTIONS_PATH = path.join(__dirname, '../backend/questions.json');
const DELAY_MS = 6000;   // ~10 RPM，避免 TPM 限速

function groq(question, options, answer, subject_name) {
  const optionText = Object.entries(options).map(([k, v]) => `${k}. ${v}`).join('\n');
  const prompt = `你是臺灣醫師國考（一階）解題老師，用繁體中文回答。

科目：${subject_name}
題目：${question}
選項：
${optionText}
正確答案：${answer}

請用以下格式回答（簡潔扼要）：

**✅ 為什麼答案是 ${answer}**
（核心機制，2-3句）

**❌ 排除其他選項**
（每個錯誤選項一句）

**🧠 記憶關鍵字**
（一個口訣或記憶技巧）

**🏥 臨床應用**
（一句話說明臨床意義）`;

  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 500,
      temperature: 0.3,
    });

    const req = https.request({
      hostname: 'api.groq.com',
      path: '/openai/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Length': Buffer.byteLength(data),
      },
    }, r => {
      let body = '';
      r.on('data', c => body += c);
      r.on('end', () => {
        try {
          const j = JSON.parse(body);
          if (j.error) return reject(new Error(j.error.message));
          resolve(j.choices?.[0]?.message?.content || '');
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  const data = JSON.parse(fs.readFileSync(QUESTIONS_PATH, 'utf-8'));
  const questions = data.questions;

  const todo = questions.filter(q => !q.explanation && q.answer);
  console.log(`待生成：${todo.length} 題（已有：${questions.length - todo.length} 題）`);

  let done = 0;
  let errors = 0;

  for (const q of todo) {
    let attempts = 0;
    let success = false;

    while (attempts < 3 && !success) {
      try {
        const explanation = await groq(q.question, q.options, q.answer, q.subject_name);
        q.explanation = explanation;
        success = true;
        done++;
      } catch (e) {
        attempts++;
        if (e.message.includes('rate') || e.message.includes('429')) {
          console.log(`  限速，等待 60 秒...`);
          await sleep(60000);
        } else {
          console.error(`  Q${q.number} 錯誤: ${e.message}`);
          await sleep(3000);
        }
      }
    }

    if (!success) {
      errors++;
      console.error(`  Q${q.number} 跳過（${q.roc_year} ${q.session}）`);
    }

    // 每 50 題存一次
    if (done % 50 === 0) {
      fs.writeFileSync(QUESTIONS_PATH, JSON.stringify(data, null, 2), 'utf-8');
      console.log(`[${done}/${todo.length}] 已儲存`);
    }

    await sleep(DELAY_MS);
  }

  // 最終儲存
  fs.writeFileSync(QUESTIONS_PATH, JSON.stringify(data, null, 2), 'utf-8');
  console.log(`\n=== 完成 ===`);
  console.log(`成功：${done} 題，失敗：${errors} 題`);
}

main().catch(console.error);

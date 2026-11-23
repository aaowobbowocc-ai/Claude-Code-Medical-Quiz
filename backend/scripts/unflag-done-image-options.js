#!/usr/bin/env node
/**
 * 選項圖已經切好了，卻還標著 incomplete='image_options' —— 前端會把這種題
 * 隱藏起來，等於白白藏了可以作答的題。
 *
 * 這個不一致是切圖流程留下的：crop-option-images-geometric.js 成功時會
 * `delete q.incomplete`，但早期用別支工具（或人工）補上 option_images 的
 * 那幾題沒有一起清旗標。
 *
 * 清旗標的條件全部要成立，少一個都不清：
 *   1. 四個選項都只是「(圖)」這種佔位字（＝本來就沒有文字選項可看）
 *   2. option_images 每一個選項鍵都有
 *   3. 每一張圖的檔案真的在 frontend/public/question-images 底下、而且不是空檔
 *
 * 第 3 條是必要的：檔名沒帶科目的舊圖會互相撞掉
 * （見 reference_figure_extractors），指到不存在的檔會變成前端破圖。
 *
 *   node scripts/unflag-done-image-options.js [--apply]
 */
const fs = require('fs');
const path = require('path');

const APPLY = process.argv.includes('--apply');
const BK = path.join(__dirname, '..');
const IMG = path.join(BK, '..', 'frontend', 'public', 'question-images');
const KEYS = ['A', 'B', 'C', 'D', 'E'];
const PLACEHOLDER = /^[（([【]?\s*(圖|如圖|見圖|圖片|圖形|image)\s*[）)\]】]?$/i;
const MIN_BYTES = 200;

let cleared = 0;
const kept = [];

for (const f of fs.readdirSync(BK).filter(x => /^questions(-[a-z0-9-]*)?\.json$/.test(x))) {
  const exam = f.replace('questions-', '').replace('questions.json', 'doctor1').replace('.json', '');
  const fp = path.join(BK, f);
  const j = JSON.parse(fs.readFileSync(fp, 'utf8'));
  const arr = Array.isArray(j) ? j : j.questions;
  if (!arr) continue;
  let touched = false;

  for (const q of arr) {
    if (q.incomplete !== 'image_options') continue;
    const keys = KEYS.filter(k => String((q.options || {})[k] || '').trim());
    const imgs = q.option_images || {};
    const why = [];
    if (keys.length < 3) why.push('選項不足 3 個');
    else if (!keys.every(k => PLACEHOLDER.test(String(q.options[k]).trim()))) why.push('還有文字選項');
    if (!keys.every(k => imgs[k])) why.push('選項圖沒補齊');
    else {
      for (const k of keys) {
        const p = path.join(IMG, String(imgs[k]).replace(/^.*\//, ''));
        if (!fs.existsSync(p)) why.push(`${k} 的圖檔不存在`);
        else if (fs.statSync(p).size < MIN_BYTES) why.push(`${k} 的圖檔是空的`);
      }
    }
    const tag = `${exam} ${q.exam_code} ${q.subject} #${q.number}`;
    if (why.length) { kept.push(`  · ${tag} —— ${why.join('、')}`); continue; }
    console.log(`${APPLY ? '✓' : '·'} 清旗標 ${tag} ans=${q.answer}`);
    if (APPLY) { delete q.incomplete; touched = true; }
    cleared++;
  }
  if (APPLY && touched) fs.writeFileSync(fp, JSON.stringify(j, null, 2) + '\n');
}

console.log(`\n${APPLY ? '已清' : '可清'} ${cleared} 題`);
if (kept.length) console.log(`仍標著待辦 ${kept.length} 題：\n${kept.join('\n')}`);
if (!APPLY) console.log('(試跑；加 --apply 才寫入)');

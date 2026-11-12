#!/usr/bin/env node
/**
 * 郵局卷的「頁眉擠位」與「超長答案標記」兩個 parser 漏洞修完後，重解整卷補救。
 *
 * ── 漏洞一：試卷頁眉被當成選項 ────────────────────────────────
 * 「【請接續背面】」「第二部分：第41-60 題（每題2 分）」這種行夾在題與題之間，
 * collectOptions() 把它當成一段，於是整題往上位移一格：
 *     題幹 ← 題幹＋選項A      A ← B      B ← C      C ← D      D ← 頁眉
 * **答案字母來自 PDF 的【X】標記，指的是官方的選項順序**，所以位移一格的題
 * 答案全是錯的（post-outdoor 114 #25 原本 A 寫「次日起算六個月」，正解其實是
 * 「之日起算六個月」那個選項）。這不是難看，是答錯。
 *
 * ── 漏洞二：超長的爭議題標記認不出來 ──────────────────────────
 * ANCHOR_RE 原本限【】內 16 字，但官方卷有
 *     【答2 或3 皆給分，未作答者不予計分】34.……
 * 這種寫法。認不出題錨 → 整題沒被切出來，被前一題吞掉或直接消失。
 *
 * 兩個漏洞都已修在 lib/post-parser.js。這支用修好的 parser 重解每一卷，
 * 然後分兩種動作：
 *
 *   修（位移）：安全閥是「拿掉頁眉之後，題幹＋四選項串起來要一字不差」。
 *               一樣 → 只是切點不同，沒有內容錯置；不一樣 → 不動，印出來人工看。
 *   補（漏題）：安全閥是「題庫裡該卷沒有這個題號，而且全卷沒有相同題幹的題」。
 *
 * PDF 一律走 pdf-fetcher 既有快取，不連外網。
 *
 *   node scripts/repair-post-furniture-shift.js
 *   node scripts/repair-post-furniture-shift.js --apply
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { parsePostPdf } = require('./lib/post-parser')
const { atomicWriteJson, withLock } = require('./lib/atomic-write')

const ROOT = path.join(__dirname, '..')
const TMP = path.join(ROOT, '_tmp')
const APPLY = process.argv.includes('--apply')
const md5 = u => crypto.createHash('md5').update(u).digest('hex')

// 題庫早已做過 NFC 正規化與 PUA/控制字元清理，parser 的輸出沒有 —— 比對前兩邊都洗過
const norm = s => String(s == null ? '' : s).normalize('NFC')
  .replace(/[\u0080-\u009f­​-‏‪-‮⁠﻿-�]/g, '')
  .replace(/[\s　]+/g, '')
const seq = q => norm(q.question) + ['A', 'B', 'C', 'D'].map(k => norm((q.options || {})[k])).join('')

// 跟 lib/post-parser.js 的 FURNITURE_RE 同一組判準（這裡只用來「解釋舊值」）
const FURNITURE = /請接續背面|入場通知書|答案卡|答案卷|監試人員|不倒扣|與答案無關之任何文字|^第[一二三四五六七八九十]+部分[：:]|^注意[：:]|^本試卷[一為]/

// ── 把每一卷 PDF 對回 (exam, year, tag) ──
function jobs() {
  const out = []
  const off = JSON.parse(fs.readFileSync(path.join(TMP, '_post-official-index.json'), 'utf8'))
  for (const p of off.papers || []) {
    if (!p.isMcqPaper) continue
    const s = p.subject || '', c = p.category || ''
    if (p.rank === '專業職二內勤' && /櫃台業務/.test(c)) {
      if (/企業管理/.test(s)) out.push({ exam: 'post-indoor', tag: 'post_mgmt', year: p.year, url: p.url, cache: 'post-official-cache' })
      if (/郵政三法/.test(s)) out.push({ exam: 'post-indoor', tag: 'post_law', year: p.year, url: p.url, cache: 'post-official-cache' })
    }
    if (p.rank === '專業職二外勤' && /郵遞業務/.test(c)) {
      if (/郵政法規/.test(s)) out.push({ exam: 'post-outdoor', tag: 'post_law', year: p.year, url: p.url, cache: 'post-official-cache' })
      if (/臺灣自然/.test(s)) out.push({ exam: 'post-outdoor', tag: 'post_geo', year: p.year, url: p.url, cache: 'post-official-cache' })
    }
  }
  const sm = JSON.parse(fs.readFileSync(path.join(TMP, '_post-index.json'), 'utf8'))
  const urls = new Set()
  for (const v of Object.values(sm.entryPdfs || {})) for (const u of v) urls.add(u)
  for (const u of urls) {
    const d = decodeURIComponent(u)
    const m = d.match(/郵局\/(\d{3})\//)
    if (!m || !d.includes('專業職(二)')) continue
    const year = m[1]
    const push = (exam, tag) => out.push({ exam, tag, year, url: u, cache: 'post-cache' })
    if (/企業管理大意/.test(d)) {
      if (/內勤/.test(d)) push('post-indoor', 'post_mgmt')
      else if (/外勤/.test(d)) push('post-outdoor', 'post_mgmt')
      else { push('post-indoor', 'post_mgmt'); push('post-outdoor', 'post_mgmt') }
    } else if (/郵政三法/.test(d) || (/郵政法規大意/.test(d) && /櫃台|郵務處理/.test(d))) push('post-indoor', 'post_law')
    else if (/郵政法大意及交通安全/.test(d) || (/郵政法規大意/.test(d) && /郵遞|運輸/.test(d))) push('post-outdoor', 'post_law')
  }
  return out
}

const SHORT = { post_law: 'law', post_mgmt: 'mgmt', post_geo: 'geo' }

async function main() {
  const banks = {}
  for (const e of ['post-indoor', 'post-outdoor'])
    banks[e] = JSON.parse(fs.readFileSync(path.join(ROOT, `questions-${e}.json`), 'utf8'))

  let fixed = 0, added = 0, refused = 0, missPdf = 0
  const touched = new Set()

  for (const j of jobs()) {
    const fp = path.join(TMP, j.cache, md5(j.url) + '.pdf')
    if (!fs.existsSync(fp)) { missPdf++; continue }
    let parsed
    try { parsed = await parsePostPdf(fs.readFileSync(fp)) }
    catch (e) { console.log(`✗ ${j.exam} ${j.year} ${j.tag}：${e.message}`); continue }
    const good = parsed.filter(q => !q.incomplete)
    const arr = banks[j.exam].questions
    const bq = arr.filter(q => q.roc_year === j.year && q.subject_tag === j.tag)
    if (!bq.length) continue                       // 這卷題庫本來就沒有（例如還沒接線的科目）
    const label = `${j.exam} ${j.year} ${j.tag}`
    const bmap = new Map(bq.map(q => [q.number, q]))

    for (const q of good) {
      const b = bmap.get(q.number)

      // ── 補：題庫沒有這個題號 ──
      if (!b) {
        const dup = arr.find(x => norm(x.question) === norm(q.question) && norm(q.question).length >= 10)
        if (dup) { refused++; console.log(`✗ ${label} #${q.number} 補不得：題幹跟 ${dup.id} 一樣`); continue }
        const sample = bq[0]
        const id = `${j.exam}-${j.year}-${SHORT[j.tag]}-${q.number}`
        if (arr.some(x => String(x.id) === id)) { refused++; console.log(`✗ ${label} #${q.number} 補不得：id ${id} 已存在`); continue }
        console.log(`+ ${label} #${q.number} 補回（答 ${q.answer}${q.disputed ? '，爭議題' : ''}）`)
        console.log(`    ${String(q.question).replace(/\s+/g, ' ').slice(0, 80)}`)
        added++; touched.add(j.exam)
        if (APPLY) arr.push({
          id, roc_year: j.year, session: sample.session, exam_code: sample.exam_code,
          subject: sample.subject, subject_tag: j.tag, subject_name: sample.subject_name,
          stage_id: 0, number: q.number, question: q.question, options: q.options,
          answer: q.answer, explanation: '', source: sample.source,
          ...(q.disputed ? { disputed: true } : {}),
        })
        continue
      }

      // ── 修：舊版把下一題整題吞進去（漏洞二的另一半）──
      // 題錨認不出來時，下一題的標記行＋題幹＋選項全部變成本題的內容，
      // 本題的四個選項於是被下一題的四個選項取代 —— 答案字母照樣指著錯的文字。
      // 安全閥：舊串接必須 = 新本題 ＋「【…】<下一題號>.」＋ 新下一題，一字不差。
      if (!['A', 'B', 'C', 'D'].some(k => FURNITURE.test(String((b.options || {})[k] || '')))) {
        const mine = seq(q), old = seq(b)
        if (old === mine) continue
        if (!old.startsWith(mine)) continue
        const nxt = good.find(x => x.number === q.number + 1)
        const rest = old.slice(mine.length)
        const mk = nxt && rest.match(/^【[^】]{1,40}】\s*(\d{1,3})\s*[.．、]?/)
        if (!mk || +mk[1] !== nxt.number || rest.slice(mk[0].length) !== seq(nxt)) continue
        if (q.answer !== b.answer) {
          refused++
          console.log(`✗ ${label} #${q.number} 不修：答案字母不同（${b.answer} vs ${q.answer}）`)
          continue
        }
        console.log(`~ ${label} #${q.number} 修「吞掉下一題」（答 ${b.answer}；原選項其實是 #${nxt.number} 的）`)
        console.log(`    A 舊 ${String((b.options || {}).A).slice(0, 56)}`)
        console.log(`    A 新 ${String(q.options.A).slice(0, 56)}`)
        fixed++; touched.add(j.exam)
        if (APPLY) { b.question = q.question; b.options = { ...q.options } }
        continue
      }

      // ── 修：舊版某個選項是頁眉 ──
      const dirty = ['A', 'B', 'C', 'D'].filter(k => FURNITURE.test(String((b.options || {})[k] || '')))
      if (!dirty.length) continue
      // 安全閥：舊值拿掉頁眉那格之後，串接要與新版一字不差
      const oldSeq = norm(b.question) + ['A', 'B', 'C', 'D']
        .map(k => dirty.includes(k) ? '' : norm((b.options || {})[k])).join('')
      if (oldSeq !== seq(q)) {
        refused++
        console.log(`✗ ${label} #${q.number} 不修：拿掉頁眉後串接仍不同`)
        console.log(`    舊 ${oldSeq.slice(0, 120)}`)
        console.log(`    新 ${seq(q).slice(0, 120)}`)
        continue
      }
      if (q.answer !== b.answer) {
        refused++
        console.log(`✗ ${label} #${q.number} 不修：答案字母不同（${b.answer} vs ${q.answer}），先查清楚`)
        continue
      }
      console.log(`~ ${label} #${q.number} 修位移（答 ${b.answer}；原選項 ${dirty.join('')} 是頁眉）`)
      console.log(`    A 舊 ${String((b.options || {}).A).slice(0, 56)}`)
      console.log(`    A 新 ${String(q.options.A).slice(0, 56)}`)
      fixed++; touched.add(j.exam)
      if (APPLY) { b.question = q.question; b.options = { ...q.options } }
    }
  }

  for (const e of touched) {
    const arr = banks[e].questions
    arr.sort((a, b) => String(a.roc_year).localeCompare(String(b.roc_year)) ||
      String(a.subject_tag).localeCompare(String(b.subject_tag)) || a.number - b.number)
    banks[e].total = arr.length
  }

  console.log(`\n${APPLY ? '已修 ' : '可修 '}${fixed} 題｜${APPLY ? '已補 ' : '可補 '}${added} 題｜拒絕 ${refused}｜快取缺 ${missPdf} 卷`)
  if (!APPLY) { console.log('(試跑；加 --apply 才寫入)'); return }
  for (const e of touched) {
    const fp = path.join(ROOT, `questions-${e}.json`)
    withLock(fp, () => atomicWriteJson(fp, banks[e]))
    console.log(`✅ → questions-${e}.json（total ${banks[e].total}）`)
  }
}

main().catch(e => { console.error(e); process.exit(1) })

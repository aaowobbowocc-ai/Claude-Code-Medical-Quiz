#!/usr/bin/env node
// 批次整卷校正 speech-therapist + audiologist 的系統性選項位移。
// 每 TARGET 6 paper（subject_tag=paper1..6, s=sBase+idx）。column-parser 對齊官方
// 選項+答案，stem 前綴驗證、送分(逗號)保護、concat 防呆只在差異時改。--apply 寫入。
const fs = require('fs')
const { fetchPdf, buildMoexUrl } = require('./lib/pdf-fetcher')
const { parseColumnAware, parseAnswersColumnAware } = require('./lib/moex-column-parser')
const APPLY = process.argv.includes('--apply')
const UA = 'Mozilla/5.0', REF = 'https://wwwq.moex.gov.tw/exam/wFrmExamQandASearch.aspx'
const norm = x => (x || '').replace(/[-]/g, '').replace(/\s/g, '')

const SP='questions-speech-therapist.json', AU='questions-audiologist.json'
const T = [
  ['speech',SP,'100090','201','0401'],['speech',SP,'100140','111','0901'],
  ['speech',SP,'101070','201','0401'],['speech',SP,'101110','111','0801'],
  ['speech',SP,'102030','114','1001'],['speech',SP,'102110','114','1001'],
  ['speech',SP,'104100','109','0801'],['speech',SP,'107110','109','0801'],
  ['speech',SP,'103100','112','0801'],
  ['audio',AU,'100090','301','0501'],['audio',AU,'100140','112','1001'],
  ['audio',AU,'101070','301','0501'],['audio',AU,'101110','112','0901'],
  ['audio',AU,'102030','112','0801'],['audio',AU,'102110','201','0707'],
  ['audio',AU,'104100','110','0901'],['audio',AU,'103100','113','0901'],
  ['audio',AU,'106110','110','0901'],
]
const sAt = (base, i) => String(parseInt(base,10) + i).padStart(4,'0')

async function getPdf(t, code, c, s) {
  for (let i=0;i<3;i++){ try { return await fetchPdf(buildMoexUrl(t,code,c,s),{userAgent:UA,referer:REF}) }
    catch(e){ if(i===2) return null; await new Promise(r=>setTimeout(r,1200)) } }
}

async function main() {
  const cache = {}
  let GF=0, GA=0, papers=0
  for (const [ex, file, code, c, sBase] of T) {
    if (!cache[file]) cache[file] = JSON.parse(fs.readFileSync(file,'utf-8'))
    const arr = cache[file].questions || cache[file]
    for (let pi=0; pi<6; pi++) {
      const s = sAt(sBase, pi), tag = `paper${pi+1}`
      const has = arr.some(o => String(o.exam_code)===code && o.subject_tag===tag &&
        o.options && (norm(o.options.A||'').endsWith('？') || (o.options.A||'').trim().endsWith('?') || (o.options.A||'').trim().endsWith('？')))
      // 仍對全卷處理（不只壞題），但若該 paper 無資料就跳過
      if (!arr.some(o => String(o.exam_code)===code && o.subject_tag===tag)) continue
      const qb = await getPdf('Q',code,c,s), ab = await getPdf('S',code,c,s)
      if (!qb || !ab) { continue }
      let P, A={}
      try { P = await parseColumnAware(qb) } catch { continue }
      try { A = await parseAnswersColumnAware(ab) } catch {}
      let f=0, a=0
      for (const o of arr) {
        if (String(o.exam_code)!==code || o.subject_tag!==tag || !o.options) continue
        // 只處理「真位移」壞題：選項A以？結尾（題幹尾巴漏進A）
        const aTxt=(o.options.A||'').trim()
        if (!(aTxt.endsWith('？')||aTxt.endsWith('?'))) continue
        const p = P[o.number]
        if (!p || !p.options || ['A','B','C','D'].some(k=>!p.options[k]) || new Set(['A','B','C','D'].map(k=>p.options[k])).size!==4) continue
        const op=norm(o.question), pp=norm(p.question)
        if (!pp || !(op.startsWith(pp.slice(0,16)) || pp.startsWith(op.slice(0,16)))) continue
        const off=A[o.number]
        const cur=norm(['A','B','C','D'].map(k=>o.options[k]).join('|'))
        const nw=norm(['A','B','C','D'].map(k=>p.options[k]).join('|'))
        const optDiff=cur!==nw
        const ansDiff=off&&/^[ABCD]$/.test(off)&&off!==o.answer&&!/[,，]/.test(o.answer||'')
        if (!optDiff && !ansDiff) continue
        if (APPLY) {
          if (optDiff) o.options={A:p.options.A,B:p.options.B,C:p.options.C,D:p.options.D}
          if (pp.length>op.length && p.question) o.question=p.question
          if (ansDiff) o.answer=off
        }
        if (optDiff) f++; if (ansDiff) a++
      }
      if (f||a) { console.log(`${ex} ${code} ${tag}(s=${s}): 選項${f} 答案${a}`); GF+=f; GA+=a }
      papers++
    }
  }
  if (APPLY) for (const [file,d] of Object.entries(cache)) fs.writeFileSync(file, JSON.stringify(d,null,2))
  console.log(`\n${APPLY?'✅已套用':'(dry)'} 卷${papers} 改選項${GF} 改答案${GA}`)
}
main().catch(e=>{console.error(e);process.exit(1)})

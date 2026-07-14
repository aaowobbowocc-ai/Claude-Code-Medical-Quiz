const fs = require('fs'); const path = require('path')
const BACKEND = path.resolve(__dirname, '..')
const FILES = { doctor1:'questions.json', doctor2:'questions-doctor2.json', dental1:'questions-dental1.json', dental2:'questions-dental2.json', pharma1:'questions-pharma1.json', pharma2:'questions-pharma2.json', nursing:'questions-nursing.json', nutrition:'questions-nutrition.json', medlab:'questions-medlab.json', pt:'questions-pt.json', ot:'questions-ot.json', radiology:'questions-radiology.json', tcm1:'questions-tcm1.json', tcm2:'questions-tcm2.json', vet:'questions-vet.json', audiologist:'questions-audiologist.json', 'speech-therapist':'questions-speech-therapist.json', rt:'questions-rt.json', 'social-worker':'questions-social-worker.json', 'dental-tech':'questions-dental-tech.json' }
const byId = new Map()
for (const [exam, file] of Object.entries(FILES)) {
  const fp = path.join(BACKEND, file); if (!fs.existsSync(fp)) continue
  const arr = (() => { const d = JSON.parse(fs.readFileSync(fp,'utf-8')); return d.questions||d })()
  for (const q of arr) { const k=String(q.id); if(!byId.has(k)) byId.set(k,[]); byId.get(k).push({exam,q}) }
}
for (const raw of process.argv.slice(2)) {
  const id = raw.replace(/_paper\d+$/,'')
  console.log('\n═══', raw, '═══')
  const ms = byId.get(id); if (!ms) { console.log('  ✗ NF'); continue }
  for (const m of ms) { const q=m.q; console.log(`  [${m.exam}] ${q.exam_code} #${q.number} | ${q.subject}`); console.log('  Q:', JSON.stringify(q.question).slice(0,150)); console.log('  O:', JSON.stringify(q.options)); console.log('  a:', q.answer, 'disp:', q.disputed||false) }
}

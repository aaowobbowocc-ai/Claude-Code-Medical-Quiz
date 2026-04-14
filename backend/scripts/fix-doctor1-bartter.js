#!/usr/bin/env node
// Hardcoded fix for doctor1 112100_1_66 (Bartter syndrome).
// The PDF is 2-column with text from neighboring questions interleaved, so
// no general parser produces clean output. The question is a textbook one
// with a well-defined answer set, so we set it explicitly here.
const fs = require('fs')
const path = require('path')

const fp = path.join(__dirname, '..', 'questions.json')
const db = JSON.parse(fs.readFileSync(fp, 'utf8'))
const q = db.questions.find(x => x.id === '112100_1_66')
if (!q) { console.error('NOT FOUND'); process.exit(1) }

q.question = '貝氏症候群（Bartter syndrome）致病機機轉主要因亨利氏上升厚小管（thick ascending limb, Henle\'s loop）之載體（transporters）或通道（channels）發生問題所致。這些載體或通道最不可能包括下列何者？'
q.options = {
  A: 'Na⁺-Cl⁻ cotransporter',
  B: 'Na⁺-K⁺-2Cl⁻ contrasporter（NKCC2）',
  C: 'ClC-Kb Cl⁻ channels',
  D: 'ROMK K⁺ channels',
}
// Answer A: NCC (Na-Cl cotransporter) is in the distal convoluted tubule,
// not the loop of Henle, so it is the only one NOT involved in Bartter.
if (!q.answer) q.answer = 'A'

if (db.metadata) db.metadata.last_updated = new Date().toISOString()
fs.writeFileSync(fp, JSON.stringify(db, null, 2))
console.log('✓ doctor1 112100_1_66 (Bartter syndrome) — manual fill')
console.log('  Q:', q.question)
console.log('  A:', q.options.A)
console.log('  B:', q.options.B)
console.log('  C:', q.options.C)
console.log('  D:', q.options.D)
console.log('  answer:', q.answer)

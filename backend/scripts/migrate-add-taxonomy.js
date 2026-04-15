#!/usr/bin/env node
// One-shot migration: add taxonomy fields (category, subCategory, level,
// selectionType, persona, sharedBanks, sharedScope, uxHints) to all existing
// medical exam-configs. Idempotent — running twice yields the same result.
//
// See backend/TAXONOMY.md for the rationale and field semantics.
//
// Usage:
//   node backend/scripts/migrate-add-taxonomy.js          # apply changes
//   node backend/scripts/migrate-add-taxonomy.js --dry    # preview only

const fs = require('fs')
const path = require('path')

const CONFIG_DIR = path.join(__dirname, '..', 'exam-configs')
const DRY = process.argv.includes('--dry')

// examId → taxonomy values (per TAXONOMY.md section 六)
const TAXONOMY = {
  doctor1:   { subCategory: '醫師',       persona: ['medical-student']    },
  doctor2:   { subCategory: '醫師',       persona: ['medical-student']    },
  dental1:   { subCategory: '牙醫師',     persona: ['dentistry-student']  },
  dental2:   { subCategory: '牙醫師',     persona: ['dentistry-student']  },
  pharma1:   { subCategory: '藥師',       persona: ['pharmacy-student']   },
  pharma2:   { subCategory: '藥師',       persona: ['pharmacy-student']   },
  nursing:   { subCategory: '護理師',     persona: ['nursing-student']    },
  nutrition: { subCategory: '營養師',     persona: ['nutrition-student']  },
  pt:        { subCategory: '物理治療師', persona: ['rehab-student']      },
  ot:        { subCategory: '職能治療師', persona: ['rehab-student']      },
  medlab:    { subCategory: '醫事檢驗師', persona: ['medlab-student']     },
  tcm1:      { subCategory: '中醫師',     persona: ['tcm-student']        },
  tcm2:      { subCategory: '中醫師',     persona: ['tcm-student']        },
  vet:       { subCategory: '獸醫師',     persona: ['vet-student']        },
}

// All medical exams share these
const MEDICAL_DEFAULTS = {
  category: 'medical',
  level: 'license',
  selectionType: 'license',
  sharedBanks: [],
  sharedScope: 'none',
  uxHints: { defaultMode: 'pure', longText: false },
}

function applyTaxonomy(cfg) {
  const t = TAXONOMY[cfg.id]
  if (!t) {
    console.warn(`  ⚠ no taxonomy mapping for ${cfg.id}, skipping`)
    return null
  }

  const next = { ...cfg }
  next.category = MEDICAL_DEFAULTS.category
  next.subCategory = t.subCategory
  next.level = MEDICAL_DEFAULTS.level
  next.selectionType = MEDICAL_DEFAULTS.selectionType
  next.persona = t.persona
  next.sharedBanks = MEDICAL_DEFAULTS.sharedBanks
  next.sharedScope = MEDICAL_DEFAULTS.sharedScope
  next.uxHints = { ...MEDICAL_DEFAULTS.uxHints, ...(cfg.uxHints || {}) }

  return next
}

// Atomic write: tmp + rename (per Plan Part C.4)
function atomicWrite(filePath, content) {
  const tmp = filePath + '.tmp'
  fs.writeFileSync(tmp, content)
  fs.renameSync(tmp, filePath)
}

function reorderKeys(cfg) {
  // Put taxonomy fields right after `icon` for readability
  const { id, name, short, icon,
    category, subCategory, level, selectionType, persona,
    sharedBanks, sharedScope, uxHints,
    ...rest } = cfg
  return {
    id, name, short, icon,
    category, subCategory, level, selectionType, persona,
    sharedBanks, sharedScope, uxHints,
    ...rest,
  }
}

function main() {
  const files = fs.readdirSync(CONFIG_DIR).filter(f => f.endsWith('.json'))
  let changed = 0
  let skipped = 0

  console.log(`${DRY ? '[DRY] ' : ''}Migrating ${files.length} exam-configs in ${CONFIG_DIR}\n`)

  for (const f of files) {
    const p = path.join(CONFIG_DIR, f)
    const cfg = JSON.parse(fs.readFileSync(p, 'utf8'))
    const next = applyTaxonomy(cfg)
    if (!next) { skipped++; continue }

    const reordered = reorderKeys(next)
    const before = JSON.stringify(cfg)
    const after = JSON.stringify(reordered)

    if (before === after) {
      console.log(`  = ${f.padEnd(20)} (already up-to-date)`)
      continue
    }

    console.log(`  ✓ ${f.padEnd(20)} → category=${reordered.category}, subCategory=${reordered.subCategory}, persona=[${reordered.persona.join(',')}]`)
    if (!DRY) {
      atomicWrite(p, JSON.stringify(reordered, null, 2) + '\n')
    }
    changed++
  }

  console.log(`\n${DRY ? '[DRY] would update' : 'Updated'} ${changed} files, skipped ${skipped}.`)
  if (DRY) console.log('Run without --dry to apply.')
}

main()

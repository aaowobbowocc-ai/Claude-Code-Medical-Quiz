const fs = require('fs');
const path = require('path');

const BANKS_DIR = path.join(__dirname, 'shared-banks');
const MAX_CACHE = 32;

const cache = new Map();

function listBankIds() {
  if (!fs.existsSync(BANKS_DIR)) return [];
  return fs.readdirSync(BANKS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => f.replace(/\.json$/, ''));
}

function loadBank(bankId) {
  const filePath = path.join(BANKS_DIR, `${bankId}.json`);
  if (!fs.existsSync(filePath)) return null;

  let mtimeMs;
  try {
    mtimeMs = fs.statSync(filePath).mtimeMs;
  } catch {
    return null;
  }

  const cached = cache.get(bankId);
  if (cached && cached.mtimeMs === mtimeMs) {
    cache.delete(bankId);
    cache.set(bankId, cached);
    return cached.data;
  }

  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const entry = { mtimeMs, data: raw };
    cache.delete(bankId);
    cache.set(bankId, entry);
    while (cache.size > MAX_CACHE) {
      const firstKey = cache.keys().next().value;
      cache.delete(firstKey);
    }
    return raw;
  } catch (err) {
    console.warn(`[shared-banks] parse error for ${bankId}: ${err.message}; falling back to cached version`);
    return cached ? cached.data : null;
  }
}

function getBankMeta(bankId) {
  const bank = loadBank(bankId);
  if (!bank) return null;
  const all = bank.questions || [];
  const active = all.filter(q => !q.is_deprecated);
  return {
    bankId: bank.bankId || bankId,
    name: bank.name || bankId,
    description: bank.description || '',
    levels: bank.levels || [],
    questionCount: active.length,
    deprecatedCount: all.length - active.length,
    bankVersion: bank.bankVersion || 0,
    last_synced_at: bank.last_synced_at || null,
  };
}

function getAllBankMeta() {
  return listBankIds().map(getBankMeta).filter(Boolean);
}

const SCOPE_LEVELS = {
  level_3_common: ['senior'],
  level_4_common: ['junior'],
  level_5_common: ['elementary'],
  none: [],
};

function getAllowedLevels(cfg) {
  if (!cfg) return [];
  return SCOPE_LEVELS[cfg.sharedScope] || [];
}

function getSharedQuestionsForExam(cfg) {
  if (!cfg || !Array.isArray(cfg.sharedBanks) || cfg.sharedBanks.length === 0) return [];
  const allowedLevels = getAllowedLevels(cfg);
  const bucket = [];
  for (const bankId of cfg.sharedBanks) {
    const bank = loadBank(bankId);
    if (!bank) continue;
    const fallbackLabel = bank.name || bankId;
    for (const q of bank.questions || []) {
      if (q.is_deprecated) continue;
      if (allowedLevels.length > 0 && !allowedLevels.includes(q.level)) continue;
      bucket.push({
        ...q,
        isSharedBank: true,
        sourceBankId: bank.bankId || bankId,
        sourceLabel: `[同等推薦] ${q.source_exam_name || fallbackLabel}`,
      });
    }
  }
  return bucket;
}

function getSharedPapersForExam(cfg) {
  if (!cfg || !Array.isArray(cfg.sharedBanks) || cfg.sharedBanks.length === 0) return [];
  const allowedLevels = getAllowedLevels(cfg);
  const papers = [];
  for (const bankId of cfg.sharedBanks) {
    const bank = loadBank(bankId);
    if (!bank) continue;
    const count = (bank.questions || []).filter(q =>
      !q.is_deprecated && (allowedLevels.length === 0 || allowedLevels.includes(q.level))
    ).length;
    papers.push({
      id: `shared_${bank.bankId || bankId}`,
      name: bank.name || bankId,
      subject: bank.name || bankId,
      subjects: bank.description || '',
      count,
      fromSharedBank: true,
      sourceBankId: bank.bankId || bankId,
      bankVersion: bank.bankVersion || 0,
      last_synced_at: bank.last_synced_at || null,
    });
  }
  return papers;
}

module.exports = {
  loadBank,
  listBankIds,
  getBankMeta,
  getAllBankMeta,
  getSharedQuestionsForExam,
  getSharedPapersForExam,
  getAllowedLevels,
};

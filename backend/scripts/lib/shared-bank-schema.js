// Loader + validator for backend/shared-banks/schema.md.
//
// Parses the markdown into:
//   - whitelist: Set<string>  — every tag declared under "## Tag 白名單"
//   - aliasMap:  Array<{ tag, aliases: string[] }>  — preserves declared order;
//     subject_name → tags resolution does substring `includes()` matching
//     against this list (per schema rule), and a single subject_name can
//     legitimately resolve to multiple tags (合考 case).
//
// The schema.md file is BOTH human spec AND runtime whitelist — modifying
// the "## Tag 白名單" section requires keeping the `- tag_name` per-line format
// since this loader regex-matches it.

const fs = require('fs');
const path = require('path');

const SCHEMA_PATH = path.join(__dirname, '..', '..', 'shared-banks', 'schema.md');

function loadSchema() {
  if (!fs.existsSync(SCHEMA_PATH)) {
    throw new Error(`shared-banks schema.md not found at ${SCHEMA_PATH}`);
  }
  const text = fs.readFileSync(SCHEMA_PATH, 'utf-8');

  // Whitelist: every line of form "- tag_name" inside "## Tag 白名單" up to
  // the next "## " (next top-level section).
  const whitelist = new Set();
  const wlSection = text.match(/^##\s*Tag\s*白名單[\s\S]*?(?=\n##\s)/m);
  if (!wlSection) throw new Error('schema.md: missing "## Tag 白名單" section');
  for (const m of wlSection[0].matchAll(/^-\s*([a-z][a-z0-9_]*)\s*$/gm)) {
    whitelist.add(m[1]);
  }
  if (whitelist.size === 0) {
    throw new Error('schema.md: "## Tag 白名單" parsed empty — check `- tag_name` format');
  }

  // Alias map: pipe-table rows under "## 中文別名對照" up to next "## ".
  const aliasSection = text.match(/^##\s*中文別名對照[\s\S]*?(?=\n##\s)/m);
  if (!aliasSection) throw new Error('schema.md: missing "## 中文別名對照" section');
  const aliasMap = [];
  for (const line of aliasSection[0].split('\n')) {
    // Match: | `tag` | alias1、alias2、... |
    const m = line.match(/^\|\s*`([a-z][a-z0-9_]*)`\s*\|\s*([^|]+?)\s*\|/);
    if (!m) continue;
    const tag = m[1];
    if (!whitelist.has(tag)) {
      throw new Error(`schema.md: alias map references tag "${tag}" not in whitelist`);
    }
    // Aliases separated by Chinese comma 、 (also accept ASCII , as fallback)
    const aliases = m[2].split(/[、,]/).map(s => s.trim()).filter(Boolean);
    aliasMap.push({ tag, aliases });
  }
  if (aliasMap.length === 0) {
    throw new Error('schema.md: alias map parsed empty — check `| \\`tag\\` | aliases |` format');
  }

  return { whitelist, aliasMap };
}

// Resolve a Chinese subject name to one-or-more tags via substring match.
// Order of aliasMap is preserved (declared in schema.md), so the first match
// wins for ambiguous cases — but ALL matching entries contribute (合考: 一題
// 可同時擁有多個 tag).
function deriveTagsFromSubjectName(subjectName, aliasMap) {
  if (!subjectName) return [];
  const hits = [];
  for (const { tag, aliases } of aliasMap) {
    if (aliases.some(a => subjectName.includes(a))) {
      if (!hits.includes(tag)) hits.push(tag);
    }
  }
  return hits;
}

// Throws if any tag is not in the whitelist; returns the validated array.
function validateTags(tags, whitelist) {
  if (!Array.isArray(tags) || tags.length === 0) {
    throw new Error('subject_tags must be a non-empty array');
  }
  const bad = tags.filter(t => !whitelist.has(t));
  if (bad.length > 0) {
    throw new Error(`unknown subject_tags: ${bad.join(', ')}. Add to backend/shared-banks/schema.md or check spelling.`);
  }
  return tags;
}

module.exports = { loadSchema, deriveTagsFromSubjectName, validateTags, SCHEMA_PATH };

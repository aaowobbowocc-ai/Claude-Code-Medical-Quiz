#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""通用版：修營養師「選項重複」OCR 損壞（103100 以外的其餘年份）。
自動依 (exam_code, 科目名) 查 c/s → 抓官方原卷重解選項+答案覆寫。
安全門檻：官方須解出 4 個相異非空選項才覆寫。"""
import sys, urllib.request, ssl, importlib.util, time, re, json
sys.stdout.reconfigure(encoding='utf-8')
ssl._create_default_https_context = ssl._create_unverified_context
from pathlib import Path
import fitz

spec = importlib.util.spec_from_file_location('ap', 'scripts/audit-paper.py')
ap = importlib.util.module_from_spec(spec); spec.loader.exec_module(ap)
BASE = 'https://wwwq.moex.gov.tw/exam'

def http(url):
    for _ in range(6):
        try:
            return urllib.request.urlopen(urllib.request.Request(
                url, headers={'User-Agent': 'Mozilla/5.0'}), timeout=80).read()
        except: time.sleep(3)
    return None

_cs_cache = {}
def find_cs(code, subj):
    """回傳 (c, s) 或 None，比對搜尋頁列文字含科目名。"""
    key = str(code)
    if key not in _cs_cache:
        y = 1911 + int(str(code)[:3])
        h = http(f'{BASE}/wFrmExamQandASearch.aspx?y={y}&e={code}')
        _cs_cache[key] = h.decode('utf-8', 'replace').replace('&amp;', '&') if h else ''
    h = _cs_cache[key]
    # 取科目主幹（去括號註解）
    stem = re.split(r'[（(]', subj)[0].strip()
    best = None
    for r in re.split(r'<tr', h):
        m = re.search(rf't=Q&code={code}&c=(\d+)&s=(\w+)', r)
        if not m: continue
        row = ' '.join(re.sub(r'<[^>]+>', '', r).split())
        if stem and stem in row:
            best = (m.group(1), m.group(2)); break
    return best

def getpdf(t, code, c, s, fn):
    p = Path(f'_tmp/{fn}.pdf')
    if p.exists() and p.stat().st_size > 8000: return p
    b = http(f'{BASE}/wHandExamQandA_File.ashx?t={t}&code={code}&c={c}&s={s}&q=1')
    if b and b[:4] == b'%PDF' and len(b) > 8000: p.write_bytes(b); return p
    return None

def parse_answers(code, c, s, subj, fn):
    p = getpdf('A', code, c, s, fn + 'A')
    if not p: return {}
    full = '\n'.join(pg.get_text() for pg in fitz.open(p))
    stem = re.split(r'[（(]', subj)[0].strip()
    idxs = [m.start() for m in re.finditer('科目名稱', full)]
    block = None
    for k, st in enumerate(idxs):
        en = idxs[k+1] if k+1 < len(idxs) else len(full)
        if stem in full[st:en]: block = full[st:en]; break
    if not block: block = full
    ans = {}
    for (lo, hi), row in zip(re.findall(r'(\d+)\s*-\s*(\d+)', block),
                             re.findall(r'([A-EＡ-Ｅ#]{5,10})', block)):
        lo, hi = int(lo), int(hi)
        if len(row) == (hi - lo + 1):
            for i, ch in enumerate(row): ans[lo + i] = ch
    return ans

FN = 'questions-nutrition.json'
data = json.loads(Path(FN).read_text(encoding='utf-8'))
arr = data['questions'] if isinstance(data, dict) and 'questions' in data else data

# 分組：(exam_code, subject) → 壞題；跳過已修的 103100
groups = {}
for q in arr:
    code = str(q.get('exam_code'))
    if code == '103100': continue
    opts = [str(v).strip() for v in (q.get('options') or {}).values()]
    if len(opts) >= 2 and len(set(opts)) != len(opts):
        groups.setdefault((code, q.get('subject')), []).append(q)

fixed = skipped = nocs = 0
for (code, subj), qs in sorted(groups.items()):
    cs = find_cs(code, subj)
    if not cs:
        print(f'✗ 找不到 c/s: {code} {subj}（{len(qs)}題）'); nocs += len(qs); continue
    c, s = cs
    fn = f'nd_{code}_{s}'
    p = getpdf('Q', code, c, s, fn)
    if not p:
        print(f'✗ PDF失敗 {code} {subj}'); skipped += len(qs); continue
    parsed = ap.parse_questions(p)
    answers = parse_answers(code, c, s, subj, fn)
    cnt = 0
    for q in qs:
        num = q.get('number')
        clean = [o.strip() for o in parsed.get(num, {}).get('opts', []) if o and o.strip()]
        if len(clean) != 4 or len(set(clean)) != 4:
            skipped += 1; continue
        q['options'] = {'A': clean[0], 'B': clean[1], 'C': clean[2], 'D': clean[3]}
        a = answers.get(num)
        if a and a in 'ABCD': q['answer'] = a
        fixed += 1; cnt += 1
    print(f'✓ {code} {subj}: 修 {cnt}/{len(qs)}')
    time.sleep(1)

Path(FN).write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
print(f'\n總計 修復 {fixed}，跳過 {skipped}，無c/s {nocs}')

#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""語言治療師題庫「選項跑掉」大規模系統性損壞修復。
對每個 (exam_code, subject) 查 c/s → 抓官方原卷重解選項/題幹/答案。
只在「本地選項疑似損壞 且 官方 parse 乾淨(4個相異非空、長度合理)」時覆寫。"""
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

_cs = {}
def find_cs(code, subj):
    key = str(code)
    if key not in _cs:
        y = 1911 + int(str(code)[:3])
        h = http(f'{BASE}/wFrmExamQandASearch.aspx?y={y}&e={code}')
        _cs[key] = h.decode('utf-8', 'replace').replace('&amp;', '&') if h else ''
    h = _cs[key]
    stem = re.split(r'[（(]', str(subj))[0].strip()
    for r in re.split(r'<tr', h):
        m = re.search(rf't=Q&code={code}&c=(\d+)&s=(\w+)', r)
        if not m: continue
        row = ' '.join(re.sub(r'<[^>]+>', '', r).split())
        if stem and stem in row:
            return (m.group(1), m.group(2))
    return None

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
    stem = re.split(r'[（(]', str(subj))[0].strip()
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

def corrupted(opts):
    o = [str(v).strip() for v in opts.values()]
    if len(o) < 4: return True
    if len(set(o)) != len(o): return True
    for x in o:
        if len(x) < 2 or len(x) > 75: return True
        if re.search(r'[？。]$', x): return True
        if re.search(r'此測驗|何者正確|何者錯誤|下列那些|下列何', x): return True
    return False

def clean_official(opts):
    o = [s.strip() for s in opts if s and s.strip()]
    if len(o) != 4: return None
    if len(set(o)) != 4: return None
    if any(len(x) > 90 for x in o): return None
    return o

FN = 'questions-speech-therapist.json'
data = json.loads(Path(FN).read_text(encoding='utf-8'))
arr = data['questions'] if isinstance(data, dict) and 'questions' in data else data

groups = {}
for q in arr:
    if corrupted(q.get('options') or {}):
        groups.setdefault((str(q.get('exam_code')), q.get('subject')), []).append(q)

print(f'需處理 {sum(len(v) for v in groups.values())} 題，分 {len(groups)} 個(卷,科)')
fixed = skipped = nocs = 0
for (code, subj), qs in sorted(groups.items()):
    cs = find_cs(code, subj)
    if not cs:
        nocs += len(qs); print(f'✗ 無c/s {code} {subj} ({len(qs)})'); continue
    c, s = cs
    fn = f'sp_{code}_{s}'
    p = getpdf('Q', code, c, s, fn)
    if not p:
        skipped += len(qs); print(f'✗ PDF失敗 {code} {subj}'); continue
    parsed = ap.parse_questions(p)
    answers = parse_answers(code, c, s, subj, fn)
    cnt = 0
    for q in qs:
        num = q.get('number')
        pq = parsed.get(num, {})
        co = clean_official(pq.get('opts', []))
        if not co: skipped += 1; continue
        q['options'] = {'A': co[0], 'B': co[1], 'C': co[2], 'D': co[3]}
        st = (pq.get('q') or '').strip()
        if st and len(st) > 8: q['question'] = st
        a = answers.get(num)
        if a and a in 'ABCD': q['answer'] = a
        fixed += 1; cnt += 1
    print(f'✓ {code} {subj}: {cnt}/{len(qs)}', flush=True)
    Path(FN).write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')  # 每卷存檔
    time.sleep(0.5)

Path(FN).write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
print(f'\n總計 修 {fixed}，跳過 {skipped}，無c/s {nocs}')

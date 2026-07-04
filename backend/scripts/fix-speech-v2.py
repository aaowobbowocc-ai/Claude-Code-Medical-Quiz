#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""語言治療師選項損壞修復 v2 —— 用 speech_parser（PUA 標記解析，正確處理
多行選項/複選 combo）。對每個 (exam_code, subject) 抓官方重解，替換損壞題的
選項/題幹/答案。安全：只在官方解析乾淨(4個相異非空、長度<200)時覆寫。"""
import sys, urllib.request, ssl, importlib.util, time, re, json
sys.stdout.reconfigure(encoding='utf-8')
ssl._create_default_https_context = ssl._create_unverified_context
from pathlib import Path
import fitz

sp = importlib.util.spec_from_file_location('spp', 'scripts/speech_parser.py')
spp = importlib.util.module_from_spec(sp); sp.loader.exec_module(spp)
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
        if m and stem and stem in ' '.join(re.sub(r'<[^>]+>', '', r).split()):
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

def is_corrupt(opts):
    o = [str(v).strip() for v in opts.values()]
    if len(o) < 4: return True
    if len(set(o)) != len(o): return True
    for x in o:
        if len(x) < 2: return True
        if re.search(r'[？。]$', x): return True
        if re.search(r'此測驗之名稱|何者正確[？?]?$|下列那些[^，。]{0,4}[？?]$', x): return True
    return False

def clean(opts):
    o = [s.strip() for s in opts if s and s.strip()]
    if len(o) != 4 or len(set(o)) != 4: return None
    if any(len(x) > 200 or len(x) < 1 for x in o): return None
    return o

FN = 'questions-speech-therapist.json'
data = json.loads(Path(FN).read_text(encoding='utf-8'))
arr = data['questions'] if isinstance(data, dict) and 'questions' in data else data

groups = {}
for q in arr:
    if is_corrupt(q.get('options') or {}):
        groups.setdefault((str(q.get('exam_code')), q.get('subject')), []).append(q)

print(f'需處理 {sum(len(v) for v in groups.values())} 題 / {len(groups)} 卷', flush=True)
fixed = skipped = nocs = 0
for (code, subj), qs in sorted(groups.items()):
    cs = find_cs(code, subj)
    if not cs: nocs += len(qs); print(f'✗nocs {code} {subj} ({len(qs)})', flush=True); continue
    c, s = cs
    p = getpdf('Q', code, c, s, f'v2_{code}_{s}')
    if not p: skipped += len(qs); print(f'✗pdf {code} {subj}', flush=True); continue
    parsed = spp.parse_speech_pdf(p)
    answers = parse_answers(code, c, s, subj, f'v2_{code}_{s}')
    cnt = 0
    for q in qs:
        pq = parsed.get(q.get('number'), {})
        co = clean(pq.get('opts', []))
        if not co: skipped += 1; continue
        q['options'] = {'A': co[0], 'B': co[1], 'C': co[2], 'D': co[3]}
        st = (pq.get('q') or '').strip()
        if st and len(st) > 6: q['question'] = st
        a = answers.get(q.get('number'))
        if a and a in 'ABCD': q['answer'] = a
        fixed += 1; cnt += 1
    print(f'✓ {code} {subj}: {cnt}/{len(qs)}', flush=True)
    Path(FN).write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
    time.sleep(0.4)

Path(FN).write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
print(f'\n總計 修 {fixed}，跳過 {skipped}，無c/s {nocs}')

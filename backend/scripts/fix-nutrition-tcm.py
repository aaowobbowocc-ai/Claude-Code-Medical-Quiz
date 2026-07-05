#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""營養師檔的中醫題污染修復（聯合考試爬蟲誤植中醫師題）。
對每個受污染的 (exam_code, subject) 抓官方營養師原卷，用正確題替換該題號。
只在官方解析乾淨且『非中醫內容』時才覆寫。"""
import sys, urllib.request, ssl, importlib.util, time, re, json
sys.stdout.reconfigure(encoding='utf-8')
ssl._create_default_https_context = ssl._create_unverified_context
from pathlib import Path
import fitz

sp = importlib.util.spec_from_file_location('spp', 'scripts/speech_parser.py')
spp = importlib.util.module_from_spec(sp); sp.loader.exec_module(spp)
BASE = 'https://wwwq.moex.gov.tw/exam'

TCM = re.compile(r'《內經》|《傷寒論?》|《金匱|《素問|《靈樞|《難經》|《針灸大成》|《溫病|《醫學入門》|《神農本草|《脈經》|經外奇穴|取穴|君臣佐使|旋覆代赭湯|痞證|辨證論治|衛氣營血|六經辨證')

def http(url):
    for _ in range(6):
        try:
            return urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'}), timeout=80).read()
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
    for (lo, hi), row in zip(re.findall(r'(\d+)\s*-\s*(\d+)', block), re.findall(r'([A-EＡ-Ｅ#]{5,10})', block)):
        lo, hi = int(lo), int(hi)
        if len(row) == (hi - lo + 1):
            for i, ch in enumerate(row): ans[lo + i] = ch
    return ans

FN = 'questions-nutrition.json'
data = json.loads(Path(FN).read_text(encoding='utf-8'))
arr = data['questions'] if isinstance(data, dict) and 'questions' in data else data

targets = [q for q in arr if TCM.search((q.get('question') or '') + json.dumps(q.get('options') or {}, ensure_ascii=False))]
groups = {}
for q in targets:
    groups.setdefault((str(q.get('exam_code')), q.get('subject')), []).append(q)

print(f'污染 {len(targets)} 題 / {len(groups)} 卷')
fixed = skipped = 0
for (code, subj), qs in sorted(groups.items()):
    cs = find_cs(code, subj)
    if not cs: print(f'✗nocs {code} {subj}'); skipped += len(qs); continue
    c, s = cs
    p = getpdf('Q', code, c, s, f'nt_{code}_{s}')
    if not p: print(f'✗pdf {code} {subj}'); skipped += len(qs); continue
    parsed = spp.parse_speech_pdf(p)
    answers = parse_answers(code, c, s, subj, f'nt_{code}_{s}')
    for q in qs:
        num = q.get('number')
        pq = parsed.get(num, {})
        st = (pq.get('q') or '').strip()
        opts = [o.strip() for o in pq.get('opts', []) if o and o.strip()]
        # 安全：官方題幹須乾淨、非中醫、四選項相異
        if not st or len(st) < 6 or len(opts) != 4 or len(set(opts)) != 4 or TCM.search(st + ''.join(opts)):
            skipped += 1; print(f'  跳過 {code} {subj} #{num}（官方不乾淨/仍中醫）'); continue
        q['question'] = st
        q['options'] = {'A': opts[0], 'B': opts[1], 'C': opts[2], 'D': opts[3]}
        a = answers.get(num)
        if a and a in 'ABCD': q['answer'] = a
        fixed += 1
    print(f'✓ {code} {subj}: 修 {len([1 for q in qs])}')
    Path(FN).write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
    time.sleep(0.4)

Path(FN).write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
print(f'\n修 {fixed}，跳過 {skipped}')

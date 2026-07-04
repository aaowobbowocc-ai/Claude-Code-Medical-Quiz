#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""營養師 103100 整卷修復：選項重複(A=B)等 OCR 損壞，用官方原卷重解選項+答案覆寫。
只在官方 parse 出 4 個相異選項時才覆寫，避免把好題改壞。"""
import sys, urllib.request, ssl, importlib.util, time, re, json
sys.stdout.reconfigure(encoding='utf-8')
ssl._create_default_https_context = ssl._create_unverified_context
from pathlib import Path
import fitz

spec = importlib.util.spec_from_file_location('ap', 'scripts/audit-paper.py')
ap = importlib.util.module_from_spec(spec); spec.loader.exec_module(ap)
U = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'

# 科目名稱 → (c, s, 答案卷 subject block 關鍵字)
PAPERS = {
    '生理學與生物化學':   ('106', '0301', '生理學與生物化學'),
    '營養學':             ('106', '0302', '營養學'),
    '膳食療養學':         ('106', '0303', '膳食療養學'),
    '團體膳食設計與管理': ('106', '0304', '團體膳食設計與管理'),
    '公共衛生營養學':     ('106', '0305', '公共衛生營養學'),
    '食品衛生與安全':     ('106', '0306', '食品衛生與安全'),
}

def getpdf(t, c, s, fn):
    p = Path(f'_tmp/{fn}.pdf')
    if p.exists() and p.stat().st_size > 8000: return p
    for _ in range(6):
        try:
            b = urllib.request.urlopen(urllib.request.Request(
                f'{U}?t={t}&code=103100&c={c}&s={s}&q=1',
                headers={'User-Agent': 'Mozilla/5.0'}), timeout=90).read()
        except: b = None
        if b and b[:4] == b'%PDF' and len(b) > 8000:
            p.write_bytes(b); return p
        time.sleep(4)
    return None

def parse_answers(c, s, subjkey, fn):
    p = getpdf('A', c, s, fn + 'A')
    if not p: return {}
    full = '\n'.join(pg.get_text() for pg in fitz.open(p))
    idxs = [m.start() for m in re.finditer('科目名稱', full)]
    block = None
    for k, st in enumerate(idxs):
        en = idxs[k+1] if k+1 < len(idxs) else len(full)
        if subjkey in full[st:en]: block = full[st:en]; break
    if not block: block = full
    ans = {}
    for (lo, hi), row in zip(re.findall(r'(\d+)\s*-\s*(\d+)', block),
                             re.findall(r'([A-EＡ-Ｅ#]{5,10})', block)):
        lo, hi = int(lo), int(hi)
        if len(row) == (hi - lo + 1):
            for i, ch in enumerate(row): ans[lo + i] = ch
    return ans

# 載入題庫
FN = 'questions-nutrition.json'
data = json.loads(Path(FN).read_text(encoding='utf-8'))
arr = data['questions'] if isinstance(data, dict) and 'questions' in data else data

# 找 103100 壞題（選項重複）依科目分組
targets = {}
for q in arr:
    if str(q.get('exam_code')) != '103100': continue
    opts = [str(v).strip() for v in (q.get('options') or {}).values()]
    if len(opts) >= 2 and len(set(opts)) != len(opts):
        targets.setdefault(q.get('subject'), []).append(q)

fixed = skipped = 0
report = []
for subj, qs in targets.items():
    if subj not in PAPERS:
        print(f'⚠ 科目未對應 c/s: {subj}（{len(qs)}題跳過）'); skipped += len(qs); continue
    c, s, akey = PAPERS[subj]
    fn = 'nut_' + s
    p = getpdf('Q', c, s, fn)
    if not p: print(f'✗ {subj} PDF 抓取失敗'); skipped += len(qs); continue
    parsed = ap.parse_questions(p)
    answers = parse_answers(c, s, akey, fn)
    for q in qs:
        num = q.get('number')
        pq = parsed.get(num, {})
        opts = pq.get('opts', [])
        # 安全門檻：官方須解出 4 個相異、非空選項
        clean = [o.strip() for o in opts if o and o.strip()]
        if len(clean) != 4 or len(set(clean)) != 4:
            skipped += 1; report.append(f'  跳過 {subj}#{num}（官方parse不乾淨:{len(clean)}選項）'); continue
        q['options'] = {'A': clean[0], 'B': clean[1], 'C': clean[2], 'D': clean[3]}
        a = answers.get(num)
        if a and a in 'ABCD': q['answer'] = a
        fixed += 1

Path(FN).write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
print(f'\n修復 {fixed} 題，跳過 {skipped} 題')
for r in report[:20]: print(r)

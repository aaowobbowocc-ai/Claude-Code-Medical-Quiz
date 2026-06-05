# -*- coding: utf-8 -*-
"""免費重建 police4 107-1 英文（code 107070, c=401, s=0204）壞題。
Q：座標式——選項在 bullet(PUA U+E18C–F) 同一橫列、依欄區間收字，字間距決定空格。
A：雙欄表格，座標把「第N題」配對正下方答案字母。
驗證：原 JSON 非空選項須出現在重抽選項中才套用。零 API。
用法：python scripts/fix-police4-107-english.py [--apply]
"""
import json, sys, re, urllib.request, ssl
from pathlib import Path
import fitz
sys.stdout.reconfigure(encoding='utf-8', errors='replace')
ssl._create_default_https_context = ssl._create_unverified_context
BASE = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'
TMP = Path('_tmp/police4-107'); TMP.mkdir(parents=True, exist_ok=True)
CODE, C, S = '107070', '401', '0204'
BUL_LO, BUL_HI = 0xE18C, 0xE18F


def dl(t, name):
    f = TMP / name
    if not (f.exists() and f.stat().st_size > 1000):
        u = f'{BASE}?t={t}&code={CODE}&c={C}&s={S}&q=1'
        f.write_bytes(urllib.request.urlopen(urllib.request.Request(
            u, headers={'User-Agent': 'Mozilla/5.0'}), timeout=40).read())
    return f


def is_bul(t):
    return len(t) == 1 and BUL_LO <= ord(t[0]) <= BUL_HI


def join_words(ws):
    """依字間 x 間距決定空格：間距<2px 視為同字接續（ha+ngover=hangover），否則加空格。"""
    ws = sorted(ws, key=lambda w: w[0]); out = ''
    for i, w in enumerate(ws):
        if i and (w[0] - ws[i - 1][2]) > 2:
            out += ' '
        out += w[4]
    return out.strip()


def join_rows(ws):
    rows = {}
    for w in ws:
        rows.setdefault(round(w[1] / 3), []).append(w)
    return ' '.join(join_words(rows[k]) for k in sorted(rows))


def parse_questions(pdf):
    doc = fitz.open(pdf); res = {}
    for pg in doc:
        words = [w for w in pg.get_text('words') if w[4].strip()]
        bl = [w for w in words if is_bul(w[4])]
        qn = sorted([(int(w[4]), w[1]) for w in words
                     if re.fullmatch(r'\d{1,2}', w[4]) and 1 <= int(w[4]) <= 50 and w[0] < 58],
                    key=lambda t: t[1])
        seq = []; last = -1
        for n, y in qn:
            if n > last:                       # 嚴格遞增即可（跨頁起始非1）
                seq.append((n, y)); last = n
        for k, (n, y0) in enumerate(seq):
            y1 = seq[k + 1][1] if k + 1 < len(seq) else 1e9
            qb = [w for w in bl if y0 <= w[1] < y1]
            if len(qb) < 4:
                continue
            qb = sorted(qb, key=lambda w: (round(w[1] / 3), w[0]))[:4]   # 前4個 by (row,x) → A,B,C,D
            opts = {}
            for bi, b in enumerate(qb):
                bx, by = b[0], b[1]
                same = [w[0] for w in qb if abs(w[1] - by) < 3 and w[0] > bx]
                xend = min(same) if same else 1e9
                cell = [w for w in words if abs(w[1] - by) < 3.5 and bx < w[0] < xend and not is_bul(w[4])]
                opts['ABCD'[bi]] = join_words(cell)
            fby = min(w[1] for w in qb)
            sw = [w for w in words if y0 - 1 <= w[1] < fby - 2
                  and not re.fullmatch(r'\d{1,2}', w[4]) and not is_bul(w[4])]
            res[n] = {'stem': re.sub(r'\s+', ' ', join_rows(sw)).strip(), 'opts': opts}
    return res


def parse_answers(pdf):
    pg = fitz.open(pdf)[0]; words = pg.get_text('words')
    labels = []; letters = []
    for w in words:
        m = re.fullmatch(r'第(\d+)題', w[4])
        if m:
            labels.append((int(m.group(1)), w[0], w[1]))
        elif re.fullmatch(r'[ABCD#]', w[4]):
            letters.append((w[4], w[0], w[1]))
    ans = {}
    for n, lx, ly in labels:
        best = None; bd = 1e9
        for L, x, y in letters:
            if 5 < (y - ly) < 28 and abs(x - lx) < 22:   # 答案在題號正下方
                d = abs(x - lx) + (y - ly)
                if d < bd:
                    bd = d; best = L
        if best is not None:
            ans[n] = None if best == '#' else best
    return ans


def main():
    apply = '--apply' in sys.argv
    q = parse_questions(dl('Q', 'q.pdf')); a = parse_answers(dl('S', 'a.pdf'))
    print(f'重抽 Q={len(q)} 題, 官方答案 A={len([v for v in a.values() if v])} 個')
    d = json.load(open('questions-police4.json', encoding='utf-8'))
    qs = d if isinstance(d, list) else d.get('questions', d)
    norm = lambda s: re.sub(r'[^a-z0-9]', '', (s or '').lower())
    fixed = skip = 0; samples = []; novalid = []

    def walk(o):
        nonlocal fixed, skip
        if isinstance(o, list):
            [walk(x) for x in o]
        elif isinstance(o, dict):
            if o.get('exam_code') == '107070' and o.get('subject_tag') == 'english' and isinstance(o.get('options'), dict):
                vals = list(o['options'].values())
                broken = any(isinstance(v, str) and v and BUL_LO <= ord(v[0]) <= BUL_HI
                             and not v.lstrip(''.join(chr(c) for c in range(BUL_LO, BUL_HI + 1)) + ' 　').strip()
                             for v in vals)
                if not broken:
                    return
                n = o.get('number'); pq = q.get(n)
                if not pq or len(pq['opts']) < 4 or not all(pq['opts'].get(k) for k in 'ABCD'):
                    skip += 1; novalid.append(('NOPARSE', n, pq, o['options'], o.get('answer'), a.get(n))); return
                # 驗證：重抽的乾淨題幹應為原（亂）題幹的前綴（原題幹＝乾淨+洩漏選項）
                op = norm(o.get('question', '')); pp = norm(pq['stem'])
                if not pp or not (op.startswith(pp[:30]) or pp.startswith(op[:30])):
                    skip += 1; novalid.append(('STEM≠', n, pq, o['options'], o.get('answer'), a.get(n))); return
                if apply:
                    o['question'] = pq['stem']; o['options'] = dict(pq['opts'])
                    if a.get(n):
                        o['answer'] = a[n]
                fixed += 1
                if len(samples) < 6:
                    samples.append((n, pq, o.get('answer'), a.get(n)))
            else:
                for v in o.values():
                    walk(v)
    walk(qs)
    print(f'\n可修 {fixed} 題, 跳過 {skip} 題')
    for n, pq, oldans, offans in samples:
        print(f'  #{n}  官方={offans} (原={oldans})  Q: {pq["stem"][:62]}')
        for k in 'ABCD':
            print(f'      {k}. {pq["opts"].get(k)}')
    for tag, n, pq, oldopts, oldans, offans in novalid:
        print(f'  [跳過-{tag}] #{n} 原答={oldans} 官方={offans}')
        if pq:
            for k in 'ABCD':
                print(f'      {k}. {pq["opts"].get(k)}')
        print('      原選項:', oldopts)
    if apply:
        json.dump(d, open('questions-police4.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
        print(f'\n✅ 已套用 {fixed} 題')


if __name__ == '__main__':
    main()

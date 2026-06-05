# -*- coding: utf-8 -*-
"""通用：免費重建「選項 bullet(PUA U+E18C–F) 洩漏」型壞題（座標重抽 + 官方答案卷）。
語言無關（英文/法學中文皆可，字間距>2px 才加空格）。零 API。
JOBS：(json檔, exam_code, c, s, subject_tag) — s 可填 'probe' 自動探測。
用法：python scripts/fix-bullet-cloze.py [--apply] [--only <code>]
"""
import json, sys, re, urllib.request, ssl
from pathlib import Path
import fitz
sys.stdout.reconfigure(encoding='utf-8', errors='replace')
ssl._create_default_https_context = ssl._create_unverified_context
BASE = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'
TMP = Path('_tmp/bullet-cloze'); TMP.mkdir(parents=True, exist_ok=True)
BUL_LO, BUL_HI = 0xE18C, 0xE18F

# (json, code, c, s, subject_tag, layout)  layout: 'cloze'(英文4欄/1欄) | '2col'(法學2欄)
JOBS = [
    ('questions-customs.json',  '107050', '101', '0312', 'law_knowledge', '2col'),
    ('questions-customs.json',  '105050', '101', '0202', 'english',       'cloze'),
]
PROBE_S = ['0312', '0605', '0606', '0506', '0202', '0203', '0204', '0201', '0103', '0102',
           '0902', '0904', '0803', '0301', '0401', '0501', '0601']


def fetch(t, code, c, s):
    f = TMP / f'{t}_{code}_{c}_{s}.pdf'
    if not (f.exists() and f.stat().st_size > 1000):
        u = f'{BASE}?t={t}&code={code}&c={c}&s={s}&q=1'
        try:
            data = urllib.request.urlopen(urllib.request.Request(u, headers={'User-Agent': 'Mozilla/5.0'}), timeout=40).read()
        except Exception:
            return None
        if data[:4] != b'%PDF':
            return None
        f.write_bytes(data)
    return f


def is_bul(t): return len(t) == 1 and BUL_LO <= ord(t[0]) <= BUL_HI


def join_words(ws):
    ws = sorted(ws, key=lambda w: w[0]); out = ''
    for i, w in enumerate(ws):
        if i and (w[0] - ws[i - 1][2]) > 2: out += ' '
        out += w[4]
    return out.strip()


def join_rows(ws):
    rows = {}
    for w in ws: rows.setdefault(round(w[1] / 3), []).append(w)
    return ' '.join(join_words(rows[k]) for k in sorted(rows))


def parse_questions(pdf, maxq=60):
    doc = fitz.open(pdf); res = {}
    for pg in doc:
        words = [w for w in pg.get_text('words') if w[4].strip()]
        bl = [w for w in words if is_bul(w[4])]
        qn = sorted([(int(w[4]), w[1]) for w in words
                     if re.fullmatch(r'\d{1,2}', w[4]) and 1 <= int(w[4]) <= maxq and w[0] < 58], key=lambda t: t[1])
        seq = []; last = -1
        for n, y in qn:
            if n > last: seq.append((n, y)); last = n
        for k, (n, y0) in enumerate(seq):
            y1 = seq[k + 1][1] if k + 1 < len(seq) else 1e9
            qb = [w for w in bl if y0 <= w[1] < y1]
            if len(qb) < 4: continue
            qb = sorted(qb, key=lambda w: (round(w[1] / 3), w[0]))[:4]
            opts = {}
            for bi, b in enumerate(qb):
                bx, by = b[0], b[1]
                same = [w[0] for w in qb if abs(w[1] - by) < 3 and w[0] > bx]
                xend = min(same) if same else 1e9
                cell = [w for w in words if abs(w[1] - by) < 3.5 and bx < w[0] < xend and not is_bul(w[4])]
                opts['ABCD'[bi]] = join_words(cell)
            fby = min(w[1] for w in qb)
            sw = [w for w in words if y0 - 1 <= w[1] < fby - 2 and not re.fullmatch(r'\d{1,2}', w[4]) and not is_bul(w[4])]
            res[n] = {'stem': re.sub(r'\s+', ' ', join_rows(sw)).strip(), 'opts': opts}
    return res


def parse_2col(pdf, maxq=60):
    """2欄×2列版型（法學長選項）：依選項文字位置列主序 A=左上 B=右上 C=左下 D=右下。"""
    doc = fitz.open(pdf); res = {}
    for pg in doc:
        words = [w for w in pg.get_text('words') if w[4].strip()]
        qn = sorted([(int(w[4]), w[1]) for w in words
                     if re.fullmatch(r'\d{1,2}', w[4]) and 1 <= int(w[4]) <= maxq and w[0] < 58], key=lambda t: t[1])
        seq = []; last = -1
        for n, y in qn:
            if n > last: seq.append((n, y)); last = n
        for k, (n, y0) in enumerate(seq):
            y1 = seq[k + 1][1] if k + 1 < len(seq) else 1e9
            region = [w for w in words if y0 <= w[1] < y1 and not is_bul(w[4])
                      and not (re.fullmatch(r'\d{1,2}', w[4]) and w[0] < 58)]
            rows = {}
            for w in region: rows.setdefault(round(w[1] / 3), []).append(w)
            # 選項列：同列同時有左欄(x<150)與右欄(305<x<365)起始字
            optrows = [kk for kk in sorted(rows)
                       if any(w[0] < 150 for w in rows[kk]) and any(305 < w[0] < 365 for w in rows[kk])]
            if len(optrows) < 2: continue
            r1, r2 = optrows[0], optrows[1]
            cell = lambda rw, lo, hi: join_words([w for w in rw if lo <= w[0] < hi])
            opts = {'A': cell(rows[r1], 55, 300), 'B': cell(rows[r1], 300, 480),
                    'C': cell(rows[r2], 55, 300), 'D': cell(rows[r2], 300, 480)}
            sw = [w for w in region if round(w[1] / 3) < r1]
            res[n] = {'stem': re.sub(r'\s+', ' ', join_rows(sw)).strip(), 'opts': opts}
    return res


def parse_answers(pdf):
    pg = fitz.open(pdf)[0]; words = pg.get_text('words')
    labels = []; letters = []
    for w in words:
        m = re.fullmatch(r'第(\d+)題', w[4])
        if m: labels.append((int(m.group(1)), w[0], w[1]))
        elif re.fullmatch(r'[ABCD#]', w[4]): letters.append((w[4], w[0], w[1]))
    ans = {}
    for n, lx, ly in labels:
        best = None; bd = 1e9
        for L, x, y in letters:
            if 5 < (y - ly) < 28 and abs(x - lx) < 22:
                d = abs(x - lx) + (y - ly)
                if d < bd: bd = d; best = L
        if best is not None: ans[n] = None if best == '#' else best
    return ans


def probe_s(code, c, tag):
    for s in PROBE_S:
        qf = fetch('Q', code, c, s)
        if not qf: continue
        t = fitz.open(qf)[0].get_text()
        if any(BUL_LO <= ord(ch) <= BUL_HI for ch in t):
            # 確認該卷確有 PUA bullet（即此版型）
            return s
    return None


norm = lambda s: re.sub(r'[^a-z0-9一-鿿]', '', (s or '').lower())


def main():
    apply = '--apply' in sys.argv
    only = None
    if '--only' in sys.argv: only = sys.argv[sys.argv.index('--only') + 1]
    grand_fix = grand_change = 0
    cache = {}
    for jf, code, c, s, tag, layout in JOBS:
        if only and code != only: continue
        if s == 'probe':
            s = probe_s(code, c, tag)
            if not s: print(f'⚠ {code}/{tag}: probe s 失敗'); continue
        qf = fetch('Q', code, c, s); af = fetch('S', code, c, s)
        if not qf or not af: print(f'⚠ {code} c={c} s={s}: PDF 失敗'); continue
        q = (parse_2col(qf) if layout == '2col' else parse_questions(qf)); a = parse_answers(af)
        if jf not in cache:
            cache[jf] = json.load(open(jf, encoding='utf-8'))
        d = cache[jf]; qs = d if isinstance(d, list) else d.get('questions', d)
        fixed = changed = skip = 0
        def walk(o):
            nonlocal fixed, changed, skip
            if isinstance(o, list):
                [walk(x) for x in o]
            elif isinstance(o, dict):
                if o.get('exam_code') == code and o.get('subject_tag') == tag and isinstance(o.get('options'), dict):
                    vals = list(o['options'].values())
                    broken = any(isinstance(v, str) and v and BUL_LO <= ord(v[0]) <= BUL_HI
                                 and not v.lstrip(''.join(chr(x) for x in range(BUL_LO, BUL_HI + 1)) + ' 　').strip() for v in vals)
                    if not broken: return
                    n = o.get('number'); pq = q.get(n)
                    # cloze 才做 options-only 救援（2col 法學選項長易誤判，維持嚴格 stem 驗證）
                    clean4 = pq and all(pq['opts'].get(k) for k in 'ABCD') and (layout != 'cloze' and True or len(set(pq['opts'].values())) == 4)
                    if not pq or not all(pq['opts'].get(k) for k in 'ABCD') or not clean4:
                        skip += 1; return
                    op = norm(o.get('question', '')); pp = norm(pq['stem'])
                    stem_ok = pp and (op.startswith(pp[:24]) or pp.startswith(op[:24]))
                    if not stem_ok and layout != 'cloze':
                        skip += 1; return                 # 法學非 cloze：stem 不符就跳過
                    off = a.get(n)
                    if off and off != o.get('answer'):
                        changed += 1
                    if apply:
                        o['options'] = dict(pq['opts'])
                        if stem_ok:
                            o['question'] = pq['stem']
                        if off:
                            o['answer'] = off
                    fixed += 1
                else:
                    for v in o.values(): walk(v)
        def nonlocal_change():
            nonlocal changed; changed += 1
        walk(qs)
        print(f'{jf.replace("questions-","").replace(".json",""):10} {tag:14} code={code} s={s}: 修 {fixed} (答案變 {changed}) 跳過 {skip}')
        grand_fix += fixed; grand_change += changed
    if apply:
        for jf, d in cache.items():
            json.dump(d, open(jf, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
        print(f'\n✅ 已套用，共修 {grand_fix} 題（答案修正 {grand_change}）')
    else:
        print(f'\n(dry) 預計修 {grand_fix} 題（答案變 {grand_change}）')


if __name__ == '__main__':
    main()

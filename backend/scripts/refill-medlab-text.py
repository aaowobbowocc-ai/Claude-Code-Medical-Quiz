"""
medlab 題幹/選項截斷修復——座標式逐字重抽。

問題：medlab 爬蟲解析 PDF 時，每行被 fitz 拆成多個 x 片段，原 scraper 只取第一片 → 題幹/選項截斷。
修法：把同一 y 的片段按 x 接合（去重疊），重建逐字題幹/選項；JSON 若是重抽結果的「前綴」(截斷) 就替換。
安全：只在「重抽完整(4 選項) 且 JSON 為其前綴」時替換；答案不動；抽不全的題跳過。零成本。

用法：
  python scripts/refill-medlab-text.py --year 112 --dry
  python scripts/refill-medlab-text.py --apply
"""
import argparse, importlib.util, json, re, sys
from pathlib import Path
import fitz

sys.stdout.reconfigure(encoding='utf-8', errors='replace')
BASE = Path(__file__).resolve().parent.parent
_spec = importlib.util.spec_from_file_location('m', Path(__file__).parent / 'audit-medlab.py')
M = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(M)


def join_pieces(texts):
    out = texts[0] if texts else ''
    for nxt in texts[1:]:
        ov = 0
        mx = min(len(out), len(nxt), 12)
        for k in range(mx, 0, -1):
            if out[-k:] == nxt[:k]:
                ov = k; break
        out += nxt[ov:]
    return out


def extract(pdf_path):
    """單欄座標接合：回傳 {n: {'q':.., 'opts':{A..D}}}（含 PUA bullet 與字母標記）。"""
    doc = fitz.open(pdf_path)
    questions = {}
    for pg in doc:
        words = [w for w in pg.get_text('words') if w[4].strip()]
        rows = {}
        for w in words:
            rows.setdefault(round(w[1] / 3.0), []).append(w)
        lines = []
        for key in sorted(rows):
            ws = sorted(rows[key], key=lambda w: w[0])
            lines.append(join_pieces([w[4] for w in ws]))
        cur = None; field = None
        for txt in lines:
            # PUA bullet → 轉成字母標記
            for i in range(4):
                txt = txt.replace(chr(0xe18c + i), '\n' + 'ABCD'[i] + '.')
            for seg in txt.split('\n'):
                seg = seg.strip()
                if not seg:
                    continue
                mq = re.match(r'^(\d{1,3})[.．]\s*(.*)$', seg)
                mo = re.match(r'^([A-D])[.．]\s*(.*)$', seg)
                if mq and 1 <= int(mq.group(1)) <= 100 and (cur is None or int(mq.group(1)) == cur + 1):
                    cur = int(mq.group(1)); questions[cur] = {'q': mq.group(2), 'opts': {}}; field = 'q'; continue
                if mo and cur and mo.group(1) not in questions[cur]['opts']:
                    questions[cur]['opts'][mo.group(1)] = mo.group(2); field = mo.group(1); continue
                if cur:
                    if field == 'q':
                        questions[cur]['q'] += seg
                    elif field in 'ABCD':
                        questions[cur]['opts'][field] += seg
    out = {}
    for n, q in questions.items():
        out[n] = {'q': re.sub(r'\s+', ' ', q['q']).strip(),
                  'opts': {k: re.sub(r'\s+', ' ', v).strip() for k, v in q['opts'].items()}}
    return out


def norm(s):
    return re.sub(r'\s+', '', s or '')


def is_truncated_prefix(jtxt, etxt):
    """JSON 文字是重抽文字的前綴且更短 → 截斷。允許結尾 1-2 字差異。"""
    j, e = norm(jtxt), norm(etxt)
    if not j or not e or len(e) <= len(j):
        return False
    return e.startswith(j) or e.startswith(j[:-1]) or e.startswith(j[:-2])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--year'); ap.add_argument('--apply', action='store_true'); ap.add_argument('--dry', action='store_true')
    args = ap.parse_args()
    apply = args.apply and not args.dry

    data = json.load(open(BASE / 'questions-medlab.json', encoding='utf-8'))
    qs_all = data if isinstance(data, list) else data['questions']
    papers = {}
    for q in qs_all:
        papers[(q.get('roc_year'), q.get('session'))] = q.get('exam_code')
    items = sorted(papers.items())
    if args.year:
        items = [it for it in items if it[0][0] == args.year]

    total_stem = total_opt = 0
    for (year, session), code in items:
        c, mapping = M.discover(year, session, code)
        if not c:
            continue
        for subject, s in mapping.items():
            qb = M.fetch('Q', code, c, s)
            if not qb:
                continue
            ext = extract(M.TMP / f'Q_{code}_c{c}_s{s}.pdf')
            cur = M.load_medlab_current(data, year, session, subject)
            ns = ts = 0
            for n, cq in cur.items():
                e = ext.get(n)
                if not e or len(e['opts']) != 4 or not all(e['opts'].get(k) for k in 'ABCD'):
                    continue
                # 確認同題：JSON 題幹是重抽題幹的前綴（或高度相符）
                if not (is_truncated_prefix(cq.get('question', ''), e['q']) or norm(cq.get('question', '')) == norm(e['q'])):
                    # 題幹不符 → 不動（避免換錯題）
                    if not norm(e['q']).startswith(norm(cq.get('question', ''))[:12]):
                        continue
                # 修題幹
                if is_truncated_prefix(cq.get('question', ''), e['q']):
                    if apply:
                        cq['question'] = e['q']
                    ns += 1
                # 修選項
                for k in 'ABCD':
                    if is_truncated_prefix(cq['options'].get(k, ''), e['opts'][k]):
                        if apply:
                            cq['options'][k] = e['opts'][k]
                        ts += 1
            if ns or ts:
                print(f'  {year}-{session} {subject[:8]} (s={s}): 題幹{ns} 選項{ts}')
            total_stem += ns; total_opt += ts

    if apply:
        json.dump(data, open(BASE / 'questions-medlab.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
        print(f'\n✅ 已寫入：修題幹 {total_stem}、修選項 {total_opt}')
    else:
        print(f'\n(dry) 預計修題幹 {total_stem}、修選項 {total_opt}')


if __name__ == '__main__':
    main()

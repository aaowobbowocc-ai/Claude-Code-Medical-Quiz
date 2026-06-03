"""
醫事檢驗師（medlab）答案校正——用座標式答案解析（同 audit-paper.py 的修正版）。

medlab 題號跟官方對齊（不需 realign），只需 audit 答案。
參數逐年變：100/101 用 c=104(舊 s=01XX)，102~104-1 用 c=311，104-2~ 用 c=308（s=11-66）。
本工具自動探測 c、讀「科目名稱」對應 s，省去硬寫對照。

成本：0（純文字 PDF + 座標解析，無 API）

用法：
  python scripts/audit-medlab.py --dry            # 全部 dry，看錯誤率
  python scripts/audit-medlab.py --apply          # 套用
  python scripts/audit-medlab.py --year 112 --dry # 只跑某年
"""
import argparse, importlib.util, json, re, sys, urllib.request, ssl
from collections import Counter, defaultdict
from difflib import SequenceMatcher
from pathlib import Path

sys.stdout.reconfigure(encoding='utf-8', errors='replace')
ssl._create_default_https_context = ssl._create_unverified_context
BASE = Path(__file__).resolve().parent.parent
TMP = BASE / '_tmp' / 'medlab-audit'
TMP.mkdir(parents=True, exist_ok=True)
URL = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'

_spec = importlib.util.spec_from_file_location('ap', Path(__file__).parent / 'audit-paper.py')
ap = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(ap)

SUBJECTS = ['臨床生理學與病理學', '臨床血液學與血庫學', '醫學分子檢驗學與臨床鏡檢學',
            '微生物學與臨床微生物學', '生物化學與臨床生化學', '臨床血清免疫學與臨床病毒學']


def fetch(t, code, c, s):
    f = TMP / f'{t}_{code}_c{c}_s{s}.pdf'
    if f.exists() and f.stat().st_size > 1000:
        return f.read_bytes()
    try:
        data = urllib.request.urlopen(urllib.request.Request(
            f'{URL}?t={t}&code={code}&c={c}&s={s}&q=1', headers={'User-Agent': 'Mozilla/5.0'}), timeout=40).read()
    except Exception:
        return None
    if data[:4] != b'%PDF':
        return None
    f.write_bytes(data)
    return data


def subject_of(pdf_bytes):
    import fitz
    t = fitz.open(stream=pdf_bytes, filetype='pdf')[0].get_text()
    if '並不存在' in t:
        return None
    import unicodedata
    m = re.search(r'科\s*目\s*(?:名\s*稱)?\s*[：:]\s*([^\n（(]{4,30})', t)
    if not m:
        return None
    name = unicodedata.normalize('NFKC', m.group(1).strip())  # 舊卷用 CJK 相容字元
    for sub in SUBJECTS:
        if name.startswith(sub[:6]) or sub[:6] in name:
            return sub
    return None


CONV = {SUBJECTS[i]: str(i + 1) * 2 for i in range(6)}  # 生理:11 血液:22 分子:33 微生物:44 生化:55 血清:66


OLD_S = {  # c=104(100/101) 舊格式可靠對映（分子/微生物 s 不規則，暫缺）
    '臨床生理學與病理學': '0107', '臨床血液學與血庫學': '0301',
    '生物化學與臨床生化學': '0304', '臨床血清免疫學與臨床病毒學': '0305',
}


def get_daihao(q_pdf_path):
    import fitz, unicodedata
    t = unicodedata.normalize('NFKC', fitz.open(q_pdf_path)[0].get_text())
    m = re.search(r'代\s*號\s*[：:]\s*(\d{3,4})', t)
    return m.group(1) if m else None


def parse_answers_old(a_pdf_path, daihao, nq=80):
    """舊格式答案卷（12 頁合卷、科目名變體字）：用『代號』數字當錨點，
    取代號到下一個四位代號之間的答案列，按 x 對齊題段。"""
    import fitz, statistics
    if not daihao:
        return None
    doc = fitz.open(a_pdf_path)
    for pg in doc:
        words = pg.get_text('words')
        codes = [w for w in words if w[4] == daihao]
        if not codes:
            continue
        cy = codes[0][1]
        nexts = [w[1] for w in words if re.fullmatch(r'\d{4}', w[4]) and w[1] > cy + 5]
        yend = min(nexts) if nexts else cy + 400
        hdr = {}
        for w in words:
            if re.fullmatch(r'(01|11|21|31|41|51|61|71|81|91)', w[4]) and cy < w[1] < yend + 30:
                hdr.setdefault((int(w[4]) - 1) // 10, []).append(w[0])
        if len(hdr) < 6:
            continue
        colx = {i: statistics.median(xs) for i, xs in hdr.items()}
        rows = [w for w in words if re.fullmatch(r'[ABCD#]{10}', w[4]) and cy < w[1] < yend]
        ans = {}
        for w in rows:
            ci = min(colx, key=lambda i: abs(w[0] - colx[i]))
            for j, ch in enumerate(w[4]):
                ans[ci * 10 + j + 1] = None if ch == '#' else ch
        if len([v for v in ans.values() if v]) >= 10:
            return ans
    return None


def resolve_c(year, session):
    """依年份/場次決定 classCode（依資料實證的規律）。"""
    y = int(year)
    if y <= 101:
        return '104'                       # 舊格式（s=01XX、變體字答案卷）
    if y >= 105 or (y == 104 and session == '第二次'):
        return '308'
    return '311'                            # 102、103、104-第一次


def discover(year, session, code):
    """回傳 (c, {subject: s})。308/311 用固定 11-66；104 逐一探測。"""
    c = resolve_c(year, session)
    if c in ('308', '311'):
        return c, dict(CONV)
    # c=104 舊格式：用已知可靠對映（讀科目名稱驗證；分子/微生物 s 不規則暫缺）
    mapping = {}
    for sub, s in OLD_S.items():
        d = fetch('Q', code, c, s)
        if d and subject_of(d) == sub:
            mapping[sub] = s
    return (c, mapping) if mapping else (None, {})


def load_medlab_current(data, year, session, subject):
    cur = {}
    def walk(o):
        if isinstance(o, list):
            for x in o: walk(x)
        elif isinstance(o, dict):
            if (o.get('roc_year') == year and o.get('session') == session
                    and o.get('subject') == subject and isinstance(o.get('options'), dict)):
                cur[o.get('number')] = o
            for v in o.values(): walk(v)
    walk(data)
    return cur


def audit_one(data_json, year, session, code, c, subject, s, apply, nq=80):
    qbytes = fetch('Q', code, c, s)
    abytes = fetch('A', code, c, s)
    if not qbytes or not abytes:
        return None
    qpath = TMP / f'Q_{code}_c{c}_s{s}.pdf'
    apath = TMP / f'A_{code}_c{c}_s{s}.pdf'
    qs = ap.parse_questions(qpath)
    if c == '104':
        ans = parse_answers_old(apath, get_daihao(qpath), nq)
    else:
        ans = ap.parse_answers_for_subject(apath, subject)
    if not ans:
        return ('NO_ANS', 0, 0)
    cur = load_medlab_current(data_json, year, session, subject)
    if not cur:
        return ('NO_JSON', 0, 0)
    # medlab 題號與選項順序都跟官方對齊，但 JSON 選項文字是改寫過的（跟 PDF 措辭不同），
    # 所以 text-match 不可靠（會假陽性）。改用「純字母比對」：官方答案字母 off vs 現答案，
    # 不同才改。pdf_correct 文字只用來寫 explanation（盡量取，取不到就不寫文字）。
    fixes = []
    issues = Counter()
    for n in range(1, nq + 1):
        official = ans.get(n)
        if official is None:
            continue  # 送分，跳過
        if n not in cur:
            issues['NOT_IN_JSON'] += 1; continue
        cq = cur[n]
        if official != cq['answer']:
            q = qs.get(n, {})
            # 題幹 guard：JSON 題幹須與官方該題題幹相符才改（避免改到誤分類/錯位題，
            # 例如 DLCO 題被誤歸到血液 #27 而與官方嗜酸性球題撞號）。
            stem_sim = SequenceMatcher(None, ap.norm(q.get('q', '')), ap.norm(cq.get('question', ''))).ratio()
            if stem_sim < 0.55:
                issues['STEM_MISMATCH'] += 1; continue
            pdf_correct = q['opts'][ord(official) - 65] if len(q.get('opts', [])) == 4 else ''
            fixes.append((cq, official, pdf_correct))
            issues['ANSWER_WRONG'] += 1
    if apply:
        for cq, off, pdf_correct in fixes:
            cq['answer'] = off
            cq['disputed'] = True
            tail = f'（{pdf_correct.strip()[:70]}）' if pdf_correct else ''
            cq['explanation'] = f'依考選部官方答案,本題正解為 {off}{tail}。原答案標註錯誤,已修正。'
    return (dict(issues), len(fixes), len(cur))


def main():
    apx = argparse.ArgumentParser()
    apx.add_argument('--year'); apx.add_argument('--apply', action='store_true'); apx.add_argument('--dry', action='store_true')
    args = apx.parse_args()
    apply = args.apply and not args.dry

    data = json.load(open(BASE / 'questions-medlab.json', encoding='utf-8'))
    qs_all = data if isinstance(data, list) else data['questions']
    # distinct (year, session, code)
    papers = {}
    for q in qs_all:
        papers[(q.get('roc_year'), q.get('session'))] = q.get('exam_code')
    items = sorted(papers.items())
    if args.year:
        items = [it for it in items if it[0][0] == args.year]

    total_fix = 0
    for (year, session), code in items:
        c, mapping = discover(year, session, code)
        if not c:
            print(f'⚠ {year}-{session} code={code}: 無法探測參數'); continue
        print(f'\n══ {year}-{session} code={code} c={c} ══')
        for subject in SUBJECTS:
            s = mapping.get(subject)
            if not s:
                print(f'  {subject[:8]}: 找不到 s'); continue
            r = audit_one(data, year, session, code, c, subject, s, apply)
            if r is None:
                print(f'  {subject[:8]} (s={s}): PDF 失敗'); continue
            issues, nfix, ncur = r
            total_fix += nfix
            print(f'  {subject[:8]} (s={s}): JSON={ncur} {issues}')

    if apply:
        json.dump(data, open(BASE / 'questions-medlab.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
        print(f'\n✅ 已寫入，共修正 {total_fix} 題')
    else:
        print(f'\n(dry) 預計修正 {total_fix} 題')


if __name__ == '__main__':
    main()

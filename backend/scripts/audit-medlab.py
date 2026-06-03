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
    # c=104 舊格式：逐一探測 s（讀科目名稱對應）
    mapping = {}
    for s in ['0107', '0207', '0301', '0302', '0401', '0402', '0501', '0502',
              '0601', '0602', '0102', '0103', '0104', '0105', '0106', '0201', '0202']:
        d = fetch('Q', code, c, s)
        if not d:
            continue
        sub = subject_of(d)
        if sub and sub not in mapping:
            mapping[sub] = s
    return (c, mapping) if len(mapping) >= 5 else (None, {})


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
    ans = ap.parse_answers_for_subject(apath, subject)
    if not ans:
        return ('NO_ANS', 0, 0)
    cur = load_medlab_current(data_json, year, session, subject)
    if not cur:
        return ('NO_JSON', 0, 0)
    fixes = []
    issues = Counter()
    for n in range(1, nq + 1):
        official = ans.get(n)
        if official is None:
            continue
        q = qs.get(n, {})
        if len(q.get('opts', [])) != 4:
            issues['PDF_PARSE_FAIL'] += 1; continue
        if n not in cur:
            issues['NOT_IN_JSON'] += 1; continue
        pdf_correct = q['opts'][ord(official) - 65]
        cq = cur[n]
        sims = [(k, SequenceMatcher(None, ap.norm(pdf_correct), ap.norm(cq['options'][k])).ratio()) for k in 'ABCD']
        bk, bs = max(sims, key=lambda x: x[1])
        if bs < 0.5:
            issues['OPT_MISSING'] += 1; continue
        if bk != cq['answer']:
            fixes.append((cq, bk, pdf_correct))
            issues['ANSWER_WRONG'] += 1
    if apply:
        for cq, bk, pdf_correct in fixes:
            cq['answer'] = bk
            cq['disputed'] = True
            cq['explanation'] = f'依考選部官方答案,本題正解為 {bk} ({pdf_correct.strip()[:70]})。原答案標註錯誤,已修正。'
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

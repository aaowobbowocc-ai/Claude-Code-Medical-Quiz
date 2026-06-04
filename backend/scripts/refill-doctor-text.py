"""
醫師一階/二階（doctor1/doctor2）題幹/選項截斷修復——座標式逐字重抽。
同 refill-medlab-text.py 的手法：同一行片段按 x 接合去重疊重建完整文字，
JSON 若為重抽結果的「前綴」(截斷) 才替換，答案不動。prefix 安全機制只補全不改錯。

用法：
  python scripts/refill-doctor-text.py --exam doctor1 --dry
  python scripts/refill-doctor-text.py --exam doctor1 --apply
  python scripts/refill-doctor-text.py --exam doctor2 --apply
"""
import argparse, importlib.util, json, sys
from pathlib import Path

sys.stdout.reconfigure(encoding='utf-8', errors='replace')
BASE = Path(__file__).resolve().parent.parent
SCR = Path(__file__).parent
_ap = importlib.util.spec_from_file_location('ap', SCR / 'audit-paper.py')
AP = importlib.util.module_from_spec(_ap); _ap.loader.exec_module(AP)
_rf = importlib.util.spec_from_file_location('rf', SCR / 'refill-medlab-text.py')
RF = importlib.util.module_from_spec(_rf); _rf.loader.exec_module(RF)

extract = RF.extract
is_trunc = RF.is_truncated_prefix
norm = RF.norm
TMP = BASE / '_tmp' / 'audit-sweep'
URL = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'

# doctor1 批次（沿用 audit-paper DOCTOR1_BATCH）：(year, session, code, subject, s, c)
DOCTOR1 = AP.DOCTOR1_BATCH
# doctor2（醫師二階）：醫學三~六。c/s 同 doctor1 規律（104-2+ 改 c=301、s=55..），其餘 c=101 s=01XX。
# 用 (year, session) → (code, c, [(subject,s)...]) 由 doctor1 推得同年同次 code，s 偏移。
DOCTOR2_SUBJ = ['醫學(三)', '醫學(四)', '醫學(五)', '醫學(六)']


def fetch(code, c, s):
    paper_dir = TMP / f'{code}-{s}'
    q_pdf = paper_dir / 'q.pdf'
    AP.fetch_pdf(f'{URL}?t=Q&code={code}&c={c}&s={s}&q=1', q_pdf)
    return q_pdf


def doctor2_jobs(data):
    # 從資料取 (year,session)→code，配 doctor1 同年同次的 c 規律
    papers = {}
    for q in (data if isinstance(data, list) else data['questions']):
        papers[(q.get('roc_year'), q.get('session'))] = q.get('exam_code')
    # c/s 規律：104-2 起 c=301、s=33/44/55/66（醫學三四五六）；其餘 c=101、s=0103/0104/0105/0106
    jobs = []
    for (y, ses), code in sorted(papers.items()):
        yi = int(y)
        if yi >= 105 or (yi == 104 and ses == '第二次'):
            c = '302'; ss = ['11', '22', '33', '44']   # 醫學三四五六
        else:
            c = '102'; ss = ['0103', '0104', '0105', '0106']
        for subj, s in zip(DOCTOR2_SUBJ, ss):
            jobs.append((y, ses, code, subj, s, c))
    return jobs


def run(exam, data, apply):
    if exam == 'doctor1':
        jobs = [(y, ses, code, subj, s, c) for (y, ses, code, subj, s, c) in DOCTOR1]
    else:
        jobs = doctor2_jobs(data)
    total_stem = total_opt = 0
    for (y, ses, code, subj, s, c) in jobs:
        try:
            q_pdf = fetch(code, c, s)
            ext = extract(q_pdf)
        except Exception as e:
            print(f'  ⚠ {y}-{ses} {subj} (c={c} s={s}): {e}'); continue
        cur = AP.load_current(y, ses, subj) if exam == 'doctor1' else load_current_doctor2(data, y, ses, subj)
        ns = ts = 0
        for n, cq in cur.items():
            e = ext.get(n)
            if not e or len(e['opts']) != 4 or not all(e['opts'].get(k) for k in 'ABCD'):
                continue
            jq = cq.get('question', '')
            if not (is_trunc(jq, e['q']) or norm(jq) == norm(e['q']) or norm(e['q']).startswith(norm(jq)[:12])):
                continue
            if is_trunc(jq, e['q']):
                if apply: cq['question'] = e['q']
                ns += 1
            for k in 'ABCD':
                if is_trunc(cq['options'].get(k, ''), e['opts'][k]):
                    if apply: cq['options'][k] = e['opts'][k]
                    ts += 1
        if ns or ts:
            print(f'  {y}-{ses} {subj} (s={s}): 題幹{ns} 選項{ts}')
        total_stem += ns; total_opt += ts
    return total_stem, total_opt


def load_current_doctor2(data, year, session, subject):
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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--exam', choices=['doctor1', 'doctor2'], required=True)
    ap.add_argument('--apply', action='store_true'); ap.add_argument('--dry', action='store_true')
    args = ap.parse_args()
    apply = args.apply and not args.dry
    fn = 'questions.json' if args.exam == 'doctor1' else 'questions-doctor2.json'
    data = json.load(open(BASE / fn, encoding='utf-8'))
    ts, to = run(args.exam, data, apply)
    if apply:
        json.dump(data, open(BASE / fn, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
        print(f'\n✅ 已寫入 {fn}：修題幹 {ts}、修選項 {to}')
    else:
        print(f'\n(dry) {fn} 預計修題幹 {ts}、修選項 {to}')


if __name__ == '__main__':
    main()

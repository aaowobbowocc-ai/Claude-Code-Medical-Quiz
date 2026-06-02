"""
醫師一階 101-105 題號/科目 re-aligner。

問題：101 年起 questions.json 的題號與科目（醫學一/二）跟官方 PDF 嚴重錯位，
      逐題 audit 無效。但內容齊全（合併兩科目 200 題池子可 96-98% 高信心對回官方 PDF）。

做法：解析官方 PDF（醫學一 s=0101、醫學二 s=0102 各 100 題，正確順序）→
      用「選項+題幹」相似度，把 JSON 池子裡的題目 1:1 對回官方題目（greedy 全域指派）→
      修正每題的 number 與 subject。對齊後再跑 audit-paper.py --apply 修答案。

成本：0（純文字比對，無 API）

用法：
  python scripts/realign-paper.py --year 101 --session 第一次 --code 101030          # dry
  python scripts/realign-paper.py --year 101 --session 第一次 --code 101030 --apply
  python scripts/realign-paper.py --batch doctor1 [--apply]

安全：
  - 只在高信心（>=THRESH）才改 number/subject；低信心列為 UNMATCHED 供人工審，不動。
  - 全域 greedy 1:1，避免兩題搶同一個官方題。
  - 不動 options/answer/subject_tag/subject_name（answer 交給 audit 後處理）。
"""
import argparse
import importlib.util
import json
import sys
from difflib import SequenceMatcher
from pathlib import Path

sys.stdout.reconfigure(encoding='utf-8', errors='replace')
BASE = Path(__file__).resolve().parent.parent

# 借用 audit-paper.py 的 PDF 解析
_spec = importlib.util.spec_from_file_location('ap', Path(__file__).parent / 'audit-paper.py')
ap = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(ap)

THRESH = 0.85   # 對齊信心門檻
TMP = BASE / '_tmp' / 'audit-sweep'

BATCH = [
    ('101', '第一次', '101030'), ('101', '第二次', '101110'),
    ('102', '第一次', '102030'), ('102', '第二次', '102110'),
    ('103', '第一次', '103030'), ('103', '第二次', '103100'),
    ('104', '第一次', '104030'), ('104', '第二次', '104090'),
    ('105', '第一次', '105020'), ('105', '第二次', '105100'),
]


def norm(s):
    return ap.norm(s or '')


def opt_sig(opts):
    return norm(''.join(opts))


def score(pdf_q, jq):
    """pdf_q: {'q':stem,'opts':[..]}  jq: JSON dict"""
    jopts = [jq['options'][k] for k in 'ABCD']
    osim = SequenceMatcher(None, opt_sig(pdf_q['opts']), opt_sig(jopts)).ratio()
    ssim = SequenceMatcher(None, norm(pdf_q.get('q', '')), norm(jq.get('question', ''))).ratio()
    return 0.7 * osim + 0.3 * ssim


def fetch_and_parse(code, s_param):
    paper_dir = TMP / f'{code}-{s_param}'
    q_pdf = paper_dir / 'q.pdf'
    ap.fetch_pdf(f'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx?t=Q&code={code}&c=101&s={s_param}&q=1', q_pdf)
    return ap.parse_questions(q_pdf)


def collect_pool(data, year, session):
    pool = []
    def walk(o):
        if isinstance(o, list):
            for x in o: walk(x)
        elif isinstance(o, dict):
            if (o.get('roc_year') == year and o.get('session') == session
                    and isinstance(o.get('options'), dict)
                    and str(o.get('subject', '')).startswith('醫學')):
                pool.append(o)
            for v in o.values(): walk(v)
    walk(data)
    return pool


def realign(year, session, code, data, apply=False):
    print(f'\n══ {year}-{session} (code={code}) ══')
    pool = collect_pool(data, year, session)
    before = {}
    for q in pool:
        before[q.get('subject')] = before.get(q.get('subject'), 0) + 1
    print(f'  JSON pool={len(pool)}  current split={before}')

    # 建立官方目標 (subject, number, parsed)
    targets = []
    for s_param, subj in [('0101', '醫學(一)'), ('0102', '醫學(二)')]:
        qs = fetch_and_parse(code, s_param)
        for n in range(1, 101):
            pq = qs.get(n, {})
            if len(pq.get('opts', [])) == 4:
                targets.append({'subject': subj, 'number': n, 'pq': pq})

    # 全域 greedy：算所有 (target, poolq) 分數，由高到低指派，1:1
    pairs = []
    for ti, t in enumerate(targets):
        for pi, jq in enumerate(pool):
            sc = score(t['pq'], jq)
            if sc >= 0.5:
                pairs.append((sc, ti, pi))
    pairs.sort(reverse=True)

    t_used = [False] * len(targets)
    p_used = [False] * len(pool)
    assign = {}  # ti -> (pi, score)
    for sc, ti, pi in pairs:
        if t_used[ti] or p_used[pi]:
            continue
        t_used[ti] = True; p_used[pi] = True
        assign[ti] = (pi, sc)

    # 補空位：PDF 某題解析失敗 → 該官方 (subject, number) 沒有 target。
    # 把「多餘未指派」的 pool 題，依現有 subject 填進該科目唯一缺號的空位。
    assigned_slots = {(targets[ti]['subject'], targets[ti]['number']) for ti in assign}
    extra = {}  # pi -> (subject, number)  人工補的空位
    for subj in ('醫學(一)', '醫學(二)'):
        miss = [n for n in range(1, 101) if (subj, n) not in assigned_slots]
        leftover = [pi for pi in range(len(pool))
                    if not p_used[pi] and pool[pi].get('subject') == subj]
        if len(miss) == len(leftover) and miss:
            for n, pi in zip(miss, leftover):
                p_used[pi] = True
                extra[pi] = (subj, n)
    self_extra = extra

    hi = sum(1 for ti, (pi, sc) in assign.items() if sc >= THRESH)
    lo = sum(1 for ti, (pi, sc) in assign.items() if sc < THRESH)
    unmatched_t = [ti for ti in range(len(targets)) if ti not in assign]
    unmatched_p = [pi for pi in range(len(pool)) if not p_used[pi]]
    print(f'  matched high(>={THRESH})={hi}  low={lo}  unmatched_targets={len(unmatched_t)}  unmatched_pool={len(unmatched_p)}')

    # 完整 1:1 指派（含低信心，因 greedy 互斥下這已是最佳唯一候選）。
    low_pairs = [(targets[ti], pool[pi], sc) for ti, (pi, sc) in assign.items() if sc < THRESH]
    changes = []
    for ti, (pi, sc) in assign.items():
        t = targets[ti]; jq = pool[pi]
        if jq.get('number') != t['number'] or jq.get('subject') != t['subject']:
            changes.append((jq, t, sc))

    # 套用後新狀態（含未指派 pool 維持原值）做唯一性驗證
    new_subj = {}   # id(jq) -> subject
    new_num = {}
    for jq in pool:
        new_subj[id(jq)] = jq.get('subject'); new_num[id(jq)] = jq.get('number')
    for ti, (pi, sc) in assign.items():
        jq = pool[pi]; t = targets[ti]
        new_subj[id(jq)] = t['subject']; new_num[id(jq)] = t['number']
    for pi, (subj, n) in self_extra.items():
        jq = pool[pi]
        new_subj[id(jq)] = subj; new_num[id(jq)] = n
    dup = {}
    for jq in pool:
        key = (new_subj[id(jq)], new_num[id(jq)])
        dup[key] = dup.get(key, 0) + 1
    collisions = {k: c for k, c in dup.items() if c > 1}

    print(f'  將修正 number/subject: {len(changes)} 題（其中低信心 {len(low_pairs)} 題）')
    for jq, t, sc in changes[:4]:
        print(f'    [{jq.get("subject")} #{jq.get("number")}] -> [{t["subject"]} #{t["number"]}] sim={sc:.2f}  {jq.get("question","")[:22]}')
    if low_pairs:
        for t, jq, sc in low_pairs:
            print(f'    ⚠ 低信心 sim={sc:.2f} -> [{t["subject"]} #{t["number"]}]  {jq.get("question","")[:30]}')
    for pi, (subj, n) in self_extra.items():
        jq = pool[pi]
        print(f'    ↪ 補空位: [{jq.get("subject")} #{jq.get("number")}] -> [{subj} #{n}] (PDF 該題解析失敗)  {jq.get("question","")[:22]}')
    still_unmatched = [pi for pi in range(len(pool)) if not p_used[pi]]
    if still_unmatched:
        for pi in still_unmatched:
            jq = pool[pi]
            print(f'    ⚠ pool 仍未指派: [{jq.get("subject")} #{jq.get("number")}]  {jq.get("question","")[:30]}')
    if collisions:
        print(f'  ❌ 題號碰撞 {len(collisions)} 處（不可 apply）: {list(collisions)[:6]}')

    if apply:
        if collisions or still_unmatched:
            print('  ⏭ 因碰撞/未指派跳過此卷，未寫入')
            return 0
        for ti, (pi, sc) in assign.items():
            jq = pool[pi]; t = targets[ti]
            jq['number'] = t['number']; jq['subject'] = t['subject']
        for pi, (subj, n) in self_extra.items():
            pool[pi]['number'] = n; pool[pi]['subject'] = subj
        return len(changes) + len(self_extra)
    return 0


def main():
    apx = argparse.ArgumentParser()
    apx.add_argument('--year'); apx.add_argument('--session'); apx.add_argument('--code')
    apx.add_argument('--batch', choices=['doctor1'])
    apx.add_argument('--apply', action='store_true')
    args = apx.parse_args()

    data = json.load(open(BASE / 'questions.json', encoding='utf-8'))
    total = 0
    jobs = BATCH if args.batch == 'doctor1' else [(args.year, args.session, args.code)]
    for (y, s, c) in jobs:
        total += realign(y, s, c, data, apply=args.apply)

    if args.apply:
        json.dump(data, open(BASE / 'questions.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
        print(f'\n✅ 已寫入 questions.json，共修正 {total} 題 number/subject')
    else:
        print('\n(dry-run，未寫入；加 --apply 套用)')


if __name__ == '__main__':
    main()

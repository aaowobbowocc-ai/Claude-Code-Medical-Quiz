"""
通用考選部試題 vs questions.json audit 工具。

用法：
  python scripts/audit-paper.py --year 100 --session 第一次 --code 100030 \
    --subject 醫學(一) --s 0101 --apply

  python scripts/audit-paper.py --batch doctor1 --apply

成本: 0 (純文字 PDF 解析,無 API)
"""
import argparse
import fitz
import json
import re
import sys
import urllib.request
from collections import Counter
from difflib import SequenceMatcher
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
TMP = BASE / '_tmp' / 'audit-sweep'
# 考選部 PDF 的 4 個選項 bullet 是 PUA 字元 U+E18C~U+E18F（A/B/C/D 各一）。
# 用顯式跳脫避免被 cp950 等編碼存檔時吃掉（曾退化成只剩 hyphen 導致 parse 全失敗）。
BULLET_RE = re.compile('[\ue18c-\ue18f]')

# Windows cp950 console 無法輸出 ❌/⚠ 等字元，強制 UTF-8 避免 print 崩潰。
try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass


def norm(s):
    if not s: return ''
    s = re.sub(r'\s+', '', s)
    s = s.replace('（', '(').replace('）', ')').replace('，', ',').replace('。', '.')
    return s.lower()


def similar(a, b):
    return SequenceMatcher(None, norm(a), norm(b)).ratio()


def fetch_pdf(url, out_path):
    if out_path.exists() and out_path.stat().st_size > 1000:
        return
    out_path.parent.mkdir(parents=True, exist_ok=True)
    print(f'[fetch] {url}', file=sys.stderr)
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=60) as r:
        out_path.write_bytes(r.read())


def extract_options(text):
    parts = BULLET_RE.split(text)
    if len(parts) != 5:
        return None, None
    p0, p1, p2, p3, p4 = parts

    p4_clean = p4.strip()
    is_pattern_a = len(p4_clean) < 2

    if is_pattern_a:
        p0_lines = [l.strip() for l in p0.split('\n') if l.strip()]
        if len(p0_lines) < 2:
            return None, None
        opt_a = p0_lines[-1]
        question = ' '.join(p0_lines[:-1])
        return question, [opt_a, p1.strip(), p2.strip(), p3.strip()]

    p0_lines = [l.strip() for l in p0.split('\n') if l.strip()]
    if not p0_lines:
        return None, None
    last_p0 = p0_lines[-1]
    has_q_marker = bool(re.search(r'[?？：:]\s*$', last_p0))

    if has_q_marker or len(p0_lines) == 1:
        question = ' '.join(p0_lines)
        opt_a = p1
    else:
        opt_a = (last_p0 + ' ' + p1.strip()).strip()
        question = ' '.join(p0_lines[:-1])

    opt_b = p2.strip()
    opt_c = p3.strip()
    opt_d = p4.strip()

    if '\n' in p3:
        p3_lines = [l.strip() for l in p3.split('\n') if l.strip()]
        if len(p3_lines) >= 2:
            last_line = p3_lines[-1]
            rest = ' '.join(p3_lines[:-1])
            if len(rest) > 2 and len(last_line) <= 30:
                opt_c = rest
                opt_d = (last_line + ' ' + opt_d).strip()

    def clean(s):
        return re.sub(r'\s+', ' ', s).strip()

    opts = [clean(opt_a), clean(opt_b), clean(opt_c), clean(opt_d)]
    if any(len(o) < 1 for o in opts):
        return None, None
    return clean(question), opts


def parse_questions_letter(full):
    """新版格式（104-2/105 起）：題號 'N.'、選項 'A./B./C./D.' 字母標記，無 PUA bullet。"""
    full = re.sub(r'代\s*號[：:][^\n]*', '', full)
    full = re.sub(r'頁\s*次[：:][^\n]*', '', full)
    out = {}
    cur = None
    field = None
    for ln in full.split('\n'):
        s = ln.strip()
        if not s:
            continue
        mq = re.match(r'^(\d{1,3})[.．]\s*(.*)$', s)
        mo = re.match(r'^([A-D])[.．]\s*(.*)$', s)
        if mq and 1 <= int(mq.group(1)) <= 100 and (cur is None or int(mq.group(1)) == cur + 1):
            cur = int(mq.group(1)); out[cur] = {'q': mq.group(2), 'opts': {}}; field = 'q'; continue
        if mo and cur and mo.group(1) not in out[cur]['opts']:
            out[cur]['opts'][mo.group(1)] = mo.group(2); field = mo.group(1); continue
        if cur:
            if field == 'q':
                out[cur]['q'] += ln
            elif field in 'ABCD':
                out[cur]['opts'][field] += ln
    questions = {}
    for n, q in out.items():
        opts = [re.sub(r'\s+', ' ', q['opts'].get(k, '')).strip() for k in 'ABCD']
        if all(opts) and len(q['opts']) == 4:
            questions[n] = {'q': re.sub(r'\s+', ' ', q['q']).strip(), 'opts': opts}
        else:
            questions[n] = {'q': '', 'opts': []}
    return questions


def parse_questions(pdf_path):
    doc = fitz.open(pdf_path)
    full = ''
    for p in doc:
        full += p.get_text()
    full = re.sub(r'代號[：:]\s*\d+\s*頁次[：:]\s*\d+－\d+', '', full)

    # 格式偵測：有 PUA bullet 走舊解析；否則走字母標記解析。
    if not any(chr(c) in full for c in range(0xe18c, 0xe190)):
        return parse_questions_letter(full)

    lines = full.split('\n')
    blocks = {}
    cur_num = None
    cur = []
    for ln in lines:
        s = ln.strip()
        m = re.fullmatch(r'(\d{1,3})', s)
        if m:
            n = int(m.group(1))
            if 1 <= n <= 100 and (cur_num is None or n == cur_num + 1):
                if cur_num is not None:
                    blocks[cur_num] = '\n'.join(cur)
                cur_num = n
                cur = []
                continue
        cur.append(ln)
    if cur_num is not None:
        blocks[cur_num] = '\n'.join(cur)

    questions = {}
    for n, txt in blocks.items():
        q, opts = extract_options(txt)
        if opts is None:
            questions[n] = {'q': '', 'opts': []}
        else:
            questions[n] = {'q': q, 'opts': opts}
    return questions


def parse_answers_for_subject(ans_pdf, subject):
    """從 answer PDF 找指定 subject 的答案 row。"""
    doc = fitz.open(ans_pdf)
    full = ''
    for p in doc: full += p.get_text() + '\n'

    idx = full.find(f'科目名稱：{subject}')
    if idx < 0:
        # try alt patterns
        idx = full.find(subject)
    if idx < 0:
        return None
    seg = full[idx:idx + 2500]
    answer_strs = re.findall(r'\b([ABCD]{10})\b', seg)
    if len(answer_strs) < 10:
        return None
    answers = {}
    for i, s in enumerate(answer_strs[:10]):
        for j, ch in enumerate(s):
            answers[i*10 + j + 1] = ch
    return answers


def load_current(year, session, subject):
    with open(BASE / 'questions.json', encoding='utf-8') as f:
        data = json.load(f)
    cur = {}
    def walk(o):
        if isinstance(o, list):
            for x in o: walk(x)
        elif isinstance(o, dict):
            if (o.get('roc_year') == year and o.get('session') == session
                    and o.get('subject') == subject):
                cur[o.get('number')] = o
            for v in o.values(): walk(v)
    walk(data)
    return cur


def audit_paper(year, session, code, subject, s_param, apply=False, c_param='101'):
    print(f'\n══ {year}-{session} {subject} (code={code} c={c_param} s={s_param}) ══')
    paper_dir = TMP / f'{code}-{s_param}'
    q_pdf = paper_dir / 'q.pdf'
    a_pdf = paper_dir / 'a.pdf'
    fetch_pdf(f'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx?t=Q&code={code}&c={c_param}&s={s_param}&q=1', q_pdf)
    fetch_pdf(f'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx?t=A&code={code}&c={c_param}&s={s_param}&q=1', a_pdf)

    try:
        qs = parse_questions(q_pdf)
    except Exception as e:
        print(f'  parse fail: {e}')
        return

    ans = parse_answers_for_subject(a_pdf, subject)
    if not ans:
        print(f'  ❌ 找不到 {subject} 答案 row')
        return

    cur = load_current(year, session, subject)
    if not cur:
        print(f'  ⚠ JSON 沒有此卷資料')
        return

    parse_ok = sum(1 for q in qs.values() if len(q.get('opts', [])) == 4)
    print(f'  PDF parse: {parse_ok}/100, JSON: {len(cur)}, answers: {len(ans)}')

    issues = []
    fine = 0
    for n in range(1, 101):
        q = qs.get(n, {})
        if not q.get('opts') or len(q['opts']) != 4:
            issues.append({'n': n, 'kind': 'PDF_PARSE_FAIL'}); continue
        if n not in cur:
            issues.append({'n': n, 'kind': 'NOT_IN_JSON'}); continue
        official = ans.get(n)
        if not official:
            continue

        pdf_opts = q['opts']
        pdf_correct = pdf_opts[ord(official) - ord('A')]

        cq = cur[n]
        cur_opts = [cq['options'][k] for k in 'ABCD']
        cur_answer = cq['answer']

        sims = [(i, similar(pdf_correct, co)) for i, co in enumerate(cur_opts)]
        best_idx, best_sim = max(sims, key=lambda x: x[1])
        best_letter = 'ABCD'[best_idx]

        if best_sim < 0.5:
            issues.append({
                'n': n, 'kind': 'OPT_MISSING',
                'pdf_correct': pdf_correct, 'json_opts': cur_opts,
                'json_answer': cur_answer, 'best_sim': round(best_sim, 2),
            }); continue
        if best_letter != cur_answer:
            issues.append({
                'n': n, 'kind': 'ANSWER_WRONG',
                'pdf_correct': pdf_correct, 'should_be': best_letter,
                'json_answer': cur_answer, 'sim': round(best_sim, 2),
            }); continue
        fine += 1

    out = paper_dir / 'report.json'
    with open(out, 'w', encoding='utf-8') as f:
        json.dump(issues, f, ensure_ascii=False, indent=2)
    kinds = Counter(i['kind'] for i in issues)
    print(f'  fine: {fine}/100 issues: {len(issues)} {dict(kinds)}')

    if apply and kinds.get('ANSWER_WRONG', 0) > 0:
        apply_fixes(issues, year, session, subject)


def apply_fixes(issues, year, session, subject):
    fixes = [i for i in issues if i['kind'] == 'ANSWER_WRONG']
    if not fixes:
        return
    with open(BASE / 'questions.json', encoding='utf-8') as f:
        data = json.load(f)
    target = {fx['n']: fx for fx in fixes}

    def walk(o):
        if isinstance(o, list):
            for x in o: walk(x)
        elif isinstance(o, dict):
            if (o.get('roc_year') == year and o.get('session') == session
                    and o.get('subject') == subject):
                n = o.get('number')
                if n in target:
                    fx = target[n]
                    o['answer'] = fx['should_be']
                    o['disputed'] = True
                    o['explanation'] = f'依考選部官方答案,本題正解為 {fx["should_be"]} ({fx["pdf_correct"].strip()[:70]})。原 OCR 答案標註錯誤,已修正。'
                    target.pop(n)
                    return
            for v in o.values(): walk(v)

    walk(data)
    with open(BASE / 'questions.json', 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    print(f'  applied {len(fixes) - len(target)}/{len(fixes)}')


# 預定義批次: 醫師一階 100-105
# (year, session, code, subject, s_param, c_param)
# 注意：104-2 起 MoEX 參數改為 c=301、醫一 s=55 / 醫二 s=66，且 PDF 改用字母標記格式。
DOCTOR1_BATCH = [
    ('100', '第一次', '100030', '醫學(一)', '0101', '101'),
    ('100', '第一次', '100030', '醫學(二)', '0102', '101'),
    ('100', '第二次', '100140', '醫學(一)', '0101', '101'),
    ('100', '第二次', '100140', '醫學(二)', '0102', '101'),
    ('101', '第一次', '101030', '醫學(一)', '0101', '101'),
    ('101', '第一次', '101030', '醫學(二)', '0102', '101'),
    ('101', '第二次', '101110', '醫學(一)', '0101', '101'),
    ('101', '第二次', '101110', '醫學(二)', '0102', '101'),
    ('102', '第一次', '102030', '醫學(一)', '0101', '101'),
    ('102', '第一次', '102030', '醫學(二)', '0102', '101'),
    ('102', '第二次', '102110', '醫學(一)', '0101', '101'),
    ('102', '第二次', '102110', '醫學(二)', '0102', '101'),
    ('103', '第一次', '103030', '醫學(一)', '0101', '101'),
    ('103', '第一次', '103030', '醫學(二)', '0102', '101'),
    ('103', '第二次', '103100', '醫學(一)', '0101', '101'),
    ('103', '第二次', '103100', '醫學(二)', '0102', '101'),
    ('104', '第一次', '104030', '醫學(一)', '0101', '101'),
    ('104', '第一次', '104030', '醫學(二)', '0102', '101'),
    ('104', '第二次', '104090', '醫學(一)', '55', '301'),
    ('104', '第二次', '104090', '醫學(二)', '66', '301'),
    ('105', '第一次', '105020', '醫學(一)', '55', '301'),
    ('105', '第一次', '105020', '醫學(二)', '66', '301'),
    ('105', '第二次', '105100', '醫學(一)', '55', '301'),
    ('105', '第二次', '105100', '醫學(二)', '66', '301'),
]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--batch', choices=['doctor1'])
    ap.add_argument('--year')
    ap.add_argument('--session')
    ap.add_argument('--code')
    ap.add_argument('--subject')
    ap.add_argument('--s')
    ap.add_argument('--c', default='101')
    ap.add_argument('--apply', action='store_true')
    args = ap.parse_args()

    if args.batch == 'doctor1':
        for (y, ses, code, subj, s_param, c_param) in DOCTOR1_BATCH:
            try:
                audit_paper(y, ses, code, subj, s_param, apply=args.apply, c_param=c_param)
            except Exception as e:
                print(f'  ❌ error: {e}')
    elif args.year:
        audit_paper(args.year, args.session, args.code, args.subject, args.s, args.apply, c_param=args.c)


if __name__ == '__main__':
    main()

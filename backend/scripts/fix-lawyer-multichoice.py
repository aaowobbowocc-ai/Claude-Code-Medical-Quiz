#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
全庫修復：律師一試「綜合法學」複選題。
爬蟲舊問題：複選題 5 選項(A-E)被併成 4 個(E 併進 D)、答案被截成單一字母。
本腳本對每份考卷：
  1. 抓官方答案卷(t=S)：讀「複選題數：N題(第A~B題)」與複選各題的多字母答案(座標定位)
  2. 抓官方題目卷(t=Q)：用 PUA 圈圈字母(Ⓐ-Ⓔ)切出每題完整 5 選項
  3. 更新 questions-lawyer1.json 對應題目(題幹+5選項+逗號複選答案+is_multi)
冪等：重跑同資料結果相同。
"""
import json, re, sys, time, urllib.request, ssl, os
sys.stdout.reconfigure(encoding='utf-8')
ssl._create_default_https_context = ssl._create_unverified_context
import fitz

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(BASE, 'questions-lawyer1.json')
U = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'
SEARCH = 'https://wwwq.moex.gov.tw/exam/wFrmExamQandASearch.aspx'
# PUA 圈圈字母 Ⓐ..Ⓔ（律師卷字型）
PUA = {0xe18c: 'A', 0xe18d: 'B', 0xe18e: 'C', 0xe18f: 'D', 0xe190: 'E'}

def fetch(url, tries=4, minlen=2000):
    for _ in range(tries):
        try:
            b = urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'}), timeout=60).read()
            if b and len(b) >= minlen:
                return b
        except Exception:
            pass
        time.sleep(2)
    return None

def subject_to_s(exam_code, year_ad):
    """回傳 {subject_keyword_group: (c,s)}；以搜尋頁科目名稱比對。"""
    h = fetch(f'{SEARCH}?y={year_ad}&e={exam_code}', minlen=500)
    if not h:
        return {}
    h = h.decode('utf-8', 'replace').replace('&amp;', '&')
    out = {}
    for r in re.split(r'<tr', h):
        m = re.search(rf't=Q&code={exam_code}&c=(\d+)&s=(\w+)', r)
        if not m:
            continue
        c, s = m.group(1), m.group(2)
        txt = ' '.join(re.findall(r'>([^<>]{2,80})<', r))
        if '民法' in txt and '民事訴訟' in txt:
            out.setdefault('civil', (c, s))
        elif '公司法' in txt or '票據' in txt:
            out.setdefault('commercial', (c, s))
        elif '刑法' in txt and '刑事訴訟' in txt:
            out.setdefault('criminal', (c, s))
        elif '憲法' in txt and '行政法' in txt:
            out.setdefault('constitutional', (c, s))
    return out

def subject_key(subject):
    if '民法' in subject and '民事訴訟' in subject: return 'civil'
    if '公司法' in subject or '票據' in subject: return 'commercial'
    if '刑法' in subject and '刑事訴訟' in subject: return 'criminal'
    if '憲法' in subject and '行政法' in subject: return 'constitutional'
    return None

def parse_answer_sheet(code, c, s):
    """回傳 {num: 'ABCE'}。座標定位題號→答案。複選由答案長度>1判定，不靠宣告文字。"""
    b = fetch(f'{U}?t=S&code={code}&c={c}&s={s}&q=1')
    if not b or b[:4] != b'%PDF':
        b = fetch(f'{U}?t=A&code={code}&c={c}&s={s}&q=1')
    if not b or b[:4] != b'%PDF':
        return None
    doc = fitz.open(stream=b, filetype='pdf')
    ans = {}
    for pg in doc:
        words = pg.get_text('words')
        qcells = {}
        for w in words:
            m = re.match(r'第(\d+)題', w[4])
            if m:
                qcells[int(m.group(1))] = (w[0], w[1], w[2], w[3])
        letters = [(w[0], w[1], w[4]) for w in words if re.fullmatch(r'[A-E#]{1,5}', w[4])]
        for n, (x0, y0, x1, y1) in qcells.items():
            cand = [(abs(lx0 - x0), ly0, lt) for lx0, ly0, lt in letters if ly0 > y1 and ly0 < y1 + 40 and abs(lx0 - x0) < 35]
            if cand:
                cand.sort(key=lambda v: (v[1], v[0]))
                ans[n] = cand[0][2]
    return ans if ans else None

def extract_multi_questions(code, c, s, nums):
    """回傳 {num: (stem, {A..})}，用 PUA 切選項。nums 為要抓的題號集合。"""
    b = fetch(f'{U}?t=Q&code={code}&c={c}&s={s}&q=1', minlen=6000)
    if not b or b[:4] != b'%PDF':
        return {}
    full = '\n'.join(p.get_text() for p in fitz.open(stream=b, filetype='pdf'))
    def clean(t):
        t = re.sub(r'代號[：:]?\s*\d+.*$', '', t)
        return re.sub(r'\s+', '', t).strip()
    res = {}
    for n in sorted(nums):
        m = re.search(rf'\n{n} \n(.*?)(?=\n{n+1} \n|\Z)', full, re.S)
        if not m:
            continue
        block = m.group(1)
        marks = []
        for i, ch in enumerate(block):
            o = ord(ch)
            if o in PUA:
                marks.append((i, PUA[o]))
        if not marks:
            continue
        marks.sort()
        stem = clean(block[:marks[0][0]])
        opts = {}
        for idx, (pos, letter) in enumerate(marks):
            end = marks[idx + 1][0] if idx + 1 < len(marks) else len(block)
            opts[letter] = clean(block[pos + 1:end])
        res[n] = (stem, opts)
    return res

def main():
    with open(DATA, encoding='utf-8') as f:
        d = json.load(f)
    arr = d['questions'] if isinstance(d, dict) and 'questions' in d else d
    # 分組：exam_code + subject
    groups = {}
    for q in arr:
        sk = subject_key(q.get('subject', '') or q.get('subject_name', ''))
        if not sk:
            continue
        key = (str(q.get('exam_code')), sk, q.get('roc_year'), q.get('session'))
        groups.setdefault(key, []).append(q)

    total_fixed = 0
    log = []
    for (code, sk, year, sess), qlist in sorted(groups.items()):
        year_ad = str(int(year) + 1911)
        cs_map = subject_to_s(code, year_ad)
        cs = cs_map.get(sk)
        if not cs:
            log.append(f'SKIP {code} {sk} {year}: 找不到 c/s')
            continue
        c, s = cs
        ans = parse_answer_sheet(code, c, s)
        if not ans:
            log.append(f'SKIP {code} {sk} {year}: 答案卷解析失敗')
            continue
        # 複選題 = 官方答案為多字母(全 A-E)
        multi_nums = [n for n, a in ans.items() if len(a) > 1 and re.fullmatch(r'[A-E]{2,5}', a)]
        if not multi_nums:
            log.append(f'NONE {code} {sk} {year} (c={c} s={s}): 無複選題')
            continue
        mq = extract_multi_questions(code, c, s, set(multi_nums))
        bynum = {int(q.get('number', -1)): q for q in qlist}
        fixed = 0
        for n in multi_nums:
            q = bynum.get(n)
            if not q or n not in mq:
                continue
            off = ans.get(n)
            if not off:
                continue
            stem, opts = mq[n]
            if len(opts) < 2:
                continue
            q['question'] = stem
            q['options'] = {k: opts[k] for k in sorted(opts)}
            q['answer'] = ','.join(list(off)) if len(off) > 1 else off
            if len(off) > 1:
                q['is_multi'] = True
            fixed += 1
        total_fixed += fixed
        log.append(f'OK   {code} {sk} {year} (c={c} s={s}) 複選{min(multi_nums)}-{max(multi_nums)}({len(multi_nums)}題): 修 {fixed} 題')
        time.sleep(1)

    with open(DATA, 'w', encoding='utf-8') as f:
        json.dump(d, f, ensure_ascii=False, indent=2)
    print('\n'.join(log))
    print(f'=== 全部完成，共修 {total_fixed} 題複選 ===')

if __name__ == '__main__':
    main()

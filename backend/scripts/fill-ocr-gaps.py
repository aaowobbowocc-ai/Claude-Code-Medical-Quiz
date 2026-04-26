#!/usr/bin/env python
"""
OCR-based gap filler for image-PDF MoEX question papers.

Targets:
  tcm1 102-2 tcm_basic_2 missing Q: 6,40,50,51,59,60,65,77,78,79,80
  nursing 108-1 psych_community entire paper (~80 Q)
"""
import os, sys, json, re, io, argparse, urllib3
os.environ['FLAGS_use_mkldnn']='0'
os.environ['FLAGS_enable_pir_in_executor']='0'
import requests
import fitz  # PyMuPDF
from pathlib import Path

urllib3.disable_warnings()
os.environ.setdefault('PYTHONIOENCODING','utf-8')

ROOT = Path(__file__).resolve().parent.parent
TMP  = ROOT / '_tmp'
PDFS = TMP / 'ocr_pdfs'
IMGS = TMP / 'ocr_imgs'
PDFS.mkdir(parents=True, exist_ok=True)
IMGS.mkdir(parents=True, exist_ok=True)

BASE = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'
UA = 'Mozilla/5.0'

def fetch_pdf(t, code, c, s, name):
    out = PDFS / f'{name}_{t}.pdf'
    if out.exists() and out.stat().st_size > 1000:
        return out
    url = f'{BASE}?t={t}&code={code}&c={c}&s={s}&q=1'
    r = requests.get(url, verify=False, timeout=60,
                     headers={'User-Agent': UA, 'Referer': 'https://wwwq.moex.gov.tw/'})
    if r.status_code != 200 or not r.content.startswith(b'%PDF'):
        print(f'  [fetch {t}] FAIL status={r.status_code} ct={r.headers.get("content-type")}')
        return None
    out.write_bytes(r.content)
    print(f'  [fetch {t}] saved {len(r.content)} bytes -> {out.name}')
    return out

def pdf_to_images(pdf_path, dpi=300):
    """Rasterize each page to PNG, return list of image paths."""
    doc = fitz.open(pdf_path)
    outs = []
    for i, page in enumerate(doc):
        pix = page.get_pixmap(dpi=dpi)
        out = IMGS / f'{pdf_path.stem}_p{i+1}.png'
        pix.save(str(out))
        outs.append(out)
    doc.close()
    return outs

_ocr = None
def ocr_engine():
    global _ocr
    if _ocr is None:
        from paddleocr import PaddleOCR
        # Try chinese_cht; fall back to ch
        # paddleocr 3.x API: use_textline_orientation; disable mkldnn to avoid IR bug
        kwargs = dict(use_textline_orientation=False, enable_mkldnn=False)
        try:
            _ocr = PaddleOCR(lang='chinese_cht', **kwargs)
        except Exception as e:
            print('  chinese_cht failed, falling back to ch:', e)
            _ocr = PaddleOCR(lang='ch', **kwargs)
    return _ocr

def ocr_image(img_path):
    """Return list of (text, bbox_center_y, bbox_min_x, bbox_max_x, bbox_min_y, bbox_max_y)."""
    eng = ocr_engine()
    # paddleocr 3.x API
    try:
        result = eng.predict(str(img_path))
        # result is list of dict per image
        items = []
        for page in result:
            texts = page.get('rec_texts', []) or []
            polys = page.get('rec_polys', []) or page.get('dt_polys', [])
            for t, poly in zip(texts, polys):
                xs = [p[0] for p in poly]; ys = [p[1] for p in poly]
                items.append({
                    'text': t, 'cx': sum(xs)/len(xs), 'cy': sum(ys)/len(ys),
                    'xmin': min(xs), 'xmax': max(xs), 'ymin': min(ys), 'ymax': max(ys),
                })
        return items
    except Exception as e:
        # fallback to 2.x API
        result = eng.ocr(str(img_path), cls=True)
        items = []
        if result and result[0]:
            for line in result[0]:
                poly, (text, _conf) = line
                xs=[p[0] for p in poly]; ys=[p[1] for p in poly]
                items.append({
                    'text': text, 'cx': sum(xs)/len(xs), 'cy': sum(ys)/len(ys),
                    'xmin':min(xs),'xmax':max(xs),'ymin':min(ys),'ymax':max(ys),
                })
        return items

def sort_reading_order(items, page_width):
    """Sort items left-column-first then right-column, top-to-bottom. MoEX papers are usually 2-column."""
    mid = page_width / 2
    left  = sorted([x for x in items if x['cx'] < mid], key=lambda x: x['cy'])
    right = sorted([x for x in items if x['cx'] >= mid], key=lambda x: x['cy'])
    return left + right

def cluster_lines(items, ytol=12):
    """Group OCR boxes into lines by y proximity within same column half."""
    # sort by y then x
    items = sorted(items, key=lambda x:(x['cy'], x['xmin']))
    lines = []
    cur = []
    cur_y = None
    for it in items:
        if cur_y is None or abs(it['cy']-cur_y) <= ytol:
            cur.append(it)
            cur_y = it['cy'] if cur_y is None else (cur_y+it['cy'])/2
        else:
            lines.append(cur); cur=[it]; cur_y=it['cy']
    if cur: lines.append(cur)
    # each line: sort by x, join text
    out = []
    for line in lines:
        line = sorted(line, key=lambda x:x['xmin'])
        out.append({
            'text': ''.join(w['text'] for w in line),
            'cy': sum(w['cy'] for w in line)/len(line),
            'xmin': min(w['xmin'] for w in line),
            'xmax': max(w['xmax'] for w in line),
        })
    return out

def parse_questions(all_lines_per_page, page_widths):
    """Input: list of lines per page. Each page processed in 2-column reading order.
    Returns list of {number, question, options:{A,B,C,D}}."""
    # Flatten into reading order: for each page, split into left/right columns, sort by y.
    ordered = []
    for plines, pw in zip(all_lines_per_page, page_widths):
        mid = pw/2
        left  = sorted([l for l in plines if (l['xmin']+l['xmax'])/2 < mid], key=lambda x:x['cy'])
        right = sorted([l for l in plines if (l['xmin']+l['xmax'])/2 >= mid], key=lambda x:x['cy'])
        ordered.extend(left); ordered.extend(right)

    # Concatenate text with newlines for regex parsing
    full = '\n'.join(l['text'] for l in ordered)
    # Quick normalise
    full = full.replace('（','(').replace('）',')')
    # Split by question starts: number followed by . or 、 at line start, 1-80
    # Pattern: (\d{1,2})\.  at start of a line
    return full, ordered

QNUM_RE = re.compile(r'^\s*(\d{1,2})[\.．、\s]\s*(.*)$')
OPT_RE  = re.compile(r'^\s*\(?([ABCD])\)?[\.．、\s]?\s*(.*)$')

def extract_qas(lines):
    """Extract question dicts from ordered lines."""
    qs = []
    cur = None
    mode = 'q'  # 'q' means collecting stem, 'opt' collecting options
    for l in lines:
        text = l['text'].strip()
        if not text: continue
        m = QNUM_RE.match(text)
        mo = OPT_RE.match(text)
        if m and (cur is None or len(cur.get('options',{}))>=1 or int(m.group(1))==cur['number']+1 or int(m.group(1))<=80):
            # Start new question if previous has options or numbers sequence fits
            if cur is not None:
                qs.append(cur)
            num = int(m.group(1))
            stem = m.group(2).strip()
            cur = {'number': num, 'question': stem, 'options': {}}
            mode = 'q'
            continue
        if mo and cur is not None:
            letter = mo.group(1)
            val = mo.group(2).strip()
            cur['options'][letter] = val
            cur['_last_opt'] = letter
            mode = 'opt'
            continue
        if cur is None: continue
        # continuation line
        if mode == 'q':
            cur['question'] += text
        elif mode == 'opt' and cur.get('_last_opt'):
            cur['options'][cur['_last_opt']] += text
    if cur is not None: qs.append(cur)
    # cleanup
    for q in qs: q.pop('_last_opt', None)
    return qs

def parse_answer_pdf(pdf_path):
    """Extract answer map {num: 'A'}.
    MoEX answer PDFs use column layout: all numbers then all letters in reading order,
    with '題號'/'答案' header markers. Parse by collecting contiguous number runs and
    letter runs, then zipping.
    """
    doc = fitz.open(pdf_path)
    text = ''
    for p in doc: text += p.get_text() + '\n'
    doc.close()
    ans = {}
    # Try inline patterns first
    for m in re.finditer(r'(?<!\d)(\d{1,3})\s*[\.、]\s*([ABCDE])(?![A-Z])', text):
        n=int(m.group(1)); l=m.group(2)
        if 1<=n<=200 and n not in ans: ans[n]=l
    if len(ans)>=5:
        return ans
    # Fallback: collect all letter-only lines after first '答案' marker in order → index 1..N
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    started = False
    letters = []
    for ln in lines:
        if ln == '答案' or '答案：' in ln:
            started = True
            continue
        if not started: continue
        if re.fullmatch(r'[ABCDE#]', ln):
            letters.append(ln)
        # Ignore 題號/答案 section headers between blocks
    if letters:
        for i, l in enumerate(letters, start=1):
            if l in 'ABCDE': ans[i] = l
        return ans
    # Column layout: iterate lines, find each "題號...答案" block followed by
    # a list of numbers then a list of letters.
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    i = 0
    while i < len(lines):
        if '題號' in lines[i]:
            # find '答案' marker
            j = i + 1
            nums = []
            while j < len(lines) and lines[j] != '答案' and not lines[j].startswith('答案'):
                if re.fullmatch(r'\d{1,3}', lines[j]):
                    nums.append(int(lines[j]))
                    j += 1
                else:
                    break
            # advance past 答案 marker
            while j < len(lines) and ('答案' in lines[j]):
                j += 1
            letters = []
            while j < len(lines) and len(letters) < len(nums):
                if re.fullmatch(r'[ABCDE#]', lines[j]):
                    letters.append(lines[j])
                    j += 1
                else:
                    break
            for n, l in zip(nums, letters):
                if l in 'ABCDE' and 1 <= n <= 200 and n not in ans:
                    ans[n] = l
            i = j
        else:
            i += 1
    return ans

def load_bank(fp):
    return json.loads(Path(fp).read_text(encoding='utf-8'))

def save_bank(fp, data):
    Path(fp).write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')

def merge_into_bank(bank_path, new_entries, exam_code):
    data = load_bank(bank_path)
    qs = data['questions']
    existing = {(q.get('exam_code'), q.get('subject_tag'), q.get('number')) for q in qs}
    added = 0
    for e in new_entries:
        key = (e['exam_code'], e['subject_tag'], e['number'])
        if key in existing:
            continue
        qs.append(e); added += 1
    data['total'] = len(qs)
    save_bank(bank_path, data)
    return added

def build_entry(roc_year, session, exam_code, subject, subject_tag, subject_name, number, question, options, answer):
    id_ = f"{exam_code}_{session_code(session)}_{number}"
    return {
        'id': id_,
        'roc_year': roc_year,
        'session': session,
        'exam_code': exam_code,
        'subject': subject,
        'subject_tag': subject_tag,
        'subject_name': subject_name,
        'stage_id': 0,
        'number': number,
        'question': question,
        'options': options,
        'answer': answer,
        'explanation': '',
    }

def session_code(session):
    return {'第一次':'0101','第二次':'0202'}.get(session,'0000')

def run_target(name, code, c, s, bank_path, roc_year, session, subject, subject_tag, subject_name, wanted_numbers=None, dry=False):
    print(f'\n=== {name} ===')
    qpdf = fetch_pdf('Q', code, c, s, name)
    if qpdf is None: return 0
    apdf = fetch_pdf('S', code, c, s, name) or fetch_pdf('A', code, c, s, name) or fetch_pdf('M', code, c, s, name)

    answers = parse_answer_pdf(apdf) if apdf else {}
    print(f'  answer PDF parsed: {len(answers)} answers')

    # rasterize
    imgs = pdf_to_images(qpdf, dpi=300)
    print(f'  pages: {len(imgs)}')

    # OCR
    all_lines = []
    page_widths = []
    for i, img in enumerate(imgs):
        items = ocr_image(img)
        # page width
        doc = fitz.open(qpdf); page = doc[i]
        pw = page.rect.width * 300/72  # convert to image px
        doc.close()
        lines = cluster_lines(items)
        all_lines.append(lines); page_widths.append(pw)
        print(f'    page {i+1}: {len(items)} boxes, {len(lines)} lines')

    # Build ordered lines across pages with column sorting
    ordered = []
    for plines, pw in zip(all_lines, page_widths):
        mid = pw/2
        left  = sorted([l for l in plines if (l['xmin']+l['xmax'])/2 < mid], key=lambda x:x['cy'])
        right = sorted([l for l in plines if (l['xmin']+l['xmax'])/2 >= mid], key=lambda x:x['cy'])
        ordered.extend(left); ordered.extend(right)

    # Debug: dump first 40 ordered lines
    print('  === first 40 ordered lines ===')
    for l in ordered[:40]:
        print(f'    [{l["cy"]:.0f}/{l["xmin"]:.0f}] {l["text"][:90]}')
    qs = extract_qas(ordered)
    print(f'  parsed {len(qs)} questions')

    # Filter to wanted set if provided
    if wanted_numbers is not None:
        qs = [q for q in qs if q['number'] in wanted_numbers]
        print(f'  after filter: {len(qs)}')

    # Build entries
    entries = []
    skipped = 0
    for q in qs:
        num = q['number']
        opts = q['options']
        if not all(k in opts for k in 'ABCD'):
            print(f'    skip Q{num}: missing options {sorted(opts.keys())}')
            skipped += 1
            continue
        ans = answers.get(num)
        if not ans:
            print(f'    skip Q{num}: no answer')
            skipped += 1
            continue
        entries.append(build_entry(
            roc_year, session, code, subject, subject_tag, subject_name,
            num, q['question'].strip(), {k:opts[k].strip() for k in 'ABCD'}, ans))

    # Spot-check first 3
    for e in entries[:3]:
        print(f'  Q{e["number"]}: {e["question"][:60]}')
        for k in 'ABCD': print(f'     ({k}) {e["options"][k][:50]}')
        print(f'     ANS: {e["answer"]}')

    if dry:
        print(f'  DRY-RUN: would add {len(entries)} entries ({skipped} skipped)')
        return 0
    added = merge_into_bank(bank_path, entries, code)
    print(f'  merged into {bank_path}: +{added} ({skipped} skipped)')
    return added

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--target', choices=['tcm1','nursing','all'], default='all')
    ap.add_argument('--dry', action='store_true')
    args = ap.parse_args()

    total = 0
    if args.target in ('tcm1','all'):
        total += run_target(
            name='tcm1_102-2_basic2',
            code='102110', c='103', s='0202',
            bank_path=ROOT/'questions-tcm1.json',
            roc_year='102', session='第二次',
            subject='中醫基礎醫學(二)', subject_tag='tcm_basic_2',
            subject_name='中醫基礎醫學(二)',
            wanted_numbers={6,40,50,51,59,60,65,77,78,79,80},
            dry=args.dry,
        )
    if args.target in ('nursing','all'):
        total += run_target(
            name='nursing_108-1_psych',
            code='108020', c='106', s='0505',
            bank_path=ROOT/'questions-nursing.json',
            roc_year='108', session='第一次',
            subject='精神科與社區衛生護理學', subject_tag='psych_community',
            subject_name='精神科與社區衛生護理學',
            wanted_numbers=None,
            dry=args.dry,
        )
    print(f'\nDONE. total added: {total}')

if __name__ == '__main__':
    main()

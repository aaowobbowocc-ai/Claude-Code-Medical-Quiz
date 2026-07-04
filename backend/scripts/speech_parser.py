# -*- coding: utf-8 -*-
"""語言治療師專用題目解析器。
考選部 PDF 的選項由 PUA 圈碼字母 - (Ⓐ-Ⓓ) 於行首分隔；audit-paper.py
對多行選項/複選圈碼 combo 會切錯，本解析器改用 PUA 標記切割，正確處理：
  - 多行換行選項（合併行內換行）
  - 複選圈碼 combo（①②④ 之類，原樣保留）
  - 承上題共用情境（回傳 shared context 供呼叫端內嵌）
用法：from speech_parser import parse_speech_pdf; parse_speech_pdf(Path) -> {num: {q,opts}}
"""
import re
import fitz

A, B, C, D = '', '', '', ''

def _clean(s):
    # 合併行內換行、壓縮空白
    s = s.replace('\n', ' ')
    # 去頁尾/頁首雜訊：代號、頁次、續前頁等
    s = re.sub(r'代號[:：]\s*\d+', '', s)
    s = re.sub(r'頁次[:：]\s*\d+\s*[－\-]\s*\d+', '', s)
    s = re.sub(r'\s+', ' ', s).strip()
    return s

def _last_line(s):
    """取一段文字最後一個非空「行」——用於『選項在標記之前』的複選版型。"""
    parts = [p.strip() for p in s.split('\n') if p.strip()]
    return parts[-1] if parts else ''

def parse_speech_pdf(path):
    doc = fitz.open(path)
    full = '\n'.join(pg.get_text() for pg in doc)
    # 統一 PUA → 佔位符，方便正則
    t = full.replace(A, '\x01').replace(B, '\x02').replace(C, '\x03').replace(D, '\x04')
    # 每題塊：行首題號 → 下一題號(且該塊含四標記)。塊內再判斷標記在文字前或後。
    blocks = re.compile(
        r'(?:^|\n)\s*(\d{1,3})\s*\n(.*?)(?=\n\s*\d{1,3}\s*\n[^\x01\x02\x03\x04]*?\x01|\Z)',
        re.S)
    out = {}
    for m in blocks.finditer(t):
        num = int(m.group(1))
        body = m.group(2)
        pa, pb, pc, pd = (body.find(x) for x in ('\x01', '\x02', '\x03', '\x04'))
        if not (0 <= pa < pb < pc < pd):
            continue
        # 版型一（標記在前）：Ⓐtext … 取標記之後到下一標記
        after = [body[pa+1:pb], body[pb+1:pc], body[pc+1:pd], body[pd+1:]]
        after_o = [_clean(x) for x in after]
        # 版型二（選項在標記之前，常見於圈碼複選）：取每個標記「之前」那一行
        before_o = [
            _last_line(body[:pa]),          # Ⓐ 之前
            _last_line(body[pa+1:pb]),      # Ⓑ 之前（在 Ⓐ、Ⓑ 之間）
            _last_line(body[pb+1:pc]),
            _last_line(body[pc+1:pd]),
        ]
        before_o = [_clean(x) for x in before_o]

        def good(o):
            return all(x and len(x) >= 1 for x in o) and len(set(o)) == 4

        if good(after_o):
            opts = after_o
            stem = _clean(body[:pa])
        elif good(before_o):
            opts = before_o
            # 題幹＝Ⓐ選項那行「之前」的所有文字
            head = body[:pa]
            stem = _clean(head[:head.rfind('\n')] if '\n' in head else head)
        else:
            continue
        if not stem:
            continue
        out[num] = {'q': stem, 'opts': opts}
    return out


if __name__ == '__main__':
    import sys
    from pathlib import Path
    sys.stdout.reconfigure(encoding='utf-8')
    res = parse_speech_pdf(Path(sys.argv[1]))
    nums = sorted(res)
    print(f'解析出 {len(res)} 題: {nums[:5]}..{nums[-3:] if len(nums)>3 else nums}')
    for n in (int(x) for x in sys.argv[2:]):
        q = res.get(n, {})
        print(f'--- #{n} ---'); print(' Q:', q.get('q', '')[:70])
        for i, o in enumerate(q.get('opts', [])): print('  ', chr(65+i), repr(o[:80]))

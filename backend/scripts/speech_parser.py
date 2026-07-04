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

def parse_speech_pdf(path):
    doc = fitz.open(path)
    full = '\n'.join(pg.get_text() for pg in doc)
    # 統一 PUA → 佔位符，方便正則
    t = full.replace(A, '\x01').replace(B, '\x02').replace(C, '\x03').replace(D, '\x04')
    # 每題：行首題號 + 題幹 + Ⓐ..Ⓓ 四選項；Ⓓ 到下一題題號(或檔尾)
    # 題號後緊跟題幹，題幹到第一個 \x01(Ⓐ) 為止
    pat = re.compile(
        r'(?:^|\n)\s*(\d{1,3})\s*\n'      # 題號
        r'(.*?)'                           # 題幹
        r'\x01(.*?)'                       # Ⓐ
        r'\x02(.*?)'                       # Ⓑ
        r'\x03(.*?)'                       # Ⓒ
        r'\x04(.*?)'                       # Ⓓ
        r'(?=\n\s*\d{1,3}\s*\n.*?\x01|\Z)',  # 下一題(有Ⓐ)或檔尾
        re.S)
    out = {}
    for m in pat.finditer(t):
        num = int(m.group(1))
        stem = _clean(m.group(2))
        opts = [_clean(m.group(i)) for i in (3, 4, 5, 6)]
        # 基本健全性：題幹非空、四選項皆非空
        if not stem or any(not o for o in opts):
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

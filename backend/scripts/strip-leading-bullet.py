# -*- coding: utf-8 -*-
"""剝除選項『開頭』殘留的選項符號 PUA bullet（U+E18C–E18F）。
只動以 bullet 開頭的選項；去掉開頭 bullet(可多顆) + 緊跟空白/全形空白。
保險：若剝完變空或長度<2 → 跳過（那是壞題殘骸，留給人工）。
題幹 PUA、選項中段 PUA（數學/Symbol 字型）一律不碰。
用法：python scripts/strip-leading-bullet.py [--apply] [--samples]
"""
import json, sys, glob
sys.stdout.reconfigure(encoding='utf-8', errors='replace')
apply = '--apply' in sys.argv
show = '--samples' in sys.argv

BUL = set(range(0xE18C, 0xE190))          # E18C..E18F
SPACE = set(map(ord, ' \t　\xa0'))    # 半形/全形/不斷行空白

def fix_val(v):
    if not isinstance(v, str) or not v or ord(v[0]) not in BUL:
        return v, False
    i = 0
    while i < len(v) and (ord(v[i]) in BUL or ord(v[i]) in SPACE):
        i += 1
    nv = v[i:]
    if not nv.strip():                    # 剝完「完全空」才跳過（單字選項如 甲/乙/縣/省 要保留）
        return v, False
    return nv, (nv != v)

samples = []
def walk(o, stat):
    if isinstance(o, list):
        for x in o: walk(x, stat)
    elif isinstance(o, dict):
        opts = o.get('options')
        host = ('question' in o or 'answer' in o)
        if host and isinstance(opts, dict):
            for k, v in list(opts.items()):
                nv, ch = fix_val(v)
                if ch:
                    if show and len(samples) < 12: samples.append((v, nv))
                    opts[k] = nv; stat[0]+=1
        elif host and isinstance(opts, list):
            for i in range(len(opts)):
                nv, ch = fix_val(opts[i])
                if ch:
                    if show and len(samples) < 12: samples.append((opts[i], nv))
                    opts[i] = nv; stat[0]+=1
        else:
            for v in o.values(): walk(v, stat)

total = 0
for fn in sorted(glob.glob('questions*.json')):
    d = json.load(open(fn, encoding='utf-8'))
    qs = d if isinstance(d, list) else d.get('questions', d)
    stat=[0]; walk(qs, stat)
    if stat[0]:
        print(f'{fn:40} 選項修正 {stat[0]}')
        total += stat[0]
        if apply:
            json.dump(d, open(fn,'w',encoding='utf-8'), ensure_ascii=False, indent=2)
if show:
    print('\n--- 前後對照抽樣 ---')
    for a,b in samples:
        print('  前:',repr(a[:40]),'→ 後:',repr(b[:40]))
print(f'\n{"已套用" if apply else "(dry)"} 共修正選項 {total} 個')

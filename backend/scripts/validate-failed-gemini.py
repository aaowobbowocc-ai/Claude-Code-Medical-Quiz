#!/usr/bin/env python3
import json
import requests
import time
import sys

KEY = open('../.gemini-key').read().strip()

def validate(q_text, answer, opts):
    prompt = f"""醫學執照考試題驗證

題目：{q_text[:200]}

選項 A: {opts.get('A','')[:60]}
選項 B: {opts.get('B','')[:60]}
選項 C: {opts.get('C','')[:60]}
選項 D: {opts.get('D','')[:60]}

此題的正確答案是 {answer}。根據醫學知識，此答案是否正確？

回傳 JSON: {{"result":"correct"/"incorrect"/"uncertain"}}"""

    url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={KEY}"
    try:
        r = requests.post(url, json={"contents": [{"parts": [{"text": prompt}]}]}, timeout=30)
        if r.status_code != 200: return None
        text = r.json()["candidates"][0]["content"]["parts"][0]["text"]
        import re
        m = re.search(r'\{[^}]*\}', text)
        return json.loads(m.group()) if m else None
    except: return None

pharma = json.load(open('../questions-pharma1.json', encoding='utf-8'))
nursing = json.load(open('../questions-nursing.json', encoding='utf-8'))
radiology = json.load(open('../questions-radiology.json', encoding='utf-8'))

complete_only = {
    'pharma1': [(109,53), (100,36), (102,57), (101,46), (105,53)],  # 實際有4個完整
    'nursing': [(108,51), (105,20), (105,72), (105,52), (104,62), (104,69), (104,3), (104,60)],
    'radiology': [(109,25), (111,77), (113,76), (114,8), (103,38), (103,11), (104,45), (104,79), (104,54), (104,41)]
}

datas = {'pharma1': pharma, 'nursing': nursing, 'radiology': radiology}

print("=== 重驗 22 個完整選項題目 ===\n")
fixed = 0

for exam in ['pharma1', 'nursing', 'radiology']:
    questions = datas[exam]['questions']
    targets = complete_only[exam]
    
    print(f"{exam}: ", end='', flush=True)
    exam_fixed = 0
    
    for year, qnum in targets:
        q = next((qq for qq in questions if qq['roc_year']==str(year) and qq['number']==qnum), None)
        if not q: continue
        
        result = validate(q['question'], q['answer'], q['options'])
        if result and result.get('result') == 'correct':
            exam_fixed += 1
            fixed += 1
        
        time.sleep(1)
    
    print(f"{exam_fixed}/{len(targets)} 修復")

print(f"\n合計: {fixed} 題重新驗證通過")

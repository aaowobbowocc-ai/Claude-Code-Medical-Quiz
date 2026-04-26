#!/usr/bin/env python3
"""用 Gemini 免費修復 pharma1/nursing/radiology"""

import json
import time
import requests
from pathlib import Path

ROOT = Path(__file__).parent.parent
KEY_FILE = ROOT / ".gemini-key"
GEMINI_KEY = KEY_FILE.read_text().strip()

EXAMS = [
    ("questions-pharma1.json", "pharma1", 79),
    ("questions-nursing.json", "nursing", 57),
    ("questions-radiology.json", "radiology", 45),
]

def fill_exam(exam_file, exam_name, expected_count):
    """修復一個考試"""
    print(f"\n=== {exam_name.upper()} ===\n")
    
    try:
        with open(ROOT / exam_file, encoding='utf-8') as f:
            data = json.load(f)
    except FileNotFoundError:
        print(f"❌ 檔案不存在：{exam_file}")
        return 0, 0
    
    questions = data.get("questions") or data
    
    # 找缺題
    incomplete = [q for q in questions if q.get("incomplete") and q.get("answer")]
    has_answer_no_opts = [
        q for q in incomplete
        if sum(1 for v in q.get("options", {}).values() if v and v.strip()) < 4
    ]
    
    actual = len(has_answer_no_opts)
    print(f"預期：{expected_count} | 實際：{actual}")
    
    if actual == 0:
        print("✓ 沒有缺題")
        return 0, 0
    
    def call_gemini(question_text, answer, options):
        existing = {k: v for k, v in options.items() if v and v.strip()}
        prompt = f"""Medical exam question. Missing options:

Q: {question_text[:180]}
Ans: {answer}

Existing:
{chr(10).join(f"  {k}: {v[:50]}" for k, v in existing.items())}

Return JSON: {{"A":"...","B":"...","C":"...","D":"..."}}"""
        
        payload = {"contents": [{"parts": [{"text": prompt}]}]}
        url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={GEMINI_KEY}"
        
        try:
            resp = requests.post(url, json=payload, timeout=30)
            if resp.status_code != 200:
                return None
            result = resp.json()
            text = result["candidates"][0]["content"]["parts"][0]["text"]
            import re
            m = re.search(r'\{[^{}]*\}', text)
            return json.loads(m.group()) if m else None
        except:
            return None
    
    updated = 0
    failed = 0
    
    for i, q in enumerate(has_answer_no_opts):
        print(f"[{i+1:3d}/{actual}] Q{q.get('number'):3d} ({q.get('roc_year')}): ", end="", flush=True)
        
        opts = call_gemini(q.get("question", ""), q.get("answer", ""), q.get("options", {}))
        
        if opts:
            for k in ["A", "B", "C", "D"]:
                if k in opts and opts[k]:
                    q["options"][k] = opts[k]
            q["incomplete"] = False
            print("OK")
            updated += 1
        else:
            print("X")
            failed += 1
        
        time.sleep(1.5)  # 速率限制
    
    # 保存
    if updated > 0:
        if isinstance(data, dict) and "questions" in data:
            data["questions"] = questions
        with open(ROOT / exam_file, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
    
    print(f"\n{exam_name}: {updated} fixed, {failed} failed")
    return updated, failed

# 主程式
print("=" * 50)
print("GEMINI 批量修復（pharma1/nursing/radiology）")
print("=" * 50)

total_up = 0
total_fail = 0

for exam_file, exam_name, expected in EXAMS:
    up, fail = fill_exam(exam_file, exam_name, expected)
    total_up += up
    total_fail += fail

print(f"\n{'=' * 50}")
print(f"TOTAL: {total_up} fixed, {total_fail} failed")
print(f"{'=' * 50}")

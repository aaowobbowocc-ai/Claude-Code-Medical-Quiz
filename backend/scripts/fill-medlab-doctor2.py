#!/usr/bin/env python3
"""Fill medlab + doctor2 incomplete options using Gemini (free)"""

import json
import time
import requests
from pathlib import Path

ROOT = Path(__file__).parent.parent
KEY_FILE = ROOT / ".gemini-key"
GEMINI_KEY = KEY_FILE.read_text().strip()

def fill_exam(exam_file, exam_name):
    """Fill incomplete for one exam"""

    with open(ROOT / exam_file, encoding='utf-8') as f:
        data = json.load(f)
    questions = data.get("questions") or data

    # Find incomplete with answer but missing options
    incomplete = [q for q in questions if q.get("incomplete") and q.get("answer")]
    has_answer_no_opts = [
        q for q in incomplete
        if sum(1 for v in q.get("options", {}).values() if v and v.strip()) < 4
    ]

    print(exam_name + ": " + str(len(has_answer_no_opts)) + " to fix\n")

    def call_gemini(question_text, answer, options):
        existing = {k: v for k, v in options.items() if v and v.strip()}
        prompt = f"""Medical exam question. Missing options to infer:

Q: {question_text[:180]}...
Ans: {answer}

Existing:
{chr(10).join(f"  {k}: {v[:50]}" for k, v in existing.items())}

Return JSON:
{{"A":"...","B":"...","C":"...","D":"..."}}"""

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
        print("[" + str(i+1) + "/" + str(len(has_answer_no_opts)) + "] Q" + str(q.get("number")) + ": ", end="", flush=True)

        opts = call_gemini(q.get("question", ""), q.get("answer", ""), q.get("options", {}))

        if opts:
            for k in ["A", "B", "C", "D"]:
                if k in opts and opts[k]:
                    q["options"][k] = opts[k]
            q["incomplete"] = False
            print("OK")
            updated += 1
        else:
            print("FAIL")
            failed += 1

        time.sleep(2)

    if updated > 0:
        if isinstance(data, dict) and "questions" in data:
            data["questions"] = questions
        with open(ROOT / exam_file, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)

    print("\n " + exam_name + " result: " + str(updated) + " fixed, " + str(failed) + " failed\n")
    return updated, failed

# Process both
print("=== Filling medlab + doctor2 ===\n")
m_up, m_fail = fill_exam("questions-medlab.json", "medlab")
d_up, d_fail = fill_exam("questions-doctor2.json", "doctor2")

print("=== TOTAL ===")
print("Updated: " + str(m_up + d_up))
print("Failed: " + str(m_fail + d_fail))

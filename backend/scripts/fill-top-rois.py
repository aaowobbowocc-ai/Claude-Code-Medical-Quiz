#!/usr/bin/env python3
"""Fill top ROI exams (medlab, doctor2) using Gemini 2.5 Flash (free tier)"""

import json
import time
import requests
from pathlib import Path

ROOT = Path(__file__).parent.parent
QUESTIONS_FILE = ROOT / "questions.json"
KEY_FILE = ROOT / ".gemini-key"
GEMINI_KEY = KEY_FILE.read_text().strip()

with open(QUESTIONS_FILE, encoding='utf-8') as f:
    data = json.load(f)
questions = data.get("questions") or data

# Find incomplete with answer but missing options for medlab and doctor2
incomplete = [
    q for q in questions
    if q.get("incomplete") and q.get("answer") and (
        q.get("subject_tag", "").startswith("med_") or
        q.get("subject_tag", "").startswith("path")
    )
]
has_answer_no_opts = [
    q for q in incomplete
    if sum(1 for v in q.get("options", {}).values() if v and v.strip()) < 4
]

print("Found " + str(len(has_answer_no_opts)) + " medlab/doctor2 incomplete with answer")

def call_gemini(question_text, correct_answer, existing_options):
    """Use Gemini to infer missing options"""
    existing = {k: v for k, v in existing_options.items() if v and v.strip()}
    prompt = f"""Extract missing multiple choice options.

Question: {question_text[:200]}...
Correct answer: {correct_answer}
Existing:
{chr(10).join(f"  {k}: {v}" for k, v in existing.items())}

Return ONLY JSON:
{{"A": "...", "B": "...", "C": "...", "D": "..."}}"""

    payload = {"contents": [{"parts": [{"text": prompt}]}]}
    url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={GEMINI_KEY}"

    try:
        resp = requests.post(url, json=payload, timeout=30)
        if resp.status_code != 200:
            return None
        result = resp.json()
        text = result["candidates"][0]["content"]["parts"][0]["text"]
        import re
        json_match = re.search(r'\{[^{}]*\}', text)
        if not json_match:
            return None
        return json.loads(json_match.group())
    except:
        return None

def main():
    print("\n Processing " + str(len(has_answer_no_opts)) + " (Gemini, 2s between)\n")
    updated = 0
    failed = 0

    for i, q in enumerate(has_answer_no_opts):
        q_num = q.get("number")
        year = q.get("roc_year")
        exam = "medlab" if "med_" in q.get("subject_tag", "") else "doctor2"

        print("[" + str(i+1) + "/" + str(len(has_answer_no_opts)) + "] " + exam + " Q" + str(q_num) + " (" + str(year) + "): ", end="", flush=True)

        options = call_gemini(q.get("question", ""), q.get("answer", ""), q.get("options", {}))

        if not options:
            print("FAIL")
            failed += 1
        else:
            for key in ["A", "B", "C", "D"]:
                if key in options and options[key]:
                    q["options"][key] = options[key]
            q["incomplete"] = False
            print("OK")
            updated += 1

        time.sleep(2)

    if updated > 0:
        if isinstance(data, dict) and "questions" in data:
            data["questions"] = questions
        with open(QUESTIONS_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        print("\n Saved " + str(updated) + " updates")

    print("\n Summary:")
    print("   Updated: " + str(updated))
    print("   Failed:  " + str(failed))

if __name__ == "__main__":
    main()

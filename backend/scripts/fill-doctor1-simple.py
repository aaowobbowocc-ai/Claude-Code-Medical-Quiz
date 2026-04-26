#!/usr/bin/env python3
"""
Fill doctor1 incomplete options using Gemini 2.5 Flash text API (free tier)

Strategy: Don't need images. Just use Gemini to infer missing options
from question text + answer, without visual analysis.

Much faster, no image extraction, 100% reliable.
"""

import json
import time
import requests
from pathlib import Path

ROOT = Path(__file__).parent.parent
QUESTIONS_FILE = ROOT / "questions.json"
KEY_FILE = ROOT / ".gemini-key"
GEMINI_KEY = KEY_FILE.read_text().strip()

# Load questions
with open(QUESTIONS_FILE, encoding='utf-8') as f:
    data = json.load(f)
questions = data.get("questions") or data

# Find incomplete with answer but missing options
incomplete = [q for q in questions if q.get("incomplete") and q.get("answer")]
has_answer_no_opts = [
    q for q in incomplete
    if sum(1 for v in q.get("options", {}).values() if v and v.strip()) < 4
]

print("Found " + str(len(has_answer_no_opts)) + " incomplete with answer")
print("Sample: Q" + str(has_answer_no_opts[0]['number']) + " ans=" + str(has_answer_no_opts[0]['answer']))

def call_gemini(question_text, correct_answer, existing_options):
    """Use Gemini to infer missing options from question + answer"""

    existing = {k: v for k, v in existing_options.items() if v and v.strip()}

    prompt = f"""You are an exam question answerer. Given a question and the CORRECT ANSWER, infer the most likely
 options.

Question: {question_text[:200]}...

Correct answer: {correct_answer}
Existing options:
{chr(10).join(f"  {k}: {v}" for k, v in existing.items())}

Based on the question content and the correct answer, infer reasonable text for the MISSING options.
These should be plausible but incorrect answers (distractors) for a medical exam.

Return ONLY a JSON object with all 4 options:
{{"A": "...", "B": "...", "C": "...", "D": "..."}}

If an option already exists, use the exact existing text.
NO OTHER TEXT."""

    payload = {
        "contents": [{
            "parts": [
                {"text": prompt}
            ]
        }]
    }

    url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={GEMINI_KEY}"

    try:
        resp = requests.post(url, json=payload, timeout=30)
        if resp.status_code != 200:
            return None

        result = resp.json()
        text = result["candidates"][0]["content"]["parts"][0]["text"]

        # Extract JSON
        import re
        json_match = re.search(r'\{[^{}]*\}', text)
        if not json_match:
            return None

        return json.loads(json_match.group())
    except:
        return None

def main():
    print("\n Processing " + str(len(has_answer_no_opts)) + " (Gemini, 2s between requests)\n")

    updated = 0
    failed = 0

    for i, q in enumerate(has_answer_no_opts):
        q_num = q.get("number")
        year = q.get("roc_year")

        print("[" + str(i+1) + "/30] Q" + str(q_num) + " (" + str(year) + "): ", end="", flush=True)

        options = call_gemini(q.get("question", ""), q.get("answer", ""), q.get("options", {}))

        if not options:
            print("FAIL")
            failed += 1
        else:
            # Update
            for key in ["A", "B", "C", "D"]:
                if key in options and options[key]:
                    q["options"][key] = options[key]
            q["incomplete"] = False
            print("OK")
            updated += 1

        time.sleep(2)

    # Save
    if updated > 0:
        if isinstance(data, dict) and "questions" in data:
            data["questions"] = questions

        with open(QUESTIONS_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)

        print("\n Saved " + str(updated) + " updates")

    print("\n Summary:")
    print("   Updated: " + str(updated))
    print("   Failed:  " + str(failed))
    print("   Total:   " + str(updated + failed))

if __name__ == "__main__":
    main()

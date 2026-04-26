#!/usr/bin/env python3
"""
Fill doctor1 incomplete options using Gemini 2.5 Flash (free tier)

Strategy:
  1. Identify PDF files for each incomplete question
  2. Extract page image as base64
  3. Send to Gemini with question context
  4. Parse options from Gemini response
  5. Update questions.json

Rate limit: ~15 req/min (free tier)
"""

import json
import os
import sys
import time
import base64
import re
import requests
from pathlib import Path

# Paths
ROOT = Path(__file__).parent.parent
QUESTIONS_FILE = ROOT / "questions.json"
PDF_CACHE = ROOT / "_tmp" / "pdf-cache-100-105"
KEY_FILE = ROOT / ".gemini-key"
GEMINI_KEY = KEY_FILE.read_text().strip()

# Load questions
with open(QUESTIONS_FILE, encoding='utf-8') as f:
    data = json.load(f)
questions = data.get("questions") or data

# Map exam_code to PDF filename pattern
PDF_PATTERNS = {
    "100030": "100030",
    "100140": "100140",
    "101030": "101030",
    "101110": "101110",
    "102030": "102030",
    "102110": "102110",
    "103030": "103030",
    "103100": "103100",
    "104030": "104030",
    "104090": "104090",
    "105020": "105020",
    "105030": "105030",
    "105090": "105090",
    "105100": "105100",
    "106020": "106020",
}

# Find incomplete doctor1 questions with answers but missing options
incomplete = [q for q in questions if q.get("incomplete") and q.get("answer")]
has_answer_no_opts = [
    q for q in incomplete
    if sum(1 for v in q.get("options", {}).values() if v and v.strip()) < 4
]

print("Found " + str(len(has_answer_no_opts)) + " incomplete questions with answers")
print("Sample: Q" + str(has_answer_no_opts[0]['number']) + " (year " + str(has_answer_no_opts[0]['roc_year']) + ")")

# Get PDF file for a question
def find_pdf(exam_code, question_type="Q"):
    """Find any PDF with matching exam_code"""
    for pdf_file in PDF_CACHE.glob(f"{question_type}_{exam_code}_*.pdf"):
        return pdf_file
    return None

# Extract PDF page as base64 image
def pdf_to_image_base64(pdf_path, page_num=0):
    """Convert PDF page to base64 image"""
    try:
        import fitz  # PyMuPDF
        doc = fitz.open(pdf_path)
        if page_num >= len(doc):
            return None

        pix = doc[page_num].get_pixmap(matrix=fitz.Matrix(1.5, 1.5))
        img_bytes = pix.tobytes("png")
        return base64.b64encode(img_bytes).decode()
    except Exception as e:
        print(f"   PDF extraction error: {e}")
        return None

# Call Gemini API
def call_gemini(image_base64, question_text, current_options):
    """Query Gemini to extract missing options"""

    existing = {k: v for k, v in current_options.items() if v and v.strip()}
    missing_count = 4 - len(existing)

    prompt = f"""This is an exam question. Extract all {missing_count} missing option texts.

Question: {question_text[:120]}...

Current options:
{chr(10).join(f"  {k}: {v[:40]}" for k, v in existing.items())}

Extract the FULL TEXT of the {missing_count} missing option(s) from the image.
Return ONLY a JSON object:
{{"A": "option text", "B": "option text", "C": "option text", "D": "option text"}}
Use null for options you cannot read clearly.
NO OTHER TEXT."""

    payload = {
        "contents": [{
            "parts": [
                {"text": prompt},
                {
                    "inline_data": {
                        "mime_type": "image/png",
                        "data": image_base64
                    }
                }
            ]
        }]
    }

    url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={GEMINI_KEY}"

    try:
        resp = requests.post(url, json=payload, timeout=30)
        if resp.status_code != 200:
            print(f"   Gemini error: {resp.status_code}")
            return None

        result = resp.json()
        text = result["candidates"][0]["content"]["parts"][0]["text"]

        # Extract JSON from response
        json_match = re.search(r'\{[^{}]*\}', text)
        if not json_match:
            return None

        return json.loads(json_match.group())

    except Exception as e:
        print(f"   API error: {e}")
        return None

# Main process
def main():
    print(f"\n Processing {len(has_answer_no_opts)} questions (Gemini free tier, 4s between requests)\n")

    updated = 0
    failed = 0
    skipped = 0

    for i, q in enumerate(has_answer_no_opts[:20]):  # Limit to 20 for demo
        exam_code = q.get("exam_code")
        q_num = q.get("number")
        year = q.get("roc_year")

        # Estimate page (rough: 8 questions per page)
        page_num = max(0, (q_num - 1) // 8)

        print(f"[{i+1}/{min(20, len(has_answer_no_opts))}] Q{q_num} ({year}/{exam_code}) page {page_num}: ", end="", flush=True)

        # Find PDF
        pdf_path = find_pdf(exam_code, question_type="Q")
        if not pdf_path:
            print(" PDF not found")
            skipped += 1
            continue

        # Extract image
        img_base64 = pdf_to_image_base64(pdf_path, page_num)
        if not img_base64:
            print(" Image extraction failed")
            failed += 1
            continue

        # Call Gemini
        print("Gemini...", end="", flush=True)
        options = call_gemini(img_base64, q.get("question", ""), q.get("options", {}))

        if not options:
            print(" ")
            failed += 1
        else:
            # Update question
            for key in ["A", "B", "C", "D"]:
                if key in options and options[key]:
                    q["options"][key] = options[key]
            q["incomplete"] = False
            print(" ")
            updated += 1

        # Respect rate limit
        time.sleep(4)

    # Save updated questions
    if updated > 0:
        if isinstance(data, dict) and "questions" in data:
            data["questions"] = questions
        else:
            data = questions

        with open(QUESTIONS_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)

        print(f"\n Saved {updated} updates to {QUESTIONS_FILE}")

    print(f"\n Summary:")
    print(f"   Updated: {updated}")
    print(f"   Failed:  {failed}")
    print(f"   Skipped: {skipped}")
    print(f"   Total:   {updated + failed + skipped}")

if __name__ == "__main__":
    main()

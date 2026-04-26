#!/usr/bin/env python3
"""免費 Gemini 驗證：檢查改過的題目"""

import json
import requests
import time
from pathlib import Path

ROOT = Path(__file__).parent.parent
KEY_FILE = ROOT / ".gemini-key"
GEMINI_KEY = KEY_FILE.read_text().strip()

def validate_question(question_text, answer, options, correct_option):
    """用 Gemini 驗證單題"""
    prompt = f"""醫學題目驗證。評估此答案的醫學正確性。

【題目】
{question_text[:300]}

【選項】
A) {options.get('A', '')[:80]}
B) {options.get('B', '')[:80]}
C) {options.get('C', '')[:80]}
D) {options.get('D', '')[:80]}

【標示正答】
{answer}) {correct_option[:80]}

評估：
1. 此答案醫學上是否正確？(correct/incorrect/unclear)
2. 信心度 (high/medium/low)
3. 如有誤，簡述正確概念

回傳 JSON：{{"verdict":"correct","confidence":"high","notes":""}}"""

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
    except Exception as e:
        print(f"  ERROR: {e}")
        return None

def main():
    print("=== Gemini 免費驗證（改過的題目）===\n")
    
    # 讀取 doctor1
    with open(ROOT / "questions.json", encoding='utf-8') as f:
        doctor1 = json.load(f)
    questions = doctor1.get("questions", doctor1)
    
    # 目標：改過的題目
    targets = []
    
    # 1. Q2 (ID: 1150205502) - PVN/CRH
    q2 = next((q for q in questions if q.get("id") == "1150205502"), None)
    if q2:
        targets.append(("Q2", q2))
    
    # 2. Q3 (ID: 1150202149) - 胰臟組織
    q3 = next((q for q in questions if q.get("id") == "1150202149"), None)
    if q3:
        targets.append(("Q3", q3))
    
    # 3. 微生物分類樣本 (10 個)
    microbio = [q for q in questions if q.get("subject_tag") == "microbiology"][:10]
    for i, q in enumerate(microbio):
        targets.append((f"microbe-{i+1}", q))
    
    print(f"驗證目標：{len(targets)} 題\n")
    
    # 驗證
    results = []
    for label, q in targets:
        print(f"[{len(results)+1}/{len(targets)}] {label} (Q{q.get('number')}/{q.get('roc_year')}): ", end="", flush=True)
        
        verdict = validate_question(
            q.get("question", ""),
            q.get("answer", ""),
            q.get("options", {}),
            q.get("options", {}).get(q.get("answer", ""), "")
        )
        
        if verdict:
            results.append({
                "label": label,
                "questionId": q.get("id"),
                "number": q.get("number"),
                "year": q.get("roc_year"),
                "subject": q.get("subject_tag"),
                "verdict": verdict.get("verdict"),
                "confidence": verdict.get("confidence"),
                "notes": verdict.get("notes", "")
            })

            status = "[OK]" if verdict.get("verdict") == "correct" else "[?]"
            print(f"{status} {verdict.get('verdict')} ({verdict.get('confidence')})", flush=True)
        else:
            print("FAIL", flush=True)
        
        time.sleep(1.5)  # 速率限制
    
    # 報告
    print(f"\n=== 驗證報告 ===")
    print(f"總驗證：{len(results)} 題")
    
    correct = [r for r in results if r["verdict"] == "correct"]
    incorrect = [r for r in results if r["verdict"] == "incorrect"]
    unclear = [r for r in results if r["verdict"] == "unclear"]

    print(f"[OK] 正確：{len(correct)} 題")
    print(f"[X] 有誤：{len(incorrect)} 題")
    print(f"[?] 不確定：{len(unclear)} 題")

    if incorrect:
        print("\n[X] 有誤的題目：")
        for r in incorrect:
            print(f"  {r['label']} (Q{r['number']})：{r['notes']}")

    if unclear:
        print("\n[?] 需要深度檢查：")
        for r in unclear:
            print(f"  {r['label']} (Q{r['number']})：{r['notes']}")
    
    # 保存結果
    report_path = ROOT / "_tmp" / "gemini-validation-report.json"
    report_path.parent.mkdir(exist_ok=True)
    with open(report_path, "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)

    print(f"\n[OK] 報告已保存：{report_path}")

if __name__ == "__main__":
    main()

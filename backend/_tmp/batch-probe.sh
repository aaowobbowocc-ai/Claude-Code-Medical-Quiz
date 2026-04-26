#!/bin/bash
cd "$(dirname "$0")/.."
# Batch probe several 醫事/特考 exams across years 107-113
# Uses cache so re-runs are fast

KEYWORDS=("語言治療師" "公共衛生師" "牙體技術師" "法醫師" "心理師" "諮商心理師" "臨床心理師" "驗光師" "驗光生")
YEARS="107,108,109,110,111,112,113"
SESSIONS="100,110,111,140"
S_LIST="0101,0201,0301,0401,0501,0601,0701,0801,0901,1001"

for kw in "${KEYWORDS[@]}"; do
  echo "============================="
  echo "  Probing $kw"
  echo "============================="
  node scripts/probe-exam-by-title.js \
    --keyword "$kw" \
    --years "$YEARS" \
    --sessions "$SESSIONS" \
    --c-range 101-120 \
    --s-list "$S_LIST" \
    --concurrency 6 \
    2>&1 | tail -25
  echo
done

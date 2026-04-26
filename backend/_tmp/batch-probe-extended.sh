#!/bin/bash
cd "$(dirname "$0")/.."
# Extend probe to 100-106 and 114-115
KEYWORDS=("聽力師" "語言治療師" "公共衛生師" "牙體技術師" "法醫師" "諮商心理師" "臨床心理師" "驗光師" "驗光生")
YEARS="100,101,102,103,104,105,106,114,115"
# More session codes for old years (130/140) and new years (020/100/110/120)
SESSIONS="010,020,030,080,090,100,110,111,120,130,140"
S_LIST="0101,0201,0301,0401,0501,0601,0701,0801,0901,1001,11,22,33,44,55,66"
for kw in "${KEYWORDS[@]}"; do
  echo "============================="
  echo "  Probing $kw (100-106,114-115)"
  echo "============================="
  node scripts/probe-exam-by-title.js \
    --keyword "$kw" \
    --years "$YEARS" \
    --sessions "$SESSIONS" \
    --c-range 101-120 \
    --s-list "$S_LIST" \
    --concurrency 8 \
    2>&1 | tail -15
  echo
done

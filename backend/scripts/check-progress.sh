#!/bin/bash
OUTPUT_FILE="C:\Users\USER\AppData\Local\Temp\claude\c--Users-USER-Desktop-----\b33b3a58-3572-4172-ab8e-18783aec54b1\tasks\bwcc8lv2y.output"
for i in {1..30}; do
  if [ -f "$OUTPUT_FILE" ]; then
    LINES=$(wc -l < "$OUTPUT_FILE" 2>/dev/null || echo "0")
    echo "Progress: $LINES lines ($(($i * 10)) seconds)"
    tail -2 "$OUTPUT_FILE" 2>/dev/null
  fi
  if grep -q "TOTAL:" "$OUTPUT_FILE" 2>/dev/null; then
    echo "Complete!"
    break
  fi
  sleep 10
done

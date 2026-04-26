#!/bin/bash
set -e
IMGDIR=_tmp/ocr_imgs
OUTDIR=_tmp/ocr_json
LOG=_tmp/ocr_batch.log
> "$LOG"
for pair in "tcm1_102-2_basic2_Q_p5:tcm1_p5" "tcm1_102-2_basic2_Q_p6:tcm1_p6" "tcm1_102-2_basic2_Q_p7:tcm1_p7" "tcm1_102-2_basic2_Q_p8:tcm1_p8" "tcm1_102-2_basic2_Q_p9:tcm1_p9" "tcm1_102-2_basic2_Q_p10:tcm1_p10" "nursing_108-1_psych_Q_p2:nursing_p2" "nursing_108-1_psych_Q_p3:nursing_p3" "nursing_108-1_psych_Q_p4:nursing_p4" "nursing_108-1_psych_Q_p5:nursing_p5" "nursing_108-1_psych_Q_p6:nursing_p6" "nursing_108-1_psych_Q_p7:nursing_p7" "nursing_108-1_psych_Q_p8:nursing_p8"; do
  SRC="${pair%%:*}"
  DST="${pair##*:}"
  if [ -f "$OUTDIR/$DST.json" ]; then
    echo "[skip] $DST.json exists" >> "$LOG"
    continue
  fi
  echo "[start] $(date +%H:%M:%S) $SRC" >> "$LOG"
  python scripts/ocr-page.py "$IMGDIR/$SRC.png" "$OUTDIR/$DST.json" >> "$LOG" 2>&1 || { echo "[FAIL] $SRC" >> "$LOG"; }
  echo "[done] $(date +%H:%M:%S) $DST" >> "$LOG"
done
echo "[ALL DONE] $(date +%H:%M:%S)" >> "$LOG"

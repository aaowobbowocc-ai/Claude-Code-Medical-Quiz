#!/usr/bin/env bash
# 全站跑 repair-stem-ate-option.js --all：**每個考試開一個 node process**。
#
# 一口氣跑會壞：mupdf 的 document handle 不釋放，跑到一定量之後整批
# 「原卷取不到」，最後在 fz_drop_page 崩掉（2026-10-22 實測只跑完 3 個考試）。
# 同一個坑見 run-foreign-audit.sh。
#
#   bash scripts/run-split-repair.sh [--apply]
set -u
cd "$(dirname "$0")/.."
APPLY="${1:-}"

SKIP="gsat ast driver-car driver-moto post-indoor post-outdoor railway-admin railway-transport
state-finance state-hr state-it state-mgmt teacher-elementary teacher-kindergarten
teacher-secondary teacher-special teacher-special-gifted"

for e in $(ls questions*.json | sed -e 's/^questions-//' -e 's/^questions\.json$/doctor1/' -e 's/\.json$//'); do
  case " $SKIP " in *" $e "*) continue;; esac
  out=$(node scripts/repair-stem-ate-option.js --all "--exam=$e" $APPLY 2>&1 | grep -E '^重建|^跳過')
  echo "── $e"
  echo "$out" | sed 's/^/   /'
done

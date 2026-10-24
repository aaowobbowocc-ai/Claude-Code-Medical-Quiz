#!/usr/bin/env bash
# 全站跑 repair-options-not-in-paper.js：**每個考試開一個 node process**。
# 一口氣跑會壞（mupdf 的 document handle 不釋放），同一個坑見 run-foreign-audit.sh。
#
#   bash scripts/run-option-repair.sh [--apply]
set -u
cd "$(dirname "$0")/.."
APPLY="${1:-}"

SKIP="gsat ast driver-car driver-moto post-indoor post-outdoor railway-admin railway-transport
state-finance state-hr state-it state-mgmt teacher-elementary teacher-kindergarten
teacher-secondary teacher-special teacher-special-gifted"

for e in $(ls questions*.json | sed -e 's/^questions-//' -e 's/^questions\.json$/doctor1/' -e 's/\.json$//'); do
  case " $SKIP " in *" $e "*) continue;; esac
  echo "── $e"
  node scripts/repair-options-not-in-paper.js "--exam=$e" $APPLY 2>&1 | grep -E '^重建|^跳過' | sed 's/^/   /'
done

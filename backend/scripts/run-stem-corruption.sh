#!/usr/bin/env bash
# 全站跑 audit-stem-corruption.js：每個考試開一個 node process。
# 理由同 run-foreign-audit.sh——mupdf 的 document handle 不會釋放，
# 一口氣跑到 600 多卷之後會整批假性失敗。
#
#   bash scripts/run-stem-corruption.sh
#
# 結果：_tmp/stem-corruption-<exam>.json ＋ _tmp/stem-corruption-<exam>.log
set -u
cd "$(dirname "$0")/.."

SKIP="gsat ast driver-car driver-moto post-indoor post-outdoor railway-admin railway-transport
state-finance state-hr state-it state-mgmt teacher-elementary teacher-kindergarten
teacher-secondary teacher-special teacher-special-gifted"

exams=$(ls questions*.json | sed -e 's/^questions-//' -e 's/^questions\.json$/doctor1/' -e 's/\.json$//')

for e in $exams; do
  case " $SKIP " in *" $e "*) continue;; esac
  if [ -s "_tmp/stem-corruption-$e.json" ]; then
    echo "· $e 已有結果，跳過"
    continue
  fi
  echo "── $e"
  node scripts/audit-stem-corruption.js "--exam=$e" > "_tmp/stem-corruption-$e.log" 2>&1
  if [ -s "_tmp/stem-corruption-$e.json" ]; then
    grep -E '^判了|^覆蓋率' "_tmp/stem-corruption-$e.log" | sed 's/^/   /'
  else
    echo "   ✗ 沒有產出，看 _tmp/stem-corruption-$e.log"
  fi
done

echo
echo "===== 彙總 ====="
node -e '
const fs=require("fs");
const all=[];
for(const f of fs.readdirSync("_tmp").filter(x=>/^stem-corruption-.+\.json$/.test(x)))
  all.push(...JSON.parse(fs.readFileSync("_tmp/"+f,"utf8")));
all.sort((a,b)=>a.cover-b.cover);
fs.writeFileSync("_tmp/stem-corruption-all.json",JSON.stringify(all,null,1));
const plain=all.filter(r=>!r.group);
console.log(`覆蓋率偏低 ${all.length} 題（題組題 ${all.length-plain.length} 題另計，非題組 ${plain.length} 題）`);
const by={};for(const r of plain)by[r.exam]=(by[r.exam]||0)+1;
for(const [k,v] of Object.entries(by).sort((a,b)=>b[1]-a[1])) console.log(`  ${String(v).padStart(4)}  ${k}`);
console.log("📄 _tmp/stem-corruption-all.json");
'

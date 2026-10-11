#!/usr/bin/env bash
# 全站跑 audit-foreign-questions.js：**每個考試開一個 node process**。
#
# 為什麼不能一口氣跑：mupdf 的 document handle 沒釋放，跑到 600 多卷之後
# pdfStems 開始整批失敗（實測 2,537/3,175 卷報「解析不足」，其實是記憶體爆了），
# 最後在 fz_drop_page 崩掉。每個考試各一個 process 就不會累積。
#
#   bash scripts/run-foreign-audit.sh
#
# 結果：_tmp/foreign-questions-<exam>.json（逐考試）＋ _tmp/foreign-audit-<exam>.log
set -u
cd "$(dirname "$0")/.."

SKIP="gsat ast driver-car driver-moto post-indoor post-outdoor railway-admin railway-transport
state-finance state-hr state-it state-mgmt teacher-elementary teacher-kindergarten
teacher-secondary teacher-special teacher-special-gifted"

exams=$(ls questions*.json | sed -e 's/^questions-//' -e 's/^questions\.json$/doctor1/' -e 's/\.json$//')

for e in $exams; do
  case " $SKIP " in *" $e "*) continue;; esac
  if [ -s "_tmp/foreign-questions-$e.json" ]; then
    echo "· $e 已有結果，跳過（要重跑先刪 _tmp/foreign-questions-$e.json）"
    continue
  fi
  echo "── $e"
  node scripts/audit-foreign-questions.js "--exam=$e" > "_tmp/foreign-audit-$e.log" 2>&1
  # mupdf 常在 process 結束時才崩，那時結果已經寫出來了，所以看檔案不看 exit code
  if [ -s "_tmp/foreign-questions-$e.json" ]; then
    grep -E '^掃過|^題幹在自己卷上' "_tmp/foreign-audit-$e.log" | sed 's/^/   /'
    grep -F '（同場次同題號）' "_tmp/foreign-audit-$e.log" | sed 's/^/   ⚠ /'
  else
    echo "   ✗ 沒有產出，看 _tmp/foreign-audit-$e.log"
  fi
done

echo
echo "===== 彙總 ====="
node -e '
const fs=require("fs");
const all=[];
for(const f of fs.readdirSync("_tmp").filter(x=>/^foreign-questions-.+\.json$/.test(x)))
  all.push(...JSON.parse(fs.readFileSync("_tmp/"+f,"utf8")));
fs.writeFileSync("_tmp/foreign-questions-all.json",JSON.stringify(all,null,1));
const strong=all.filter(r=>r.sameCodeDonor.length);
console.log(`題幹在自己卷上找不到 ${all.length} 題；同場次同題號有來源（強簽章）${strong.length} 題`);
for(const r of strong) console.log(`  ${r.exam} ${r.code} ${r.subject} #${r.n}  ← ${r.sameCodeDonor[0]}`);
console.log("📄 _tmp/foreign-questions-all.json");
'

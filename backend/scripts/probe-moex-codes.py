"""反查考選部某年度某場次的「類科碼 c / 科目碼 s」。

為什麼需要：舊年度的類科碼與現行**完全不同**（例如營養師現行 c=102，
107 年是 c=103），科目碼也整組位移（現行 0204=營養學，107 年 0202=營養學）。
直接沿用現行參數打 wHandExamQandA_File.ashx 一律 302，抓不到卷。

用法：
  python scripts/probe-moex-codes.py <西元年> <場次碼> [類科關鍵字]
例：
  python scripts/probe-moex-codes.py 2018 107030 營養
  → c=103 s=0202  營養學

場次碼不知道的話，先只帶年份跑 moex 搜尋頁的場次清單（見 --help 或直接看輸出）。
"""
import re, urllib.request, urllib.parse, http.cookiejar, sys
BASE="https://wwwq.moex.gov.tw/exam/wFrmExamQandASearch.aspx"
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
cj=http.cookiejar.CookieJar()
op=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
op.addheaders=[("User-Agent",UA),("Referer",BASE)]
def get(u): return op.open(u,timeout=40).read().decode("utf-8","replace")
def post(u,d):
    r=urllib.request.Request(u,data=urllib.parse.urlencode(d,encoding="utf-8").encode(),
        headers={"Content-Type":"application/x-www-form-urlencoded","User-Agent":UA,"Referer":BASE})
    return op.open(r,timeout=60).read().decode("utf-8","replace")
def hid(h):
    return {m.group(1):m.group(2) for m in re.finditer(r'<input type="hidden" name="([^"]+)"[^>]*value="([^"]*)"',h)}

if len(sys.argv) < 3:
    print(__doc__)
    sys.exit(1)
ad, code, kw = sys.argv[1], sys.argv[2], (sys.argv[3] if len(sys.argv) > 3 else None)
h=get(BASE); f=hid(h)
Y1="ctl00$holderContent$wUctlExamYearStart$ddlExamYear"; Y2="ctl00$holderContent$wUctlExamYearEnd$ddlExamYear"
CODE="ctl00$holderContent$ddlExamCode"
for t in (Y1,Y2):
    f.update({Y1:ad,Y2:ad,"__EVENTTARGET":t,"__EVENTARGUMENT":""}); h=post(BASE,f); f.update(hid(h))
f.update({Y1:ad,Y2:ad,CODE:code,"__EVENTTARGET":CODE,"__EVENTARGUMENT":""})
h=post(BASE,f); f.update(hid(h))
# 送出查詢
f.update({Y1:ad,Y2:ad,CODE:code,"__EVENTTARGET":"","__EVENTARGUMENT":"",
          "ctl00$holderContent$btnSearch":"查詢"})
h=post(BASE,f)
print("結果頁長度:",len(h))
links=set(re.findall(r'wHandExamQandA_File\.ashx\?t=(\w+)&(?:amp;)?code=(\d+)&(?:amp;)?c=(\d+)&(?:amp;)?s=(\w+)',h))
print("找到檔案連結:",len(links))
# 連結旁的文字（類科/科目名稱）
rows=re.findall(r'<tr[^>]*>(.*?)</tr>',h,re.S)
for r in rows:
    if 'wHandExamQandA_File' not in r: continue
    txt=re.sub(r'<[^>]+>',' ',r); txt=re.sub(r'\s+',' ',txt).strip()
    m=re.search(r'code=(\d+)&(?:amp;)?c=(\d+)&(?:amp;)?s=(\w+)',r)
    if not m: continue
    if kw and kw not in txt: continue
    print(f"  c={m.group(2)} s={m.group(3)}  {txt[:90]}")

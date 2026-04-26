const https = require('https')
const agent = new https.Agent({ rejectUnauthorized: false })
const pdfParse = require('pdf-parse')

function get(url) {
  return new Promise((res, rej) => {
    https.get(url, { agent }, r => {
      if (r.statusCode !== 200) return rej(new Error('HTTP ' + r.statusCode))
      const cs = []; r.on('data', c => cs.push(c)); r.on('end', () => res(Buffer.concat(cs)))
    }).on('error', rej)
  })
}

async function findAudio(code) {
  // Try c=101-115 with typical s codes for medical exam
  for (const c of ['101','102','103','104','105','106','107','108','109','110','111','112','113','114','115']) {
    for (const s of ['0101','0102','0103','0104','0105','0106']) {
      const url = `https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx?t=Q&code=${code}&c=${c}&s=${s}&q=1`
      try {
        const buf = await get(url)
        const { text } = await pdfParse(buf)
        const head = text.slice(0, 500)
        if (/類科名稱[：:]\s*聽力師/.test(head)) {
          const subj = head.match(/科[目\s]*[：:][^\n]+/)
          const cls = head.match(/類[科名稱\s]*[：:][^\n]+/)
          console.log('✓', code, 'c=' + c, 's=' + s, '|', cls?.[0]?.slice(0,40), '|', subj?.[0]?.slice(0,60))
        }
      } catch {}
    }
  }
}

;(async () => {
  // Try many sessions across recent years — 聽力師 might be in any combined high-exam
  const codes = []
  for (const yr of ['110','111','112','113','114','115']) {
    for (const sfx of ['010','020','030','040','050','060','070','080','090','100','110','120']) {
      codes.push(yr + sfx)
    }
  }
  for (const code of codes) {
    await findAudio(code)
  }
})()

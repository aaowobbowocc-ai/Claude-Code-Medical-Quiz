/**
 * Unified PDF fetching module
 * Consolidates HTTP download, 302/301 redirect handling, retry logic, and caching
 */

const https = require('https')
const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/**
 * Fetch a PDF from URL with retry logic and 302/301 redirect handling
 * @param {string} url - PDF URL
 * @param {object} opts - Options
 * @param {number} opts.retries - Retry count on non-200 (default: 2)
 * @param {number} opts.timeout - Request timeout in ms (default: 20000)
 * @param {string} opts.userAgent - User-Agent header (default: Chrome 131)
 * @param {string} opts.referer - Referer header (optional)
 * @returns {Promise<Buffer>} PDF buffer
 */
function fetchPdf(url, opts = {}) {
  const {
    retries = 2,
    timeout = 20000,
    userAgent = DEFAULT_USER_AGENT,
    referer = null,
  } = opts

  return new Promise((resolve, reject) => {
    const httpOpts = {
      rejectUnauthorized: false,
      timeout,
      headers: {
        'User-Agent': userAgent,
        'Accept': 'application/pdf,*/*',
        'Accept-Language': 'zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7',
      },
    }
    if (referer) httpOpts.headers['Referer'] = referer

    const req = https.get(url, httpOpts, (res) => {
      // Handle redirects
      if (res.statusCode === 302 || res.statusCode === 301) {
        let loc = res.headers.location
        res.resume()
        if (loc && !loc.startsWith('http')) {
          return reject(new Error(`Redirect to ${loc}`))
        }
        if (!loc) return reject(new Error(`Redirect without location`))
        // Recurse into redirect URL
        return fetchPdf(loc, opts).then(resolve, reject)
      }

      if (res.statusCode !== 200) {
        res.resume()
        if (retries > 0) {
          return setTimeout(
            () => fetchPdf(url, { ...opts, retries: retries - 1 }).then(resolve, reject),
            1000
          )
        }
        return reject(new Error(`HTTP ${res.statusCode}`))
      }

      // Validate content type
      const contentType = res.headers['content-type'] || ''
      if (!contentType.includes('pdf') && !contentType.includes('octet')) {
        res.resume()
        return reject(new Error(`Not PDF: ${contentType}`))
      }

      // Stream into buffer
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve(Buffer.concat(chunks)))
      res.on('error', reject)
    })

    req.on('error', (e) => {
      if (retries > 0) {
        return setTimeout(
          () => fetchPdf(url, { ...opts, retries: retries - 1 }).then(resolve, reject),
          1000
        )
      }
      reject(e)
    })

    req.on('timeout', () => {
      req.destroy()
      reject(new Error('timeout'))
    })
  })
}

/**
 * Validate PDF content by checking for expected exam name keywords
 * @param {Buffer} buf - PDF buffer
 * @param {string} keyword - Expected exam name (e.g., "護理師", "醫事檢驗師")
 * @param {object} opts - Options
 * @param {function} opts.textExtractor - Function to extract text from PDF (e.g., pdfParse)
 * @returns {Promise<boolean>} True if keyword found in first ~200 chars
 * @throws {Error} If keyword not found (possible class code mismatch)
 */
async function validateExamName(buf, keyword, opts = {}) {
  const { textExtractor = null } = opts

  if (!textExtractor) {
    throw new Error('validateExamName: textExtractor function required')
  }

  try {
    const data = await textExtractor(buf)
    const text = data.text || String(data)
    const snippet = text.substring(0, 300)

    if (snippet.includes(keyword)) {
      return true
    }
    throw new Error(`Exam name mismatch: expected "${keyword}" not found in PDF`)
  } catch (e) {
    throw new Error(`validateExamName failed: ${e.message}`)
  }
}

/**
 * Fetch PDF with optional file cache
 * @param {string} url - PDF URL
 * @param {string} cacheDir - Directory to cache PDFs (e.g., '_tmp/pdf-cache')
 * @param {object} opts - fetchPdf options (retries, timeout, etc.)
 * @returns {Promise<Buffer>} PDF buffer
 */
async function cachedFetch(url, cacheDir, opts = {}) {
  if (!cacheDir) {
    return fetchPdf(url, opts)
  }

  // Create cache directory if it doesn't exist
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true })
  }

  // Generate cache key from URL (use safe filename)
  const cacheKey = Buffer.from(url).toString('base64').replace(/[/+=]/g, '_').substring(0, 60)
  const cachePath = path.join(cacheDir, `${cacheKey}.pdf`)

  // Return from cache if exists
  if (fs.existsSync(cachePath)) {
    return fs.readFileSync(cachePath)
  }

  // Fetch and cache
  const buf = await fetchPdf(url, opts)
  fs.writeFileSync(cachePath, buf)
  return buf
}

/**
 * Build MoEX (考選部) URL for exam questions/answers
 * @param {string} type - 'Q' (questions), 'S' (answers), 'M' (corrections)
 * @param {string} code - Exam code (e.g., "114030")
 * @param {string} classCode - Class code (e.g., "101" for nursing)
 * @param {string} subjectCode - Subject code (e.g., "0101")
 * @returns {string} Full URL
 */
function buildMoexUrl(type, code, classCode, subjectCode) {
  const baseUrl = 'https://wwwq.moex.gov.tw/exam/wHandExamQandA_File.ashx'
  return `${baseUrl}?t=${type}&code=${code}&c=${classCode}&s=${subjectCode}&q=1`
}

module.exports = {
  fetchPdf,
  validateExamName,
  cachedFetch,
  buildMoexUrl,
  DEFAULT_USER_AGENT,
}

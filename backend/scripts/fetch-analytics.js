#!/usr/bin/env node
/**
 * GA4 + GSC fetcher (OAuth Desktop App flow).
 *
 * First run: opens browser, you log in with the Google account that has
 *   GA4/GSC access. Token saved to backend/gcp-token.json.
 * Subsequent runs: silent — uses refresh token.
 *
 * Auto-discovers your GA4 properties and GSC sites; no env vars needed.
 * If you have multiple, pass --ga4-property=XXX or --gsc-site=YYY to pick.
 */
const fs = require('fs')
const path = require('path')
const { google } = require('googleapis')
const { authenticate } = require('@google-cloud/local-auth')

const SCOPES = [
  'https://www.googleapis.com/auth/analytics.readonly',
  'https://www.googleapis.com/auth/webmasters.readonly',
]

const KEY_PATH = path.join(__dirname, '..', 'gcp-oauth.json')
const TOKEN_PATH = path.join(__dirname, '..', 'gcp-token.json')

const args = process.argv.slice(2)
const getArg = name => {
  const a = args.find(x => x.startsWith('--' + name + '='))
  return a ? a.split('=')[1] : null
}

async function loadAuth() {
  if (fs.existsSync(TOKEN_PATH)) {
    const credentials = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf-8'))
    const keyFile = JSON.parse(fs.readFileSync(KEY_PATH, 'utf-8'))
    const key = keyFile.installed || keyFile.web
    const client = new google.auth.OAuth2(
      key.client_id, key.client_secret,
      key.redirect_uris ? key.redirect_uris[0] : 'http://localhost'
    )
    client.setCredentials(credentials)
    return client
  }
  console.log('🔑 First run — opening browser for OAuth login…')
  console.log('   (Log in with your Google account that has GA4 + GSC access)')
  const client = await authenticate({ keyfilePath: KEY_PATH, scopes: SCOPES })
  if (client.credentials) {
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(client.credentials, null, 2))
    console.log('✅ Token saved to', path.relative(process.cwd(), TOKEN_PATH))
  }
  return client
}

async function discoverGA4Properties(auth) {
  const admin = google.analyticsadmin({ version: 'v1beta', auth })
  const accounts = await admin.accounts.list()
  const allProps = []
  for (const acc of accounts.data.accounts || []) {
    const props = await admin.properties.list({ filter: `parent:${acc.name}` })
    for (const p of props.data.properties || []) {
      allProps.push({
        propertyId: p.name.split('/')[1],
        displayName: p.displayName,
        accountName: acc.displayName,
      })
    }
  }
  return allProps
}

async function discoverGSCSites(auth) {
  const sc = google.searchconsole({ version: 'v1', auth })
  const r = await sc.sites.list()
  return (r.data.siteEntry || []).map(s => ({
    siteUrl: s.siteUrl,
    permissionLevel: s.permissionLevel,
  }))
}

async function fetchGA4(auth, propertyId) {
  const data = google.analyticsdata({ version: 'v1beta', auth })
  const property = `properties/${propertyId}`
  const dr28 = [{ startDate: '28daysAgo', endDate: 'today' }]

  const pages = await data.properties.runReport({
    property,
    requestBody: {
      dateRanges: dr28,
      dimensions: [{ name: 'pagePath' }, { name: 'pageTitle' }],
      metrics: [
        { name: 'screenPageViews' },
        { name: 'activeUsers' },
        { name: 'userEngagementDuration' },
        { name: 'engagementRate' },
      ],
      orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
      limit: 30,
    },
  })

  const traffic = await data.properties.runReport({
    property,
    requestBody: {
      dateRanges: dr28,
      dimensions: [{ name: 'sessionDefaultChannelGroup' }, { name: 'sessionSource' }],
      metrics: [{ name: 'sessions' }, { name: 'engagementRate' }, { name: 'activeUsers' }],
      orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
      limit: 20,
    },
  })

  const country = await data.properties.runReport({
    property,
    requestBody: {
      dateRanges: dr28,
      dimensions: [{ name: 'country' }],
      metrics: [{ name: 'activeUsers' }, { name: 'sessions' }],
      orderBys: [{ metric: { metricName: 'activeUsers' }, desc: true }],
      limit: 10,
    },
  })

  const daily = await data.properties.runReport({
    property,
    requestBody: {
      dateRanges: dr28,
      dimensions: [{ name: 'date' }],
      metrics: [{ name: 'activeUsers' }, { name: 'sessions' }, { name: 'screenPageViews' }],
      orderBys: [{ dimension: { dimensionName: 'date' } }],
    },
  })

  const device = await data.properties.runReport({
    property,
    requestBody: {
      dateRanges: dr28,
      dimensions: [{ name: 'deviceCategory' }],
      metrics: [{ name: 'activeUsers' }, { name: 'sessions' }, { name: 'engagementRate' }],
    },
  })

  // ★ exam-level traffic via content_group (set by useDocumentMeta on each route)
  const exams = await data.properties.runReport({
    property,
    requestBody: {
      dateRanges: dr28,
      dimensions: [{ name: 'contentGroup' }],
      metrics: [
        { name: 'screenPageViews' },
        { name: 'activeUsers' },
        { name: 'engagementRate' },
        { name: 'userEngagementDuration' },
      ],
      orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
      limit: 50,
    },
  })

  // Drill: full page_title (no truncation) per content_group
  const titlesByExam = await data.properties.runReport({
    property,
    requestBody: {
      dateRanges: dr28,
      dimensions: [{ name: 'contentGroup' }, { name: 'pageTitle' }],
      metrics: [{ name: 'screenPageViews' }],
      orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
      limit: 100,
    },
  })

  return {
    pages: pages.data, traffic: traffic.data, country: country.data,
    daily: daily.data, device: device.data,
    exams: exams.data, titlesByExam: titlesByExam.data,
  }
}

async function fetchGSC(auth, siteUrl) {
  const sc = google.searchconsole({ version: 'v1', auth })
  const today = new Date()
  const start = new Date(today.getTime() - 90 * 24 * 60 * 60 * 1000)
  const fmt = d => d.toISOString().slice(0, 10)
  const dr = { startDate: fmt(start), endDate: fmt(today) }

  const queries = await sc.searchanalytics.query({
    siteUrl,
    requestBody: { ...dr, dimensions: ['query'], rowLimit: 200 },
  })

  const pages = await sc.searchanalytics.query({
    siteUrl,
    requestBody: { ...dr, dimensions: ['page'], rowLimit: 100 },
  })

  const queryByPage = await sc.searchanalytics.query({
    siteUrl,
    requestBody: { ...dr, dimensions: ['page', 'query'], rowLimit: 500 },
  })

  const country = await sc.searchanalytics.query({
    siteUrl,
    requestBody: { ...dr, dimensions: ['country'], rowLimit: 10 },
  })

  return { queries: queries.data, pages: pages.data, queryByPage: queryByPage.data, country: country.data }
}

function summarizeGA4(d) {
  const totalViews = d.pages.rows?.reduce((s, r) => s + Number(r.metricValues[0].value), 0) || 0
  const totalUsers = d.daily.rows?.reduce((s, r) => s + Number(r.metricValues[0].value), 0) || 0
  console.log('\n--- GA4 (last 28 days) ---')
  console.log('Total page views:', totalViews.toLocaleString())
  console.log('Cumulative active users:', totalUsers.toLocaleString())

  console.log('\nTop 10 pages:')
  ;(d.pages.rows || []).slice(0, 10).forEach((r, i) => {
    const path = r.dimensionValues[0].value
    const title = r.dimensionValues[1].value.slice(0, 30)
    const views = r.metricValues[0].value
    const users = r.metricValues[1].value
    const engagementRate = (Number(r.metricValues[3].value) * 100).toFixed(1)
    console.log(`  ${(i + 1).toString().padStart(2)} ${path.padEnd(40).slice(0, 40)} | ${views.toString().padStart(5)} views | ${users.toString().padStart(4)} users | ${engagementRate}%`)
  })

  console.log('\nTraffic acquisition:')
  ;(d.traffic.rows || []).slice(0, 10).forEach(r => {
    const ch = r.dimensionValues[0].value
    const src = r.dimensionValues[1].value
    const sessions = r.metricValues[0].value
    console.log(`  ${ch.padEnd(20)} ${src.padEnd(25)} ${sessions.toString().padStart(5)} sessions`)
  })

  console.log('\nCountry:')
  ;(d.country.rows || []).slice(0, 5).forEach(r => {
    console.log(`  ${r.dimensionValues[0].value.padEnd(20)} ${r.metricValues[0].value} users`)
  })

  console.log('\n★ Exam (content_group) traffic — 撇除首頁的真實熱門考試:')
  ;(d.exams.rows || []).slice(0, 20).forEach((r, i) => {
    const cg = r.dimensionValues[0].value || '(none)'
    const views = r.metricValues[0].value
    const users = r.metricValues[1].value
    const er = (Number(r.metricValues[2].value) * 100).toFixed(1)
    const eng = Number(r.metricValues[3].value)
    const minPerUser = users > 0 ? (eng / users / 60).toFixed(1) : '-'
    console.log(`  ${(i + 1).toString().padStart(2)} ${cg.padEnd(20).slice(0, 20)} | ${views.toString().padStart(5)} views | ${users.toString().padStart(4)} users | ER ${er}% | ${minPerUser} min/user`)
  })

  console.log('\nDevice:')
  ;(d.device.rows || []).forEach(r => {
    console.log(`  ${r.dimensionValues[0].value.padEnd(10)} ${r.metricValues[0].value} users  ${(Number(r.metricValues[2].value) * 100).toFixed(1)}% engaged`)
  })
}

function summarizeGSC(d) {
  const totalClicks = d.queries.rows?.reduce((s, r) => s + r.clicks, 0) || 0
  const totalImpressions = d.queries.rows?.reduce((s, r) => s + r.impressions, 0) || 0
  console.log('\n--- GSC (last 90 days) ---')
  console.log('Total clicks:', totalClicks.toLocaleString())
  console.log('Total impressions:', totalImpressions.toLocaleString())
  if (totalImpressions > 0) {
    console.log('Avg CTR:', (totalClicks / totalImpressions * 100).toFixed(2) + '%')
  }

  console.log('\nTop 20 queries (by impressions):')
  const byImp = (d.queries.rows || []).slice().sort((a, b) => b.impressions - a.impressions).slice(0, 20)
  byImp.forEach((r, i) => {
    console.log(`  ${(i + 1).toString().padStart(2)} ${r.keys[0].padEnd(35).slice(0, 35)} | ${r.impressions.toString().padStart(5)} imp | ${r.clicks.toString().padStart(4)} clicks | CTR ${(r.ctr * 100).toFixed(1)}% | pos ${r.position.toFixed(1)}`)
  })

  console.log('\nTop 10 queries (by clicks):')
  const byClicks = (d.queries.rows || []).slice().sort((a, b) => b.clicks - a.clicks).slice(0, 10)
  byClicks.forEach((r, i) => {
    console.log(`  ${(i + 1).toString().padStart(2)} ${r.keys[0].padEnd(35).slice(0, 35)} | ${r.clicks.toString().padStart(4)} clicks | pos ${r.position.toFixed(1)}`)
  })

  console.log('\nNear-miss queries (pos 5-15, high impressions — SEO opportunity):')
  const opp = (d.queries.rows || []).filter(r => r.position >= 5 && r.position <= 15 && r.impressions >= 20).sort((a, b) => b.impressions - a.impressions).slice(0, 15)
  opp.forEach(r => {
    console.log(`  ${r.keys[0].padEnd(35).slice(0, 35)} | ${r.impressions} imp | pos ${r.position.toFixed(1)}`)
  })
}

async function main() {
  const auth = await loadAuth()

  console.log('\n📊 Discovering accessible GA4 properties + GSC sites…')
  const [props, sites] = await Promise.all([
    discoverGA4Properties(auth).catch(e => { console.error('GA4 discover failed:', e.message); return [] }),
    discoverGSCSites(auth).catch(e => { console.error('GSC discover failed:', e.message); return [] }),
  ])

  console.log('\nGA4 properties:')
  props.forEach(p => console.log(`  - id=${p.propertyId}  ${p.displayName}  (${p.accountName})`))
  console.log('\nGSC sites:')
  sites.forEach(s => console.log(`  - ${s.siteUrl}  (${s.permissionLevel})`))

  let propertyId = getArg('ga4-property') || (props[0] && props[0].propertyId)
  let siteUrl = getArg('gsc-site') || (sites[0] && sites[0].siteUrl)

  if (!propertyId) { console.error('No GA4 property accessible'); process.exit(1) }
  if (!siteUrl) { console.error('No GSC site accessible'); process.exit(1) }

  console.log(`\n→ Using GA4 property: ${propertyId}`)
  console.log(`→ Using GSC site: ${siteUrl}`)

  const ga4 = await fetchGA4(auth, propertyId)
  const gsc = await fetchGSC(auth, siteUrl)

  const date = new Date().toISOString().slice(0, 10)
  const dir = path.join(__dirname, '..', '_tmp', 'ga-snapshot', date)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'ga4.json'), JSON.stringify(ga4, null, 2))
  fs.writeFileSync(path.join(dir, 'gsc.json'), JSON.stringify(gsc, null, 2))
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ propertyId, siteUrl, date, props, sites }, null, 2))
  console.log(`\n✅ Saved snapshots to _tmp/ga-snapshot/${date}/`)

  summarizeGA4(ga4)
  summarizeGSC(gsc)
}

main().catch(e => { console.error('\n❌ Error:', e.message); if (e.errors) console.error(JSON.stringify(e.errors, null, 2)); process.exit(1) })

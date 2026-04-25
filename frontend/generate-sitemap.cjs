#!/usr/bin/env node
/**
 * Generate sitemap.xml from exam-configs-snapshot + static routes.
 * Runs after build-shells.cjs so all /<examId>/ pages exist.
 *
 * Output: dist/sitemap.xml (overrides public/sitemap.xml in build).
 * Also writes back to public/sitemap.xml so it survives between builds.
 */
const fs = require('fs')
const path = require('path')

const ROOT = 'https://examking.tw'
const DIST = path.resolve(__dirname, 'dist')
const PUBLIC = path.resolve(__dirname, 'public')
const SNAPSHOT = path.resolve(__dirname, 'src', 'exam-configs-snapshot')

const STATIC_ROUTES = [
  { path: '/', priority: 1.0, changefreq: 'weekly' },
  { path: '/browse', priority: 0.8, changefreq: 'monthly' },
  { path: '/practice', priority: 0.8, changefreq: 'monthly' },
  { path: '/mock-exam', priority: 0.8, changefreq: 'monthly' },
  { path: '/weakness', priority: 0.7, changefreq: 'monthly' },
  { path: '/map', priority: 0.7, changefreq: 'monthly' },
  { path: '/leaderboard', priority: 0.6, changefreq: 'weekly' },
  { path: '/board', priority: 0.6, changefreq: 'weekly' },
  { path: '/notes', priority: 0.6, changefreq: 'weekly' },
  { path: '/history', priority: 0.5, changefreq: 'monthly' },
  { path: '/favorites', priority: 0.5, changefreq: 'monthly' },
  { path: '/changelog', priority: 0.5, changefreq: 'weekly' },
  { path: '/coverage', priority: 0.5, changefreq: 'monthly' },
  { path: '/privacy', priority: 0.3, changefreq: 'yearly' },
  { path: '/tos', priority: 0.3, changefreq: 'yearly' },
  { path: '/contact', priority: 0.3, changefreq: 'yearly' },
]

const GUIDES = [
  '/guides/',
  '/guides/doctor1-vs-doctor2/',
  '/guides/medlab-six-subjects-guide/',
  '/guides/nursing-50q-strategy/',
  '/guides/pharma2-reform-110/',
  '/guides/ai-practice-best-practices/',
]

function loadExamIds() {
  if (!fs.existsSync(SNAPSHOT)) return []
  return fs.readdirSync(SNAPSHOT)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      const cfg = JSON.parse(fs.readFileSync(path.join(SNAPSHOT, f), 'utf-8'))
      return cfg.id
    })
    .filter(Boolean)
    .sort()
}

function url(loc, changefreq, priority) {
  return `  <url>\n    <loc>${ROOT}${loc}</loc>\n    <changefreq>${changefreq}</changefreq>\n    <priority>${priority.toFixed(1)}</priority>\n  </url>`
}

function build() {
  const examIds = loadExamIds()
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']

  for (const r of STATIC_ROUTES) lines.push(url(r.path, r.changefreq, r.priority))
  for (const id of examIds) lines.push(url(`/${id}/`, 'weekly', 0.9))
  for (const g of GUIDES) lines.push(url(g, 'monthly', 0.7))

  lines.push('</urlset>')

  const xml = lines.join('\n') + '\n'
  fs.mkdirSync(DIST, { recursive: true })
  fs.writeFileSync(path.join(DIST, 'sitemap.xml'), xml)
  fs.writeFileSync(path.join(PUBLIC, 'sitemap.xml'), xml)
  console.log(`[sitemap] wrote ${STATIC_ROUTES.length + examIds.length + GUIDES.length} URLs (${examIds.length} exams)`)
}

build()

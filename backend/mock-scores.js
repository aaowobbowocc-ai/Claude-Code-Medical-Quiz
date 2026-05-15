/**
 * 模擬考成績排行榜 API。
 *
 * 跟 leaderboard.js（每週累計分數）不同 — 這裡記每場「歷史模擬考」單獨成績，
 * 例如「醫師一階 113第一次 醫學(一)」前 10 名。
 */
const supabase = require('./supabase')

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function registerRoutes(app) {
  // POST /mock-exam/score — 記一場模擬考成績
  app.post('/mock-exam/score', async (req, res) => {
    try {
      if (!supabase) return res.status(503).json({ error: 'supabase unavailable' })
      const {
        user_id,
        player_name,
        exam_id,
        year,
        session,
        paper_id,
        paper_name,
        score,
        max_score,
        total_questions,
        correct_questions,
        duration_seconds,
        device_id,
      } = req.body

      if (!exam_id || !player_name) return res.status(400).json({ error: 'missing exam_id or player_name' })
      if (typeof score !== 'number' || typeof max_score !== 'number' || max_score <= 0) {
        return res.status(400).json({ error: 'invalid score' })
      }
      // Sanity — prevent fake-score injection
      if (score < 0 || score > max_score || max_score > 100000) {
        return res.status(400).json({ error: 'score out of range' })
      }
      const tq = Number(total_questions) || 0
      const cq = Number(correct_questions) || 0
      if (tq < 0 || tq > 500 || cq < 0 || cq > tq) {
        return res.status(400).json({ error: 'invalid question counts' })
      }
      const dur = Number(duration_seconds) || 0
      if (dur < 0 || dur > 86400) {
        return res.status(400).json({ error: 'duration out of range' })
      }

      const cleanUserId = typeof user_id === 'string' && UUID_RE.test(user_id) ? user_id : null

      const { error } = await supabase.from('mock_exam_scores').insert({
        user_id: cleanUserId,
        player_name: String(player_name).slice(0, 60),
        exam_id,
        year: year || null,
        session: session || null,
        paper_id: paper_id || null,
        paper_name: paper_name || null,
        score: Math.round(score),
        max_score: Math.round(max_score),
        total_questions: total_questions || 0,
        correct_questions: correct_questions || 0,
        duration_seconds: duration_seconds || null,
        device_id: device_id || null,
      })
      if (error) {
        console.error('mock-exam score insert', error)
        return res.status(500).json({ error: 'db error' })
      }
      res.json({ ok: true })
    } catch (e) {
      console.error('mock-exam score error', e)
      res.status(500).json({ error: 'internal error' })
    }
  })

  // GET /mock-exam/top-scores — 查 top scores
  // ?exam_id=doctor1&year=113&session=第一次&paper_id=paper1&limit=10
  app.get('/mock-exam/top-scores', async (req, res) => {
    try {
      if (!supabase) return res.json({ scores: [] })
      const { exam_id, year, session, paper_id } = req.query
      const limit = Math.min(parseInt(req.query.limit) || 10, 50)
      if (!exam_id) return res.status(400).json({ error: 'missing exam_id' })

      let q = supabase.from('mock_exam_scores')
        .select('player_name, score, max_score, total_questions, correct_questions, duration_seconds, completed_at, paper_name')
        .eq('exam_id', exam_id)
        .order('score', { ascending: false })
        .order('duration_seconds', { ascending: true, nullsFirst: false })
        .order('completed_at', { ascending: true })
        .limit(limit)

      if (year) q = q.eq('year', year)
      if (session) q = q.eq('session', session)
      if (paper_id) q = q.eq('paper_id', paper_id)

      const { data, error } = await q
      if (error) return res.status(500).json({ error: error.message })

      // Dedup per player_name (keep highest)
      const seen = new Set()
      const dedup = []
      for (const row of (data || [])) {
        const key = row.player_name
        if (seen.has(key)) continue
        seen.add(key)
        dedup.push(row)
        if (dedup.length >= limit) break
      }
      res.set('Cache-Control', 'public, max-age=60')
      res.json({ scores: dedup })
    } catch (e) {
      res.status(500).json({ error: 'internal error' })
    }
  })

  // GET /mock-exam/my-best — 使用者個人 PR
  app.get('/mock-exam/my-best', async (req, res) => {
    try {
      if (!supabase) return res.json({ best: [] })
      const { user_id, exam_id } = req.query
      if (!user_id) return res.status(400).json({ error: 'missing user_id' })
      if (!UUID_RE.test(user_id)) return res.json({ best: [] })

      let q = supabase.from('mock_exam_scores')
        .select('paper_name, year, session, score, max_score, completed_at')
        .eq('user_id', user_id)
        .order('score', { ascending: false })
        .limit(20)
      if (exam_id) q = q.eq('exam_id', exam_id)

      const { data, error } = await q
      if (error) return res.status(500).json({ error: error.message })
      res.json({ best: data || [] })
    } catch (e) {
      res.status(500).json({ error: 'internal error' })
    }
  })
}

module.exports = { registerRoutes }

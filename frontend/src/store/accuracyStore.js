import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { getExamConfig } from '../config/examRegistry'

/**
 * Per-subject accuracy tracker.
 *
 * Two pools:
 *   data:       { [examId]:       { [tag]: { correct, wrong, lastSeen } } }
 *   sharedData: { [sharedBankId]: { [tag]: { correct, wrong, lastSeen } } }
 *
 * Exam-owned questions (medical 14) write to `data`. Shared-bank questions
 * (civil common subjects) write to `sharedData` keyed by their bankId so a
 * wrong answer in civil-senior-general surfaces in civil-junior-general's
 * weakness view. getAllSubjects(exam) merges both pools by walking the
 * exam's `sharedBanks` declaration.
 *
 * Isolation: localStorage is device-local, so per-user isolation is implicit.
 * This matches existing medical behavior — cross-device sync is a separate
 * future concern that should apply to all tracking, not just shared banks.
 */

function addEntry(bucket, tag, isCorrect, now) {
  const prev = bucket[tag] || { correct: 0, wrong: 0, lastSeen: 0 }
  bucket[tag] = {
    correct: prev.correct + (isCorrect ? 1 : 0),
    wrong:   prev.wrong   + (isCorrect ? 0 : 1),
    lastSeen: now,
  }
}

// 同題只算一次（回饋 CZY）：首答計入對/總；重練不加總，只在對錯改變時
// 以最新一次為準調整該題原科目的 correct/wrong。qid 缺失時退回舊行為（每次都計）。
function applyEntry(bucket, seenMap, qid, tag, isCorrect, now) {
  if (!qid) { addEntry(bucket, tag, isCorrect, now); return }
  const key = String(qid)
  const prev = seenMap[key]
  if (!prev) {
    addEntry(bucket, tag, isCorrect, now)
    seenMap[key] = { tag, correct: !!isCorrect }
    return
  }
  const t = prev.tag || tag
  if (prev.correct !== !!isCorrect) {
    const e = bucket[t] || { correct: 0, wrong: 0, lastSeen: 0 }
    bucket[t] = {
      correct: Math.max(0, e.correct + (isCorrect ? 1 : -1)),
      wrong:   Math.max(0, e.wrong   + (isCorrect ? -1 : 1)),
      lastSeen: now,
    }
    seenMap[key] = { tag: t, correct: !!isCorrect }
  } else if (bucket[t]) {
    bucket[t] = { ...bucket[t], lastSeen: now }
  }
}

function mergeInto(acc, bucket) {
  for (const [tag, e] of Object.entries(bucket)) {
    const prev = acc[tag]
    if (prev) {
      acc[tag] = {
        correct: prev.correct + e.correct,
        wrong:   prev.wrong   + e.wrong,
        lastSeen: Math.max(prev.lastSeen || 0, e.lastSeen || 0),
      }
    } else {
      acc[tag] = { ...e }
    }
  }
}

/** Collect merged { tag → aggregate } across exam's own pool + all its shared banks */
function collectMerged(state, exam) {
  const merged = {}
  const own = state.data[exam]
  if (own) mergeInto(merged, own)
  const cfg = getExamConfig(exam)
  const banks = cfg?.sharedBanks || []
  for (const bankId of banks) {
    const bankBucket = state.sharedData?.[bankId]
    if (bankBucket) mergeInto(merged, bankBucket)
  }
  return merged
}

export const useAccuracyStore = create(
  persist(
    (set, get) => ({
      data: {},
      sharedData: {},
      seen: {},          // { [exam]: { [qid]: {tag, correct} } } — 同題只算一次
      seenShared: {},    // { [bankId]: { [qid]: {tag, correct} } }

      /** Record a single question result. `sharedBankId` routes the write
       *  to the cross-exam pool when the question came from a shared bank.
       *  `qid` 讓同一題只計一次（重練以最新對錯為準）。 */
      record(exam, tag, isCorrect, sharedBankId = null, qid = null) {
        if (!tag) return
        if (!sharedBankId && !exam) return
        set(s => {
          const now = Date.now()
          if (sharedBankId) {
            const bank = { ...(s.sharedData?.[sharedBankId] || {}) }
            const seenMap = { ...((s.seenShared || {})[sharedBankId] || {}) }
            applyEntry(bank, seenMap, qid, tag, isCorrect, now)
            return {
              sharedData: { ...(s.sharedData || {}), [sharedBankId]: bank },
              seenShared: { ...(s.seenShared || {}), [sharedBankId]: seenMap },
            }
          }
          const examBucket = { ...(s.data[exam] || {}) }
          const seenMap = { ...((s.seen || {})[exam] || {}) }
          applyEntry(examBucket, seenMap, qid, tag, isCorrect, now)
          return {
            data: { ...s.data, [exam]: examBucket },
            seen: { ...(s.seen || {}), [exam]: seenMap },
          }
        })
      },

      /** Batch record (for mock exams) — results: [{ tag, isCorrect, sharedBankId?, qid? }] */
      recordBatch(exam, results) {
        if (!results?.length) return
        set(s => {
          const now = Date.now()
          const nextData = { ...s.data }
          const nextShared = { ...(s.sharedData || {}) }
          const nextSeen = { ...(s.seen || {}) }
          const nextSeenShared = { ...(s.seenShared || {}) }
          const examBucket = { ...(nextData[exam] || {}) }
          const examSeen = { ...(nextSeen[exam] || {}) }
          let examTouched = false
          const sharedTouched = new Set()

          for (const { tag, isCorrect, sharedBankId, qid } of results) {
            if (!tag) continue
            if (sharedBankId) {
              const bank = { ...(nextShared[sharedBankId] || {}) }
              const bankSeen = { ...(nextSeenShared[sharedBankId] || {}) }
              applyEntry(bank, bankSeen, qid, tag, isCorrect, now)
              nextShared[sharedBankId] = bank
              nextSeenShared[sharedBankId] = bankSeen
              sharedTouched.add(sharedBankId)
            } else if (exam) {
              applyEntry(examBucket, examSeen, qid, tag, isCorrect, now)
              examTouched = true
            }
          }
          if (examTouched) { nextData[exam] = examBucket; nextSeen[exam] = examSeen }
          return {
            data: examTouched ? nextData : s.data,
            sharedData: sharedTouched.size > 0 ? nextShared : s.sharedData,
            seen: examTouched ? nextSeen : s.seen,
            seenShared: sharedTouched.size > 0 ? nextSeenShared : s.seenShared,
          }
        })
      },

      /** Get accuracy for a single subject (merged across own + shared banks) */
      getAccuracy(exam, tag) {
        const merged = collectMerged(get(), exam)
        const entry = merged[tag]
        if (!entry) return null
        const total = entry.correct + entry.wrong
        return { ...entry, total, rate: total > 0 ? entry.correct / total : 0 }
      },

      /** Get all subjects for an exam, sorted weakest first (min 5 answers) */
      getWeakest(exam, minAnswers = 5) {
        const merged = collectMerged(get(), exam)
        return Object.entries(merged)
          .map(([tag, e]) => {
            const total = e.correct + e.wrong
            return { tag, ...e, total, rate: total > 0 ? e.correct / total : 0 }
          })
          .filter(e => e.total >= minAnswers)
          .sort((a, b) => a.rate - b.rate)
      },

      /** Get all subjects for an exam (no minimum) */
      getAllSubjects(exam) {
        const merged = collectMerged(get(), exam)
        return Object.entries(merged)
          .map(([tag, e]) => {
            const total = e.correct + e.wrong
            return { tag, ...e, total, rate: total > 0 ? e.correct / total : 0 }
          })
          .sort((a, b) => a.rate - b.rate)
      },

      /** 跨裝置同步：把雲端練習記錄併入本機（max-merge，單調不倒退）。
       *  data/sharedData 每個 (exam/bank, tag) 取 correct/wrong 較大者；
       *  seen/seenShared 以 qid 聯集（衝突保留本機）。用於 cloudSync.syncOnLogin。*/
      mergeCloud(cloud) {
        if (!cloud || typeof cloud !== 'object') return
        const mergeBuckets = (localB, cloudB) => {
          const L = localB || {}, C = cloudB || {}
          const out = {}
          for (const k of new Set([...Object.keys(L), ...Object.keys(C)])) {
            const l = L[k] || {}, c = C[k] || {}
            const m = {}
            for (const t of new Set([...Object.keys(l), ...Object.keys(c)])) {
              const le = l[t] || { correct: 0, wrong: 0, lastSeen: 0 }
              const ce = c[t] || { correct: 0, wrong: 0, lastSeen: 0 }
              m[t] = {
                correct: Math.max(le.correct || 0, ce.correct || 0),
                wrong: Math.max(le.wrong || 0, ce.wrong || 0),
                lastSeen: Math.max(le.lastSeen || 0, ce.lastSeen || 0),
              }
            }
            out[k] = m
          }
          return out
        }
        const mergeSeen = (localS, cloudS) => {
          const L = localS || {}, C = cloudS || {}
          const out = {}
          for (const k of new Set([...Object.keys(L), ...Object.keys(C)])) {
            out[k] = { ...(C[k] || {}), ...(L[k] || {}) } // 衝突保留本機
          }
          return out
        }
        set(s => ({
          data: mergeBuckets(s.data, cloud.data),
          sharedData: mergeBuckets(s.sharedData, cloud.sharedData),
          seen: mergeSeen(s.seen, cloud.seen),
          seenShared: mergeSeen(s.seenShared, cloud.seenShared),
        }))
      },

      /** Reset data for a specific exam. Does NOT clear sharedData — other
       *  exams that share the same bank still rely on those entries. */
      resetExam(exam) {
        set(s => {
          const { [exam]: _, ...rest } = s.data
          const { [exam]: __, ...restSeen } = (s.seen || {})
          return { data: rest, seen: restSeen }
        })
      },
    }),
    { name: 'quiz-accuracy-v1' }
  )
)

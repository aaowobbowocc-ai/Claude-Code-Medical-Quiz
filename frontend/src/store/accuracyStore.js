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

      /** Record a single question result. `sharedBankId` routes the write
       *  to the cross-exam pool when the question came from a shared bank. */
      record(exam, tag, isCorrect, sharedBankId = null) {
        if (!tag) return
        if (!sharedBankId && !exam) return
        set(s => {
          const now = Date.now()
          if (sharedBankId) {
            const bank = { ...(s.sharedData?.[sharedBankId] || {}) }
            addEntry(bank, tag, isCorrect, now)
            return { sharedData: { ...(s.sharedData || {}), [sharedBankId]: bank } }
          }
          const examBucket = { ...(s.data[exam] || {}) }
          addEntry(examBucket, tag, isCorrect, now)
          return { data: { ...s.data, [exam]: examBucket } }
        })
      },

      /** Batch record (for mock exams) — results: [{ tag, isCorrect, sharedBankId? }] */
      recordBatch(exam, results) {
        if (!results?.length) return
        set(s => {
          const now = Date.now()
          const nextData = { ...s.data }
          const nextShared = { ...(s.sharedData || {}) }
          const examBucket = { ...(nextData[exam] || {}) }
          let examTouched = false
          const sharedTouched = new Set()

          for (const { tag, isCorrect, sharedBankId } of results) {
            if (!tag) continue
            if (sharedBankId) {
              const bank = { ...(nextShared[sharedBankId] || {}) }
              addEntry(bank, tag, isCorrect, now)
              nextShared[sharedBankId] = bank
              sharedTouched.add(sharedBankId)
            } else if (exam) {
              addEntry(examBucket, tag, isCorrect, now)
              examTouched = true
            }
          }
          if (examTouched) nextData[exam] = examBucket
          return {
            data: examTouched ? nextData : s.data,
            sharedData: sharedTouched.size > 0 ? nextShared : s.sharedData,
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

      /** Reset data for a specific exam. Does NOT clear sharedData — other
       *  exams that share the same bank still rely on those entries. */
      resetExam(exam) {
        set(s => {
          const { [exam]: _, ...rest } = s.data
          return { data: rest }
        })
      },
    }),
    { name: 'quiz-accuracy-v1' }
  )
)

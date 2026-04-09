import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/**
 * Per-subject accuracy tracker.
 * Data shape: { [examId]: { [tag]: { correct, wrong, lastSeen } } }
 * ~50 tags × 6 exams × 40 bytes ≈ 12KB — fits localStorage easily.
 */
export const useAccuracyStore = create(
  persist(
    (set, get) => ({
      data: {},

      /** Record a single question result */
      record(exam, tag, isCorrect) {
        if (!exam || !tag) return
        set(s => {
          const examData = { ...(s.data[exam] || {}) }
          const prev = examData[tag] || { correct: 0, wrong: 0, lastSeen: 0 }
          examData[tag] = {
            correct: prev.correct + (isCorrect ? 1 : 0),
            wrong: prev.wrong + (isCorrect ? 0 : 1),
            lastSeen: Date.now(),
          }
          return { data: { ...s.data, [exam]: examData } }
        })
      },

      /** Batch record (for mock exams) — results: [{ tag, isCorrect }] */
      recordBatch(exam, results) {
        if (!exam || !results?.length) return
        set(s => {
          const examData = { ...(s.data[exam] || {}) }
          const now = Date.now()
          for (const { tag, isCorrect } of results) {
            if (!tag) continue
            const prev = examData[tag] || { correct: 0, wrong: 0, lastSeen: 0 }
            examData[tag] = {
              correct: prev.correct + (isCorrect ? 1 : 0),
              wrong: prev.wrong + (isCorrect ? 0 : 1),
              lastSeen: now,
            }
          }
          return { data: { ...s.data, [exam]: examData } }
        })
      },

      /** Get accuracy for a single subject */
      getAccuracy(exam, tag) {
        const entry = get().data[exam]?.[tag]
        if (!entry) return null
        const total = entry.correct + entry.wrong
        return { ...entry, total, rate: total > 0 ? entry.correct / total : 0 }
      },

      /** Get all subjects for an exam, sorted weakest first (min 5 answers) */
      getWeakest(exam, minAnswers = 5) {
        const examData = get().data[exam]
        if (!examData) return []
        return Object.entries(examData)
          .map(([tag, e]) => {
            const total = e.correct + e.wrong
            return { tag, ...e, total, rate: total > 0 ? e.correct / total : 0 }
          })
          .filter(e => e.total >= minAnswers)
          .sort((a, b) => a.rate - b.rate)
      },

      /** Get all subjects for an exam (no minimum) */
      getAllSubjects(exam) {
        const examData = get().data[exam]
        if (!examData) return []
        return Object.entries(examData)
          .map(([tag, e]) => {
            const total = e.correct + e.wrong
            return { tag, ...e, total, rate: total > 0 ? e.correct / total : 0 }
          })
          .sort((a, b) => a.rate - b.rate)
      },

      /** Reset data for a specific exam */
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

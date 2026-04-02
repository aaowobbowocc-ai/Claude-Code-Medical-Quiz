import { useState, useCallback } from 'react'

const KEY = 'bookmarked-questions'
const MAX = 200

function load() {
  try { return JSON.parse(localStorage.getItem(KEY) || '[]') } catch { return [] }
}

function save(list) {
  localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX)))
}

/** Unique key for a question (fallback to question text hash) */
function qKey(q) {
  return q.id || q.question.slice(0, 60)
}

export function useBookmarks() {
  const [list, setList] = useState(load)

  const isBookmarked = useCallback((q) => {
    return list.some(b => qKey(b) === qKey(q))
  }, [list])

  const toggle = useCallback((q) => {
    setList(prev => {
      const key = qKey(q)
      const exists = prev.some(b => qKey(b) === key)
      const next = exists
        ? prev.filter(b => qKey(b) !== key)
        : [{ ...q, bookmarkedAt: Date.now() }, ...prev]
      save(next)
      return next
    })
  }, [])

  const clear = useCallback(() => {
    save([])
    setList([])
  }, [])

  return { bookmarks: list, isBookmarked, toggle, clear }
}

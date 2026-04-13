import { useState, useCallback } from 'react'

const KEY = 'bookmarked-questions-v2'
const MAX_PER_FOLDER = 100
const DEFAULT_FOLDERS = ['收藏夾 1', '收藏夾 2']

// doctor1 ids used to be `{exam_code}_{number}` and collided between 醫學(一)/醫學(二).
// Bookmarks saved under the old scheme need to be rewritten to the new
// `{exam_code}_{paperIdx}_{number}` format so they still match live questions.
const DOCTOR1_SUBJECT_TO_PAPER = { '醫學(一)': 1, '醫學(二)': 2, '醫學(三)': 3, '醫學(四)': 4 }
function migrateDoctor1Id(q) {
  if (!q || typeof q.id !== 'string') return q
  if (!/^\d{6}_\d+$/.test(q.id)) return q // only touches old doctor1 shape
  const paperIdx = DOCTOR1_SUBJECT_TO_PAPER[q.subject]
  if (!paperIdx || !q.exam_code || q.number == null) return q
  return { ...q, id: `${q.exam_code}_${paperIdx}_${q.number}` }
}

function load() {
  try {
    const data = JSON.parse(localStorage.getItem(KEY) || 'null')
    if (data && data.folders) {
      // Walk every bookmark and rewrite legacy doctor1 ids in place
      const rewritten = { ...data, questions: {} }
      for (const f of data.folders) {
        rewritten.questions[f] = (data.questions[f] || []).map(migrateDoctor1Id)
      }
      return rewritten
    }
    // Migrate from v1
    const v1 = JSON.parse(localStorage.getItem('bookmarked-questions') || '[]')
    const migrated = { folders: DEFAULT_FOLDERS, questions: {} }
    migrated.questions[DEFAULT_FOLDERS[0]] = v1.slice(0, MAX_PER_FOLDER).map(migrateDoctor1Id)
    migrated.questions[DEFAULT_FOLDERS[1]] = []
    return migrated
  } catch { return { folders: DEFAULT_FOLDERS, questions: { [DEFAULT_FOLDERS[0]]: [], [DEFAULT_FOLDERS[1]]: [] } } }
}

function save(data) {
  localStorage.setItem(KEY, JSON.stringify(data))
}

function qKey(q) {
  return q.id || q.question?.slice(0, 60) || ''
}

export function useBookmarks() {
  const [data, setData] = useState(load)

  const folders = data.folders

  const allBookmarks = Object.values(data.questions).flat()

  const isBookmarked = useCallback((q) => {
    return Object.values(data.questions).some(list => list.some(b => qKey(b) === qKey(q)))
  }, [data])

  const getFolder = useCallback((q) => {
    for (const folder of data.folders) {
      if ((data.questions[folder] || []).some(b => qKey(b) === qKey(q))) return folder
    }
    return null
  }, [data])

  const getFolderQuestions = useCallback((folder) => {
    return data.questions[folder] || []
  }, [data])

  const addToFolder = useCallback((q, folder) => {
    setData(prev => {
      const list = prev.questions[folder] || []
      if (list.some(b => qKey(b) === qKey(q))) return prev // already in this folder
      if (list.length >= MAX_PER_FOLDER) return prev // full
      // Remove from other folders first
      const newQuestions = { ...prev.questions }
      for (const f of prev.folders) {
        newQuestions[f] = (newQuestions[f] || []).filter(b => qKey(b) !== qKey(q))
      }
      newQuestions[folder] = [{ ...q, bookmarkedAt: Date.now() }, ...newQuestions[folder]]
      const next = { ...prev, questions: newQuestions }
      save(next)
      return next
    })
  }, [])

  const removeBookmark = useCallback((q) => {
    setData(prev => {
      const newQuestions = { ...prev.questions }
      for (const f of prev.folders) {
        newQuestions[f] = (newQuestions[f] || []).filter(b => qKey(b) !== qKey(q))
      }
      const next = { ...prev, questions: newQuestions }
      save(next)
      return next
    })
  }, [])

  const toggle = useCallback((q, folder) => {
    const currentFolder = getFolder(q)
    if (currentFolder) {
      removeBookmark(q)
    } else {
      addToFolder(q, folder || folders[0])
    }
  }, [getFolder, removeBookmark, addToFolder, folders])

  const renameFolder = useCallback((oldName, newName) => {
    if (!newName.trim() || newName === oldName) return
    setData(prev => {
      const newFolders = prev.folders.map(f => f === oldName ? newName.trim().slice(0, 10) : f)
      const newQuestions = { ...prev.questions }
      newQuestions[newName.trim().slice(0, 10)] = newQuestions[oldName] || []
      delete newQuestions[oldName]
      const next = { folders: newFolders, questions: newQuestions }
      save(next)
      return next
    })
  }, [])

  const clearFolder = useCallback((folder) => {
    setData(prev => {
      const newQuestions = { ...prev.questions, [folder]: [] }
      const next = { ...prev, questions: newQuestions }
      save(next)
      return next
    })
  }, [])

  // Spaced repetition: questions due for review
  const getDueCount = useCallback(() => {
    const now = Date.now()
    const INTERVALS = [1, 3, 7, 14, 30].map(d => d * 86400000)
    return allBookmarks.filter(q => {
      const age = now - (q.bookmarkedAt || 0)
      return INTERVALS.some(iv => age >= iv && age < iv + 86400000)
    }).length
  }, [allBookmarks])

  return {
    folders,
    bookmarks: allBookmarks,
    isBookmarked,
    getFolder,
    getFolderQuestions,
    addToFolder,
    removeBookmark,
    toggle,
    renameFolder,
    clearFolder,
    getDueCount,
    MAX_PER_FOLDER,
  }
}

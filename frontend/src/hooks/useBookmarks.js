import { useState, useCallback } from 'react'

const KEY = 'bookmarked-questions-v2'
const MAX_PER_FOLDER = 100
const DEFAULT_FOLDERS = ['收藏夾 1', '收藏夾 2']

function load() {
  try {
    const data = JSON.parse(localStorage.getItem(KEY) || 'null')
    if (data && data.folders) return data
    // Migrate from v1
    const v1 = JSON.parse(localStorage.getItem('bookmarked-questions') || '[]')
    const migrated = { folders: DEFAULT_FOLDERS, questions: {} }
    migrated.questions[DEFAULT_FOLDERS[0]] = v1.slice(0, MAX_PER_FOLDER)
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

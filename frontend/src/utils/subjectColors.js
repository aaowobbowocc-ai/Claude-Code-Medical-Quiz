import { getSubjectColorFromRegistry } from '../config/examRegistry'

// Fallback: generate a stable color from the name string
function hashColor(name) {
  let hash = 0
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash)
  const colors = ['#3B82F6', '#EF4444', '#8B5CF6', '#10B981', '#F97316', '#D97706', '#6366F1', '#DC2626', '#0D9488', '#818CF8']
  return colors[Math.abs(hash) % colors.length]
}

// Paper-based fallback colors
const PAPER_COLORS = {
  '卷一': '#3B82F6', '卷二': '#10B981', '卷三': '#8B5CF6', '卷四': '#F97316',
  '醫學(三)': '#3B82F6', '醫學(四)': '#10B981', '醫學(五)': '#8B5CF6', '醫學(六)': '#F97316',
}

export function getSubjectColor(subjectName) {
  if (!subjectName) return '#94A3B8'
  return getSubjectColorFromRegistry(subjectName) || PAPER_COLORS[subjectName] || hashColor(subjectName)
}

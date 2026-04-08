// Subject name → color mapping (matches Browse.jsx STAGE_COLORS)
const SUBJECT_COLOR_MAP = {
  // Doctor 1 subjects
  '解剖學': '#3B82F6',
  '生理學': '#EF4444',
  '生物化學': '#8B5CF6',
  '生化學': '#8B5CF6',
  '組織學': '#6366F1',
  '胚胎學': '#818CF8',
  '微生物與免疫學': '#10B981',
  '微生物與免疫': '#10B981',
  '微免': '#10B981',
  '寄生蟲學': '#D97706',
  '藥理學': '#F97316',
  '病理學': '#DC2626',
  '公共衛生': '#0D9488',
  '公衛': '#0D9488',
  // Doctor 2 papers
  '醫學(三)': '#3B82F6',
  '醫學(四)': '#10B981',
  '醫學(五)': '#8B5CF6',
  '醫學(六)': '#F97316',
  // Dental
  '口腔解剖': '#3B82F6',
  '牙醫解剖': '#3B82F6',
  '牙體形態': '#6366F1',
  '口腔病理': '#DC2626',
  '牙科藥理': '#F97316',
  '口腔生理': '#EF4444',
  '口腔顎面外科': '#3B82F6',
  '牙周病學': '#10B981',
  '齒顎矯正': '#8B5CF6',
  '兒童牙科': '#818CF8',
  '牙髓病': '#D97706',
  '牙體復形': '#F97316',
  '牙科材料': '#6366F1',
  '補綴學': '#DC2626',
  '口腔診斷': '#0D9488',
  // Pharma
  '藥物化學': '#3B82F6',
  '藥物分析': '#10B981',
  '生藥學': '#8B5CF6',
  '藥劑學': '#F97316',
  '生物藥劑學': '#D97706',
  '調劑學': '#3B82F6',
  '臨床藥學': '#10B981',
  '治療學': '#8B5CF6',
  '藥物治療學': '#EF4444',
  '藥事行政與法規': '#0D9488',
  // Paper-based fallbacks
  '卷一': '#3B82F6',
  '卷二': '#10B981',
  '卷三': '#8B5CF6',
  '卷四': '#F97316',
}

// Fallback: generate a stable color from the name string
function hashColor(name) {
  let hash = 0
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash)
  const colors = ['#3B82F6', '#EF4444', '#8B5CF6', '#10B981', '#F97316', '#D97706', '#6366F1', '#DC2626', '#0D9488', '#818CF8']
  return colors[Math.abs(hash) % colors.length]
}

export function getSubjectColor(subjectName) {
  if (!subjectName) return '#94A3B8'
  return SUBJECT_COLOR_MAP[subjectName] || hashColor(subjectName)
}

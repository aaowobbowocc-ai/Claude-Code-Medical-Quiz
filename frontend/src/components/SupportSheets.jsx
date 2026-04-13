import { useState } from 'react'
import Sheet from './Sheet'
import { exportBackup, parseBackup, applyBackup, summarizeBackup } from '../lib/backup'

const BACKEND = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001'

export default function SupportSheets({ sheet, setSheet }) {
  const [feedbackText, setFeedbackText] = useState('')
  const [feedbackSent, setFeedbackSent] = useState(false)
  const [sending, setSending] = useState(false)
  // Backup sheet state
  const [backupMode, setBackupMode] = useState('menu') // menu | export | import
  const [exportCode, setExportCode] = useState('')
  const [copied, setCopied] = useState(false)
  const [importText, setImportText] = useState('')
  const [importPreview, setImportPreview] = useState(null)
  const [importError, setImportError] = useState('')

  const closeBackup = () => {
    setSheet(null)
    setBackupMode('menu')
    setExportCode('')
    setCopied(false)
    setImportText('')
    setImportPreview(null)
    setImportError('')
  }

  const handleExport = () => {
    setExportCode(exportBackup())
    setBackupMode('export')
  }
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(exportCode)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard API blocked — user can still long-press the textarea
    }
  }
  const handleValidateImport = () => {
    const r = parseBackup(importText)
    if (!r.ok) { setImportError(r.error); setImportPreview(null); return }
    setImportError('')
    setImportPreview({ payload: r.payload, summary: summarizeBackup(r.payload) })
  }
  const handleConfirmImport = () => {
    if (!importPreview) return
    applyBackup(importPreview.payload)
    // Force a full reload so every hook re-reads localStorage fresh — the
    // zustand store in memory still holds the pre-import state otherwise.
    window.location.reload()
  }

  const sendContact = async () => {
    if (!feedbackText.trim() || sending) return
    setSending(true)
    try {
      const res = await fetch(`${BACKEND}/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: feedbackText }),
      })
      if (res.ok) setFeedbackSent(true)
    } catch { /* ignore */ }
    setSending(false)
  }

  return (
    <>
      {sheet === 'donate' && (
        <Sheet onClose={() => setSheet(null)}>
          <div className="text-center mb-5">
            <div className="text-5xl mb-3">☕</div>
            <h2 className="text-xl font-bold text-medical-dark">支持這個計畫</h2>
            <p className="text-gray-400 text-sm mt-2 leading-relaxed">
              「免費」是這裡的核心。<br />
              每位努力備考的醫學生，都值得一個好用的練習工具。
            </p>
          </div>

          <div className="bg-amber-50 rounded-2xl px-4 py-4 mb-5 text-sm text-amber-800 leading-relaxed space-y-1.5">
            <p>你的贊助會直接用於：</p>
            <p>🖥️ 伺服器費用，讓大家隨時連得到</p>
            <p>🤖 AI 解說功能，看懂每一道題</p>
            <p>📚 題庫持續更新，緊跟最新考試</p>
          </div>

          <a
            href="https://p.ecpay.com.tw/E11DBDD"
            target="_blank"
            rel="noopener noreferrer"
            className="block w-full py-4 rounded-2xl text-center mb-3 font-bold text-lg text-white active:scale-95 transition-transform grad-cta shadow-md"
          >
            ☕ 前往贊助
          </a>
          <p className="text-center text-[11px] text-gray-400 mb-3">
            支援信用卡、ATM、超商代碼（綠界金流）
          </p>

          <p className="text-center text-xs text-gray-300 leading-relaxed">
            加油，未來的醫生！🩺<br />這裡永遠為你開著。
          </p>
        </Sheet>
      )}

      {sheet === 'backup' && (
        <Sheet onClose={closeBackup}>
          {backupMode === 'menu' && (
            <>
              <div className="text-center mb-5">
                <div className="text-5xl mb-3">📦</div>
                <h2 className="text-xl font-bold text-medical-dark">備份 / 還原資料</h2>
                <p className="text-gray-400 text-sm mt-2 leading-relaxed">
                  把這台裝置的資料匯出成一段代碼,<br />
                  貼到別台裝置就能還原所有進度。
                </p>
              </div>

              <div className="bg-blue-50 rounded-2xl px-4 py-3 mb-4 text-xs text-blue-700 leading-relaxed">
                <p className="font-semibold mb-1">📱 PWA 使用者看這裡:</p>
                <p>PWA 無法直接綁定 Google。請在 PWA 按「匯出」複製代碼,然後用瀏覽器打開 examking.tw,按「匯入」貼上 — 之後就能在瀏覽器綁 Google 同步到雲端。</p>
              </div>

              <button onClick={handleExport}
                className="w-full py-4 rounded-2xl text-center mb-3 font-bold text-base text-white active:scale-95 transition-transform grad-cta shadow-md">
                📤 匯出目前資料
              </button>
              <button onClick={() => setBackupMode('import')}
                className="w-full py-4 rounded-2xl text-center font-bold text-base text-emerald-700 bg-emerald-50 border-2 border-emerald-200 active:scale-95 transition-transform">
                📥 匯入備份
              </button>
            </>
          )}

          {backupMode === 'export' && (
            <>
              <div className="text-center mb-4">
                <div className="text-5xl mb-3">✨</div>
                <h2 className="text-xl font-bold text-medical-dark">匯出成功</h2>
                <p className="text-gray-400 text-xs mt-2 leading-relaxed">
                  複製下面整段文字,貼到其他裝置的「匯入備份」即可還原。
                </p>
              </div>
              <textarea
                readOnly
                value={exportCode}
                onFocus={e => e.target.select()}
                className="w-full border-2 border-gray-200 rounded-2xl px-3 py-2 text-[10px] text-gray-600 font-mono resize-none mb-3 break-all leading-tight"
                rows={6}
              />
              <button onClick={handleCopy}
                className="w-full py-3 rounded-2xl font-bold text-white active:scale-95 transition-transform grad-cta mb-2">
                {copied ? '✓ 已複製' : '📋 複製到剪貼簿'}
              </button>
              <button onClick={() => setBackupMode('menu')}
                className="w-full py-2 text-xs text-gray-400">
                返回
              </button>
            </>
          )}

          {backupMode === 'import' && !importPreview && (
            <>
              <div className="text-center mb-4">
                <div className="text-5xl mb-3">📥</div>
                <h2 className="text-xl font-bold text-medical-dark">匯入備份</h2>
                <p className="text-amber-600 text-xs mt-2 leading-relaxed">
                  ⚠️ 匯入會覆蓋目前裝置的所有進度<br />(建議先用「匯出」備份一份再操作)
                </p>
              </div>
              <textarea
                autoFocus
                placeholder="貼上以 MKBAK1: 開頭的備份代碼…"
                value={importText}
                onChange={e => { setImportText(e.target.value); setImportError('') }}
                className="w-full border-2 border-gray-200 rounded-2xl px-3 py-2 text-[11px] text-gray-700 font-mono resize-none mb-2 break-all leading-tight focus:border-medical-blue outline-none"
                rows={6}
              />
              {importError && <p className="text-xs text-red-500 mb-2 text-center">{importError}</p>}
              <button onClick={handleValidateImport}
                disabled={!importText.trim()}
                className="w-full py-3 rounded-2xl font-bold text-white active:scale-95 transition-transform grad-cta disabled:opacity-40 mb-2">
                驗證備份
              </button>
              <button onClick={() => setBackupMode('menu')}
                className="w-full py-2 text-xs text-gray-400">
                返回
              </button>
            </>
          )}

          {backupMode === 'import' && importPreview && (
            <>
              <div className="text-center mb-4">
                <div className="text-5xl mb-3">🔍</div>
                <h2 className="text-xl font-bold text-medical-dark">確認要匯入嗎?</h2>
                <p className="text-gray-400 text-xs mt-2">
                  匯出時間:{importPreview.summary.exportedAt}
                </p>
              </div>
              <div className="bg-gray-50 rounded-2xl p-4 text-sm text-gray-700 space-y-1.5 mb-4">
                <div className="flex justify-between"><span>玩家名稱</span><span className="font-semibold">{importPreview.summary.name}</span></div>
                <div className="flex justify-between"><span>金幣</span><span className="font-semibold">{importPreview.summary.coins} 🪙</span></div>
                <div className="flex justify-between"><span>等級</span><span className="font-semibold">Lv.{importPreview.summary.level}</span></div>
                <div className="flex justify-between"><span>收藏題目</span><span className="font-semibold">{importPreview.summary.bookmarks ?? 0} 題</span></div>
                <div className="flex justify-between"><span>練習次數</span><span className="font-semibold">{importPreview.summary.practiceSessions ?? 0} 次</span></div>
                <div className="flex justify-between"><span>對戰紀錄</span><span className="font-semibold">{importPreview.summary.battles ?? 0} 場</span></div>
                <div className="flex justify-between"><span>模擬考紀錄</span><span className="font-semibold">{importPreview.summary.mockExams ?? 0} 次</span></div>
              </div>
              <p className="text-center text-xs text-red-500 mb-3">
                ⚠️ 按下「確認匯入」後目前資料會被完全覆蓋
              </p>
              <button onClick={handleConfirmImport}
                className="w-full py-4 rounded-2xl font-bold text-white bg-red-500 active:scale-95 transition-transform mb-2">
                確認匯入
              </button>
              <button onClick={() => { setImportPreview(null); setImportText('') }}
                className="w-full py-2 text-xs text-gray-400">
                取消,改用別的備份
              </button>
            </>
          )}
        </Sheet>
      )}

      {sheet === 'contact' && (
        <Sheet onClose={() => { setSheet(null); setFeedbackSent(false); setFeedbackText('') }}>
          {feedbackSent ? (
            <div className="text-center py-6">
              <div className="text-6xl mb-4">🙏</div>
              <h2 className="text-xl font-bold text-medical-dark mb-2">謝謝你！</h2>
              <p className="text-gray-400 text-sm leading-relaxed">
                每一條訊息我都會認真讀。<br />
                正是這樣的回饋讓這個專案繼續走下去。
              </p>
              <button onClick={() => { setSheet(null); setFeedbackSent(false); setFeedbackText('') }}
                      className="mt-6 px-8 py-3 rounded-2xl font-bold text-white active:scale-95 grad-cta">
                關閉
              </button>
            </div>
          ) : (
            <>
              <div className="text-center mb-5">
                <div className="text-5xl mb-3">💌</div>
                <h2 className="text-xl font-bold text-medical-dark">聯絡開發者</h2>
                <p className="text-gray-400 text-sm mt-1.5 leading-relaxed">
                  意見回饋、功能建議、題目有誤——<br />
                  什麼都可以說，我都想聽。
                </p>
              </div>
              <textarea
                autoFocus
                className="w-full border-2 border-gray-200 rounded-2xl px-4 py-3.5 text-sm text-gray-700 outline-none focus:border-medical-blue resize-none mb-4 leading-relaxed"
                rows={5}
                placeholder="例如：113年第一次第42題答案有疑義、希望新增某功能、或只是說聲謝謝……"
                value={feedbackText}
                onChange={e => setFeedbackText(e.target.value)}
              />
              <button
                onClick={sendContact}
                disabled={!feedbackText.trim() || sending}
                className="w-full py-4 rounded-2xl font-bold text-lg text-white active:scale-95 transition-transform disabled:opacity-40 grad-cta"
              >
                {sending ? '送出中...' : '送出意見'}
              </button>
            </>
          )}
        </Sheet>
      )}
    </>
  )
}

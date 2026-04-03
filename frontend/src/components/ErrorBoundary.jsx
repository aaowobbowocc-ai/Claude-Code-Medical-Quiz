import React from 'react'

export default class ErrorBoundary extends React.Component {
  state = { hasError: false }

  static getDerivedStateFromError() {
    return { hasError: true }
  }

  componentDidCatch(error, info) {
    console.error('ErrorBoundary caught:', error, info)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center min-h-dvh bg-medical-ice px-6 text-center">
          <div className="text-6xl mb-4">😵</div>
          <h1 className="text-xl font-bold text-medical-dark mb-2">發生錯誤</h1>
          <p className="text-gray-500 text-sm mb-6">頁面出了點問題，請重新整理試試看</p>
          <button
            onClick={() => window.location.reload()}
            className="px-6 py-3 rounded-2xl font-bold text-white grad-cta active:scale-95 transition-transform"
          >
            重新整理
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

import { useState, useEffect, useCallback } from 'react'

export function usePWA() {
  const [installPrompt, setInstallPrompt] = useState(null)
  const [isInstalled, setIsInstalled] = useState(false)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    // Check if already installed
    if (window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone) {
      setIsInstalled(true)
      return
    }

    // Check if user dismissed banner before
    const dismissedAt = localStorage.getItem('pwa-banner-dismissed')
    if (dismissedAt) {
      const daysSince = (Date.now() - parseInt(dismissedAt)) / (1000 * 60 * 60 * 24)
      if (daysSince < 7) setDismissed(true) // Show again after 7 days
    }

    // Chrome/Edge: capture beforeinstallprompt
    const handler = (e) => {
      e.preventDefault()
      setInstallPrompt(e)
    }
    window.addEventListener('beforeinstallprompt', handler)

    // Detect install
    window.addEventListener('appinstalled', () => setIsInstalled(true))

    return () => window.removeEventListener('beforeinstallprompt', handler)
  }, [])

  const install = useCallback(async () => {
    if (!installPrompt) return false
    installPrompt.prompt()
    const result = await installPrompt.userChoice
    if (result.outcome === 'accepted') setIsInstalled(true)
    setInstallPrompt(null)
    return result.outcome === 'accepted'
  }, [installPrompt])

  const dismiss = useCallback(() => {
    setDismissed(true)
    localStorage.setItem('pwa-banner-dismissed', Date.now().toString())
  }, [])

  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
  const isSafari = isIOS && !navigator.userAgent.includes('CriOS') && !navigator.userAgent.includes('FxiOS')
  const showBanner = !isInstalled && !dismissed

  return { isInstalled, installPrompt, install, dismiss, showBanner, isIOS, isSafari }
}

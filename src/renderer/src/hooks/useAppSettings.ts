import { useEffect, useState } from 'react'

import type { AppSettings } from '../../../shared/settings'
import { applyTheme } from '../styles/theme'

export function useAppSettings(): AppSettings | null {
  const [settings, setSettings] = useState<AppSettings | null>(null)

  useEffect(() => {
    let mounted = true
    void window.api.getSettings().then((next) => {
      if (!mounted) {
        return
      }
      setSettings(next)
      applyTheme(next)
    })

    const disposeSettings = window.api.onSettingsUpdated((next) => {
      setSettings(next)
      applyTheme(next)
    })

    return () => {
      mounted = false
      disposeSettings()
    }
  }, [])

  return settings
}

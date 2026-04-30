import { ElectronAPI } from '@electron-toolkit/preload'
import type { DatabaseApi } from '../shared/database'
import type { LiveApi } from '../shared/live'
import type { LoggingApi } from '../shared/logging'
import type { SettingsApi } from '../shared/settings'

declare global {
  interface Window {
    electron: ElectronAPI
    api: SettingsApi & DatabaseApi & LiveApi & LoggingApi
  }
}

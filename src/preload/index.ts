import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import { DATABASE_CHANNELS, type DatabaseApi, type DatabaseHealth } from '../shared/database'
import {
  LOGGING_CHANNELS,
  type AppLogLevel,
  type LoggingApi,
  type RendererLogEntry
} from '../shared/logging'
import {
  LIVE_CHANNELS,
  isLivePlaybackCommand,
  isLivePlayerMode,
  type AddLiveChannelColumnRequest,
  type AddLiveChannelRequest,
  type LiveChannelsSnapshot,
  type LiveApi,
  type LivePlaybackCommand,
  type LivePlaybackState,
  type LivePlayerMode,
  type LivePlayerState,
  type LivePlayerStatePatch,
  type PreviewLiveChannelRequest,
  type UpdateLiveChannelColumnRequest,
  type UpdateLiveChannelRequest
} from '../shared/live'
import {
  SETTINGS_CHANNELS,
  isSettingsTabId,
  type AppSettings,
  type FontFamiliesSnapshot,
  type ProxySettings,
  type SettingsApi,
  type SettingsTabId,
  type UpdateCheckResult,
  type UpdateSettingsRequest
} from '../shared/settings'

// Custom APIs for renderer
const api: SettingsApi & DatabaseApi & LiveApi & LoggingApi = {
  writeLog: (level: AppLogLevel, scope: string, message: string, details?: unknown): void => {
    try {
      ipcRenderer.send(LOGGING_CHANNELS.write, {
        level,
        scope,
        message,
        details: normalizeLogDetails(details)
      } satisfies RendererLogEntry)
    } catch (error) {
      console.error('[logging:write]', error)
    }
  },
  getSettings: () => ipcRenderer.invoke(SETTINGS_CHANNELS.get),
  updateSettings: (patch: UpdateSettingsRequest) =>
    ipcRenderer.invoke(SETTINGS_CHANNELS.update, patch),
  showSettingsWindow: (tab?: SettingsTabId) =>
    ipcRenderer.invoke(SETTINGS_CHANNELS.showWindow, tab),
  hideSettingsWindow: () => ipcRenderer.invoke(SETTINGS_CHANNELS.hideWindow),
  openLogDirectory: () => ipcRenderer.invoke(SETTINGS_CHANNELS.openLogDirectory),
  getSystemProxyInfo: () => ipcRenderer.invoke(SETTINGS_CHANNELS.systemProxyInfo),
  testProxy: (proxy: ProxySettings) => ipcRenderer.invoke(SETTINGS_CHANNELS.testProxy, proxy),
  getAppInfo: () => ipcRenderer.invoke(SETTINGS_CHANNELS.appInfo),
  checkForUpdates: () => ipcRenderer.invoke(SETTINGS_CHANNELS.checkUpdates),
  installUpdate: () => ipcRenderer.invoke(SETTINGS_CHANNELS.installUpdate),
  openExternal: (url: string) => ipcRenderer.invoke(SETTINGS_CHANNELS.openExternal, url),
  listFontFamilies: () => ipcRenderer.invoke(SETTINGS_CHANNELS.listFontFamilies),
  getDatabaseHealth: (): Promise<DatabaseHealth> => ipcRenderer.invoke(DATABASE_CHANNELS.health),
  listLiveChannels: () => ipcRenderer.invoke(LIVE_CHANNELS.list),
  listLiveChannelColumns: () => ipcRenderer.invoke(LIVE_CHANNELS.listColumns),
  addLiveChannelColumn: (request: AddLiveChannelColumnRequest) =>
    ipcRenderer.invoke(LIVE_CHANNELS.addColumn, request),
  updateLiveChannelColumn: (request: UpdateLiveChannelColumnRequest) =>
    ipcRenderer.invoke(LIVE_CHANNELS.updateColumn, request),
  removeLiveChannelColumn: (id: string) => ipcRenderer.invoke(LIVE_CHANNELS.removeColumn, id),
  refreshLiveCatalog: () => ipcRenderer.invoke(LIVE_CHANNELS.refreshCatalog),
  previewLiveChannel: (request: PreviewLiveChannelRequest) =>
    ipcRenderer.invoke(LIVE_CHANNELS.previewChannel, request),
  addLiveChannel: (request: AddLiveChannelRequest) =>
    ipcRenderer.invoke(LIVE_CHANNELS.addChannel, request),
  updateLiveChannel: (request: UpdateLiveChannelRequest) =>
    ipcRenderer.invoke(LIVE_CHANNELS.updateChannel, request),
  removeLiveChannel: (id: string) => ipcRenderer.invoke(LIVE_CHANNELS.removeChannel, id),
  getLiveStatuses: (videoIds: string[]) => ipcRenderer.invoke(LIVE_CHANNELS.statuses, videoIds),
  getLivePlayerState: () => ipcRenderer.invoke(LIVE_CHANNELS.getState),
  updateLivePlayerState: (patch: LivePlayerStatePatch) =>
    ipcRenderer.invoke(LIVE_CHANNELS.updateState, patch),
  setLivePlayerMode: (mode: LivePlayerMode) => ipcRenderer.invoke(LIVE_CHANNELS.setMode, mode),
  getLivePlaybackState: () => ipcRenderer.invoke(LIVE_CHANNELS.getPlaybackState),
  updateLivePlaybackState: (state: LivePlaybackState) =>
    ipcRenderer.invoke(LIVE_CHANNELS.updatePlaybackState, state),
  dispatchLivePlaybackCommand: (command: LivePlaybackCommand) =>
    ipcRenderer.invoke(LIVE_CHANNELS.dispatchPlaybackCommand, command),
  fitLiveVideoWindow: () => ipcRenderer.invoke(LIVE_CHANNELS.fitVideoWindow),
  onSettingsUpdated: (callback: (settings: AppSettings) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, settings: AppSettings): void =>
      callback(settings)
    ipcRenderer.on(SETTINGS_CHANNELS.updated, listener)
    return (): void => {
      ipcRenderer.removeListener(SETTINGS_CHANNELS.updated, listener)
    }
  },
  onNavigateSettings: (callback: (tab: SettingsTabId) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, tab: unknown): void => {
      if (isSettingsTabId(tab)) {
        callback(tab)
      }
    }
    ipcRenderer.on(SETTINGS_CHANNELS.navigate, listener)
    return (): void => {
      ipcRenderer.removeListener(SETTINGS_CHANNELS.navigate, listener)
    }
  },
  onUpdateStatus: (callback: (update: UpdateCheckResult) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, update: UpdateCheckResult): void =>
      callback(update)
    ipcRenderer.on(SETTINGS_CHANNELS.updateStatus, listener)
    return (): void => {
      ipcRenderer.removeListener(SETTINGS_CHANNELS.updateStatus, listener)
    }
  },
  onFontFamiliesUpdated: (callback: (snapshot: FontFamiliesSnapshot) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, snapshot: FontFamiliesSnapshot): void =>
      callback(snapshot)
    ipcRenderer.on(SETTINGS_CHANNELS.fontFamiliesUpdated, listener)
    return (): void => {
      ipcRenderer.removeListener(SETTINGS_CHANNELS.fontFamiliesUpdated, listener)
    }
  },
  onLiveChannelsChanged: (callback: (snapshot: LiveChannelsSnapshot) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, snapshot: LiveChannelsSnapshot): void =>
      callback(snapshot)
    ipcRenderer.on(LIVE_CHANNELS.channelsChanged, listener)
    return (): void => {
      ipcRenderer.removeListener(LIVE_CHANNELS.channelsChanged, listener)
    }
  },
  onLivePlayerStateChanged: (callback: (state: LivePlayerState) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: LivePlayerState): void =>
      callback(state)
    ipcRenderer.on(LIVE_CHANNELS.stateChanged, listener)
    return (): void => {
      ipcRenderer.removeListener(LIVE_CHANNELS.stateChanged, listener)
    }
  },
  onLivePlayerModeChanged: (callback: (mode: LivePlayerMode) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, mode: unknown): void => {
      if (isLivePlayerMode(mode)) {
        callback(mode)
      }
    }
    ipcRenderer.on(LIVE_CHANNELS.modeChanged, listener)
    return (): void => {
      ipcRenderer.removeListener(LIVE_CHANNELS.modeChanged, listener)
    }
  },
  onLivePlaybackStateChanged: (callback: (state: LivePlaybackState) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: LivePlaybackState): void =>
      callback(state)
    ipcRenderer.on(LIVE_CHANNELS.playbackStateChanged, listener)
    return (): void => {
      ipcRenderer.removeListener(LIVE_CHANNELS.playbackStateChanged, listener)
    }
  },
  onLivePlaybackCommand: (callback: (command: LivePlaybackCommand) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, command: unknown): void => {
      if (isLivePlaybackCommand(command)) {
        callback(command)
      }
    }
    ipcRenderer.on(LIVE_CHANNELS.playbackCommand, listener)
    return (): void => {
      ipcRenderer.removeListener(LIVE_CHANNELS.playbackCommand, listener)
    }
  }
}

function normalizeLogDetails(details: unknown, seen = new WeakSet<object>(), depth = 0): unknown {
  if (typeof details === 'function') {
    return `[Function ${details.name || 'anonymous'}]`
  }
  if (typeof details === 'symbol') {
    return String(details)
  }
  if (!details || typeof details !== 'object') {
    return details
  }
  const errorLike = details as { name?: unknown; message?: unknown; stack?: unknown }
  if (typeof errorLike.message === 'string') {
    return {
      name: typeof errorLike.name === 'string' ? errorLike.name : 'Error',
      message: errorLike.message,
      stack: typeof errorLike.stack === 'string' ? errorLike.stack : undefined
    }
  }
  if (seen.has(details)) {
    return '[Circular]'
  }
  if (depth >= 5) {
    return '[MaxDepth]'
  }
  seen.add(details)
  if (Array.isArray(details)) {
    return details.slice(0, 50).map((item) => normalizeLogDetails(item, seen, depth + 1))
  }
  const normalized: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(details).slice(0, 50)) {
    normalized[key] = normalizeLogDetails(value, seen, depth + 1)
  }
  return normalized
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  const preloadWindow = window as Window &
    typeof globalThis & {
      electron: typeof electronAPI
      api: typeof api
    }
  preloadWindow.electron = electronAPI
  preloadWindow.api = api
}

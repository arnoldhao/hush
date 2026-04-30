import {
  app,
  shell,
  BrowserWindow,
  ipcMain,
  nativeTheme,
  Menu,
  nativeImage,
  screen,
  Tray,
  type BrowserWindowConstructorOptions,
  type MenuItemConstructorOptions,
  type NativeImage,
  type TitleBarOverlayOptions
} from 'electron'
import { mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import appIcon from '../../resources/icon.png?asset'
import trayColorIcon from '../../resources/tray.png?asset'
import trayTemplateIcon from '../../resources/tray-template.png?asset'
import trayWindowsIcon from '../../resources/tray.ico?asset'
import { AppDatabase } from './database'
import { LiveService } from './live-service'
import {
  initializeLogger,
  logDebug,
  logError,
  logInfo,
  logWarning,
  setLoggerLevel,
  type AppLogLevel
} from './logger'
import { SettingsService } from './settings-service'
import { SystemFontService } from './system-fonts'
import { TelemetryService, resolveTelemetryDeckAppId } from './telemetry-service'
import { APP_APP_ID, APP_DISPLAY_NAME, APP_INTERNAL_NAME } from '../shared/app'
import { DATABASE_CHANNELS } from '../shared/database'
import { getText } from '../shared/i18n'
import { LOGGING_CHANNELS, isAppLogLevel, type RendererLogEntry } from '../shared/logging'
import {
  LIVE_AUDIO_DOUBLE_LAYOUT_MIN_WIDTH,
  LIVE_CHANNELS,
  isLivePlaybackCommand,
  isLivePlayerMode,
  type LiveChannelsSnapshot,
  type LivePlaybackCommand,
  type LivePlaybackState,
  type LivePlayerMode,
  type LivePlayerState
} from '../shared/live'
import {
  SETTINGS_CHANNELS,
  isSettingsTabId,
  resolveThemePack,
  type FontFamiliesSnapshot,
  type AppSettings,
  type MenuBarVisibility,
  type SettingsTabId,
  type UpdateCheckResult,
  type UpdateSettingsRequest,
  type WindowBounds
} from '../shared/settings'

const SETTINGS_TITLE_BAR_HEIGHT = 36
const PLAYER_TITLE_BAR_HEIGHT = 36
const MAIN_WINDOW_MIN_WIDTH = 360
const MAIN_WINDOW_MIN_HEIGHT = 520
const MAIN_WINDOW_MAX_WIDTH = 2400
const MAIN_WINDOW_MAX_HEIGHT = 1800
const MINI_PLAYER_BOUNDS = { width: 300, height: 132 }
const VIDEO_PLAYER_TOPBAR_HEIGHT = 74
const VIDEO_PLAYER_FRAME_MARGIN_X = 10
const VIDEO_PLAYER_FRAME_MARGIN_TOP = 8
const VIDEO_PLAYER_FRAME_MARGIN_BOTTOM = 10
const VIDEO_PLAYER_ASPECT_RATIO = 16 / 9
const VIDEO_PLAYER_MIN_CONTENT_HEIGHT = 260
const TRAY_ICON_SIZE = process.platform === 'darwin' ? 18 : 16
const TRAY_SINGLE_CLICK_DELAY_MS = 120
const WINDOWS_TITLE_BAR_OVERLAY_COLOR = 'rgba(0, 0, 0, 0)'
const ALLOWED_EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

type RestoredWindowBoundsOptions = Pick<BrowserWindowConstructorOptions, 'width' | 'height'> &
  Partial<Pick<BrowserWindowConstructorOptions, 'x' | 'y'>>

let appPathsConfigured = false

configureAppIdentity()
configurePlaybackPolicy()
configureAppPaths()
registerProcessLogging()

let mainWindow: BrowserWindow | null = null
let miniWindow: BrowserWindow | null = null
let trayPreviewWindow: BrowserWindow | null = null
let settingsWindow: BrowserWindow | null = null
let settingsService: SettingsService | null = null
let appDatabase: AppDatabase | null = null
let liveService: LiveService | null = null
let systemFontService: SystemFontService | null = null
let telemetryService: TelemetryService | null = null
let tray: Tray | null = null
let trayMenu: Menu | null = null
let isQuitting = false
let currentPlayerMode: LivePlayerMode = 'audio'
let currentPlaybackState: LivePlaybackState = 'idle'
let isClosingMiniWindow = false
let isClosingTrayPreviewWindow = false
let telemetryQuitFlushCompleted = false
let isInstallingDownloadedUpdate = false
let isTrayPreviewReadyToShow = false
let shouldShowTrayPreviewWhenReady = false
let pendingTrayPreviewBounds: Electron.Rectangle | undefined
let traySingleClickTimer: ReturnType<typeof setTimeout> | null = null
const windowBoundsSaveTimers = new Map<'main' | 'settings', ReturnType<typeof setTimeout>>()

function configureAppIdentity(): void {
  app.setName(APP_DISPLAY_NAME)
  app.setAboutPanelOptions({ applicationName: APP_DISPLAY_NAME })
}

function configureDockIcon(): void {
  if (process.platform === 'darwin') {
    app.dock?.setIcon(appIcon)
  }
}

function configurePlaybackPolicy(): void {
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
}

function configureAppPaths(): void {
  if (appPathsConfigured) {
    return
  }
  appPathsConfigured = true
  const userDataPath = join(app.getPath('appData'), APP_INTERNAL_NAME)
  const sessionDataPath = join(userDataPath, 'session-data')
  const logDataPath = join(userDataPath, 'logs')
  mkdirSync(userDataPath, { recursive: true })
  mkdirSync(sessionDataPath, { recursive: true })
  mkdirSync(logDataPath, { recursive: true })
  app.setPath('userData', userDataPath)
  app.setPath('sessionData', sessionDataPath)
  app.setAppLogsPath(logDataPath)
  initializeLogger({
    logDir: logDataPath,
    level: 'info',
    mirrorToConsole: is.dev,
    metadata: {
      appVersion: app.getVersion(),
      platform: process.platform,
      packaged: app.isPackaged
    }
  })
  cleanupDamagedChromiumCaches(userDataPath)
  cleanupDamagedChromiumCaches(sessionDataPath)
}

function registerProcessLogging(): void {
  process.on('uncaughtException', (error) => {
    logError('process:uncaughtException', 'unhandled exception', error)
  })
  process.on('unhandledRejection', (reason) => {
    logError('process:unhandledRejection', 'unhandled promise rejection', reason)
  })
  app.on('child-process-gone', (_event, details) => {
    logError('app:child-process-gone', 'child process exited unexpectedly', details)
  })
}

function cleanupDamagedChromiumCaches(userDataPath: string): void {
  for (const cachePath of [
    join(userDataPath, 'Cache'),
    join(userDataPath, 'Code Cache'),
    join(userDataPath, 'GPUCache'),
    join(userDataPath, 'DawnCache'),
    join(userDataPath, 'Shared Dictionary'),
    join(userDataPath, 'Partitions', 'hush-youtube', 'Cache'),
    join(userDataPath, 'Partitions', 'hush-youtube', 'Code Cache'),
    join(userDataPath, 'Partitions', 'hush-youtube', 'GPUCache'),
    join(userDataPath, 'Partitions', 'hush-youtube', 'Shared Dictionary')
  ]) {
    try {
      rmSync(cachePath, { recursive: true, force: true })
    } catch {
      // Chromium will recreate these caches; stale or malformed cache files should not block startup.
    }
  }
}

function createWindow(): void {
  const settings = getSettingsService().getSettings()
  const text = getText(settings.language)
  const minimumSize = getMainWindowMinimumSize(currentPlayerMode)
  // Create the browser window.
  mainWindow = new BrowserWindow({
    ...getRestoredWindowBoundsOptions(settings.mainBounds, minimumSize),
    minWidth: minimumSize.width,
    minHeight: minimumSize.height,
    maxWidth: MAIN_WINDOW_MAX_WIDTH,
    maxHeight: MAIN_WINDOW_MAX_HEIGHT,
    show: false,
    title: text.windowTitles.main,
    autoHideMenuBar: settings.menuBarVisibility !== 'always',
    ...getPlayerWindowChromeOptions(settings),
    ...(process.platform !== 'darwin' ? { icon: appIcon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true,
      backgroundThrottling: false
    }
  })
  attachWebContentsDiagnostics(mainWindow, 'main')
  configurePlaybackWebContents(mainWindow)
  trackWindowBounds(mainWindow, 'main')

  mainWindow.on('ready-to-show', () => {
    restoreWindowState(mainWindow, settings.mainBounds)
    if (settings.minimizeToTrayOnStart || currentPlayerMode === 'mini') {
      mainWindow?.hide()
      updateTray(getSettingsService().getSettings())
      return
    }
    mainWindow?.show()
    updateTray(getSettingsService().getSettings())
  })

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault()
      hideMainWindowToTray()
      return
    }
    flushWindowBounds('main')
  })

  mainWindow.on('closed', () => {
    mainWindow = null
    closeTrayPreviewWindow()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    void openExternalUrl(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  getSettingsService().applyMenuBarToWindow(mainWindow)
  updateTray(settings)
}

function createMiniWindow(bounds?: Electron.Rectangle): BrowserWindow {
  const settings = getSettingsService().getSettings()
  const text = getText(settings.language)
  miniWindow = new BrowserWindow({
    width: MINI_PLAYER_BOUNDS.width,
    height: MINI_PLAYER_BOUNDS.height,
    minWidth: MINI_PLAYER_BOUNDS.width,
    minHeight: MINI_PLAYER_BOUNDS.height,
    maxWidth: MINI_PLAYER_BOUNDS.width,
    maxHeight: MINI_PLAYER_BOUNDS.height,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    show: false,
    title: text.windowTitles.main,
    autoHideMenuBar: true,
    skipTaskbar: true,
    ...getMiniWindowChromeOptions(settings),
    ...(process.platform !== 'darwin' ? { icon: appIcon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false
    }
  })
  attachWebContentsDiagnostics(miniWindow, 'mini')
  configurePlaybackWebContents(miniWindow)

  miniWindow.on('ready-to-show', () => {
    if (!miniWindow || miniWindow.isDestroyed()) {
      return
    }
    positionMiniPlayer(bounds)
    miniWindow.show()
  })

  miniWindow.on('close', (event) => {
    if (isQuitting || isClosingMiniWindow) {
      return
    }
    event.preventDefault()
    showMainWindow('audio')
  })

  miniWindow.on('closed', () => {
    miniWindow = null
    isClosingMiniWindow = false
  })

  miniWindow.webContents.setWindowOpenHandler((details) => {
    void openExternalUrl(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    miniWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?window=mini`)
  } else {
    miniWindow.loadFile(join(__dirname, '../renderer/index.html'), {
      query: { window: 'mini' }
    })
  }

  getSettingsService().applyMenuBarToWindow(miniWindow)
  return miniWindow
}

function createTrayPreviewWindow(): BrowserWindow {
  const settings = getSettingsService().getSettings()
  const text = getText(settings.language)
  isTrayPreviewReadyToShow = false
  trayPreviewWindow = new BrowserWindow({
    width: MINI_PLAYER_BOUNDS.width,
    height: MINI_PLAYER_BOUNDS.height,
    minWidth: MINI_PLAYER_BOUNDS.width,
    minHeight: MINI_PLAYER_BOUNDS.height,
    maxWidth: MINI_PLAYER_BOUNDS.width,
    maxHeight: MINI_PLAYER_BOUNDS.height,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    frame: false,
    show: false,
    title: text.windowTitles.main,
    autoHideMenuBar: true,
    skipTaskbar: true,
    ...(process.platform !== 'darwin' ? { icon: appIcon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false
    }
  })
  attachWebContentsDiagnostics(trayPreviewWindow, 'tray-preview')
  configurePlaybackWebContents(trayPreviewWindow)

  trayPreviewWindow.on('ready-to-show', () => {
    if (!trayPreviewWindow || trayPreviewWindow.isDestroyed()) {
      return
    }
    isTrayPreviewReadyToShow = true
    positionTrayPreviewWindow(pendingTrayPreviewBounds)
    if (shouldShowTrayPreviewWhenReady) {
      showReadyTrayPreviewWindow()
    }
  })

  trayPreviewWindow.on('blur', () => {
    if (!isClosingTrayPreviewWindow) {
      hideTrayPreviewWindow()
    }
  })

  trayPreviewWindow.on('closed', () => {
    trayPreviewWindow = null
    isClosingTrayPreviewWindow = false
    isTrayPreviewReadyToShow = false
    shouldShowTrayPreviewWhenReady = false
    pendingTrayPreviewBounds = undefined
  })

  trayPreviewWindow.webContents.setWindowOpenHandler((details) => {
    void openExternalUrl(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    trayPreviewWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?window=tray-preview`)
  } else {
    trayPreviewWindow.loadFile(join(__dirname, '../renderer/index.html'), {
      query: { window: 'tray-preview' }
    })
  }

  getSettingsService().applyMenuBarToWindow(trayPreviewWindow)
  return trayPreviewWindow
}

function createSettingsWindow(tab?: SettingsTabId): BrowserWindow {
  const settings = getSettingsService().getSettings()
  const text = getText(settings.language)
  settingsWindow = new BrowserWindow({
    ...getRestoredWindowBoundsOptions(settings.settingsBounds, { width: 480, height: 550 }),
    minWidth: 480,
    minHeight: 550,
    show: false,
    title: text.windowTitles.settings,
    autoHideMenuBar: true,
    ...getSettingsWindowChromeOptions(settings),
    ...(process.platform !== 'darwin' ? { icon: appIcon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  attachWebContentsDiagnostics(settingsWindow, 'settings')
  trackWindowBounds(settingsWindow, 'settings')

  settingsWindow.on('ready-to-show', () => {
    restoreWindowState(settingsWindow, settings.settingsBounds)
    settingsWindow?.show()
    settingsWindow?.focus()
    if (tab) {
      sendSettingsNavigation(tab)
    }
  })

  settingsWindow.on('close', () => {
    flushWindowBounds('settings')
  })

  settingsWindow.on('closed', () => {
    settingsWindow = null
  })

  settingsWindow.webContents.setWindowOpenHandler((details) => {
    void openExternalUrl(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    settingsWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?window=settings`)
  } else {
    settingsWindow.loadFile(join(__dirname, '../renderer/index.html'), {
      query: { window: 'settings' }
    })
  }

  return settingsWindow
}

function attachWebContentsDiagnostics(window: BrowserWindow, label: string): void {
  window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    if (errorCode === -3) {
      return
    }
    logError(`${label}:load`, 'web contents failed to load', {
      errorCode,
      errorDescription,
      url: validatedURL
    })
  })

  window.webContents.on(
    'did-fail-provisional-load',
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (errorCode === -3) {
        return
      }
      logError(`${label}:provisional-load`, 'web contents failed provisional load', {
        errorCode,
        errorDescription,
        url: validatedURL,
        isMainFrame
      })
    }
  )

  window.webContents.on('preload-error', (_event, preloadPath, error) => {
    logError(`${label}:preload`, 'preload script failed', { preloadPath, error })
  })

  window.webContents.on('render-process-gone', (_event, details) => {
    logError(`${label}:renderer-gone`, 'renderer process exited', details)
  })

  window.webContents.on('console-message', (event) => {
    const details = event as Electron.Event<Electron.WebContentsConsoleMessageEventParams>
    const level = getRendererConsoleLogLevel(details.level)
    if (!level) {
      return
    }
    logRendererConsoleMessage(level, label, details)
  })
}

function getRendererConsoleLogLevel(level: string): AppLogLevel | null {
  if (level === 'error') {
    return 'error'
  }
  if (level === 'warning') {
    return 'warn'
  }
  if (level === 'debug') {
    return 'debug'
  }
  return null
}

function logRendererConsoleMessage(
  level: AppLogLevel,
  label: string,
  details: Electron.WebContentsConsoleMessageEventParams
): void {
  const payload = {
    message: details.message,
    sourceId: details.sourceId,
    lineNumber: details.lineNumber
  }
  if (level === 'error') {
    logError(`${label}:console`, 'renderer console error', payload)
    return
  }
  if (level === 'warn') {
    logWarning(`${label}:console`, 'renderer console warning', payload)
    return
  }
  logDebug(`${label}:console`, 'renderer console debug', payload)
}

function configurePlaybackWebContents(window: BrowserWindow): void {
  window.webContents.setAudioMuted(false)
  window.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    if (!isAllowedPlaybackWebviewUrl(params.src)) {
      event.preventDefault()
      return
    }

    delete webPreferences.preload
    webPreferences.contextIsolation = true
    webPreferences.nodeIntegration = false
    webPreferences.sandbox = true
  })
  window.webContents.on('did-attach-webview', (_event, webContents) => {
    webContents.setAudioMuted(false)
    webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    webContents.on('will-navigate', (event, url) => {
      if (!isAllowedPlaybackWebviewUrl(url)) {
        event.preventDefault()
      }
    })
  })
}

function isAllowedPlaybackWebviewUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl)
    const host = parsed.hostname.replace(/^www\./, '').toLowerCase()
    return (
      parsed.protocol === 'https:' &&
      (host === 'youtube.com' || host === 'youtube-nocookie.com') &&
      parsed.pathname.startsWith('/embed/')
    )
  } catch {
    return false
  }
}

function showSettingsWindow(tab?: SettingsTabId): void {
  if (settingsWindow) {
    if (settingsWindow.isMinimized()) {
      settingsWindow.restore()
    }
    settingsWindow.show()
    settingsWindow.focus()
    if (tab) {
      sendSettingsNavigation(tab)
    }
    return
  }
  createSettingsWindow(tab)
}

function sendSettingsNavigation(tab: SettingsTabId): void {
  settingsWindow?.webContents.send(SETTINGS_CHANNELS.navigate, tab)
}

function broadcastSettings(settings: AppSettings): void {
  setLoggerLevel(settings.logLevel)
  syncNativeShell(settings)
  BrowserWindow.getAllWindows().forEach((window) => {
    if (window.isDestroyed() || window.webContents.isDestroyed()) {
      return
    }
    try {
      window.webContents.send(SETTINGS_CHANNELS.updated, settings)
    } catch (error) {
      logError('settings:broadcast', 'failed to send settings update', error)
    }
  })
}

function broadcastFontFamilies(snapshot: FontFamiliesSnapshot): void {
  BrowserWindow.getAllWindows().forEach((window) => {
    window.webContents.send(SETTINGS_CHANNELS.fontFamiliesUpdated, snapshot)
  })
}

function broadcastUpdateStatus(update: UpdateCheckResult): void {
  BrowserWindow.getAllWindows().forEach((window) => {
    if (window.isDestroyed() || window.webContents.isDestroyed()) {
      return
    }
    window.webContents.send(SETTINGS_CHANNELS.updateStatus, update)
  })
}

function broadcastLivePlaybackState(): void {
  BrowserWindow.getAllWindows().forEach((window) => {
    window.webContents.send(LIVE_CHANNELS.playbackStateChanged, currentPlaybackState)
  })
}

function broadcastLiveChannels(snapshot: LiveChannelsSnapshot): void {
  BrowserWindow.getAllWindows().forEach((window) => {
    window.webContents.send(LIVE_CHANNELS.channelsChanged, snapshot)
  })
}

function broadcastLivePlayerState(state: LivePlayerState): void {
  BrowserWindow.getAllWindows().forEach((window) => {
    window.webContents.send(LIVE_CHANNELS.stateChanged, state)
  })
}

function getSettingsService(): SettingsService {
  if (!settingsService) {
    throw new Error('Settings service is not initialized')
  }
  return settingsService
}

function getSystemFontService(): SystemFontService {
  if (!systemFontService) {
    throw new Error('System font service is not initialized')
  }
  return systemFontService
}

function getDatabase(): AppDatabase {
  if (!appDatabase) {
    throw new Error('Database is not initialized')
  }
  return appDatabase
}

function getLiveService(): LiveService {
  if (!liveService) {
    throw new Error('Live service is not initialized')
  }
  return liveService
}

function registerIpcHandlers(): void {
  const service = getSettingsService()

  ipcMain.on(LOGGING_CHANNELS.write, (_event, entry: RendererLogEntry) => {
    writeRendererLog(entry)
  })
  ipcMain.handle(SETTINGS_CHANNELS.get, () => service.getSettings())
  ipcMain.handle(SETTINGS_CHANNELS.update, async (_event, patch: UpdateSettingsRequest) => {
    return runLoggedIpcHandler(SETTINGS_CHANNELS.update, () => service.updateSettings(patch))
  })
  ipcMain.handle(SETTINGS_CHANNELS.showWindow, (_event, tab?: SettingsTabId) => {
    showSettingsWindow(isSettingsTabId(tab) ? tab : undefined)
  })
  ipcMain.handle(SETTINGS_CHANNELS.hideWindow, () => {
    settingsWindow?.hide()
  })
  ipcMain.handle(SETTINGS_CHANNELS.openLogDirectory, async () => {
    await runLoggedIpcHandler(SETTINGS_CHANNELS.openLogDirectory, () => service.openLogDirectory())
  })
  ipcMain.handle(SETTINGS_CHANNELS.systemProxyInfo, async () => {
    return runLoggedIpcHandler(SETTINGS_CHANNELS.systemProxyInfo, () =>
      service.getSystemProxyInfo()
    )
  })
  ipcMain.handle(SETTINGS_CHANNELS.testProxy, async (_event, proxy) => {
    return runLoggedIpcHandler(SETTINGS_CHANNELS.testProxy, () => service.testProxy(proxy))
  })
  ipcMain.handle(SETTINGS_CHANNELS.appInfo, () => service.getAppInfo())
  ipcMain.handle(SETTINGS_CHANNELS.checkUpdates, async () => {
    return runLoggedIpcHandler(SETTINGS_CHANNELS.checkUpdates, () => service.checkForUpdates())
  })
  ipcMain.handle(SETTINGS_CHANNELS.installUpdate, async () => {
    return runLoggedIpcHandler(SETTINGS_CHANNELS.installUpdate, async () => {
      if (!telemetryQuitFlushCompleted && telemetryService?.enabled()) {
        telemetryQuitFlushCompleted = true
        try {
          await telemetryService.flushSessionSummary()
        } catch (error) {
          logWarning(
            'updates:telemetry-flush',
            'telemetry flush failed before update install',
            error
          )
        }
      }
      isInstallingDownloadedUpdate = true
      try {
        return service.installDownloadedUpdate()
      } catch (error) {
        isInstallingDownloadedUpdate = false
        throw error
      }
    })
  })
  ipcMain.handle(SETTINGS_CHANNELS.openExternal, async (_event, url: string) => {
    await runLoggedIpcHandler(SETTINGS_CHANNELS.openExternal, () =>
      openExternalUrl(String(url ?? ''))
    )
  })
  ipcMain.handle(SETTINGS_CHANNELS.listFontFamilies, async () => {
    return runLoggedIpcHandler(SETTINGS_CHANNELS.listFontFamilies, () =>
      getSystemFontService().getFontFamilies()
    )
  })
  ipcMain.handle(DATABASE_CHANNELS.health, () => {
    return getDatabase().getHealth()
  })
  ipcMain.handle(LIVE_CHANNELS.list, async () => {
    return getLiveService().listChannels()
  })
  ipcMain.handle(LIVE_CHANNELS.listColumns, () => {
    return getLiveService().listColumns()
  })
  ipcMain.handle(LIVE_CHANNELS.addColumn, async (_event, request: { title?: string }) => {
    const columns = getLiveService().addColumn(String(request?.title ?? ''))
    broadcastLiveChannels(await getLiveService().listChannels())
    return columns
  })
  ipcMain.handle(
    LIVE_CHANNELS.updateColumn,
    async (_event, request: { id?: string; title?: string }) => {
      const columns = getLiveService().updateColumn(
        String(request?.id ?? ''),
        String(request?.title ?? '')
      )
      broadcastLiveChannels(await getLiveService().listChannels())
      return columns
    }
  )
  ipcMain.handle(LIVE_CHANNELS.removeColumn, async (_event, id: string) => {
    const columns = getLiveService().removeColumn(String(id ?? ''))
    broadcastLiveChannels(await getLiveService().listChannels())
    return columns
  })
  ipcMain.handle(LIVE_CHANNELS.refreshCatalog, async () => {
    const snapshot = await getLiveService().refreshCatalog()
    broadcastLiveChannels(snapshot)
    return snapshot
  })
  ipcMain.handle(LIVE_CHANNELS.previewChannel, async (_event, request: { url?: string }) => {
    return getLiveService().previewCustomChannel(String(request?.url ?? ''))
  })
  ipcMain.handle(
    LIVE_CHANNELS.addChannel,
    async (_event, request: { url?: string; title?: string; groupTitle?: string }) => {
      const channel = await getLiveService().addCustomChannel(
        String(request?.url ?? ''),
        String(request?.title ?? ''),
        String(request?.groupTitle ?? '')
      )
      broadcastLiveChannels(await getLiveService().listChannels())
      return channel
    }
  )
  ipcMain.handle(
    LIVE_CHANNELS.updateChannel,
    async (_event, request: { id?: string; title?: string; groupTitle?: string }) => {
      const snapshot = await getLiveService().updateCustomChannel(
        String(request?.id ?? ''),
        String(request?.title ?? ''),
        String(request?.groupTitle ?? '')
      )
      broadcastLiveChannels(snapshot)
      return snapshot
    }
  )
  ipcMain.handle(LIVE_CHANNELS.removeChannel, async (_event, id: string) => {
    const snapshot = await getLiveService().removeCustomChannel(String(id ?? ''))
    broadcastLiveChannels(snapshot)
    broadcastLivePlayerState(getLiveService().getState())
    return snapshot
  })
  ipcMain.handle(LIVE_CHANNELS.statuses, async (_event, videoIds: string[]) => {
    return getLiveService().getStatuses(Array.isArray(videoIds) ? videoIds : [])
  })
  ipcMain.handle(LIVE_CHANNELS.getState, () => {
    return getLiveService().getState()
  })
  ipcMain.handle(LIVE_CHANNELS.updateState, (_event, patch) => {
    const state = getLiveService().updateState(patch ?? {})
    broadcastLivePlayerState(state)
    return state
  })
  ipcMain.handle(LIVE_CHANNELS.setMode, async (_event, mode: LivePlayerMode) => {
    return setLivePlayerMode(mode)
  })
  ipcMain.handle(LIVE_CHANNELS.getPlaybackState, () => {
    return currentPlaybackState
  })
  ipcMain.handle(LIVE_CHANNELS.updatePlaybackState, (_event, state: LivePlaybackState) => {
    currentPlaybackState = sanitizeLivePlaybackState(state)
    broadcastLivePlaybackState()
    return currentPlaybackState
  })
  ipcMain.handle(LIVE_CHANNELS.dispatchPlaybackCommand, (_event, command: LivePlaybackCommand) => {
    if (!isLivePlaybackCommand(command)) {
      return
    }
    if (!mainWindow) {
      createWindow()
    }
    mainWindow?.webContents.send(LIVE_CHANNELS.playbackCommand, command)
  })
  ipcMain.handle(LIVE_CHANNELS.fitVideoWindow, () => {
    fitMainWindowToLiveVideo()
  })
}

async function runLoggedIpcHandler<T>(channel: string, handler: () => T | Promise<T>): Promise<T> {
  try {
    return await handler()
  } catch (error) {
    logError(`${channel}:ipc`, 'ipc handler failed', error)
    throw error
  }
}

function writeRendererLog(entry: RendererLogEntry): void {
  const level = isAppLogLevel(entry?.level) ? entry.level : 'info'
  const scope = `renderer:${typeof entry?.scope === 'string' ? entry.scope : 'app'}`
  const message =
    typeof entry?.message === 'string' && entry.message.trim() ? entry.message : 'renderer log'

  if (level === 'error') {
    logError(scope, message, entry?.details)
    return
  }
  if (level === 'warn') {
    logWarning(scope, message, entry?.details)
    return
  }
  if (level === 'debug') {
    logDebug(scope, message, entry?.details)
    return
  }
  logInfo(scope, message, entry?.details)
}

function ensureTray(): Tray {
  if (tray) {
    return tray
  }
  tray = new Tray(createTrayIcon())
  tray.on('click', (_event, bounds) => {
    scheduleTraySingleClick(bounds)
  })
  tray.on('double-click', () => {
    clearTraySingleClickTimer()
    hideTrayPreviewWindow()
    showMainWindowFromTray()
  })
  tray.on('right-click', () => {
    clearTraySingleClickTimer()
    hideTrayPreviewWindow()
    tray?.popUpContextMenu(trayMenu ?? createTrayMenu(getSettingsService().getSettings()))
  })
  return tray
}

function updateTray(settings: AppSettings): void {
  if (!shouldKeepTray(settings)) {
    clearTraySingleClickTimer()
    closeTrayPreviewWindow()
    tray?.destroy()
    tray = null
    trayMenu = null
    return
  }

  const currentTray = ensureTray()
  const text = getText(settings.language)
  trayMenu = createTrayMenu(settings)
  currentTray.setImage(createTrayIcon())
  currentTray.setToolTip(text.windowTitles.main)
  preloadTrayPreviewWindow()
}

function shouldKeepTray(settings: AppSettings): boolean {
  if (process.platform === 'win32' || settings.menuBarVisibility !== 'never') {
    return true
  }
  return Boolean(mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible())
}

function scheduleTraySingleClick(bounds?: Electron.Rectangle): void {
  clearTraySingleClickTimer()
  traySingleClickTimer = setTimeout(() => {
    traySingleClickTimer = null
    showTrayPreviewFromTray(bounds)
  }, TRAY_SINGLE_CLICK_DELAY_MS)
}

function clearTraySingleClickTimer(): void {
  if (!traySingleClickTimer) {
    return
  }
  clearTimeout(traySingleClickTimer)
  traySingleClickTimer = null
}

function preloadTrayPreviewWindow(): void {
  if (trayPreviewWindow && !trayPreviewWindow.isDestroyed()) {
    return
  }
  shouldShowTrayPreviewWhenReady = false
  createTrayPreviewWindow()
}

function createTrayMenu(settings: AppSettings): Menu {
  const text = getText(settings.language)
  const visibility =
    process.platform === 'win32' && settings.menuBarVisibility === 'never'
      ? 'whenRunning'
      : settings.menuBarVisibility
  const visibilityLabel =
    process.platform === 'win32' ? text.tray.showTrayIcon : text.tray.showInMenuBar
  const visibilitySubmenu: MenuItemConstructorOptions[] = [
    {
      label: text.tray.showAlways,
      type: 'radio',
      checked: visibility === 'always',
      click: () => updateMenuBarVisibility('always')
    },
    {
      label: text.tray.showWhenRunning,
      type: 'radio',
      checked: visibility === 'whenRunning',
      click: () => updateMenuBarVisibility('whenRunning')
    }
  ]

  if (process.platform !== 'win32') {
    visibilitySubmenu.push({
      label: text.tray.showNever,
      type: 'radio',
      checked: visibility === 'never',
      click: () => updateMenuBarVisibility('never')
    })
  }

  return Menu.buildFromTemplate([
    {
      label: text.tray.openApp,
      click: () => showMainWindowFromTray()
    },
    {
      label: text.tray.settings,
      click: () => showSettingsWindow('general')
    },
    { type: 'separator' },
    {
      label: visibilityLabel,
      submenu: visibilitySubmenu
    },
    { type: 'separator' },
    {
      label: text.tray.quit,
      click: () => {
        isQuitting = true
        app.quit()
      }
    }
  ])
}

function createTrayIcon(): NativeImage {
  const imagePath =
    process.platform === 'darwin'
      ? trayTemplateIcon
      : process.platform === 'win32'
        ? trayWindowsIcon
        : trayColorIcon
  const image = nativeImage.createFromPath(imagePath)
  const resized = image.isEmpty()
    ? image
    : image.resize({ width: TRAY_ICON_SIZE, height: TRAY_ICON_SIZE, quality: 'best' })
  if (process.platform === 'darwin') {
    resized.setTemplateImage(true)
  }
  return resized
}

async function openExternalUrl(rawUrl: string): Promise<void> {
  const normalized = rawUrl.trim()
  let parsed: URL
  try {
    parsed = new URL(normalized)
  } catch {
    throw new Error('Unsupported external URL')
  }

  if (!ALLOWED_EXTERNAL_PROTOCOLS.has(parsed.protocol.toLowerCase())) {
    throw new Error('Unsupported external URL')
  }

  await shell.openExternal(normalized)
}

function updateMenuBarVisibility(visibility: MenuBarVisibility): void {
  void settingsService?.updateSettings({ menuBarVisibility: visibility })
}

function showMainWindow(mode?: LivePlayerMode): void {
  if (!mainWindow) {
    createWindow()
  }
  if (mode) {
    void setLivePlayerMode(mode)
  }
  hideTrayPreviewWindow()
  closeMiniWindow()
  if (mainWindow?.isMinimized()) {
    mainWindow.restore()
  }
  mainWindow?.show()
  mainWindow?.focus()
  updateTray(getSettingsService().getSettings())
}

function showMainWindowFromTray(): void {
  showMainWindow(currentPlayerMode === 'mini' ? 'audio' : undefined)
}

function hideMainWindowToTray(): void {
  flushWindowBounds('main')
  hideTrayPreviewWindow()
  const window = mainWindow
  if (!window || window.isDestroyed()) {
    return
  }
  window.hide()
  updateTray(getSettingsService().getSettings())
}

function showTrayPreviewFromTray(bounds?: Electron.Rectangle): void {
  pendingTrayPreviewBounds = bounds
  shouldShowTrayPreviewWhenReady = true
  if (!trayPreviewWindow || trayPreviewWindow.isDestroyed()) {
    createTrayPreviewWindow()
    return
  }
  positionTrayPreviewWindow(bounds)
  if (isTrayPreviewReadyToShow) {
    showReadyTrayPreviewWindow()
  }
}

function showReadyTrayPreviewWindow(): void {
  if (!trayPreviewWindow || trayPreviewWindow.isDestroyed()) {
    return
  }
  shouldShowTrayPreviewWhenReady = false
  trayPreviewWindow.show()
  trayPreviewWindow.focus()
}

function openMiniPlayer(bounds?: Electron.Rectangle): void {
  hideTrayPreviewWindow()
  currentPlayerMode = 'mini'
  if (!mainWindow) {
    createWindow()
  }
  void setLivePlayerMode('mini', { miniBounds: bounds })
}

function positionTrayPreviewWindow(bounds?: Electron.Rectangle): void {
  const window = trayPreviewWindow
  if (!window || window.isDestroyed()) {
    return
  }
  if (bounds) {
    positionMiniPlayerNearTray(window, bounds)
    return
  }
  positionMiniPlayerNearMainWindow(window)
}

function positionMiniPlayer(bounds?: Electron.Rectangle): void {
  const window = miniWindow
  if (!window || window.isDestroyed()) {
    return
  }
  if (bounds) {
    positionMiniPlayerNearTray(window, bounds)
    return
  }
  positionMiniPlayerNearMainWindow(window)
}

function positionMiniPlayerNearTray(window: BrowserWindow, bounds: Electron.Rectangle): void {
  const display = screen.getDisplayNearestPoint({
    x: Math.round(bounds.x + bounds.width / 2),
    y: Math.round(bounds.y + bounds.height / 2)
  }) as Electron.Display
  const workArea = display.workArea
  const width = MINI_PLAYER_BOUNDS.width
  const height = MINI_PLAYER_BOUNDS.height
  const x = Math.min(
    Math.max(Math.round(bounds.x + bounds.width / 2 - width / 2), workArea.x + 8),
    workArea.x + workArea.width - width - 8
  )
  const trayBelowMidpoint = bounds.y > workArea.y + workArea.height / 2
  const y = trayBelowMidpoint
    ? Math.max(workArea.y + 8, Math.round(bounds.y - height - 10))
    : Math.min(workArea.y + workArea.height - height - 8, Math.round(bounds.y + bounds.height + 10))
  window.setPosition(x, y, false)
}

function positionMiniPlayerNearMainWindow(window: BrowserWindow): void {
  const anchor = mainWindow && !mainWindow.isDestroyed() ? mainWindow.getBounds() : undefined
  const display = anchor
    ? screen.getDisplayMatching(anchor)
    : screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const workArea = display.workArea
  const width = MINI_PLAYER_BOUNDS.width
  const height = MINI_PLAYER_BOUNDS.height
  const x = anchor
    ? Math.min(
        Math.max(Math.round(anchor.x + anchor.width - width - 18), workArea.x + 8),
        workArea.x + workArea.width - width - 8
      )
    : Math.round(workArea.x + workArea.width - width - 18)
  const y = anchor
    ? Math.min(
        Math.max(Math.round(anchor.y + 18), workArea.y + 8),
        workArea.y + workArea.height - height - 8
      )
    : Math.round(workArea.y + 18)
  window.setPosition(x, y, false)
}

function closeMiniWindow(): void {
  if (!miniWindow || miniWindow.isDestroyed()) {
    return
  }
  isClosingMiniWindow = true
  miniWindow.close()
}

function hideTrayPreviewWindow(): void {
  shouldShowTrayPreviewWhenReady = false
  pendingTrayPreviewBounds = undefined
  if (!trayPreviewWindow || trayPreviewWindow.isDestroyed() || !trayPreviewWindow.isVisible()) {
    return
  }
  trayPreviewWindow.hide()
}

function closeTrayPreviewWindow(): void {
  if (!trayPreviewWindow || trayPreviewWindow.isDestroyed() || isClosingTrayPreviewWindow) {
    return
  }
  isClosingTrayPreviewWindow = true
  trayPreviewWindow.close()
}

async function setLivePlayerMode(
  mode: LivePlayerMode,
  options: { miniBounds?: Electron.Rectangle } = {}
): Promise<ReturnType<LiveService['getState']>> {
  const nextMode = isLivePlayerMode(mode) ? mode : 'audio'
  if (currentPlayerMode !== 'mini') {
    flushWindowBounds('main')
  }
  currentPlayerMode = nextMode
  const state = getLiveService().updateState({ playerMode: nextMode })
  broadcastLivePlayerState(state)
  applyLivePlayerWindowMode(nextMode)
  mainWindow?.webContents.send(LIVE_CHANNELS.modeChanged, nextMode)
  miniWindow?.webContents.send(LIVE_CHANNELS.modeChanged, nextMode)
  trayPreviewWindow?.webContents.send(LIVE_CHANNELS.modeChanged, nextMode)
  if (nextMode === 'mini') {
    hideTrayPreviewWindow()
    mainWindow?.hide()
    if (!miniWindow || miniWindow.isDestroyed()) {
      createMiniWindow(options.miniBounds)
    } else {
      positionMiniPlayer(options.miniBounds)
      miniWindow.show()
      miniWindow.focus()
    }
  } else {
    closeMiniWindow()
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore()
      }
      mainWindow.show()
      mainWindow.focus()
    }
  }
  return state
}

function applyLivePlayerWindowMode(mode: LivePlayerMode): void {
  const window = mainWindow
  if (!window || window.isDestroyed()) {
    return
  }
  if (mode === 'mini') {
    window.setAlwaysOnTop(false)
    return
  }

  window.setResizable(true)
  const minimumSize = getMainWindowMinimumSize(mode)
  window.setMinimumSize(minimumSize.width, minimumSize.height)
  window.setMaximumSize(MAIN_WINDOW_MAX_WIDTH, MAIN_WINDOW_MAX_HEIGHT)
  ensureMainWindowMinimumBounds(window, minimumSize)
  window.setAlwaysOnTop(false)
}

function getMainWindowMinimumSize(mode: LivePlayerMode): { width: number; height: number } {
  return {
    width: mode === 'video' ? LIVE_AUDIO_DOUBLE_LAYOUT_MIN_WIDTH : MAIN_WINDOW_MIN_WIDTH,
    height: MAIN_WINDOW_MIN_HEIGHT
  }
}

function ensureMainWindowMinimumBounds(
  window: BrowserWindow,
  minimumSize: { width: number; height: number }
): void {
  const bounds = window.getBounds()
  const nextWidth = Math.min(MAIN_WINDOW_MAX_WIDTH, Math.max(bounds.width, minimumSize.width))
  const nextHeight = Math.min(MAIN_WINDOW_MAX_HEIGHT, Math.max(bounds.height, minimumSize.height))
  if (bounds.width === nextWidth && bounds.height === nextHeight) {
    return
  }

  const workArea = screen.getDisplayMatching(bounds).workArea
  const nextX = Math.min(
    Math.max(bounds.x, workArea.x),
    Math.max(workArea.x, workArea.x + workArea.width - nextWidth)
  )
  const nextY = Math.min(
    Math.max(bounds.y, workArea.y),
    Math.max(workArea.y, workArea.y + workArea.height - nextHeight)
  )
  window.setBounds(
    {
      x: nextX,
      y: nextY,
      width: nextWidth,
      height: nextHeight
    },
    false
  )
}

function fitMainWindowToLiveVideo(): void {
  const window = mainWindow
  if (!window || window.isDestroyed()) {
    return
  }

  ensureMainWindowMinimumBounds(window, {
    width: getMainWindowMinimumSize('video').width,
    height: 1
  })
  const [contentWidth, contentHeight] = window.getContentSize()
  const bounds = window.getBounds()
  const chromeHeight = Math.max(0, bounds.height - contentHeight)
  const display = screen.getDisplayMatching(bounds)
  const maxContentHeight = Math.max(
    VIDEO_PLAYER_MIN_CONTENT_HEIGHT,
    display.workArea.height - 16 - chromeHeight
  )
  const frameWidth = Math.max(1, contentWidth - VIDEO_PLAYER_FRAME_MARGIN_X * 2)
  const frameHeight = Math.round(frameWidth / VIDEO_PLAYER_ASPECT_RATIO)
  const targetContentHeight = Math.round(
    VIDEO_PLAYER_TOPBAR_HEIGHT +
      VIDEO_PLAYER_FRAME_MARGIN_TOP +
      frameHeight +
      VIDEO_PLAYER_FRAME_MARGIN_BOTTOM
  )
  const nextContentHeight = Math.round(
    Math.min(Math.max(VIDEO_PLAYER_MIN_CONTENT_HEIGHT, targetContentHeight), maxContentHeight)
  )
  const nextWindowHeight = nextContentHeight + chromeHeight
  const nextY = Math.min(
    Math.max(bounds.y, display.workArea.y + 8),
    display.workArea.y + display.workArea.height - nextWindowHeight - 8
  )

  const minimumSize = {
    width: getMainWindowMinimumSize('video').width,
    height: Math.min(MAIN_WINDOW_MIN_HEIGHT, nextWindowHeight)
  }
  window.setMinimumSize(minimumSize.width, minimumSize.height)
  ensureMainWindowMinimumBounds(window, minimumSize)
  window.setBounds(
    {
      x: bounds.x,
      y: nextY,
      width: Math.max(bounds.width, minimumSize.width),
      height: nextWindowHeight
    },
    false
  )
  scheduleSaveWindowBounds('main')
}

function trackWindowBounds(window: BrowserWindow, windowType: 'main' | 'settings'): void {
  const scheduleSave = (): void => scheduleSaveWindowBounds(windowType)
  window.on('resize', scheduleSave)
  window.on('move', scheduleSave)
  window.on('maximize', scheduleSave)
  window.on('unmaximize', scheduleSave)
  window.on('enter-full-screen', scheduleSave)
  window.on('leave-full-screen', scheduleSave)
}

function scheduleSaveWindowBounds(windowType: 'main' | 'settings'): void {
  const currentTimer = windowBoundsSaveTimers.get(windowType)
  if (currentTimer) {
    clearTimeout(currentTimer)
  }
  windowBoundsSaveTimers.set(
    windowType,
    setTimeout(() => {
      windowBoundsSaveTimers.delete(windowType)
      saveWindowBounds(windowType)
    }, 300)
  )
}

function flushWindowBounds(windowType: 'main' | 'settings'): void {
  const currentTimer = windowBoundsSaveTimers.get(windowType)
  if (currentTimer) {
    clearTimeout(currentTimer)
    windowBoundsSaveTimers.delete(windowType)
  }
  saveWindowBounds(windowType)
}

function saveWindowBounds(windowType: 'main' | 'settings'): void {
  const window = windowType === 'main' ? mainWindow : settingsWindow
  if (!window || !settingsService) {
    return
  }
  const bounds = getCurrentWindowBounds(window)
  if (windowType === 'main') {
    if (currentPlayerMode === 'mini') {
      return
    }
    settingsService.updateWindowBounds({ mainBounds: bounds })
    return
  }
  settingsService.updateWindowBounds({ settingsBounds: bounds })
}

function getCurrentWindowBounds(window: BrowserWindow): WindowBounds {
  const bounds =
    window.isMaximized() || window.isFullScreen() ? window.getNormalBounds() : window.getBounds()
  return {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    isMaximized: window.isMaximized(),
    isFullScreen: window.isFullScreen()
  }
}

function getRestoredWindowBoundsOptions(
  bounds: WindowBounds,
  minimumSize: { width: number; height: number }
): RestoredWindowBoundsOptions {
  const width = Math.max(minimumSize.width, Math.round(bounds.width))
  const height = Math.max(minimumSize.height, Math.round(bounds.height))
  const options: RestoredWindowBoundsOptions = { width, height }

  if (!shouldRestoreWindowPosition(bounds)) {
    return options
  }

  const display = screen.getDisplayMatching({
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width,
    height
  })
  const workArea = display.workArea
  const maxX = Math.max(workArea.x, workArea.x + workArea.width - width)
  const maxY = Math.max(workArea.y, workArea.y + workArea.height - height)
  options.x = Math.min(Math.max(Math.round(bounds.x), workArea.x), maxX)
  options.y = Math.min(Math.max(Math.round(bounds.y), workArea.y), maxY)
  return options
}

function shouldRestoreWindowPosition(bounds: WindowBounds): boolean {
  return (
    Number.isFinite(bounds.x) &&
    Number.isFinite(bounds.y) &&
    (Math.round(bounds.x) !== 0 || Math.round(bounds.y) !== 0)
  )
}

function restoreWindowState(window: BrowserWindow | null, bounds: WindowBounds): void {
  if (!window || window.isDestroyed()) {
    return
  }
  if (bounds.isFullScreen) {
    window.setFullScreen(true)
    return
  }
  if (bounds.isMaximized) {
    window.maximize()
  }
}

function getPlayerWindowChromeOptions(
  settings: AppSettings
): Pick<
  BrowserWindowConstructorOptions,
  'titleBarStyle' | 'titleBarOverlay' | 'trafficLightPosition'
> {
  if (process.platform === 'darwin') {
    return {
      titleBarStyle: 'hidden',
      trafficLightPosition: { x: 14, y: 14 }
    }
  }

  if (process.platform === 'win32') {
    return {
      titleBarStyle: 'hidden',
      titleBarOverlay: getPlayerTitleBarOverlay(settings)
    }
  }

  return {}
}

function getMiniWindowChromeOptions(
  settings: AppSettings
): Pick<
  BrowserWindowConstructorOptions,
  'titleBarStyle' | 'titleBarOverlay' | 'trafficLightPosition'
> {
  if (process.platform === 'darwin') {
    return {
      titleBarStyle: 'hidden',
      trafficLightPosition: { x: 10, y: 10 }
    }
  }

  if (process.platform === 'win32') {
    return {
      titleBarStyle: 'hidden',
      titleBarOverlay: getPlayerTitleBarOverlay(settings)
    }
  }

  return {}
}

function getSettingsWindowChromeOptions(
  settings: AppSettings
): Pick<
  BrowserWindowConstructorOptions,
  'titleBarStyle' | 'titleBarOverlay' | 'trafficLightPosition'
> {
  if (process.platform === 'darwin') {
    return {
      titleBarStyle: 'hidden',
      trafficLightPosition: { x: 16, y: 12 }
    }
  }

  if (process.platform === 'win32') {
    return {
      titleBarStyle: 'hidden',
      titleBarOverlay: getSettingsTitleBarOverlay(settings)
    }
  }

  return {}
}

function updateSettingsWindowChrome(settings: AppSettings): void {
  if (process.platform !== 'win32') {
    return
  }
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    setWindowTitleBarOverlay(settingsWindow, getSettingsTitleBarOverlay(settings))
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    setWindowTitleBarOverlay(mainWindow, getPlayerTitleBarOverlay(settings))
  }
  if (miniWindow && !miniWindow.isDestroyed()) {
    setWindowTitleBarOverlay(miniWindow, getPlayerTitleBarOverlay(settings))
  }
}

function setWindowTitleBarOverlay(window: BrowserWindow, overlay: TitleBarOverlayOptions): void {
  try {
    window.setTitleBarOverlay(overlay)
  } catch (error) {
    logError('window:titlebar-overlay', 'failed to update title bar overlay', error)
  }
}

function getPlayerTitleBarOverlay(settings: AppSettings): TitleBarOverlayOptions {
  return {
    color: WINDOWS_TITLE_BAR_OVERLAY_COLOR,
    symbolColor: getNativeTitleBarSymbolColor(settings),
    height: PLAYER_TITLE_BAR_HEIGHT
  }
}

function getSettingsTitleBarOverlay(settings: AppSettings): TitleBarOverlayOptions {
  return {
    color: WINDOWS_TITLE_BAR_OVERLAY_COLOR,
    symbolColor: getNativeTitleBarSymbolColor(settings),
    height: SETTINGS_TITLE_BAR_HEIGHT
  }
}

function getNativeTitleBarSymbolColor(settings: AppSettings): string {
  const pack = resolveThemePack(settings.appearanceConfig.themePackId)
  const tokens = settings.effectiveAppearance === 'dark' ? pack.dark : pack.light
  const nativeColor = toNativeHexColor(tokens.foreground)
  if (nativeColor) {
    return nativeColor
  }
  logWarning('window:titlebar-overlay', 'falling back from unsupported symbol color', {
    symbolColor: tokens.foreground
  })
  return settings.effectiveAppearance === 'dark' ? '#f8fafc' : '#111827'
}

function toNativeHexColor(color: string): string | null {
  const value = color.trim()
  if (/^#[0-9a-f]{6}$/i.test(value)) {
    return value
  }
  const shortHexMatch = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(value)
  if (shortHexMatch) {
    return `#${shortHexMatch[1]}${shortHexMatch[1]}${shortHexMatch[2]}${shortHexMatch[2]}${shortHexMatch[3]}${shortHexMatch[3]}`
  }
  return hslToHexColor(value) ?? rgbToHexColor(value)
}

function hslToHexColor(color: string): string | null {
  const match = /^hsla?\((.+)\)$/i.exec(color)
  if (!match) {
    return null
  }
  const parts = splitCssColorParts(match[1])
  if (parts.length < 3) {
    return null
  }
  const hue = parseCssHue(parts[0])
  const saturation = parseCssPercentage(parts[1])
  const lightness = parseCssPercentage(parts[2])
  if (hue === null || saturation === null || lightness === null) {
    return null
  }
  return rgbToHex(...hslToRgb(hue, saturation / 100, lightness / 100))
}

function rgbToHexColor(color: string): string | null {
  const match = /^rgba?\((.+)\)$/i.exec(color)
  if (!match) {
    return null
  }
  const parts = splitCssColorParts(match[1])
  if (parts.length < 3) {
    return null
  }
  const red = parseCssRgbComponent(parts[0])
  const green = parseCssRgbComponent(parts[1])
  const blue = parseCssRgbComponent(parts[2])
  if (red === null || green === null || blue === null) {
    return null
  }
  return rgbToHex(red, green, blue)
}

function splitCssColorParts(value: string): string[] {
  return value
    .replace(/\s*\/\s*/g, ' ')
    .replace(/,/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
}

function parseCssHue(value: string): number | null {
  const normalized = value.trim().toLowerCase()
  const amount = Number.parseFloat(normalized)
  if (!Number.isFinite(amount)) {
    return null
  }
  if (normalized.endsWith('turn')) {
    return amount * 360
  }
  if (normalized.endsWith('rad')) {
    return (amount * 180) / Math.PI
  }
  if (normalized.endsWith('grad')) {
    return amount * 0.9
  }
  return amount
}

function parseCssPercentage(value: string): number | null {
  const normalized = value.trim()
  if (!normalized.endsWith('%')) {
    return null
  }
  const amount = Number.parseFloat(normalized)
  return Number.isFinite(amount) ? clampNumber(amount, 0, 100) : null
}

function parseCssRgbComponent(value: string): number | null {
  const normalized = value.trim()
  const amount = Number.parseFloat(normalized)
  if (!Number.isFinite(amount)) {
    return null
  }
  if (normalized.endsWith('%')) {
    return Math.round((clampNumber(amount, 0, 100) / 100) * 255)
  }
  return Math.round(clampNumber(amount, 0, 255))
}

function hslToRgb(hue: number, saturation: number, lightness: number): [number, number, number] {
  const normalizedHue = (((hue % 360) + 360) % 360) / 360
  if (saturation === 0) {
    const gray = Math.round(lightness * 255)
    return [gray, gray, gray]
  }

  const q =
    lightness < 0.5 ? lightness * (1 + saturation) : lightness + saturation - lightness * saturation
  const p = 2 * lightness - q
  return [
    Math.round(hueToRgb(p, q, normalizedHue + 1 / 3) * 255),
    Math.round(hueToRgb(p, q, normalizedHue) * 255),
    Math.round(hueToRgb(p, q, normalizedHue - 1 / 3) * 255)
  ]
}

function hueToRgb(p: number, q: number, hue: number): number {
  let nextHue = hue
  if (nextHue < 0) {
    nextHue += 1
  }
  if (nextHue > 1) {
    nextHue -= 1
  }
  if (nextHue < 1 / 6) {
    return p + (q - p) * 6 * nextHue
  }
  if (nextHue < 1 / 2) {
    return q
  }
  if (nextHue < 2 / 3) {
    return p + (q - p) * (2 / 3 - nextHue) * 6
  }
  return p
}

function rgbToHex(red: number, green: number, blue: number): string {
  return `#${[red, green, blue]
    .map((value) =>
      Math.round(clampNumber(value, 0, 255))
        .toString(16)
        .padStart(2, '0')
    )
    .join('')}`
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function sanitizeLivePlaybackState(state: unknown): LivePlaybackState {
  switch (state) {
    case 'loading':
    case 'ready':
    case 'playing':
    case 'paused':
    case 'stopped':
    case 'error':
      return state
    default:
      return 'idle'
  }
}

function syncNativeShell(settings: AppSettings): void {
  try {
    syncWindowTitles(settings)
    rebuildApplicationMenu(settings)
    updateSettingsWindowChrome(settings)
    updateTray(settings)
  } catch (error) {
    logError('settings:native-shell-sync', 'failed to sync native shell', error)
  }
}

function syncWindowTitles(settings: AppSettings): void {
  const text = getText(settings.language)
  mainWindow?.setTitle(text.windowTitles.main)
  miniWindow?.setTitle(text.windowTitles.main)
  trayPreviewWindow?.setTitle(text.windowTitles.main)
  settingsWindow?.setTitle(text.windowTitles.settings)
}

function rebuildApplicationMenu(settings: AppSettings): void {
  Menu.setApplicationMenu(createApplicationMenu(settings))
}

function createApplicationMenu(settings: AppSettings): Menu {
  const text = getText(settings.language)
  const menu = text.menu
  const isMac = process.platform === 'darwin'
  const appSubmenu: MenuItemConstructorOptions[] = [
    isMac
      ? {
          label: menu.about,
          role: 'about'
        }
      : {
          label: menu.about,
          click: () => showSettingsWindow('about')
        },
    {
      type: 'separator'
    },
    {
      label: menu.settings,
      accelerator: 'CommandOrControl+,',
      click: () => showSettingsWindow('general')
    }
  ]

  if (isMac) {
    appSubmenu.push(
      { type: 'separator' },
      { label: menu.hide, role: 'hide' },
      { label: menu.hideOthers, role: 'hideOthers' },
      { label: menu.showAll, role: 'unhide' },
      { type: 'separator' },
      { label: menu.quit, role: 'quit' }
    )
  } else {
    appSubmenu.push({ type: 'separator' }, { label: menu.quit, role: 'quit' })
  }

  const template: MenuItemConstructorOptions[] = [
    {
      label: menu.appTitle,
      submenu: appSubmenu
    },
    {
      label: menu.file,
      submenu: [{ label: menu.close, role: 'close' }]
    },
    {
      label: menu.edit,
      submenu: [
        { label: menu.undo, role: 'undo' },
        { label: menu.redo, role: 'redo' },
        { type: 'separator' },
        { label: menu.cut, role: 'cut' },
        { label: menu.copy, role: 'copy' },
        { label: menu.paste, role: 'paste' },
        { label: menu.delete, role: 'delete' },
        { type: 'separator' },
        { label: menu.selectAll, role: 'selectAll' }
      ]
    },
    {
      label: menu.window,
      submenu: [
        { label: menu.minimize, role: 'minimize' },
        { label: menu.zoom, role: 'zoom' },
        ...(process.platform === 'win32'
          ? []
          : ([
              { label: menu.fullScreen, role: 'togglefullscreen' }
            ] as MenuItemConstructorOptions[])),
        { type: 'separator' },
        { label: menu.bringAllToFront, role: 'front' }
      ]
    },
    {
      label: menu.help,
      submenu: []
    }
  ]

  return Menu.buildFromTemplate(template)
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(async () => {
  // Set app user model id for windows
  configureAppIdentity()
  configureDockIcon()
  electronApp.setAppUserModelId(APP_APP_ID)
  settingsService = await SettingsService.create(broadcastSettings, broadcastUpdateStatus)
  setLoggerLevel(settingsService.getSettings().logLevel)
  logInfo('app', 'settings loaded', {
    logLevel: settingsService.getSettings().logLevel,
    language: settingsService.getSettings().language
  })
  systemFontService = new SystemFontService(broadcastFontFamilies)
  telemetryService = await TelemetryService.create({
    appId: resolveTelemetryDeckAppId(),
    appVersion: app.getVersion(),
    getLanguage: () => settingsService?.getSettings().language ?? app.getLocale()
  })
  appDatabase = new AppDatabase()
  appDatabase.initialize()
  liveService = new LiveService(appDatabase, broadcastLiveChannels)
  liveService.initialize()
  const initialLiveState = liveService.getState()
  currentPlayerMode = initialLiveState.playerMode
  registerIpcHandlers()
  await settingsService.applyCurrentSettings()
  settingsService.scheduleAutomaticUpdateCheck()
  syncNativeShell(settingsService.getSettings())
  void telemetryService.trackAppLaunch({ startMode: 'manual' })

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
    settingsService?.applyMenuBarToWindow(window)
  })

  nativeTheme.on('updated', () => {
    void settingsService?.refreshSystemAppearance()
  })

  createWindow()
  if (currentPlayerMode === 'mini') {
    openMiniPlayer()
  }
  setTimeout(() => {
    void systemFontService?.warmUp()
  }, 3000)

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (!mainWindow || mainWindow.isDestroyed()) {
      createWindow()
      return
    }
    showMainWindowFromTray()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    isQuitting = true
    app.quit()
  }
})

app.on('before-quit', (event) => {
  isQuitting = true
  flushWindowBounds('main')
  flushWindowBounds('settings')
  if (isInstallingDownloadedUpdate) {
    appDatabase?.close()
    return
  }
  if (!telemetryQuitFlushCompleted && telemetryService?.enabled()) {
    event.preventDefault()
    telemetryQuitFlushCompleted = true
    void telemetryService.flushSessionSummary().finally(() => {
      app.quit()
    })
    return
  }
  appDatabase?.close()
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.

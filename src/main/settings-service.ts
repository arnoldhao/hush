import {
  app,
  BrowserWindow,
  nativeTheme,
  safeStorage,
  session,
  shell,
  systemPreferences
} from 'electron'
import type ElectronStore from 'electron-store'
import type { Options as ElectronStoreOptions } from 'electron-store'
import { autoUpdater } from 'electron-updater'
import { mkdirSync, readFileSync } from 'fs'
import { join } from 'path'

import {
  DEFAULT_APPEARANCE_CONFIG,
  DEFAULT_PROXY_SETTINGS,
  resolveThemePack,
  type AppInfo,
  type AppSettings,
  type AppearanceConfig,
  type AppearanceMode,
  type EffectiveAppearance,
  type LogLevel,
  type MenuBarVisibility,
  type ProxyMode,
  type ProxyScheme,
  type ProxySettings,
  type SupportedLanguage,
  type SystemProxyInfo,
  type UpdateCheckResult,
  type UpdateDownloadProgress,
  type UpdateSettingsRequest,
  type WindowBounds
} from '../shared/settings'
import { LIVE_AUDIO_DOUBLE_LAYOUT_MIN_WIDTH } from '../shared/live'
import { logError } from './logger'

const SETTINGS_SCHEMA_VERSION = 1
const PROXY_TEST_URL = 'https://www.gstatic.com/generate_204'
const DEFAULT_MAIN_BOUNDS: WindowBounds = {
  x: 0,
  y: 0,
  width: LIVE_AUDIO_DOUBLE_LAYOUT_MIN_WIDTH,
  height: 680,
  isMaximized: false,
  isFullScreen: false
}
const LEGACY_DEFAULT_MAIN_BOUNDS: WindowBounds = {
  x: 0,
  y: 0,
  width: 420,
  height: 680,
  isMaximized: false,
  isFullScreen: false
}
const DEFAULT_SETTINGS_BOUNDS: WindowBounds = {
  x: 0,
  y: 0,
  width: 480,
  height: 550,
  isMaximized: false,
  isFullScreen: false
}
const LEGACY_DEFAULT_SETTINGS_BOUNDS: WindowBounds = {
  x: 0,
  y: 0,
  width: 720,
  height: 620,
  isMaximized: false,
  isFullScreen: false
}
const MIN_SETTINGS_WINDOW_WIDTH = 480
const MIN_SETTINGS_WINDOW_HEIGHT = 550
const AUTOMATIC_UPDATE_CHECK_DELAY_MS = 15_000
const SECURE_STORAGE_UNAVAILABLE_MESSAGE =
  'Secure password storage is unavailable on this system. Proxy password was not saved.'

type ElectronStoreConstructor = new <T extends Record<string, unknown>>(
  options?: ElectronStoreOptions<T>
) => ElectronStore<T>
type StoredProxySettings = ProxySettings & {
  passwordEncrypted?: string
}
type SettingsStoreShape = Omit<AppSettings, 'proxy'> & {
  proxy: StoredProxySettings
} & Record<string, unknown>
type UpdateStatusChangedCallback = (update: UpdateCheckResult) => void

let activeProxyCredentials: { username: string; password: string } | null = null
let proxyAuthListenerInstalled = false
const SAFE_STORAGE_PREFIX = 'safe:v1:'

export class SettingsService {
  private settings: AppSettings | null = null
  private updateCheckTimer: ReturnType<typeof setTimeout> | null = null
  private updateCheckPromise: Promise<UpdateCheckResult> | null = null
  private updateInfo: UpdateCheckResult = createUpdateResult('idle')
  private readonly logDir: string

  private constructor(
    private readonly store: ElectronStore<SettingsStoreShape>,
    private readonly onSettingsChanged: (settings: AppSettings) => void,
    private readonly onUpdateStatusChanged: UpdateStatusChangedCallback
  ) {
    const logDir = app.getPath('logs')
    mkdirSync(logDir, { recursive: true })
    this.logDir = logDir
    installProxyAuthListener()
    this.configureAutoUpdater()
  }

  static async create(
    onSettingsChanged: (settings: AppSettings) => void,
    onUpdateStatusChanged: UpdateStatusChangedCallback = () => undefined
  ): Promise<SettingsService> {
    const Store = await loadElectronStore()
    const store = new Store<SettingsStoreShape>({
      name: 'settings',
      defaults: createDefaultSettings() as SettingsStoreShape,
      clearInvalidConfig: true
    })
    const service = new SettingsService(store, onSettingsChanged, onUpdateStatusChanged)
    service.settings = service.readSettings()
    service.writeSettings(service.settings)
    return service
  }

  getSettings(): AppSettings {
    if (!this.settings) {
      this.settings = this.readSettings()
    }
    return this.settings
  }

  async updateSettings(patch: UpdateSettingsRequest): Promise<AppSettings> {
    if (patch.proxy?.password) {
      assertSecretStorageAvailable()
    }

    const current = this.getSettings()
    const merged = sanitizeSettings({
      ...current,
      ...patch,
      proxy: patch.proxy ? sanitizeProxy(patch.proxy) : current.proxy,
      appearanceConfig: patch.appearanceConfig
        ? sanitizeAppearanceConfig({ ...current.appearanceConfig, ...patch.appearanceConfig })
        : current.appearanceConfig,
      version: current.version + 1
    })

    return this.commitSettings(current, merged, {
      syncLoginItem: patch.autoStart !== undefined || patch.minimizeToTrayOnStart !== undefined
    })
  }

  updateWindowBounds(
    patch: Pick<UpdateSettingsRequest, 'mainBounds' | 'settingsBounds'>
  ): AppSettings {
    const current = this.getSettings()
    const next = sanitizeSettings({
      ...current,
      ...patch,
      version: current.version + 1
    })
    this.settings = next
    this.writeSettings(next)
    return next
  }

  async refreshSystemAppearance(): Promise<AppSettings | null> {
    const current = this.getSettings()
    if (current.appearance !== 'auto') {
      return null
    }
    const next = sanitizeSettings({
      ...current,
      effectiveAppearance: resolveEffectiveAppearance(current.appearance),
      systemThemeColor: resolveSystemAccentColor()
    })

    if (
      next.effectiveAppearance === current.effectiveAppearance &&
      next.systemThemeColor === current.systemThemeColor
    ) {
      return null
    }

    return this.commitSettings(current, { ...next, version: current.version + 1 })
  }

  async applyCurrentSettings(): Promise<void> {
    await this.applySettings(this.getSettings())
  }

  private async openPath(path: string): Promise<void> {
    const normalized = path.trim()
    if (!normalized) {
      return
    }
    const error = await shell.openPath(normalized)
    if (error) {
      throw new Error(error)
    }
  }

  async openLogDirectory(): Promise<void> {
    mkdirSync(this.logDir, { recursive: true })
    await this.openPath(this.logDir)
  }

  async getSystemProxyInfo(): Promise<SystemProxyInfo> {
    const proxySession = session.fromPartition(`proxy-detect-${Date.now()}`)
    await proxySession.setProxy({ mode: 'system' })
    const resolved = await proxySession.resolveProxy(PROXY_TEST_URL)
    const address = parseResolvedProxyAddress(resolved)
    return { address, source: 'system' }
  }

  async testProxy(proxy: ProxySettings): Promise<ProxySettings> {
    const normalized = sanitizeProxy(proxy)
    const testedAt = new Date().toISOString()

    if (normalized.mode === 'manual' && (!normalized.host.trim() || normalized.port <= 0)) {
      return {
        ...normalized,
        testedAt,
        testSuccess: false,
        testMessage: 'Proxy host and port are required.'
      }
    }

    const testSession = session.fromPartition(`proxy-test-${Date.now()}`)
    await testSession.setProxy(toElectronProxyConfig(normalized))
    const previousCredentials = activeProxyCredentials
    activeProxyCredentials =
      normalized.mode === 'manual' && normalized.username
        ? { username: normalized.username, password: normalized.password }
        : previousCredentials

    try {
      await fetchWithTimeout(testSession, normalized.timeoutSeconds)
      return {
        ...normalized,
        testedAt,
        testSuccess: true,
        testMessage: 'Proxy test succeeded.'
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        ...normalized,
        testedAt,
        testSuccess: false,
        testMessage: message || 'Proxy test failed.'
      }
    } finally {
      activeProxyCredentials = previousCredentials
    }
  }

  getAppInfo(): AppInfo {
    const metadata = readPackageMetadata()
    return {
      name: metadata.productName || metadata.name || app.getName(),
      version: app.getVersion(),
      author: metadata.author || 'Arnold HAO',
      homepage: metadata.homepage || '',
      platform: process.platform
    }
  }

  async checkForUpdates(): Promise<UpdateCheckResult> {
    if (!app.isPackaged) {
      return this.commitUpdateStatus({
        ...createUpdateResult('unsupported'),
        message: 'Update checks are only available in packaged builds.'
      })
    }

    if (this.updateInfo.status === 'downloaded' || this.updateInfo.status === 'downloading') {
      return this.updateInfo
    }

    if (this.updateCheckPromise) {
      return this.updateCheckPromise
    }

    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true
    this.updateCheckPromise = autoUpdater
      .checkForUpdates()
      .then((result) => {
        if (result?.updateInfo && this.updateInfo.status === 'checking') {
          this.commitUpdateStatus(this.createUpdateResultFromInfo('available', result.updateInfo))
        }
        return this.updateInfo
      })
      .catch((error) => this.commitUpdateError(error))
      .finally(() => {
        this.updateCheckPromise = null
      })

    return this.updateCheckPromise
  }

  scheduleAutomaticUpdateCheck(delayMs = AUTOMATIC_UPDATE_CHECK_DELAY_MS): void {
    if (!app.isPackaged || this.updateCheckTimer) {
      return
    }
    this.updateCheckTimer = setTimeout(() => {
      this.updateCheckTimer = null
      void this.checkForUpdates().catch((error) => {
        logError('updates:auto-check', 'automatic update check failed', error)
      })
    }, delayMs)
  }

  installDownloadedUpdate(): UpdateCheckResult {
    if (this.updateInfo.status !== 'downloaded') {
      throw new Error('Update is not downloaded yet.')
    }
    autoUpdater.quitAndInstall(process.platform === 'win32', true)
    return this.updateInfo
  }

  applyMenuBarToWindow(window: BrowserWindow): void {
    applyMenuBarVisibility(window, this.getSettings().menuBarVisibility)
  }

  private async applySettings(settings: AppSettings): Promise<void> {
    nativeTheme.themeSource = settings.appearance === 'auto' ? 'system' : settings.appearance
    BrowserWindow.getAllWindows().forEach((window) =>
      applyMenuBarVisibility(window, settings.menuBarVisibility)
    )
    activeProxyCredentials =
      settings.proxy.mode === 'manual' && settings.proxy.username
        ? { username: settings.proxy.username, password: settings.proxy.password }
        : null
    await session.defaultSession.setProxy(toElectronProxyConfig(settings.proxy))
  }

  private configureAutoUpdater(): void {
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.on('checking-for-update', () => {
      this.commitUpdateStatus({
        ...this.updateInfo,
        status: 'checking',
        checkedAt: new Date().toISOString(),
        message: '',
        downloadProgress: undefined
      })
    })
    autoUpdater.on('update-available', (info) => {
      this.commitUpdateStatus(this.createUpdateResultFromInfo('downloading', info))
    })
    autoUpdater.on('update-not-available', (info) => {
      this.commitUpdateStatus(this.createUpdateResultFromInfo('not-available', info))
    })
    autoUpdater.on('download-progress', (progress) => {
      this.commitUpdateStatus({
        ...this.updateInfo,
        status: 'downloading',
        checkedAt: new Date().toISOString(),
        message: '',
        downloadProgress: normalizeDownloadProgress(progress)
      })
    })
    autoUpdater.on('update-downloaded', (info) => {
      this.commitUpdateStatus(
        this.createUpdateResultFromInfo('downloaded', info, normalizeDownloadProgress())
      )
    })
    autoUpdater.on('error', (error) => {
      this.commitUpdateError(error)
    })
  }

  private createUpdateResultFromInfo(
    status: UpdateCheckResult['status'],
    info: unknown,
    downloadProgress?: UpdateDownloadProgress
  ): UpdateCheckResult {
    const version = readUpdateVersion(info) || this.updateInfo.latestVersion || app.getVersion()
    const releaseNotes = normalizeReleaseNotes(readUpdateReleaseNotes(info))

    return {
      status,
      currentVersion: app.getVersion(),
      latestVersion: version,
      checkedAt: new Date().toISOString(),
      message: '',
      releaseNotes: releaseNotes || this.updateInfo.releaseNotes,
      downloadProgress
    }
  }

  private commitUpdateStatus(update: UpdateCheckResult): UpdateCheckResult {
    this.updateInfo = update
    try {
      this.onUpdateStatusChanged(update)
    } catch (error) {
      logError('updates:changed-callback', 'update status callback failed', error)
    }
    return update
  }

  private commitUpdateError(error: unknown): UpdateCheckResult {
    const message = error instanceof Error ? error.message : String(error)
    return this.commitUpdateStatus({
      ...createUpdateResult('error'),
      latestVersion: this.updateInfo.latestVersion,
      releaseNotes: this.updateInfo.releaseNotes,
      message,
      downloadProgress: undefined
    })
  }

  private readSettings(): AppSettings {
    return fromStoredSettings(this.store.store)
  }

  private writeSettings(settings: AppSettings): void {
    this.store.store = toStoredSettings(settings)
  }

  private async commitSettings(
    current: AppSettings,
    next: AppSettings,
    options: { syncLoginItem?: boolean } = {}
  ): Promise<AppSettings> {
    try {
      this.settings = next
      if (options.syncLoginItem) {
        applyLoginItemSettings(next)
      }
      await this.applySettings(next)
      this.writeSettings(next)
      try {
        this.onSettingsChanged(next)
      } catch (error) {
        logError('settings:changed-callback', 'settings changed callback failed', error)
      }
      return next
    } catch (error) {
      this.settings = current
      if (options.syncLoginItem) {
        try {
          applyLoginItemSettings(current)
        } catch {
          // The original error is more useful to the caller.
        }
      }
      await this.applySettings(current).catch(() => undefined)
      throw error
    }
  }
}

async function loadElectronStore(): Promise<ElectronStoreConstructor> {
  const dynamicImport = new Function('specifier', 'return import(specifier)') as (
    specifier: string
  ) => Promise<{ default: ElectronStoreConstructor }>
  const module = await dynamicImport('electron-store')
  return module.default
}

function fromStoredSettings(raw: Partial<SettingsStoreShape>): AppSettings {
  const settings = sanitizeSettings(raw as Partial<AppSettings>)
  const storedProxy = raw.proxy
  const encryptedPassword = sanitizeString(storedProxy?.passwordEncrypted)
  if (encryptedPassword) {
    settings.proxy.password = decryptSecret(encryptedPassword)
  }
  return settings
}

function toStoredSettings(settings: AppSettings): SettingsStoreShape {
  const encryptedPassword = encryptSecret(settings.proxy.password)
  const storedProxy: StoredProxySettings = {
    ...settings.proxy,
    password: '',
    passwordEncrypted: encryptedPassword || undefined
  }

  return {
    ...settings,
    proxy: storedProxy
  } as SettingsStoreShape
}

function createDefaultSettings(): AppSettings {
  const language: SupportedLanguage = app.getLocale().toLowerCase().startsWith('zh')
    ? 'zh-CN'
    : 'en'
  const loginSettings = app.getLoginItemSettings()
  return {
    appearance: 'auto',
    effectiveAppearance: resolveEffectiveAppearance('auto'),
    fontFamily: '',
    fontSize: 15,
    language,
    themeColor: 'system',
    systemThemeColor: resolveSystemAccentColor(),
    logLevel: 'info',
    menuBarVisibility: 'whenRunning',
    autoStart: loginSettings.openAtLogin,
    minimizeToTrayOnStart: false,
    mainBounds: { ...DEFAULT_MAIN_BOUNDS },
    settingsBounds: { ...DEFAULT_SETTINGS_BOUNDS },
    proxy: { ...DEFAULT_PROXY_SETTINGS },
    appearanceConfig: { ...DEFAULT_APPEARANCE_CONFIG },
    version: SETTINGS_SCHEMA_VERSION
  }
}

function sanitizeSettings(settings: Partial<AppSettings>): AppSettings {
  const fallback = createDefaultSettings()
  const appearance = sanitizeAppearance(settings.appearance)
  return {
    ...fallback,
    ...settings,
    appearance,
    effectiveAppearance: resolveEffectiveAppearance(appearance),
    fontFamily: sanitizeString(settings.fontFamily),
    fontSize: clampInteger(settings.fontSize, 12, 24, fallback.fontSize),
    language:
      settings.language === 'zh-CN' || settings.language === 'en'
        ? settings.language
        : fallback.language,
    themeColor: sanitizeString(settings.themeColor || fallback.themeColor),
    systemThemeColor: resolveSystemAccentColor(),
    logLevel: sanitizeLogLevel(settings.logLevel),
    menuBarVisibility: sanitizeMenuBarVisibility(settings.menuBarVisibility),
    autoStart: typeof settings.autoStart === 'boolean' ? settings.autoStart : fallback.autoStart,
    minimizeToTrayOnStart:
      typeof settings.minimizeToTrayOnStart === 'boolean'
        ? settings.minimizeToTrayOnStart
        : fallback.minimizeToTrayOnStart,
    mainBounds: sanitizeMainBounds(settings.mainBounds, fallback.mainBounds),
    settingsBounds: sanitizeSettingsBounds(settings.settingsBounds, fallback.settingsBounds),
    proxy: sanitizeProxy(settings.proxy),
    appearanceConfig: sanitizeAppearanceConfig(settings.appearanceConfig),
    version:
      Number.isInteger(settings.version) && Number(settings.version) > 0
        ? Number(settings.version)
        : fallback.version
  }
}

function sanitizeProxy(proxy?: Partial<ProxySettings> | null): ProxySettings {
  const mode = sanitizeProxyMode(proxy?.mode)
  const scheme = sanitizeProxyScheme(proxy?.scheme)
  return {
    ...DEFAULT_PROXY_SETTINGS,
    ...proxy,
    mode,
    scheme,
    host: sanitizeString(proxy?.host),
    port: clampInteger(proxy?.port, 0, 65535, 0),
    username: sanitizeString(proxy?.username),
    password: sanitizeString(proxy?.password),
    noProxy: Array.isArray(proxy?.noProxy) ? proxy.noProxy.map(sanitizeString).filter(Boolean) : [],
    timeoutSeconds: clampInteger(
      proxy?.timeoutSeconds,
      3,
      120,
      DEFAULT_PROXY_SETTINGS.timeoutSeconds
    ),
    testedAt: sanitizeString(proxy?.testedAt),
    testSuccess: Boolean(proxy?.testSuccess),
    testMessage: sanitizeString(proxy?.testMessage)
  }
}

function sanitizeAppearanceConfig(config?: Partial<AppearanceConfig> | null): AppearanceConfig {
  return {
    themePackId: resolveThemePack(config?.themePackId || DEFAULT_APPEARANCE_CONFIG.themePackId).id,
    accentMode: config?.accentMode === 'color' ? 'color' : 'theme'
  }
}

function sanitizeBounds(bounds: WindowBounds | undefined, fallback: WindowBounds): WindowBounds {
  if (!bounds) {
    return fallback
  }
  return {
    x: Number.isFinite(bounds.x) ? bounds.x : fallback.x,
    y: Number.isFinite(bounds.y) ? bounds.y : fallback.y,
    width: clampInteger(bounds.width, 360, 2400, fallback.width),
    height: clampInteger(bounds.height, 360, 1800, fallback.height),
    isMaximized:
      typeof bounds.isMaximized === 'boolean' ? bounds.isMaximized : fallback.isMaximized,
    isFullScreen:
      typeof bounds.isFullScreen === 'boolean' ? bounds.isFullScreen : fallback.isFullScreen
  }
}

function sanitizeMainBounds(
  bounds: WindowBounds | undefined,
  fallback: WindowBounds
): WindowBounds {
  if (
    bounds?.width === LEGACY_DEFAULT_MAIN_BOUNDS.width &&
    bounds.height === LEGACY_DEFAULT_MAIN_BOUNDS.height
  ) {
    return {
      x: Number.isFinite(bounds.x) ? bounds.x : fallback.x,
      y: Number.isFinite(bounds.y) ? bounds.y : fallback.y,
      width: DEFAULT_MAIN_BOUNDS.width,
      height: DEFAULT_MAIN_BOUNDS.height,
      isMaximized: false,
      isFullScreen: false
    }
  }

  return sanitizeBounds(bounds, fallback)
}

function sanitizeSettingsBounds(
  bounds: WindowBounds | undefined,
  fallback: WindowBounds
): WindowBounds {
  if (
    bounds?.width === LEGACY_DEFAULT_SETTINGS_BOUNDS.width &&
    bounds.height === LEGACY_DEFAULT_SETTINGS_BOUNDS.height
  ) {
    return {
      x: Number.isFinite(bounds.x) ? bounds.x : fallback.x,
      y: Number.isFinite(bounds.y) ? bounds.y : fallback.y,
      width: DEFAULT_SETTINGS_BOUNDS.width,
      height: DEFAULT_SETTINGS_BOUNDS.height,
      isMaximized: false,
      isFullScreen: false
    }
  }

  const sanitized = sanitizeBounds(bounds, fallback)
  return {
    ...sanitized,
    width: clampInteger(sanitized.width, MIN_SETTINGS_WINDOW_WIDTH, 2400, fallback.width),
    height: clampInteger(sanitized.height, MIN_SETTINGS_WINDOW_HEIGHT, 1800, fallback.height)
  }
}

function sanitizeAppearance(value?: string): AppearanceMode {
  return value === 'light' || value === 'dark' || value === 'auto' ? value : 'auto'
}

function sanitizeMenuBarVisibility(value?: string): MenuBarVisibility {
  if (process.platform === 'win32' && value === 'never') {
    return 'whenRunning'
  }
  return value === 'always' || value === 'whenRunning' || value === 'never' ? value : 'whenRunning'
}

function sanitizeLogLevel(value?: string): LogLevel {
  return value === 'debug' || value === 'warn' || value === 'error' ? value : 'info'
}

function sanitizeProxyMode(value?: string): ProxyMode {
  return value === 'none' || value === 'manual' || value === 'system' ? value : 'system'
}

function sanitizeProxyScheme(value?: string): ProxyScheme {
  return value === 'https' || value === 'socks5' ? value : 'http'
}

function sanitizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function encryptSecret(value: string): string {
  if (!value) {
    return ''
  }
  assertSecretStorageAvailable()
  try {
    return `${SAFE_STORAGE_PREFIX}${safeStorage.encryptString(value).toString('base64')}`
  } catch {
    throw new Error('Secure password storage failed. Proxy password was not saved.')
  }
}

function decryptSecret(value: string): string {
  if (!value.startsWith(SAFE_STORAGE_PREFIX)) {
    return value
  }
  try {
    const encrypted = value.slice(SAFE_STORAGE_PREFIX.length)
    return safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
  } catch {
    return ''
  }
}

function assertSecretStorageAvailable(): void {
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return
    }
  } catch {
    // Fall through to the explicit error below.
  }
  throw new Error(SECURE_STORAGE_UNAVAILABLE_MESSAGE)
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed)) {
    return fallback
  }
  return Math.min(Math.max(Math.trunc(parsed), min), max)
}

function resolveEffectiveAppearance(appearance: AppearanceMode): EffectiveAppearance {
  if (appearance === 'dark') {
    return 'dark'
  }
  if (appearance === 'light') {
    return 'light'
  }
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
}

function resolveSystemAccentColor(): string {
  try {
    const raw = systemPreferences.getAccentColor()
    const normalized = raw.startsWith('#') ? raw.slice(1) : raw
    const sixDigit = normalized.length >= 6 ? normalized.slice(0, 6) : normalized
    if (/^[0-9a-f]{6}$/i.test(sixDigit)) {
      return `#${sixDigit}`
    }
  } catch {
    // Some Linux environments do not expose an accent color.
  }
  return '#2563eb'
}

function applyLoginItemSettings(settings: AppSettings): void {
  app.setLoginItemSettings({
    openAtLogin: settings.autoStart,
    openAsHidden: settings.minimizeToTrayOnStart
  })
}

function applyMenuBarVisibility(window: BrowserWindow, visibility: MenuBarVisibility): void {
  if (process.platform === 'darwin') {
    return
  }
  const visible = visibility === 'always'
  window.setAutoHideMenuBar(!visible)
  window.setMenuBarVisibility(visible)
}

function toElectronProxyConfig(proxy: ProxySettings): Electron.ProxyConfig {
  if (proxy.mode === 'none') {
    return { mode: 'direct' }
  }
  if (proxy.mode === 'system') {
    return { mode: 'system' }
  }
  if (!proxy.host.trim() || proxy.port <= 0) {
    return { mode: 'direct' }
  }
  return {
    mode: 'fixed_servers',
    proxyRules: `${proxy.scheme}://${formatHostPort(proxy.host, proxy.port)}`,
    proxyBypassRules: proxy.noProxy.join(';')
  }
}

function formatHostPort(host: string, port: number): string {
  if (!host || port <= 0) {
    return ''
  }
  const normalizedHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
  return `${normalizedHost}:${port}`
}

function parseResolvedProxyAddress(value: string): string {
  const parts = value
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)

  for (const part of parts) {
    const match = part.match(/^(?:PROXY|HTTPS|SOCKS|SOCKS5)\s+(.+)$/i)
    if (match?.[1]) {
      return match[1].trim()
    }
  }
  return ''
}

async function fetchWithTimeout(
  fetchSession: Electron.Session,
  timeoutSeconds: number
): Promise<void> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutSeconds * 1000)
  try {
    const response = await fetchSession.fetch(PROXY_TEST_URL, {
      cache: 'no-store',
      signal: controller.signal
    })
    if (response.status >= 500) {
      throw new Error(`Unexpected status ${response.status}`)
    }
  } finally {
    clearTimeout(timeout)
  }
}

function installProxyAuthListener(): void {
  if (proxyAuthListenerInstalled) {
    return
  }
  proxyAuthListenerInstalled = true
  app.on('login', (event, _webContents, _request, authInfo, callback) => {
    if (!authInfo.isProxy || !activeProxyCredentials) {
      return
    }
    event.preventDefault()
    callback(activeProxyCredentials.username, activeProxyCredentials.password)
  })
}

function readPackageMetadata(): {
  name?: string
  productName?: string
  author?: string
  homepage?: string
} {
  try {
    const raw = JSON.parse(readFileSync(join(app.getAppPath(), 'package.json'), 'utf8')) as {
      name?: string
      productName?: string
      author?: string
      homepage?: string
    }
    return raw
  } catch {
    return {}
  }
}

function createUpdateResult(status: UpdateCheckResult['status']): UpdateCheckResult {
  return {
    status,
    currentVersion: app.getVersion(),
    latestVersion: app.getVersion(),
    checkedAt: new Date().toISOString(),
    message: '',
    releaseNotes: ''
  }
}

function normalizeDownloadProgress(
  progress?: Partial<UpdateDownloadProgress>
): UpdateDownloadProgress {
  return {
    bytesPerSecond: sanitizeProgressNumber(progress?.bytesPerSecond, 0),
    percent: sanitizeProgressNumber(progress?.percent, 100),
    total: sanitizeProgressNumber(progress?.total, 0),
    transferred: sanitizeProgressNumber(progress?.transferred, progress?.total ?? 0)
  }
}

function sanitizeProgressNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : fallback
}

function readUpdateVersion(info: unknown): string {
  if (!info || typeof info !== 'object' || !('version' in info)) {
    return ''
  }
  const version = (info as { version?: unknown }).version
  return typeof version === 'string' ? version.trim() : ''
}

function readUpdateReleaseNotes(info: unknown): unknown {
  if (!info || typeof info !== 'object' || !('releaseNotes' in info)) {
    return ''
  }
  return (info as { releaseNotes?: unknown }).releaseNotes
}

function normalizeReleaseNotes(releaseNotes: unknown): string {
  if (typeof releaseNotes === 'string') {
    return stripReleaseNotesBoilerplate(releaseNotes)
  }
  if (!Array.isArray(releaseNotes)) {
    return ''
  }
  const notes = releaseNotes
    .map((item) => {
      if (typeof item === 'string') {
        return item
      }
      if (item && typeof item === 'object' && 'note' in item) {
        return String((item as { note?: unknown }).note ?? '')
      }
      return ''
    })
    .filter(Boolean)
    .join('\n\n')
  return stripReleaseNotesBoilerplate(notes)
}

function stripReleaseNotesBoilerplate(releaseNotes: string): string {
  const normalized = releaseNotes.replace(/\r\n?/g, '\n')
  if (isHtmlReleaseNotes(normalized)) {
    return stripHtmlReleaseNotesBoilerplate(normalized)
  }

  return normalized
    .replace(
      /<!--\s*hush-release-header:start\s*-->[\s\S]*?<!--\s*hush-release-header:end\s*-->/gi,
      ''
    )
    .replace(/^\s*##\s+版本变更\s*\/\s*Changelog\s*\n+/i, '')
    .trim()
}

function isHtmlReleaseNotes(releaseNotes: string): boolean {
  return /<\/?(?:h[1-6]|p|ul|ol|li|a|code|pre|blockquote|table|thead|tbody|tr|th|td|hr|br|strong|em)\b/i.test(
    releaseNotes
  )
}

function stripHtmlReleaseNotesBoilerplate(releaseNotes: string): string {
  const changelogHeading = /<h[1-6]\b[^>]*>\s*版本变更\s*\/\s*Changelog\s*<\/h[1-6]>/i.exec(
    releaseNotes
  )
  if (changelogHeading) {
    return releaseNotes.slice(changelogHeading.index + changelogHeading[0].length).trim()
  }
  return releaseNotes.trim()
}

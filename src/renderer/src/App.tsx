import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { JSX, MouseEvent as ReactMouseEvent, ReactNode } from 'react'

import {
  AlertCircle,
  ArrowUpCircle,
  CheckCircle2,
  Cog,
  Download,
  FolderOpen,
  GitBranch,
  Globe,
  Info,
  Loader2,
  Mail,
  MessageSquare,
  Monitor,
  Moon,
  Palette,
  Pencil,
  RefreshCw,
  RotateCcw,
  Sun
} from 'lucide-react'

import {
  ACCENT_SWATCHES,
  DEFAULT_APPEARANCE_CONFIG,
  DEFAULT_PROXY_SETTINGS,
  THEME_PACKS,
  isSettingsTabId,
  resolveThemePack,
  type AccentMode,
  type AppInfo,
  type AppSettings,
  type FontFamiliesSnapshot,
  type LogLevel,
  type MenuBarVisibility,
  type ProxySettings,
  type SettingsTabId,
  type SupportedLanguage,
  type SystemProxyInfo,
  type UpdateCheckResult,
  type UpdateSettingsRequest
} from '../../shared/settings'
import { getText, type TextBundle } from '../../shared/i18n'
import { useAppSettings } from './hooks/useAppSettings'
import { LiveMiniPlayer, LivePlayer } from './live/LivePlayer'
import {
  SYSTEM_THEME_COLOR,
  applyTheme,
  buildFontStack,
  isHexColor,
  resolveAccentColor
} from './styles/theme'

const appIconUrl = new URL('../../../resources/icon.png', import.meta.url).href
const dreamCreatorIconUrl = new URL('../../../resources/dreamcreator.png', import.meta.url).href
const xiaDownIconUrl = new URL('../../../resources/xiadown.png', import.meta.url).href

interface LatestVersionMeta {
  label: string
  tone: 'is-muted' | 'is-primary' | 'is-danger' | 'is-success'
  icon: JSX.Element
}

function App(): JSX.Element {
  const windowType = new URLSearchParams(window.location.search).get('window')
  if (windowType === 'settings') {
    return <SettingsWindow />
  }
  if (windowType === 'mini' || windowType === 'tray-preview') {
    return <MiniWindow />
  }
  return <MainWindow />
}

function MainWindow(): JSX.Element {
  const settings = useAppSettings()
  const text = getText(settings?.language ?? 'zh-CN')

  return <LivePlayer settings={settings} text={text} />
}

function MiniWindow(): JSX.Element {
  const settings = useAppSettings()
  const text = getText(settings?.language ?? 'zh-CN')

  return <LiveMiniPlayer settings={settings} text={text} />
}

function SettingsWindow(): JSX.Element {
  const initialTab = getInitialSettingsTab()
  const [activeTab, setActiveTab] = useState<SettingsTabId>(initialTab)
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null)
  const [systemProxyInfo, setSystemProxyInfo] = useState<SystemProxyInfo | null>(null)
  const [proxyDraft, setProxyDraft] = useState<ProxySettings>(DEFAULT_PROXY_SETTINGS)
  const [proxyNoProxyText, setProxyNoProxyText] = useState('')
  const [proxyDialogOpen, setProxyDialogOpen] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [isTestingProxy, setIsTestingProxy] = useState(false)
  const [isRefreshingProxy, setIsRefreshingProxy] = useState(false)
  const [updateInfo, setUpdateInfo] = useState<UpdateCheckResult | null>(null)
  const [isCheckingUpdate, setIsCheckingUpdate] = useState(false)
  const [isInstallingUpdate, setIsInstallingUpdate] = useState(false)
  const [fontFamilies, setFontFamilies] = useState<string[]>([])
  const [isFontFamiliesLoading, setIsFontFamiliesLoading] = useState(false)
  const fontFamiliesRequestInFlightRef = useRef(false)

  const language = settings?.language ?? detectRendererLanguage()
  const text = getText(language)
  const appearanceConfig = settings?.appearanceConfig ?? DEFAULT_APPEARANCE_CONFIG
  const activePack = resolveThemePack(appearanceConfig.themePackId)
  const selectedAccent = resolveAccentColor(settings)
  const currentProxy = normalizeProxy(settings?.proxy)
  const manualProxyAddress = formatProxyAddress(proxyDraft)
  const selectedFont = settings?.fontFamily.trim() ?? ''
  const fontOptions = buildFontOptions(
    fontFamilies.length > 0 ? fontFamilies : buildDefaultFontOptions(selectedFont),
    selectedFont
  )
  const menuBarVisibilityOptions = getMenuBarVisibilityOptions(appInfo?.platform)
  const proxyAddress =
    currentProxy.mode === 'system'
      ? systemProxyInfo?.address || text.settings.notConfigured
      : currentProxy.mode === 'manual'
        ? formatProxyAddress(currentProxy) || text.settings.notConfigured
        : text.settings.noProxy

  const refreshSystemProxy = useCallback(async (): Promise<void> => {
    setIsRefreshingProxy(true)
    try {
      setSystemProxyInfo(await window.api.getSystemProxyInfo())
    } finally {
      setIsRefreshingProxy(false)
    }
  }, [])

  const loadFontFamilies = useCallback(async (): Promise<void> => {
    if (fontFamiliesRequestInFlightRef.current) {
      return
    }

    fontFamiliesRequestInFlightRef.current = true
    setIsFontFamiliesLoading(true)
    try {
      const snapshot = await window.api.listFontFamilies()
      applyFontFamiliesSnapshot(snapshot, setFontFamilies, setIsFontFamiliesLoading)
    } catch {
      setIsFontFamiliesLoading(false)
    } finally {
      fontFamiliesRequestInFlightRef.current = false
    }
  }, [])

  useEffect(() => {
    let mounted = true
    void window.api.getSettings().then((nextSettings) => {
      if (!mounted) {
        return
      }
      setSettings(nextSettings)
      setProxyDraft(normalizeProxy(nextSettings.proxy))
      setProxyNoProxyText(normalizeProxy(nextSettings.proxy).noProxy.join(', '))
      applyTheme(nextSettings)
      document.title = `${getText(nextSettings.language).settings.title} - ${getText(nextSettings.language).appName}`
    })
    void window.api.getAppInfo().then((nextAppInfo) => {
      if (mounted) {
        setAppInfo(nextAppInfo)
      }
    })

    const disposeSettings = window.api.onSettingsUpdated((next) => {
      setSettings(next)
      setProxyDraft(normalizeProxy(next.proxy))
      setProxyNoProxyText(normalizeProxy(next.proxy).noProxy.join(', '))
      applyTheme(next)
      document.title = `${getText(next.language).settings.title} - ${getText(next.language).appName}`
    })
    const disposeNavigation = window.api.onNavigateSettings(setActiveTab)
    const disposeUpdateStatus = window.api.onUpdateStatus(setUpdateInfo)
    const disposeFontFamilies = window.api.onFontFamiliesUpdated((snapshot) => {
      applyFontFamiliesSnapshot(snapshot, setFontFamilies, setIsFontFamiliesLoading)
    })
    return () => {
      mounted = false
      disposeSettings()
      disposeNavigation()
      disposeUpdateStatus()
      disposeFontFamilies()
    }
  }, [])

  useEffect(() => {
    if (settings?.proxy.mode !== 'system') {
      return
    }
    const timer = window.setTimeout(() => {
      void refreshSystemProxy()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [refreshSystemProxy, settings?.proxy.mode])

  useEffect(() => {
    if (!settings || activeTab !== 'appearance') {
      return
    }

    const timer = window.setTimeout(() => {
      void loadFontFamilies()
    }, 120)
    return () => window.clearTimeout(timer)
  }, [activeTab, loadFontFamilies, settings])

  async function saveSettingsPatch(patch: UpdateSettingsRequest): Promise<AppSettings | null> {
    setIsSaving(true)
    setSaveError('')
    try {
      const next = await window.api.updateSettings(patch)
      setSettings(next)
      applyTheme(next)
      return next
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setSaveError(message || text.settings.unavailable)
      window.api.writeLog('error', 'settings:save', 'settings save failed', error)
      return settings
    } finally {
      setIsSaving(false)
    }
  }

  async function changeProxyMode(mode: ProxySettings['mode']): Promise<void> {
    const next = resetProxyTestState({
      ...currentProxy,
      mode,
      scheme: currentProxy.scheme || 'http'
    })
    setProxyDraft(next)
    setProxyNoProxyText(next.noProxy.join(', '))
    if (mode === 'manual') {
      setProxyDialogOpen(true)
      return
    }
    await saveSettingsPatch({ proxy: next })
    if (mode === 'system') {
      void refreshSystemProxy()
    }
  }

  function changeProxyField(field: keyof ProxySettings, value: string): void {
    const numeric = field === 'port' || field === 'timeoutSeconds'
    setProxyDraft((current) =>
      resetProxyTestState({
        ...current,
        [field]: numeric ? clamp(Number.parseInt(value, 10) || 0, 0, 65535) : value
      })
    )
  }

  async function clearProxy(): Promise<void> {
    const empty = { ...DEFAULT_PROXY_SETTINGS, mode: 'none' as const }
    setProxyDraft(empty)
    setProxyNoProxyText('')
    await saveSettingsPatch({ proxy: empty })
    setProxyDialogOpen(false)
  }

  async function testAndSaveManualProxy(): Promise<void> {
    const payload: ProxySettings = {
      ...proxyDraft,
      mode: 'manual',
      noProxy: parseNoProxy(proxyNoProxyText)
    }
    setIsTestingProxy(true)
    try {
      const tested = await window.api.testProxy(payload)
      setProxyDraft(tested)
      setProxyNoProxyText(tested.noProxy.join(', '))
      if (tested.testSuccess) {
        await saveSettingsPatch({ proxy: tested })
        setProxyDialogOpen(false)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setProxyDraft((current) => ({
        ...current,
        testSuccess: false,
        testMessage: message || text.settings.unavailable
      }))
    } finally {
      setIsTestingProxy(false)
    }
  }

  async function checkForUpdates(): Promise<void> {
    setIsCheckingUpdate(true)
    try {
      setUpdateInfo(await window.api.checkForUpdates())
    } finally {
      setIsCheckingUpdate(false)
    }
  }

  async function installUpdate(): Promise<void> {
    setIsInstallingUpdate(true)
    try {
      setUpdateInfo(await window.api.installUpdate())
    } finally {
      setIsInstallingUpdate(false)
    }
  }

  if (!settings) {
    return (
      <div className="settings-window is-loading">
        <Loader2 className="spin" size={16} />
        <span>{text.loading}</span>
      </div>
    )
  }

  const tabs: Array<{ id: SettingsTabId; label: string; icon: ReactNode }> = [
    { id: 'general', label: text.tabs.general, icon: <Cog size={26} /> },
    { id: 'appearance', label: text.tabs.appearance, icon: <Palette size={26} /> },
    { id: 'about', label: text.tabs.about, icon: <Info size={26} /> }
  ]

  return (
    <div className="settings-window">
      <header className="settings-header" aria-label={text.settings.title}>
        <div className="settings-drag-strip" />
        <nav className="settings-tabs" aria-label={text.settings.title}>
          {tabs.map((tab) => (
            <button
              className={tab.id === activeTab ? 'tab-button is-active' : 'tab-button'}
              type="button"
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              title={tab.label}
            >
              <span>{tab.icon}</span>
              <strong>{tab.label}</strong>
            </button>
          ))}
        </nav>
      </header>

      <div className="settings-content">
        {saveError ? <div className="settings-error-banner">{saveError}</div> : null}
        {activeTab === 'general' ? (
          <div className="settings-stack">
            <SettingsCard>
              <SettingsRow label={text.settings.startup}>
                <Switch
                  checked={settings.autoStart}
                  ariaLabel={text.settings.startup}
                  onChange={(checked) => void saveSettingsPatch({ autoStart: checked })}
                />
              </SettingsRow>
              <SettingsSeparator />
              <SettingsRow label={text.settings.tray}>
                <Switch
                  checked={settings.minimizeToTrayOnStart}
                  ariaLabel={text.settings.tray}
                  onChange={(checked) => void saveSettingsPatch({ minimizeToTrayOnStart: checked })}
                />
              </SettingsRow>
              <SettingsSeparator />
              <SettingsRow label={text.settings.menuBar}>
                <select
                  className="select-control"
                  value={settings.menuBarVisibility}
                  onChange={(event) =>
                    void saveSettingsPatch({
                      menuBarVisibility: event.currentTarget.value as MenuBarVisibility
                    })
                  }
                >
                  {menuBarVisibilityOptions.map((option) => (
                    <option value={option} key={option}>
                      {text.settings.menuBarOptions[option]}
                    </option>
                  ))}
                </select>
              </SettingsRow>
              <SettingsSeparator />
              <SettingsRow label={text.settings.language}>
                <select
                  className="select-control"
                  value={settings.language}
                  onChange={(event) =>
                    void saveSettingsPatch({
                      language: event.currentTarget.value as SupportedLanguage
                    })
                  }
                >
                  <option value="en">{text.common.languages.en}</option>
                  <option value="zh-CN">{text.common.languages.zhCN}</option>
                </select>
              </SettingsRow>
            </SettingsCard>

            <SettingsCard>
              <SettingsRow label={text.settings.proxy}>
                <SegmentGroup>
                  <SegmentButton
                    active={currentProxy.mode === 'none'}
                    onClick={() => void changeProxyMode('none')}
                  >
                    {text.settings.noProxy}
                  </SegmentButton>
                  <SegmentButton
                    active={currentProxy.mode === 'system'}
                    onClick={() => void changeProxyMode('system')}
                  >
                    {text.settings.systemProxy}
                  </SegmentButton>
                  <SegmentButton
                    active={currentProxy.mode === 'manual'}
                    onClick={() => void changeProxyMode('manual')}
                  >
                    {text.settings.manualProxy}
                  </SegmentButton>
                </SegmentGroup>
              </SettingsRow>
              {currentProxy.mode !== 'none' ? (
                <>
                  <SettingsSeparator />
                  <SettingsRow label={text.settings.status} contentClassName="wide-content">
                    <div className="status-line">
                      {isRefreshingProxy ? <Loader2 className="spin" size={14} /> : null}
                      <span className="path-text">{proxyAddress}</span>
                      <StatusDot
                        active
                        success={currentProxy.mode === 'system' || currentProxy.testSuccess}
                      />
                      {currentProxy.mode === 'manual' ? (
                        <IconButton
                          title={text.settings.editProxy}
                          onClick={() => setProxyDialogOpen(true)}
                        >
                          <Pencil size={15} />
                        </IconButton>
                      ) : null}
                    </div>
                  </SettingsRow>
                </>
              ) : null}
            </SettingsCard>

            <SettingsCard>
              <SettingsRow label={text.settings.logLevel}>
                <div className="inline-actions">
                  <IconButton
                    title={text.actions.openLogs}
                    onClick={() => void window.api.openLogDirectory()}
                  >
                    <FolderOpen size={15} />
                  </IconButton>
                  <select
                    className="select-control"
                    value={settings.logLevel}
                    onChange={(event) =>
                      void saveSettingsPatch({ logLevel: event.currentTarget.value as LogLevel })
                    }
                  >
                    <option value="debug">debug</option>
                    <option value="info">info</option>
                    <option value="warn">warn</option>
                    <option value="error">error</option>
                  </select>
                </div>
              </SettingsRow>
            </SettingsCard>
          </div>
        ) : activeTab === 'appearance' ? (
          <div className="settings-stack is-compact">
            <SettingsCard contentClassName="theme-grid-card">
              <div className="theme-pack-grid">
                {THEME_PACKS.map((pack) => (
                  <Tooltip key={pack.id} label={pack.descriptions[language]}>
                    <button
                      className={
                        pack.id === activePack.id
                          ? 'theme-pack-button is-active'
                          : 'theme-pack-button'
                      }
                      type="button"
                      onClick={() =>
                        void saveSettingsPatch({
                          appearanceConfig: { themePackId: pack.id }
                        })
                      }
                    >
                      <span className="theme-pack-preview" aria-hidden="true">
                        <i style={{ backgroundColor: pack.preview.shell }} />
                        <i style={{ backgroundColor: pack.preview.sidebar }} />
                        <i style={{ backgroundColor: pack.preview.accent }} />
                      </span>
                      <span>
                        <strong>{pack.labels[language]}</strong>
                      </span>
                    </button>
                  </Tooltip>
                ))}
              </div>
            </SettingsCard>

            <SettingsCard>
              <SettingsRow label={text.settings.appearanceMode}>
                <SegmentGroup>
                  <SegmentButton
                    active={settings.appearance === 'light'}
                    onClick={() => void saveSettingsPatch({ appearance: 'light' })}
                  >
                    <Sun size={15} />
                    {text.common.light}
                  </SegmentButton>
                  <SegmentButton
                    active={settings.appearance === 'dark'}
                    onClick={() => void saveSettingsPatch({ appearance: 'dark' })}
                  >
                    <Moon size={15} />
                    {text.common.dark}
                  </SegmentButton>
                  <SegmentButton
                    active={settings.appearance === 'auto'}
                    onClick={() => void saveSettingsPatch({ appearance: 'auto' })}
                  >
                    <Monitor size={15} />
                    {text.common.followSystem}
                  </SegmentButton>
                </SegmentGroup>
              </SettingsRow>
              <SettingsSeparator />
              <SettingsRow label={text.settings.accent}>
                <SegmentGroup>
                  <SegmentButton
                    active={appearanceConfig?.accentMode !== 'color'}
                    onClick={() => void saveAccentMode('theme')}
                  >
                    {text.settings.accentOptions.theme}
                  </SegmentButton>
                  <SegmentButton
                    active={appearanceConfig?.accentMode === 'color'}
                    onClick={() => void saveAccentMode('color')}
                  >
                    {text.settings.accentOptions.color}
                  </SegmentButton>
                </SegmentGroup>
              </SettingsRow>
              {appearanceConfig?.accentMode === 'color' ? (
                <>
                  <SettingsSeparator />
                  <SettingsRow label={text.settings.accentColor}>
                    <div className="swatch-row">
                      <Tooltip label={text.common.followSystem}>
                        <SwatchButton
                          color={
                            isHexColor(settings.systemThemeColor)
                              ? settings.systemThemeColor
                              : activePack.preview.accent
                          }
                          active={settings.themeColor.toLowerCase() === SYSTEM_THEME_COLOR}
                          label={text.common.followSystem}
                          onClick={() => void saveSettingsPatch({ themeColor: SYSTEM_THEME_COLOR })}
                        />
                      </Tooltip>
                      {ACCENT_SWATCHES.map((swatch) => (
                        <Tooltip key={swatch.value} label={swatch.labels[language]}>
                          <SwatchButton
                            color={swatch.value}
                            active={
                              settings.themeColor.toLowerCase() === swatch.value.toLowerCase()
                            }
                            label={swatch.labels[language]}
                            onClick={() => void saveSettingsPatch({ themeColor: swatch.value })}
                          />
                        </Tooltip>
                      ))}
                      <Tooltip label={text.common.customColor}>
                        <input
                          type="color"
                          className="color-input"
                          value={selectedAccent}
                          aria-label={text.common.customColor}
                          onChange={(event) =>
                            void saveSettingsPatch({ themeColor: event.currentTarget.value })
                          }
                        />
                      </Tooltip>
                    </div>
                  </SettingsRow>
                </>
              ) : null}
              <SettingsSeparator />
              <SettingsRow label={text.settings.fontFamily}>
                <select
                  className="select-control"
                  value={settings.fontFamily}
                  style={{ fontFamily: buildFontStack(settings.fontFamily) }}
                  onFocus={() => void loadFontFamilies()}
                  onMouseDown={() => void loadFontFamilies()}
                  onChange={(event) =>
                    void saveSettingsPatch({ fontFamily: event.currentTarget.value })
                  }
                >
                  <option value="">{text.common.systemDefault}</option>
                  {isFontFamiliesLoading ? (
                    <option value="__loading-fonts" disabled>
                      {text.settings.fontsLoading}
                    </option>
                  ) : null}
                  {fontOptions.map((font) => (
                    <option key={font} value={font} style={{ fontFamily: buildFontStack(font) }}>
                      {font}
                    </option>
                  ))}
                </select>
              </SettingsRow>
              <SettingsSeparator />
              <SettingsRow label={text.settings.fontSize}>
                <input
                  className="number-control"
                  type="number"
                  min={12}
                  max={24}
                  value={settings.fontSize}
                  onChange={(event) =>
                    void saveSettingsPatch({
                      fontSize: Number.parseInt(event.currentTarget.value, 10)
                    })
                  }
                />
              </SettingsRow>
            </SettingsCard>
          </div>
        ) : (
          <AboutTab
            appInfo={appInfo}
            text={text}
            updateInfo={updateInfo}
            isCheckingUpdate={isCheckingUpdate}
            isInstallingUpdate={isInstallingUpdate}
            onCheckUpdates={() => void checkForUpdates()}
            onInstallUpdate={() => void installUpdate()}
          />
        )}
      </div>

      {proxyDialogOpen ? (
        <div
          className="dialog-backdrop"
          role="presentation"
          onMouseDown={() => setProxyDialogOpen(false)}
        >
          <section
            className="dialog-panel"
            role="dialog"
            aria-modal="true"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className="dialog-header">
              <h2>{text.settings.proxyDialogTitle}</h2>
              <button
                className="icon-button"
                type="button"
                onClick={() => setProxyDialogOpen(false)}
                title={text.actions.close}
              >
                x
              </button>
            </header>
            <div className="proxy-form">
              <label>
                <span>{text.settings.scheme}</span>
                <select
                  className="select-control"
                  value={proxyDraft.scheme}
                  onChange={(event) => changeProxyField('scheme', event.currentTarget.value)}
                >
                  <option value="http">HTTP</option>
                  <option value="https">HTTPS</option>
                  <option value="socks5">SOCKS5</option>
                </select>
              </label>
              <label>
                <span>{text.settings.timeout}</span>
                <input
                  className="text-control"
                  type="number"
                  min={3}
                  max={120}
                  value={proxyDraft.timeoutSeconds || ''}
                  onChange={(event) =>
                    changeProxyField('timeoutSeconds', event.currentTarget.value)
                  }
                />
              </label>
              <label>
                <span>{text.settings.host}</span>
                <input
                  className="text-control"
                  value={proxyDraft.host}
                  placeholder="127.0.0.1"
                  onChange={(event) => changeProxyField('host', event.currentTarget.value)}
                />
              </label>
              <label>
                <span>{text.settings.port}</span>
                <input
                  className="text-control"
                  type="number"
                  value={proxyDraft.port || ''}
                  placeholder="8080"
                  onChange={(event) => changeProxyField('port', event.currentTarget.value)}
                />
              </label>
              <label>
                <span>{text.settings.username}</span>
                <input
                  className="text-control"
                  value={proxyDraft.username}
                  onChange={(event) => changeProxyField('username', event.currentTarget.value)}
                />
              </label>
              <label>
                <span>{text.settings.password}</span>
                <input
                  className="text-control"
                  type="password"
                  value={proxyDraft.password}
                  onChange={(event) => changeProxyField('password', event.currentTarget.value)}
                />
              </label>
              <label className="form-wide">
                <span>{text.settings.noProxyList}</span>
                <input
                  className="text-control"
                  value={proxyNoProxyText}
                  onChange={(event) => setProxyNoProxyText(event.currentTarget.value)}
                />
              </label>
            </div>
            <div className={proxyDraft.testSuccess ? 'proxy-feedback' : 'proxy-feedback is-error'}>
              {proxyDraft.testMessage || manualProxyAddress}
            </div>
            <footer className="dialog-actions">
              <button
                className="danger-button"
                type="button"
                disabled={isSaving || isTestingProxy}
                onClick={() => void clearProxy()}
              >
                {text.actions.clear}
              </button>
              <button
                className="secondary-button"
                type="button"
                onClick={() => setProxyDialogOpen(false)}
              >
                {text.actions.close}
              </button>
              <button
                className="primary-button"
                type="button"
                disabled={
                  isSaving || isTestingProxy || !proxyDraft.host.trim() || proxyDraft.port <= 0
                }
                onClick={() => void testAndSaveManualProxy()}
              >
                {isSaving || isTestingProxy ? <Loader2 className="spin" size={15} /> : null}
                {text.actions.testProxy}
              </button>
            </footer>
          </section>
        </div>
      ) : null}
    </div>
  )

  async function saveAccentMode(accentMode: AccentMode): Promise<void> {
    const patch: UpdateSettingsRequest = {
      appearanceConfig: { accentMode }
    }
    if (accentMode === 'theme') {
      await saveSettingsPatch(patch)
      return
    }
    await saveSettingsPatch({
      ...patch,
      themeColor: settings?.themeColor || activePack.preview.accent
    })
  }
}
function AboutTab(props: {
  appInfo: AppInfo | null
  text: TextBundle
  updateInfo: UpdateCheckResult | null
  isCheckingUpdate: boolean
  isInstallingUpdate: boolean
  onCheckUpdates: () => void
  onInstallUpdate: () => void
}): JSX.Element {
  const [releaseNotesOpen, setReleaseNotesOpen] = useState(false)
  const {
    appInfo,
    text,
    updateInfo,
    isCheckingUpdate,
    isInstallingUpdate,
    onCheckUpdates,
    onInstallUpdate
  } = props
  const author = normalizeExampleValue(appInfo?.author) || 'Arnold HAO'
  const homepage = normalizeExampleValue(appInfo?.homepage) || 'https://dreamapp.cc/'
  const github = 'https://github.com/arnoldhao'
  const feedback = 'https://github.com/arnoldhao/hush/issues'
  const latestMeta = resolveLatestVersionMeta(updateInfo, text)
  const updateProgress = formatUpdateProgress(updateInfo)
  const updateReady = updateInfo?.status === 'downloaded'
  const updateInProgress = updateInfo?.status === 'downloading'
  const releaseNotes = updateInfo?.releaseNotes?.trim() ?? ''
  const dreamApps = [
    {
      name: text.about.dreamCreator,
      description: text.about.dreamCreatorDescription,
      url: 'https://dreamcreator.dreamapp.cc/',
      iconUrl: dreamCreatorIconUrl
    },
    {
      name: text.about.xiaDown,
      description: text.about.xiaDownDescription,
      url: 'https://xiadown.dreamapp.cc/',
      iconUrl: xiaDownIconUrl
    }
  ]

  useEffect(() => {
    if (!releaseNotesOpen) {
      return
    }

    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setReleaseNotesOpen(false)
      }
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [releaseNotesOpen])

  return (
    <div className="settings-stack">
      <div className="about-brand">
        <img className="about-app-icon" src={appIconUrl} alt="" aria-hidden="true" />
        <div>{text.appName}</div>
      </div>

      <SettingsCard>
        <SettingsRow label={text.about.currentVersion}>
          <strong className="value-text">{appInfo?.version ?? 'dev'}</strong>
        </SettingsRow>
        <SettingsSeparator />
        <SettingsRow label={text.about.latestVersion}>
          <span className={`status-badge ${latestMeta.tone}`}>
            {latestMeta.icon}
            {latestMeta.label}
          </span>
        </SettingsRow>
        <SettingsSeparator />
        <SettingsRow label={text.about.releaseNotes}>
          <button
            className="secondary-button release-notes-trigger"
            type="button"
            onClick={() => setReleaseNotesOpen(true)}
          >
            <Info size={15} />
            {text.about.viewReleaseNotes}
          </button>
        </SettingsRow>
        <SettingsSeparator />
        <SettingsRow label={text.about.updateStatus}>
          {updateReady ? (
            <button
              className="primary-button"
              type="button"
              disabled={isInstallingUpdate}
              onClick={onInstallUpdate}
            >
              {isInstallingUpdate ? (
                <Loader2 className="spin" size={15} />
              ) : (
                <RotateCcw size={15} />
              )}
              {text.actions.installUpdate}
            </button>
          ) : (
            <button
              className="secondary-button"
              type="button"
              disabled={isCheckingUpdate || updateInProgress}
              onClick={onCheckUpdates}
            >
              {isCheckingUpdate || updateInProgress ? (
                <Loader2 className="spin" size={15} />
              ) : (
                <RefreshCw size={15} />
              )}
              {updateInProgress ? text.about.downloadingUpdate : text.actions.checkUpdates}
            </button>
          )}
        </SettingsRow>
        {updateProgress ? (
          <>
            <SettingsSeparator />
            <SettingsRow label={text.about.downloadProgress}>
              <span className="muted-text">{updateProgress}</span>
            </SettingsRow>
          </>
        ) : null}
        {updateInfo?.message ? (
          <>
            <SettingsSeparator />
            <SettingsRow label={text.about.status} contentClassName="wide-content">
              <span className="error-text">{updateInfo.message}</span>
            </SettingsRow>
          </>
        ) : null}
      </SettingsCard>

      <SettingsCard>
        <SettingsRow label={text.about.craftedBy}>
          <strong className="value-text">{author}</strong>
        </SettingsRow>
        <SettingsSeparator />
        <SettingsRow label={text.about.contact}>
          <div className="inline-actions">
            <IconButton
              title={text.about.email}
              onClick={() => void window.api.openExternal('mailto:xunruhao@gmail.com')}
            >
              <Mail size={15} />
            </IconButton>
            <IconButton
              title={text.about.website}
              onClick={() => void window.api.openExternal(homepage)}
            >
              <Globe size={15} />
            </IconButton>
            <IconButton
              title={text.about.github}
              onClick={() => void window.api.openExternal(github)}
            >
              <GitBranch size={15} />
            </IconButton>
          </div>
        </SettingsRow>
        <SettingsSeparator />
        <SettingsRow label={text.about.feedback}>
          <IconButton
            title={text.about.sendFeedback}
            onClick={() => void window.api.openExternal(feedback)}
          >
            <MessageSquare size={15} />
          </IconButton>
        </SettingsRow>
      </SettingsCard>

      <div className="dream-app-section">
        <div className="dream-app-title">{text.about.dreamApp}</div>
        <SettingsCard contentClassName="dream-app-card">
          {dreamApps.map((app, index) => (
            <div
              className={index > 0 ? 'dream-app-item has-border' : 'dream-app-item'}
              key={app.name}
            >
              <div className="dream-app-icon" aria-hidden="true">
                <img src={app.iconUrl} alt="" />
              </div>
              <div className="dream-app-copy">
                <div className="dream-app-name">{app.name}</div>
                <div className="dream-app-description">{app.description}</div>
              </div>
              <button
                className="secondary-button dream-app-link"
                type="button"
                onClick={() => void window.api.openExternal(app.url)}
              >
                <Globe size={15} />
                {text.about.website}
              </button>
            </div>
          ))}
        </SettingsCard>
      </div>

      {releaseNotesOpen ? (
        <div
          className="dialog-backdrop"
          role="presentation"
          onMouseDown={() => setReleaseNotesOpen(false)}
        >
          <section
            className="dialog-panel release-notes-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="release-notes-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className="dialog-header">
              <h2 id="release-notes-title">{text.about.releaseNotes}</h2>
              <button
                className="icon-button"
                type="button"
                onClick={() => setReleaseNotesOpen(false)}
                title={text.actions.close}
                aria-label={text.actions.close}
              >
                x
              </button>
            </header>
            <div className="release-notes-body">
              <ReleaseNotesContent content={releaseNotes || text.about.noReleaseNotes} />
            </div>
            <footer className="dialog-actions">
              <button
                className="secondary-button"
                type="button"
                onClick={() => setReleaseNotesOpen(false)}
              >
                {text.actions.close}
              </button>
            </footer>
          </section>
        </div>
      ) : null}
    </div>
  )
}

type MarkdownBlock =
  | { type: 'code'; content: string }
  | { type: 'heading'; level: number; content: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'paragraph'; content: string }
  | { type: 'quote'; content: string }
  | { type: 'rule' }

const ALLOWED_RELEASE_NOTES_HTML_TAGS = new Set([
  'a',
  'blockquote',
  'br',
  'code',
  'em',
  'h1',
  'h2',
  'h3',
  'h4',
  'hr',
  'li',
  'ol',
  'p',
  'pre',
  'strong',
  'table',
  'tbody',
  'td',
  'th',
  'thead',
  'tr',
  'ul'
])

function ReleaseNotesContent(props: { content: string }): JSX.Element {
  if (isReleaseNotesHtml(props.content)) {
    return <HtmlContent html={props.content} />
  }
  return <MarkdownContent markdown={props.content} />
}

function HtmlContent(props: { html: string }): JSX.Element {
  const sanitizedHtml = sanitizeReleaseNotesHtml(props.html)
  return (
    <div
      className="markdown-content"
      onClick={handleReleaseNotesHtmlClick}
      dangerouslySetInnerHTML={{ __html: sanitizedHtml }}
    />
  )
}

function MarkdownContent(props: { markdown: string }): JSX.Element {
  const blocks = parseMarkdownBlocks(props.markdown)

  return (
    <div className="markdown-content">
      {blocks.map((block, index) => {
        const key = `markdown-block-${index}`
        if (block.type === 'heading') {
          const HeadingTag = `h${Math.min(block.level, 4)}` as keyof JSX.IntrinsicElements
          return <HeadingTag key={key}>{renderMarkdownInline(block.content, key)}</HeadingTag>
        }
        if (block.type === 'list') {
          const ListTag = block.ordered ? 'ol' : 'ul'
          return (
            <ListTag key={key}>
              {block.items.map((item, itemIndex) => (
                <li key={`${key}-${itemIndex}`}>
                  {renderMarkdownInline(item, `${key}-${itemIndex}`)}
                </li>
              ))}
            </ListTag>
          )
        }
        if (block.type === 'code') {
          return (
            <pre key={key}>
              <code>{block.content}</code>
            </pre>
          )
        }
        if (block.type === 'quote') {
          return <blockquote key={key}>{renderMarkdownInline(block.content, key)}</blockquote>
        }
        if (block.type === 'rule') {
          return <hr key={key} />
        }
        return <p key={key}>{renderMarkdownInline(block.content, key)}</p>
      })}
    </div>
  )
}

function parseMarkdownBlocks(markdown: string): MarkdownBlock[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  const blocks: MarkdownBlock[] = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index]
    const trimmed = line.trim()

    if (!trimmed) {
      index += 1
      continue
    }

    if (trimmed.startsWith('```')) {
      const codeLines: string[] = []
      index += 1
      while (index < lines.length && !lines[index].trim().startsWith('```')) {
        codeLines.push(lines[index])
        index += 1
      }
      blocks.push({ type: 'code', content: codeLines.join('\n') })
      index += index < lines.length ? 1 : 0
      continue
    }

    const headingMatch = /^(#{1,4})\s+(.+)$/.exec(trimmed)
    if (headingMatch) {
      blocks.push({
        type: 'heading',
        level: headingMatch[1].length,
        content: headingMatch[2].trim()
      })
      index += 1
      continue
    }

    if (/^[-*_]{3,}$/.test(trimmed)) {
      blocks.push({ type: 'rule' })
      index += 1
      continue
    }

    const quoteMatch = /^>\s?(.+)$/.exec(trimmed)
    if (quoteMatch) {
      const quoteLines = [quoteMatch[1].trim()]
      index += 1
      while (index < lines.length) {
        const nextQuoteMatch = /^>\s?(.+)$/.exec(lines[index].trim())
        if (!nextQuoteMatch) {
          break
        }
        quoteLines.push(nextQuoteMatch[1].trim())
        index += 1
      }
      blocks.push({ type: 'quote', content: quoteLines.join(' ') })
      continue
    }

    const listMatch = /^((?:[-*+])|(?:\d+[.)]))\s+(.+)$/.exec(trimmed)
    if (listMatch) {
      const ordered = /^\d/.test(listMatch[1])
      const items = [listMatch[2].trim()]
      index += 1
      while (index < lines.length) {
        const nextListMatch = /^((?:[-*+])|(?:\d+[.)]))\s+(.+)$/.exec(lines[index].trim())
        if (!nextListMatch || /^\d/.test(nextListMatch[1]) !== ordered) {
          break
        }
        items.push(nextListMatch[2].trim())
        index += 1
      }
      blocks.push({ type: 'list', ordered, items })
      continue
    }

    const paragraphLines = [trimmed]
    index += 1
    while (index < lines.length) {
      const nextTrimmed = lines[index].trim()
      if (
        !nextTrimmed ||
        nextTrimmed.startsWith('```') ||
        /^(#{1,4})\s+/.test(nextTrimmed) ||
        /^((?:[-*+])|(?:\d+[.)]))\s+/.test(nextTrimmed) ||
        /^>\s?(.+)$/.test(nextTrimmed) ||
        /^[-*_]{3,}$/.test(nextTrimmed)
      ) {
        break
      }
      paragraphLines.push(nextTrimmed)
      index += 1
    }
    blocks.push({ type: 'paragraph', content: paragraphLines.join(' ') })
  }

  return blocks
}

function isReleaseNotesHtml(content: string): boolean {
  return /<\/?(?:h[1-6]|p|ul|ol|li|a|code|pre|blockquote|table|thead|tbody|tr|th|td|hr|br|strong|em)\b/i.test(
    content
  )
}

function sanitizeReleaseNotesHtml(html: string): string {
  const parser = new DOMParser()
  const source = parser.parseFromString(html, 'text/html')
  const target = document.implementation.createHTMLDocument('')
  const container = target.createElement('div')

  for (const child of Array.from(source.body.childNodes)) {
    for (const safeChild of sanitizeReleaseNotesHtmlNode(child, target)) {
      container.appendChild(safeChild)
    }
  }

  return container.innerHTML.trim()
}

function sanitizeReleaseNotesHtmlNode(node: Node, target: Document): Node[] {
  if (node.nodeType === 3) {
    return [target.createTextNode(node.textContent ?? '')]
  }
  if (node.nodeType !== 1) {
    return []
  }

  const element = node as Element
  const tagName = element.tagName.toLowerCase()
  const children = Array.from(element.childNodes).flatMap((child) =>
    sanitizeReleaseNotesHtmlNode(child, target)
  )

  if (!ALLOWED_RELEASE_NOTES_HTML_TAGS.has(tagName)) {
    return children
  }

  const safeElement = target.createElement(tagName)
  if (tagName === 'a') {
    const href = normalizeReleaseNotesHref(element.getAttribute('href') ?? '')
    if (!href) {
      return children
    }
    safeElement.setAttribute('href', href)
    safeElement.setAttribute('rel', 'noopener noreferrer')
  }

  children.forEach((child) => safeElement.appendChild(child))
  return [safeElement]
}

function handleReleaseNotesHtmlClick(event: ReactMouseEvent<HTMLDivElement>): void {
  const target = event.target
  if (!(target instanceof Element)) {
    return
  }

  const anchor = target.closest('a')
  if (!(anchor instanceof HTMLAnchorElement)) {
    return
  }

  const href = normalizeReleaseNotesHref(anchor.getAttribute('href') ?? '')
  event.preventDefault()
  if (href) {
    void window.api.openExternal(href)
  }
}

function renderMarkdownInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = []
  const tokenPattern = /(\[[^\]]+\]\([^)]+\)|`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*|_[^_]+_)/g
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = tokenPattern.exec(text))) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index))
    }

    const token = match[0]
    const key = `${keyPrefix}-${match.index}`
    const linkMatch = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token)
    if (linkMatch) {
      const href = normalizeReleaseNotesHref(linkMatch[2])
      nodes.push(
        href ? (
          <a
            key={key}
            href={href}
            onClick={(event) => {
              event.preventDefault()
              void window.api.openExternal(href)
            }}
          >
            {renderMarkdownInline(linkMatch[1], `${key}-label`)}
          </a>
        ) : (
          linkMatch[1]
        )
      )
    } else if (token.startsWith('`')) {
      nodes.push(<code key={key}>{token.slice(1, -1)}</code>)
    } else if (token.startsWith('**') || token.startsWith('__')) {
      nodes.push(
        <strong key={key}>{renderMarkdownInline(token.slice(2, -2), `${key}-strong`)}</strong>
      )
    } else {
      nodes.push(<em key={key}>{renderMarkdownInline(token.slice(1, -1), `${key}-em`)}</em>)
    }

    lastIndex = tokenPattern.lastIndex
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex))
  }

  return nodes
}

function normalizeReleaseNotesHref(href: string): string {
  try {
    const parsed = new URL(href.trim())
    if (
      parsed.protocol === 'https:' ||
      parsed.protocol === 'http:' ||
      parsed.protocol === 'mailto:'
    ) {
      return parsed.toString()
    }
  } catch {
    return ''
  }
  return ''
}

function SettingsCard(props: { children: ReactNode; contentClassName?: string }): JSX.Element {
  return (
    <section className={`settings-card ${props.contentClassName ?? ''}`}>{props.children}</section>
  )
}

function SettingsRow(props: {
  label: ReactNode
  children: ReactNode
  contentClassName?: string
}): JSX.Element {
  return (
    <div className="settings-row">
      <div className="settings-label">{props.label}</div>
      <div className={`settings-value ${props.contentClassName ?? ''}`}>{props.children}</div>
    </div>
  )
}

function SettingsSeparator(): JSX.Element {
  return <div className="settings-separator" />
}

function Switch(props: {
  checked: boolean
  onChange: (checked: boolean) => void
  ariaLabel: string
}): JSX.Element {
  return (
    <button
      className={props.checked ? 'switch-control is-on' : 'switch-control'}
      type="button"
      role="switch"
      aria-checked={props.checked}
      aria-label={props.ariaLabel}
      onClick={() => props.onChange(!props.checked)}
    >
      <span />
    </button>
  )
}

function SegmentGroup(props: { children: ReactNode }): JSX.Element {
  return <div className="segment-group">{props.children}</div>
}

function SegmentButton(props: {
  active: boolean
  children: ReactNode
  onClick: () => void
}): JSX.Element {
  return (
    <button
      className={props.active ? 'segment-button is-active' : 'segment-button'}
      type="button"
      onClick={props.onClick}
    >
      {props.children}
    </button>
  )
}

function IconButton(props: {
  title: string
  children: ReactNode
  disabled?: boolean
  onClick: () => void
}): JSX.Element {
  return (
    <button
      className="icon-button"
      type="button"
      title={props.title}
      aria-label={props.title}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  )
}

function SwatchButton(props: {
  color: string
  active: boolean
  label: string
  onClick: () => void
}): JSX.Element {
  return (
    <button
      className={props.active ? 'swatch-button is-active' : 'swatch-button'}
      type="button"
      aria-label={props.label}
      style={{ backgroundColor: props.color, color: props.color }}
      onClick={props.onClick}
    />
  )
}

function StatusDot(props: { active: boolean; success: boolean }): JSX.Element {
  const className = props.active
    ? props.success
      ? 'status-dot is-success'
      : 'status-dot is-muted'
    : 'status-dot'
  return <span className={className} aria-hidden="true" />
}

function Tooltip(props: {
  children: ReactNode
  label: string
  side?: 'top' | 'bottom'
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<{
    arrowClassName: string
    left: number
    top: number
    transform: string
  } | null>(null)
  const id = useId()
  const triggerRef = useRef<HTMLSpanElement | null>(null)
  const side = props.side ?? 'top'

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) {
      return
    }

    const update = (): void => {
      const rect = triggerRef.current?.getBoundingClientRect()
      if (!rect) {
        return
      }
      const sideOffset = 8
      if (side === 'bottom') {
        setPosition({
          top: rect.bottom + sideOffset,
          left: rect.left + rect.width / 2,
          transform: 'translate(-50%, 0)',
          arrowClassName: 'is-top'
        })
        return
      }
      setPosition({
        top: rect.top - sideOffset,
        left: rect.left + rect.width / 2,
        transform: 'translate(-50%, -100%)',
        arrowClassName: 'is-bottom'
      })
    }

    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [open, side])

  return (
    <span
      ref={triggerRef}
      className="tooltip-trigger-wrap"
      aria-describedby={open ? id : undefined}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          setOpen(false)
        }
      }}
    >
      {props.children}
      {open && position && props.label
        ? createPortal(
            <div
              id={id}
              role="tooltip"
              className="app-tooltip"
              style={{
                left: position.left,
                top: position.top,
                transform: position.transform
              }}
            >
              {props.label}
              <span className={`app-tooltip-arrow ${position.arrowClassName}`} aria-hidden="true" />
            </div>,
            document.body
          )
        : null}
    </span>
  )
}

function getInitialSettingsTab(): SettingsTabId {
  const raw = new URLSearchParams(window.location.search).get('tab')
  return isSettingsTabId(raw) ? raw : 'general'
}

function detectRendererLanguage(): SupportedLanguage {
  return navigator.language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en'
}

function normalizeProxy(proxy?: ProxySettings | null): ProxySettings {
  return {
    ...DEFAULT_PROXY_SETTINGS,
    ...(proxy ?? {}),
    noProxy: [...(proxy?.noProxy ?? [])]
  }
}

function resetProxyTestState(proxy: ProxySettings): ProxySettings {
  return {
    ...proxy,
    testSuccess: false,
    testMessage: '',
    testedAt: ''
  }
}

function parseNoProxy(text: string): string[] {
  return text
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function formatProxyAddress(proxy: ProxySettings): string {
  if (!proxy.host.trim() || proxy.port <= 0) {
    return ''
  }
  const host =
    proxy.host.includes(':') && !proxy.host.startsWith('[') ? `[${proxy.host}]` : proxy.host
  return `${proxy.scheme}://${host}:${proxy.port}`
}

function getMenuBarVisibilityOptions(platform?: string): MenuBarVisibility[] {
  const options: MenuBarVisibility[] = ['always', 'whenRunning']
  if (platform !== 'win32') {
    options.push('never')
  }
  return options
}

function normalizeFontFamilies(fonts: unknown): string[] {
  if (!Array.isArray(fonts)) {
    return []
  }
  return [...new Set(fonts.map((font) => String(font ?? '').trim()).filter(Boolean))].sort(
    (left, right) => left.localeCompare(right)
  )
}

function applyFontFamiliesSnapshot(
  snapshot: FontFamiliesSnapshot,
  setFontFamilies: (fonts: string[]) => void,
  setIsFontFamiliesLoading: (loading: boolean) => void
): void {
  setFontFamilies(normalizeFontFamilies(snapshot.families))
  setIsFontFamiliesLoading(snapshot.refreshing)
}

function buildFontOptions(fonts: string[], selectedFont: string): string[] {
  const options = normalizeFontFamilies(fonts)
  if (selectedFont && !options.some((font) => font.toLowerCase() === selectedFont.toLowerCase())) {
    return [selectedFont, ...options]
  }
  return options
}

function buildDefaultFontOptions(selectedFont: string): string[] {
  return buildFontOptions(
    [
      'Arial',
      'Helvetica Neue',
      'PingFang SC',
      'Microsoft YaHei',
      'Noto Sans CJK SC',
      'Inter',
      'SF Pro Text',
      'Segoe UI'
    ],
    selectedFont.trim()
  )
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function resolveLatestVersionMeta(
  updateInfo: UpdateCheckResult | null,
  text: TextBundle
): LatestVersionMeta {
  if (!updateInfo) {
    return {
      label: text.about.notChecked,
      tone: 'is-muted',
      icon: <Info size={14} />
    }
  }
  if (updateInfo.status === 'available') {
    return {
      label: updateInfo.latestVersion || text.about.latestAvailable,
      tone: 'is-primary',
      icon: <ArrowUpCircle size={14} />
    }
  }
  if (updateInfo.status === 'downloading') {
    return {
      label: updateInfo.latestVersion || text.about.downloadingUpdate,
      tone: 'is-primary',
      icon: <Download size={14} />
    }
  }
  if (updateInfo.status === 'downloaded') {
    return {
      label: updateInfo.latestVersion || text.about.updateReady,
      tone: 'is-success',
      icon: <CheckCircle2 size={14} />
    }
  }
  if (updateInfo.status === 'error') {
    return {
      label: text.about.latestFailed,
      tone: 'is-danger',
      icon: <AlertCircle size={14} />
    }
  }
  if (updateInfo.status === 'unsupported') {
    return {
      label: text.about.unsupported,
      tone: 'is-muted',
      icon: <Info size={14} />
    }
  }
  return {
    label: text.about.latestOk,
    tone: 'is-success',
    icon: <CheckCircle2 size={14} />
  }
}

function formatUpdateProgress(updateInfo: UpdateCheckResult | null): string {
  if (updateInfo?.status !== 'downloading' || !updateInfo.downloadProgress) {
    return ''
  }

  const percent = Math.min(Math.round(updateInfo.downloadProgress.percent), 100)
  const transferred = formatBytes(updateInfo.downloadProgress.transferred)
  const total = formatBytes(updateInfo.downloadProgress.total)

  if (!total) {
    return `${percent}%`
  }

  if (!transferred) {
    return `${percent}% (${total})`
  }

  return `${percent}% (${transferred} / ${total})`
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return ''
  }

  const units = ['B', 'KB', 'MB', 'GB']
  let nextValue = value
  let unitIndex = 0

  while (nextValue >= 1024 && unitIndex < units.length - 1) {
    nextValue /= 1024
    unitIndex += 1
  }

  const precision = unitIndex === 0 || nextValue >= 10 ? 0 : 1
  return `${nextValue.toFixed(precision)} ${units[unitIndex]}`
}

function normalizeExampleValue(value?: string): string {
  const normalized = (value ?? '').trim()
  return normalized.includes('example.com') ? '' : normalized
}

export default App

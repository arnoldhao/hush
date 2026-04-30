import { getText } from '../../../shared/i18n'
import { resolveThemePack, type AppSettings } from '../../../shared/settings'

export const SYSTEM_THEME_COLOR = 'system'

export function applyTheme(settings: AppSettings): void {
  const root = document.documentElement
  const pack = resolveThemePack(settings.appearanceConfig.themePackId)
  const tokens = settings.effectiveAppearance === 'dark' ? pack.dark : pack.light
  const accent = resolveAccentColor(settings)
  const accentForeground = readableForeground(accent)

  root.dataset.theme = settings.effectiveAppearance
  root.dataset.themePack = pack.id
  root.dataset.platform = detectPlatform()
  root.style.setProperty('--app-bg', tokens.background)
  root.style.setProperty('--app-fg', tokens.foreground)
  root.style.setProperty('--app-panel', tokens.panel)
  root.style.setProperty('--app-panel-elevated', tokens.panelElevated)
  root.style.setProperty('--app-muted', tokens.muted)
  root.style.setProperty('--app-muted-fg', tokens.mutedForeground)
  root.style.setProperty('--app-border', tokens.border)
  root.style.setProperty('--app-input', tokens.input)
  root.style.setProperty('--app-accent-soft', tokens.accent)
  root.style.setProperty('--app-accent-soft-fg', tokens.accentForeground)
  root.style.setProperty('--app-primary', accent)
  root.style.setProperty('--app-primary-fg', accentForeground)
  root.style.setProperty('--app-font', buildFontStack(settings.fontFamily))
  root.style.setProperty('--app-font-size', `${settings.fontSize}px`)
  document.title = getText(settings.language).appName
}

export function resolveAccentColor(settings: AppSettings | null | undefined): string {
  if (!settings) {
    return '#2563eb'
  }
  const pack = resolveThemePack(settings.appearanceConfig.themePackId)
  if (settings.appearanceConfig.accentMode !== 'color') {
    return pack.preview.accent
  }
  const color = settings.themeColor.trim()
  if (!color || color.toLowerCase() === SYSTEM_THEME_COLOR) {
    return isHexColor(settings.systemThemeColor) ? settings.systemThemeColor : pack.preview.accent
  }
  return isHexColor(color) ? color : pack.preview.accent
}

export function buildFontStack(fontFamily: string): string {
  const trimmed = fontFamily.trim()
  const fallback =
    'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'
  if (!trimmed) {
    return fallback
  }
  return `"${trimmed.replace(/"/g, '\\"')}", ${fallback}`
}

export function isHexColor(value: string): boolean {
  return /^#[0-9a-f]{6}$/i.test(value.trim())
}

function detectPlatform(): string {
  const platform = `${navigator.platform} ${navigator.userAgent}`.toLowerCase()
  if (platform.includes('win')) {
    return 'windows'
  }
  if (platform.includes('mac')) {
    return 'macos'
  }
  if (platform.includes('linux')) {
    return 'linux'
  }
  return 'unknown'
}

function readableForeground(hex: string): string {
  const normalized = hex.replace('#', '')
  const red = Number.parseInt(normalized.slice(0, 2), 16)
  const green = Number.parseInt(normalized.slice(2, 4), 16)
  const blue = Number.parseInt(normalized.slice(4, 6), 16)
  const luminance = (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255
  return luminance > 0.62 ? '#111827' : '#ffffff'
}

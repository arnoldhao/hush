export type AppearanceMode = 'light' | 'dark' | 'auto'
export type EffectiveAppearance = 'light' | 'dark'
export type AccentMode = 'theme' | 'color'
export type MenuBarVisibility = 'always' | 'whenRunning' | 'never'
export type ProxyMode = 'none' | 'system' | 'manual'
export type ProxyScheme = 'http' | 'https' | 'socks5'
export type SettingsTabId = 'general' | 'appearance' | 'about'
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
export type SupportedLanguage = 'en' | 'zh-CN'

export interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
  isMaximized: boolean
  isFullScreen: boolean
}

export interface ProxySettings {
  mode: ProxyMode
  scheme: ProxyScheme
  host: string
  port: number
  username: string
  password: string
  noProxy: string[]
  timeoutSeconds: number
  testedAt: string
  testSuccess: boolean
  testMessage: string
}

export interface AppearanceConfig {
  themePackId: ThemePackId
  accentMode: AccentMode
}

export interface AppSettings {
  appearance: AppearanceMode
  effectiveAppearance: EffectiveAppearance
  fontFamily: string
  fontSize: number
  language: SupportedLanguage
  themeColor: string
  systemThemeColor: string
  logLevel: LogLevel
  menuBarVisibility: MenuBarVisibility
  autoStart: boolean
  minimizeToTrayOnStart: boolean
  mainBounds: WindowBounds
  settingsBounds: WindowBounds
  proxy: ProxySettings
  appearanceConfig: AppearanceConfig
  version: number
}

export interface UpdateSettingsRequest {
  appearance?: AppearanceMode
  fontFamily?: string
  fontSize?: number
  language?: SupportedLanguage
  themeColor?: string
  logLevel?: LogLevel
  menuBarVisibility?: MenuBarVisibility
  autoStart?: boolean
  minimizeToTrayOnStart?: boolean
  mainBounds?: WindowBounds
  settingsBounds?: WindowBounds
  proxy?: ProxySettings
  appearanceConfig?: Partial<AppearanceConfig>
}

export interface SystemProxyInfo {
  address: string
  source?: 'system' | 'vpn'
  name?: string
}

export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'not-available'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'error'
  | 'unsupported'

export interface UpdateDownloadProgress {
  bytesPerSecond: number
  percent: number
  total: number
  transferred: number
}

export interface UpdateCheckResult {
  status: UpdateStatus
  currentVersion: string
  latestVersion: string
  checkedAt: string
  message: string
  releaseNotes: string
  downloadProgress?: UpdateDownloadProgress
}

export interface AppInfo {
  name: string
  version: string
  author: string
  homepage: string
  platform: string
}

export interface FontFamiliesSnapshot {
  families: string[]
  refreshing: boolean
  source: 'fallback' | 'cache' | 'scan'
}

export interface SettingsApi {
  getSettings: () => Promise<AppSettings>
  updateSettings: (patch: UpdateSettingsRequest) => Promise<AppSettings>
  showSettingsWindow: (tab?: SettingsTabId) => Promise<void>
  hideSettingsWindow: () => Promise<void>
  openLogDirectory: () => Promise<void>
  getSystemProxyInfo: () => Promise<SystemProxyInfo>
  testProxy: (proxy: ProxySettings) => Promise<ProxySettings>
  getAppInfo: () => Promise<AppInfo>
  checkForUpdates: () => Promise<UpdateCheckResult>
  installUpdate: () => Promise<UpdateCheckResult>
  openExternal: (url: string) => Promise<void>
  listFontFamilies: () => Promise<FontFamiliesSnapshot>
  onSettingsUpdated: (callback: (settings: AppSettings) => void) => () => void
  onNavigateSettings: (callback: (tab: SettingsTabId) => void) => () => void
  onUpdateStatus: (callback: (update: UpdateCheckResult) => void) => () => void
  onFontFamiliesUpdated: (callback: (snapshot: FontFamiliesSnapshot) => void) => () => void
}

export const THEME_PACK_IDS = [
  'graphite',
  'citrus',
  'pixel',
  'tape',
  'teal',
  'cloud',
  'damson',
  'fuchsia',
  'cobalt',
  'terracotta',
  'lavender',
  'nocturne'
] as const

export type ThemePackId = (typeof THEME_PACK_IDS)[number]

export interface ThemeTokens {
  background: string
  foreground: string
  panel: string
  panelElevated: string
  muted: string
  mutedForeground: string
  border: string
  input: string
  accent: string
  accentForeground: string
}

export interface ThemePack {
  id: ThemePackId
  labels: Record<SupportedLanguage, string>
  descriptions: Record<SupportedLanguage, string>
  preview: {
    shell: string
    sidebar: string
    accent: string
  }
  light: ThemeTokens
  dark: ThemeTokens
}

export const DEFAULT_APPEARANCE_CONFIG: AppearanceConfig = {
  themePackId: 'citrus',
  accentMode: 'theme'
}

export const DEFAULT_PROXY_SETTINGS: ProxySettings = {
  mode: 'system',
  scheme: 'http',
  host: '',
  port: 0,
  username: '',
  password: '',
  noProxy: [],
  timeoutSeconds: 30,
  testedAt: '',
  testSuccess: false,
  testMessage: ''
}

export const THEME_PACKS: ThemePack[] = [
  {
    id: 'graphite',
    labels: {
      en: 'Graphite',
      'zh-CN': '石墨'
    },
    descriptions: {
      en: 'Sharper grayscale surfaces with stronger contrast',
      'zh-CN': '更利落的中性色块和对比'
    },
    preview: {
      shell: '#F5F5F4',
      sidebar: '#E7E5E4',
      accent: '#4F46E5'
    },
    light: {
      background: 'hsl(220 14% 96%)',
      foreground: 'hsl(224 20% 12%)',
      panel: 'hsl(0 0% 100%)',
      panelElevated: 'hsl(220 10% 91%)',
      muted: 'hsl(220 10% 92%)',
      mutedForeground: 'hsl(220 9% 35%)',
      border: 'hsl(220 12% 84%)',
      input: 'hsl(220 12% 84%)',
      accent: 'hsl(231 100% 97%)',
      accentForeground: 'hsl(234 48% 30%)'
    },
    dark: {
      background: 'hsl(220 9% 8%)',
      foreground: 'hsl(210 20% 96%)',
      panel: 'hsl(220 9% 12%)',
      panelElevated: 'hsl(220 8% 16%)',
      muted: 'hsl(220 8% 15%)',
      mutedForeground: 'hsl(220 8% 68%)',
      border: 'hsl(220 8% 18%)',
      input: 'hsl(220 8% 18%)',
      accent: 'hsl(232 24% 20%)',
      accentForeground: 'hsl(210 20% 96%)'
    }
  },
  {
    id: 'citrus',
    labels: {
      en: 'Citrus',
      'zh-CN': '柑橘'
    },
    descriptions: {
      en: 'Bright, lively, and still restrained',
      'zh-CN': '更活泼，但仍然克制清爽'
    },
    preview: {
      shell: '#FFFBEB',
      sidebar: '#FDE68A',
      accent: '#EA580C'
    },
    light: {
      background: 'hsl(32 100% 97%)',
      foreground: 'hsl(22 38% 16%)',
      panel: 'hsl(0 0% 100%)',
      panelElevated: 'hsl(35 100% 93%)',
      muted: 'hsl(34 100% 94%)',
      mutedForeground: 'hsl(25 24% 40%)',
      border: 'hsl(35 65% 86%)',
      input: 'hsl(35 65% 86%)',
      accent: 'hsl(40 100% 90%)',
      accentForeground: 'hsl(26 56% 20%)'
    },
    dark: {
      background: 'hsl(25 18% 10%)',
      foreground: 'hsl(32 100% 96%)',
      panel: 'hsl(24 18% 13%)',
      panelElevated: 'hsl(24 17% 18%)',
      muted: 'hsl(24 15% 18%)',
      mutedForeground: 'hsl(31 22% 74%)',
      border: 'hsl(24 14% 21%)',
      input: 'hsl(24 14% 21%)',
      accent: 'hsl(25 28% 20%)',
      accentForeground: 'hsl(32 100% 96%)'
    }
  },
  {
    id: 'pixel',
    labels: {
      en: 'Pixel',
      'zh-CN': '像素'
    },
    descriptions: {
      en: 'Hard edges, punchy contrast, retro rhythm',
      'zh-CN': '硬边、强对比、像素复古节奏'
    },
    preview: {
      shell: '#FEF3C7',
      sidebar: '#FDE047',
      accent: '#E11D48'
    },
    light: {
      background: 'hsl(48 100% 92%)',
      foreground: 'hsl(219 43% 12%)',
      panel: 'hsl(53 100% 98%)',
      panelElevated: 'hsl(48 94% 78%)',
      muted: 'hsl(48 86% 82%)',
      mutedForeground: 'hsl(224 17% 27%)',
      border: 'hsl(42 71% 35%)',
      input: 'hsl(42 71% 35%)',
      accent: 'hsl(351 84% 88%)',
      accentForeground: 'hsl(345 81% 24%)'
    },
    dark: {
      background: 'hsl(230 23% 12%)',
      foreground: 'hsl(51 100% 92%)',
      panel: 'hsl(230 23% 16%)',
      panelElevated: 'hsl(224 28% 20%)',
      muted: 'hsl(224 28% 18%)',
      mutedForeground: 'hsl(44 33% 73%)',
      border: 'hsl(43 60% 55%)',
      input: 'hsl(43 60% 55%)',
      accent: 'hsl(351 63% 24%)',
      accentForeground: 'hsl(51 100% 92%)'
    }
  },
  {
    id: 'tape',
    labels: {
      en: 'Tape',
      'zh-CN': '磁带'
    },
    descriptions: {
      en: 'Warm studio tones with darker rails',
      'zh-CN': '偏暖录音室质感，沉稳但不厚重'
    },
    preview: {
      shell: '#FAF5EF',
      sidebar: '#E7DDD4',
      accent: '#7C3AED'
    },
    light: {
      background: 'hsl(24 24% 95%)',
      foreground: 'hsl(16 22% 18%)',
      panel: 'hsl(28 24% 98%)',
      panelElevated: 'hsl(26 20% 90%)',
      muted: 'hsl(26 18% 91%)',
      mutedForeground: 'hsl(18 10% 39%)',
      border: 'hsl(25 12% 82%)',
      input: 'hsl(25 12% 82%)',
      accent: 'hsl(274 80% 95%)',
      accentForeground: 'hsl(274 44% 28%)'
    },
    dark: {
      background: 'hsl(18 10% 11%)',
      foreground: 'hsl(26 26% 94%)',
      panel: 'hsl(18 12% 15%)',
      panelElevated: 'hsl(18 10% 18%)',
      muted: 'hsl(18 10% 18%)',
      mutedForeground: 'hsl(24 10% 70%)',
      border: 'hsl(18 9% 22%)',
      input: 'hsl(18 9% 22%)',
      accent: 'hsl(274 32% 22%)',
      accentForeground: 'hsl(26 26% 94%)'
    }
  },
  {
    id: 'teal',
    labels: {
      en: 'Tide',
      'zh-CN': '转潮'
    },
    descriptions: {
      en: 'A 2026 transformative teal axis with quiet blue-green surfaces and warm pulses',
      'zh-CN': '以 2026 转化青为主轴，蓝绿降噪，暖色只做脉冲'
    },
    preview: {
      shell: '#F2FBF8',
      sidebar: '#CDEFE6',
      accent: '#006B67'
    },
    light: {
      background: 'hsl(160 53% 97%)',
      foreground: 'hsl(198 48% 12%)',
      panel: 'hsl(0 0% 100%)',
      panelElevated: 'hsl(166 38% 91%)',
      muted: 'hsl(166 34% 92%)',
      mutedForeground: 'hsl(187 18% 37%)',
      border: 'hsl(166 30% 82%)',
      input: 'hsl(166 30% 82%)',
      accent: 'hsl(172 54% 90%)',
      accentForeground: 'hsl(178 80% 19%)'
    },
    dark: {
      background: 'hsl(180 59% 7%)',
      foreground: 'hsl(160 36% 94%)',
      panel: 'hsl(178 41% 11%)',
      panelElevated: 'hsl(178 28% 16%)',
      muted: 'hsl(178 28% 16%)',
      mutedForeground: 'hsl(169 18% 70%)',
      border: 'hsl(178 22% 21%)',
      input: 'hsl(178 22% 21%)',
      accent: 'hsl(178 45% 18%)',
      accentForeground: 'hsl(160 52% 94%)'
    }
  },
  {
    id: 'cloud',
    labels: {
      en: 'Cloud',
      'zh-CN': '云白'
    },
    descriptions: {
      en: 'Warm off-white surfaces, smoky blue accents, and low-contrast shadows',
      'zh-CN': '暖白底色搭配烟蓝和低对比阴影'
    },
    preview: {
      shell: '#F0EEE9',
      sidebar: '#E7E2D9',
      accent: '#4E6E81'
    },
    light: {
      background: 'hsl(43 19% 93%)',
      foreground: 'hsl(220 16% 16%)',
      panel: 'hsl(40 28% 98%)',
      panelElevated: 'hsl(42 18% 89%)',
      muted: 'hsl(45 16% 90%)',
      mutedForeground: 'hsl(220 7% 42%)',
      border: 'hsl(39 13% 80%)',
      input: 'hsl(39 13% 80%)',
      accent: 'hsl(204 28% 88%)',
      accentForeground: 'hsl(202 37% 25%)'
    },
    dark: {
      background: 'hsl(40 5% 9%)',
      foreground: 'hsl(42 28% 93%)',
      panel: 'hsl(40 6% 13%)',
      panelElevated: 'hsl(40 5% 18%)',
      muted: 'hsl(40 5% 18%)',
      mutedForeground: 'hsl(42 10% 70%)',
      border: 'hsl(40 5% 22%)',
      input: 'hsl(40 5% 22%)',
      accent: 'hsl(202 20% 24%)',
      accentForeground: 'hsl(42 28% 93%)'
    }
  },
  {
    id: 'damson',
    labels: {
      en: 'Damson',
      'zh-CN': '梅影'
    },
    descriptions: {
      en: 'Deep plum, gold, and teal for a richer dark-leaning interface',
      'zh-CN': '梅紫深色轴配金色和青绿，适合夜间高质感界面'
    },
    preview: {
      shell: '#FBF4F5',
      sidebar: '#EAD8DD',
      accent: '#64223C'
    },
    light: {
      background: 'hsl(351 47% 97%)',
      foreground: 'hsl(335 32% 15%)',
      panel: 'hsl(0 0% 100%)',
      panelElevated: 'hsl(344 28% 91%)',
      muted: 'hsl(344 25% 92%)',
      mutedForeground: 'hsl(338 12% 39%)',
      border: 'hsl(343 20% 82%)',
      input: 'hsl(343 20% 82%)',
      accent: 'hsl(337 38% 89%)',
      accentForeground: 'hsl(336 49% 26%)'
    },
    dark: {
      background: 'hsl(332 29% 9%)',
      foreground: 'hsl(345 33% 94%)',
      panel: 'hsl(334 25% 13%)',
      panelElevated: 'hsl(334 20% 18%)',
      muted: 'hsl(334 20% 18%)',
      mutedForeground: 'hsl(342 14% 70%)',
      border: 'hsl(334 17% 23%)',
      input: 'hsl(334 17% 23%)',
      accent: 'hsl(336 32% 22%)',
      accentForeground: 'hsl(345 34% 94%)'
    }
  },
  {
    id: 'fuchsia',
    labels: {
      en: 'Fuchsia',
      'zh-CN': '电莓'
    },
    descriptions: {
      en: 'Electric pink, blue aura, and mint flashes with restrained whitespace',
      'zh-CN': '电光洋红、蓝色气场和薄荷绿，明亮但留白克制'
    },
    preview: {
      shell: '#F8F6FF',
      sidebar: '#DCE8F7',
      accent: '#D4148E'
    },
    light: {
      background: 'hsl(253 100% 98%)',
      foreground: 'hsl(244 32% 14%)',
      panel: 'hsl(0 0% 100%)',
      panelElevated: 'hsl(225 52% 94%)',
      muted: 'hsl(225 40% 95%)',
      mutedForeground: 'hsl(237 12% 40%)',
      border: 'hsl(230 32% 86%)',
      input: 'hsl(230 32% 86%)',
      accent: 'hsl(322 74% 92%)',
      accentForeground: 'hsl(322 70% 31%)'
    },
    dark: {
      background: 'hsl(244 33% 9%)',
      foreground: 'hsl(240 35% 96%)',
      panel: 'hsl(246 28% 13%)',
      panelElevated: 'hsl(244 24% 18%)',
      muted: 'hsl(244 24% 18%)',
      mutedForeground: 'hsl(239 17% 72%)',
      border: 'hsl(244 20% 23%)',
      input: 'hsl(244 20% 23%)',
      accent: 'hsl(322 42% 22%)',
      accentForeground: 'hsl(240 35% 96%)'
    }
  },
  {
    id: 'cobalt',
    labels: {
      en: 'Cobalt',
      'zh-CN': '钴蓝'
    },
    descriptions: {
      en: 'Clean cobalt with cyan and warm yellow for focused work surfaces',
      'zh-CN': '干净钴蓝配青色和暖黄，适合高效率工作界面'
    },
    preview: {
      shell: '#F3F7FF',
      sidebar: '#D9E7FF',
      accent: '#2557D6'
    },
    light: {
      background: 'hsl(220 100% 98%)',
      foreground: 'hsl(224 40% 14%)',
      panel: 'hsl(0 0% 100%)',
      panelElevated: 'hsl(218 52% 93%)',
      muted: 'hsl(218 40% 94%)',
      mutedForeground: 'hsl(224 14% 40%)',
      border: 'hsl(218 34% 86%)',
      input: 'hsl(218 34% 86%)',
      accent: 'hsl(223 71% 94%)',
      accentForeground: 'hsl(223 63% 28%)'
    },
    dark: {
      background: 'hsl(225 44% 8%)',
      foreground: 'hsl(220 35% 96%)',
      panel: 'hsl(224 38% 12%)',
      panelElevated: 'hsl(225 30% 17%)',
      muted: 'hsl(225 28% 17%)',
      mutedForeground: 'hsl(220 17% 72%)',
      border: 'hsl(225 25% 23%)',
      input: 'hsl(225 25% 23%)',
      accent: 'hsl(223 44% 22%)',
      accentForeground: 'hsl(220 35% 96%)'
    }
  },
  {
    id: 'terracotta',
    labels: {
      en: 'Terracotta',
      'zh-CN': '陶土'
    },
    descriptions: {
      en: 'Clay red, wood warmth, and teal signals for a grounded retro tone',
      'zh-CN': '陶土橙红和木质暖底，复古但不会发闷'
    },
    preview: {
      shell: '#FFF5ED',
      sidebar: '#F3D1BE',
      accent: '#B84A2D'
    },
    light: {
      background: 'hsl(27 100% 96%)',
      foreground: 'hsl(16 35% 16%)',
      panel: 'hsl(0 0% 100%)',
      panelElevated: 'hsl(22 55% 90%)',
      muted: 'hsl(24 42% 91%)',
      mutedForeground: 'hsl(17 18% 39%)',
      border: 'hsl(22 35% 82%)',
      input: 'hsl(22 35% 82%)',
      accent: 'hsl(13 54% 90%)',
      accentForeground: 'hsl(13 61% 28%)'
    },
    dark: {
      background: 'hsl(16 35% 8%)',
      foreground: 'hsl(28 46% 94%)',
      panel: 'hsl(16 29% 12%)',
      panelElevated: 'hsl(16 24% 17%)',
      muted: 'hsl(16 24% 17%)',
      mutedForeground: 'hsl(24 16% 70%)',
      border: 'hsl(16 20% 22%)',
      input: 'hsl(16 20% 22%)',
      accent: 'hsl(13 35% 22%)',
      accentForeground: 'hsl(28 46% 94%)'
    }
  },
  {
    id: 'lavender',
    labels: {
      en: 'Lavender',
      'zh-CN': '薰衣草'
    },
    descriptions: {
      en: 'Soft violet, blue-pink, and teal notes with a gentle signature',
      'zh-CN': '浅紫、蓝粉和青绿轻轻混合，柔和但有记忆点'
    },
    preview: {
      shell: '#FAF7FF',
      sidebar: '#E7DBFF',
      accent: '#7C5CFF'
    },
    light: {
      background: 'hsl(262 100% 98%)',
      foreground: 'hsl(258 34% 14%)',
      panel: 'hsl(0 0% 100%)',
      panelElevated: 'hsl(260 60% 94%)',
      muted: 'hsl(260 42% 95%)',
      mutedForeground: 'hsl(258 12% 42%)',
      border: 'hsl(260 32% 86%)',
      input: 'hsl(260 32% 86%)',
      accent: 'hsl(252 100% 94%)',
      accentForeground: 'hsl(252 68% 34%)'
    },
    dark: {
      background: 'hsl(260 35% 9%)',
      foreground: 'hsl(262 45% 96%)',
      panel: 'hsl(260 30% 13%)',
      panelElevated: 'hsl(260 24% 18%)',
      muted: 'hsl(260 24% 18%)',
      mutedForeground: 'hsl(260 17% 72%)',
      border: 'hsl(260 20% 23%)',
      input: 'hsl(260 20% 23%)',
      accent: 'hsl(252 42% 24%)',
      accentForeground: 'hsl(262 45% 96%)'
    }
  },
  {
    id: 'nocturne',
    labels: {
      en: 'Nocturne',
      'zh-CN': '夜曲'
    },
    descriptions: {
      en: 'Deep blue-black with amber signals for a calmer night interface',
      'zh-CN': '深蓝黑配琥珀信号，夜间模式更沉静利落'
    },
    preview: {
      shell: '#F5F7FB',
      sidebar: '#D8DEF0',
      accent: '#0F172A'
    },
    light: {
      background: 'hsl(220 43% 97%)',
      foreground: 'hsl(222 47% 11%)',
      panel: 'hsl(0 0% 100%)',
      panelElevated: 'hsl(225 28% 91%)',
      muted: 'hsl(225 24% 92%)',
      mutedForeground: 'hsl(222 13% 39%)',
      border: 'hsl(225 20% 84%)',
      input: 'hsl(225 20% 84%)',
      accent: 'hsl(38 85% 90%)',
      accentForeground: 'hsl(222 47% 11%)'
    },
    dark: {
      background: 'hsl(222 47% 7%)',
      foreground: 'hsl(44 45% 93%)',
      panel: 'hsl(222 36% 11%)',
      panelElevated: 'hsl(222 28% 16%)',
      muted: 'hsl(222 28% 16%)',
      mutedForeground: 'hsl(222 13% 72%)',
      border: 'hsl(222 22% 20%)',
      input: 'hsl(222 22% 20%)',
      accent: 'hsl(38 62% 22%)',
      accentForeground: 'hsl(44 45% 93%)'
    }
  }
]

export const ACCENT_SWATCHES = [
  { id: 'blue', value: '#2563eb', labels: { en: 'Blue', 'zh-CN': '蓝色' } },
  { id: 'indigo', value: '#4f46e5', labels: { en: 'Indigo', 'zh-CN': '靛蓝' } },
  { id: 'violet', value: '#7c3aed', labels: { en: 'Violet', 'zh-CN': '紫色' } },
  { id: 'rose', value: '#db2777', labels: { en: 'Rose', 'zh-CN': '玫红' } },
  { id: 'red', value: '#e11d48', labels: { en: 'Red', 'zh-CN': '红色' } },
  { id: 'orange', value: '#ea580c', labels: { en: 'Orange', 'zh-CN': '橙色' } },
  { id: 'amber', value: '#d97706', labels: { en: 'Amber', 'zh-CN': '琥珀' } },
  { id: 'teal', value: '#0f766e', labels: { en: 'Teal', 'zh-CN': '青绿' } }
] as const

export const SETTINGS_CHANNELS = {
  get: 'settings:get',
  update: 'settings:update',
  showWindow: 'settings:show-window',
  hideWindow: 'settings:hide-window',
  openLogDirectory: 'settings:open-log-directory',
  systemProxyInfo: 'settings:system-proxy-info',
  testProxy: 'settings:test-proxy',
  updated: 'settings:updated',
  navigate: 'settings:navigate',
  appInfo: 'app:info',
  checkUpdates: 'app:check-updates',
  installUpdate: 'app:install-update',
  updateStatus: 'app:update-status',
  openExternal: 'app:open-external',
  listFontFamilies: 'system:list-font-families',
  fontFamiliesUpdated: 'system:font-families-updated'
} as const

export function resolveThemePack(id?: string): ThemePack {
  return (
    THEME_PACKS.find((pack) => pack.id === id) ??
    THEME_PACKS.find((pack) => pack.id === DEFAULT_APPEARANCE_CONFIG.themePackId) ??
    THEME_PACKS[0]
  )
}

export function isSupportedLanguage(value: unknown): value is SupportedLanguage {
  return value === 'en' || value === 'zh-CN'
}

export function isSettingsTabId(value: unknown): value is SettingsTabId {
  return value === 'general' || value === 'appearance' || value === 'about'
}

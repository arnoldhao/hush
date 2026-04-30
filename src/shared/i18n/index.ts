import type { SupportedLanguage } from '../settings'
import { en } from './locales/en'
import { zhCN } from './locales/zh-CN'
import type { TextBundle } from './types'

export type { TextBundle } from './types'

export const DEFAULT_LANGUAGE: SupportedLanguage = 'en'

export const LOCALE_BUNDLES = {
  en,
  'zh-CN': zhCN
} satisfies Record<SupportedLanguage, TextBundle>

export function getText(language?: string | null): TextBundle {
  return LOCALE_BUNDLES[normalizeLanguage(language)]
}

export function normalizeLanguage(language?: string | null): SupportedLanguage {
  return language === 'zh-CN' || language === 'en' ? language : DEFAULT_LANGUAGE
}

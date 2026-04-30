import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'fs'
import type { Dirent } from 'fs'
import { open, readdir, writeFile } from 'fs/promises'
import type { FileHandle } from 'fs/promises'
import { dirname, extname, join } from 'path'

import type { FontFamiliesSnapshot } from '../shared/settings'

const FONT_CACHE_VERSION = 1
const FONT_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const MAX_FONT_FILE_SIZE_BYTES = 100 << 20
const MAX_NAME_TABLE_SIZE_BYTES = 4 << 20
const FONT_EXTENSIONS = new Set(['.ttf', '.otf', '.ttc', '.otc'])
const NAME_ID_FAMILY = 1
const NAME_ID_FULL = 4
const NAME_ID_POSTSCRIPT = 6
const NAME_ID_TYPOGRAPHIC_FAMILY = 16
const NAME_ID_WWS_FAMILY = 21
const FALLBACK_FONT_FAMILIES = [
  'Arial',
  'Helvetica Neue',
  'PingFang SC',
  'Microsoft YaHei',
  'Noto Sans CJK SC',
  'Inter',
  'SF Pro Text',
  'Segoe UI'
]

interface FontCacheFile {
  version: number
  platform: NodeJS.Platform
  updatedAt: string
  families: string[]
}

type FontFamiliesUpdatedCallback = (snapshot: FontFamiliesSnapshot) => void

export class SystemFontService {
  private cacheLoaded = false
  private cacheUpdatedAt = 0
  private cachedFontFamilies: string[] = []
  private refreshPromise: Promise<void> | null = null

  constructor(private readonly onUpdated: FontFamiliesUpdatedCallback = () => undefined) {}

  async getFontFamilies(): Promise<FontFamiliesSnapshot> {
    const cached = this.getCachedFontFamilies()
    const shouldRefresh = cached.length === 0 || this.isCacheStale()
    if (shouldRefresh) {
      void this.warmUp()
    }

    if (cached.length > 0) {
      return {
        families: cached,
        refreshing: Boolean(this.refreshPromise),
        source: 'cache'
      }
    }

    return {
      families: [...FALLBACK_FONT_FAMILIES],
      refreshing: Boolean(this.refreshPromise),
      source: 'fallback'
    }
  }

  warmUp(): Promise<void> {
    if (this.refreshPromise) {
      return this.refreshPromise
    }

    this.refreshPromise = scanFontFamilies()
      .then((families) => {
        const normalized = normalizeFontFamilies(families)
        if (normalized.length > 0) {
          this.cacheLoaded = true
          this.cacheUpdatedAt = Date.now()
          this.cachedFontFamilies = normalized
          void this.writeCacheFile(normalized)
        }
        this.onUpdated(this.createSnapshot('scan', false))
      })
      .catch(() => {
        this.onUpdated(
          this.createSnapshot(this.cachedFontFamilies.length > 0 ? 'cache' : 'fallback', false)
        )
      })
      .finally(() => {
        this.refreshPromise = null
      })

    return this.refreshPromise
  }

  private getCachedFontFamilies(): string[] {
    if (!this.cacheLoaded) {
      this.loadCacheFile()
    }
    return [...this.cachedFontFamilies]
  }

  private isCacheStale(): boolean {
    return this.cacheUpdatedAt <= 0 || Date.now() - this.cacheUpdatedAt > FONT_CACHE_MAX_AGE_MS
  }

  private createSnapshot(
    source: FontFamiliesSnapshot['source'],
    refreshing: boolean
  ): FontFamiliesSnapshot {
    const cached = this.getCachedFontFamilies()
    return {
      families: cached.length > 0 ? cached : [...FALLBACK_FONT_FAMILIES],
      refreshing,
      source: cached.length > 0 ? source : 'fallback'
    }
  }

  private loadCacheFile(): void {
    this.cacheLoaded = true
    const cachePath = fontCachePath()
    if (!existsSync(cachePath)) {
      return
    }

    try {
      const raw = JSON.parse(readFileSync(cachePath, 'utf8')) as Partial<FontCacheFile>
      if (raw.version !== FONT_CACHE_VERSION || raw.platform !== process.platform) {
        return
      }
      const families = normalizeFontFamilies(raw.families)
      if (families.length === 0) {
        return
      }
      this.cachedFontFamilies = families
      this.cacheUpdatedAt = Date.parse(String(raw.updatedAt ?? '')) || 0
    } catch {
      this.cachedFontFamilies = []
      this.cacheUpdatedAt = 0
    }
  }

  private async writeCacheFile(families: string[]): Promise<void> {
    const cachePath = fontCachePath()
    const payload: FontCacheFile = {
      version: FONT_CACHE_VERSION,
      platform: process.platform,
      updatedAt: new Date(this.cacheUpdatedAt || Date.now()).toISOString(),
      families
    }

    try {
      mkdirSync(dirname(cachePath), { recursive: true })
      await writeFile(cachePath, `${JSON.stringify(payload)}\n`, 'utf8')
    } catch {
      // Font cache is only a performance hint; failing to persist it should not affect settings.
    }
  }
}

async function scanFontFamilies(): Promise<string[]> {
  const families = new Map<string, string>()
  const files = await collectFontFiles()
  let scanned = 0

  for (const filePath of files) {
    for (const family of await fontFamiliesFromFile(filePath)) {
      if (family.startsWith('.')) {
        continue
      }
      const key = normalizeFontFamilyKey(family)
      if (key && !families.has(key)) {
        families.set(key, family)
      }
    }

    scanned += 1
    if (scanned % 20 === 0) {
      await yieldToEventLoop()
    }
  }

  return [...families.values()].sort((left, right) => left.localeCompare(right))
}

async function collectFontFiles(): Promise<string[]> {
  const files: string[] = []
  for (const directory of fontDirectories()) {
    await walkFontDirectory(directory, files)
  }
  return files
}

async function walkFontDirectory(directory: string, files: string[]): Promise<void> {
  if (!directory.trim()) {
    return
  }

  let entries: Dirent[]
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of entries) {
    const fullPath = join(directory, entry.name)
    if (entry.isDirectory()) {
      await walkFontDirectory(fullPath, files)
      continue
    }
    if (entry.isFile() && FONT_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      files.push(fullPath)
    }
  }
}

function fontDirectories(): string[] {
  const home = process.env.HOME || process.env.USERPROFILE || ''

  if (process.platform === 'darwin') {
    return [
      '/System/Library/Fonts',
      ...darwinSystemFontAssetDirectories('/System/Library/AssetsV2'),
      '/Library/Fonts',
      home ? join(home, 'Library/Fonts') : ''
    ].filter(Boolean)
  }

  if (process.platform === 'win32') {
    return [
      process.env.WINDIR ? join(process.env.WINDIR, 'Fonts') : 'C:\\Windows\\Fonts',
      process.env.LOCALAPPDATA
        ? join(process.env.LOCALAPPDATA, 'Microsoft', 'Windows', 'Fonts')
        : ''
    ].filter(Boolean)
  }

  return [
    '/usr/share/fonts',
    '/usr/local/share/fonts',
    home ? join(home, '.fonts') : '',
    home ? join(home, '.local/share/fonts') : ''
  ].filter(Boolean)
}

function darwinSystemFontAssetDirectories(base: string): string[] {
  let entries: Dirent[]
  try {
    entries = readdirSync(base, { withFileTypes: true })
  } catch {
    return []
  }

  return entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('com_apple_MobileAsset_Font'))
    .map((entry) => join(base, entry.name))
    .sort((left, right) => left.localeCompare(right))
}

async function fontFamiliesFromFile(filePath: string): Promise<string[]> {
  let handle: FileHandle | null = null
  try {
    handle = await open(filePath, 'r')
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_FONT_FILE_SIZE_BYTES) {
      return []
    }

    const header = await readFileSlice(handle, 0, 12, stat.size)
    if (header.length < 12) {
      return []
    }

    if (header.subarray(0, 4).toString('ascii') === 'ttcf') {
      return await fontCollectionFamiliesFromFile(handle, stat.size, header)
    }

    const family = await fontFamilyAtFileOffset(handle, stat.size, 0)
    return family ? [family] : []
  } catch {
    return []
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function fontCollectionFamiliesFromFile(
  handle: FileHandle,
  fileSize: number,
  header: Buffer
): Promise<string[]> {
  const count = readUInt32(header, 8)
  if (!count || count > 2048 || fileSize < 12 + count * 4) {
    return []
  }

  const offsets = await readFileSlice(handle, 12, count * 4, fileSize)
  const families: string[] = []
  const seen = new Set<string>()
  for (let index = 0; index < count; index += 1) {
    const offset = readUInt32(offsets, index * 4)
    const family = await fontFamilyAtFileOffset(handle, fileSize, offset)
    const key = normalizeFontFamilyKey(family)
    if (family && key && !seen.has(key)) {
      seen.add(key)
      families.push(family)
    }
  }
  return families
}

async function fontFamilyAtFileOffset(
  handle: FileHandle,
  fileSize: number,
  fontOffset: number
): Promise<string> {
  if (fontOffset < 0 || fontOffset + 12 > fileSize) {
    return ''
  }

  const header = await readFileSlice(handle, fontOffset, 12, fileSize)
  const tableCount = readUInt16(header, 4)
  if (!tableCount || tableCount > 4096) {
    return ''
  }

  const records = await readFileSlice(handle, fontOffset + 12, tableCount * 16, fileSize)
  if (records.length < tableCount * 16) {
    return ''
  }

  let nameTableOffset = 0
  let nameTableLength = 0
  for (let index = 0; index < tableCount; index += 1) {
    const recordOffset = index * 16
    const tag = records.subarray(recordOffset, recordOffset + 4).toString('ascii')
    if (tag === 'name') {
      nameTableOffset = readUInt32(records, recordOffset + 8)
      nameTableLength = readUInt32(records, recordOffset + 12)
      break
    }
  }

  if (
    !nameTableOffset ||
    !nameTableLength ||
    nameTableLength > MAX_NAME_TABLE_SIZE_BYTES ||
    nameTableOffset + nameTableLength > fileSize
  ) {
    return ''
  }

  const nameTable = await readFileSlice(handle, nameTableOffset, nameTableLength, fileSize)
  const names = readNameTable(nameTable, 0, nameTable.length)
  return resolveCatalogFontFamily(
    names.get(NAME_ID_TYPOGRAPHIC_FAMILY) ?? '',
    names.get(NAME_ID_WWS_FAMILY) ?? '',
    names.get(NAME_ID_FAMILY) ?? '',
    names.get(NAME_ID_FULL) ?? '',
    names.get(NAME_ID_POSTSCRIPT) ?? ''
  )
}

function readNameTable(
  data: Buffer,
  tableOffset: number,
  tableLength: number
): Map<number, string> {
  const names = new Map<number, { preferred?: string; unicode?: string; fallback?: string }>()
  if (tableLength < 6) {
    return new Map()
  }

  const count = readUInt16(data, tableOffset + 2)
  const stringStorageOffset = tableOffset + readUInt16(data, tableOffset + 4)
  for (let index = 0; index < count; index += 1) {
    const recordOffset = tableOffset + 6 + index * 12
    if (recordOffset + 12 > tableOffset + tableLength) {
      break
    }

    const platformId = readUInt16(data, recordOffset)
    const encodingId = readUInt16(data, recordOffset + 2)
    const languageId = readUInt16(data, recordOffset + 4)
    if (platformId === 1 && languageId !== 0) {
      continue
    }
    const nameId = readUInt16(data, recordOffset + 6)
    const length = readUInt16(data, recordOffset + 8)
    const offset = readUInt16(data, recordOffset + 10)
    const valueOffset = stringStorageOffset + offset
    if (valueOffset < tableOffset || valueOffset + length > tableOffset + tableLength) {
      continue
    }

    const raw = data.subarray(valueOffset, valueOffset + length)
    const value = cleanFontName(decodeFontName(raw, platformId, encodingId))
    if (!value || isHiddenCatalogFontFamily(value)) {
      continue
    }

    const current = names.get(nameId) ?? {}
    if (isPreferredLanguage(platformId, languageId)) {
      current.preferred ??= value
    }
    if (platformId === 0 || platformId === 3) {
      current.unicode ??= value
    }
    current.fallback ??= value
    names.set(nameId, current)
  }

  return new Map(
    [...names.entries()]
      .map(
        ([nameId, value]) =>
          [nameId, value.preferred || value.unicode || value.fallback || ''] as const
      )
      .filter(([, value]) => Boolean(value))
  )
}

function decodeFontName(data: Buffer, platformId: number, encodingId: number): string {
  if (platformId === 0 || platformId === 3 || (platformId === 2 && encodingId === 1)) {
    return decodeUtf16BE(data)
  }
  return data.toString('latin1')
}

function decodeUtf16BE(data: Buffer): string {
  const values: number[] = []
  for (let index = 0; index + 1 < data.length; index += 2) {
    values.push(data.readUInt16BE(index))
  }
  let result = ''
  for (let index = 0; index < values.length; index += 8192) {
    result += String.fromCharCode(...values.slice(index, index + 8192))
  }
  return result
}

function isPreferredLanguage(platformId: number, languageId: number): boolean {
  return (
    platformId === 0 ||
    (platformId === 1 && languageId === 0) ||
    (platformId === 3 && (languageId === 0x0409 || (languageId & 0xff) === 0x09))
  )
}

function resolveCatalogFontFamily(
  typographicFamily: string,
  wwsFamily: string,
  legacyFamily: string,
  fullName: string,
  postScript: string
): string {
  if (isHiddenCatalogFontFamily(legacyFamily) || isHiddenCatalogFontFamily(wwsFamily)) {
    return ''
  }
  return firstPublicCatalogFontFamily(
    legacyFamily,
    wwsFamily,
    typographicFamily,
    fullName,
    postScript
  )
}

function firstPublicCatalogFontFamily(...values: string[]): string {
  for (const value of values) {
    const trimmed = cleanFontName(value)
    if (trimmed && !isHiddenCatalogFontFamily(trimmed)) {
      return trimmed
    }
  }
  return ''
}

function normalizeFontFamilies(fonts: unknown): string[] {
  if (!Array.isArray(fonts)) {
    return []
  }
  return [...new Set(fonts.map((font) => cleanFontName(String(font ?? ''))).filter(Boolean))].sort(
    (left, right) => left.localeCompare(right)
  )
}

function isHiddenCatalogFontFamily(value: string): boolean {
  return value.trim().startsWith('.')
}

function normalizeFontFamilyKey(value: string): string {
  return cleanFontName(value).replace(/[-_]/g, ' ').split(/\s+/).join(' ').toLowerCase()
}

function cleanFontName(value: string): string {
  return value.replace(/\0/g, '').replace(/\s+/g, ' ').trim()
}

async function readFileSlice(
  handle: FileHandle,
  position: number,
  length: number,
  fileSize: number
): Promise<Buffer> {
  if (position < 0 || length <= 0 || position >= fileSize) {
    return Buffer.alloc(0)
  }

  const safeLength = Math.min(length, fileSize - position)
  const buffer = Buffer.alloc(safeLength)
  const result = await handle.read(buffer, 0, safeLength, position)
  return buffer.subarray(0, result.bytesRead)
}

function readUInt16(data: Buffer, offset: number): number {
  return offset >= 0 && offset + 2 <= data.length ? data.readUInt16BE(offset) : 0
}

function readUInt32(data: Buffer, offset: number): number {
  return offset >= 0 && offset + 4 <= data.length ? data.readUInt32BE(offset) : 0
}

function fontCachePath(): string {
  return join(app.getPath('userData'), 'cache', 'font-families.json')
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve)
  })
}

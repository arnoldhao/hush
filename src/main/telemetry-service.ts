import { app } from 'electron'
import TelemetryDeck from '@telemetrydeck/sdk'
import type ElectronStore from 'electron-store'
import type { Options as ElectronStoreOptions } from 'electron-store'
import { randomUUID, webcrypto } from 'node:crypto'
import { logWarning } from './logger'

declare const __TELEMETRYDECK_APP_ID__: string | undefined

const TELEMETRY_STORE_NAME = 'telemetry'
const FORBIDDEN_PAYLOAD_KEYS = new Set([
  'count',
  'type',
  'appID',
  'clientUser',
  '__time',
  'payload',
  'platform',
  'receivedAt'
])

type ElectronStoreConstructor = new <T extends Record<string, unknown>>(
  options?: ElectronStoreOptions<T>
) => ElectronStore<T>

interface TelemetryStoreShape extends Record<string, unknown> {
  installId: string
  installCreatedAt: string
  launchCount: number
  launchDates: string[]
  completedSessionCount: number
  totalSessionSeconds: number
  previousSessionSeconds?: number
}

interface TelemetryServiceOptions {
  appId: string
  appVersion: string
  getLanguage: () => string
}

interface TrackAppLaunchOptions {
  startMode: 'manual' | 'autostart'
}

type TelemetryDeckPrivateClient = TelemetryDeck & {
  target: string
  _build: (
    type: string,
    payload?: Record<string, unknown>,
    options?: Record<string, unknown>,
    receivedAt?: string
  ) => Promise<Record<string, unknown>>
}

export function resolveTelemetryDeckAppId(): string {
  return typeof __TELEMETRYDECK_APP_ID__ === 'string' ? __TELEMETRYDECK_APP_ID__.trim() : ''
}

export class TelemetryService {
  private readonly appVersion: string
  private readonly getLanguage: () => string
  private readonly startedAt = new Date()
  private readonly pendingSignals = new Set<Promise<unknown>>()
  private launched = false
  private flushed = false

  private constructor(
    private readonly store: ElectronStore<TelemetryStoreShape> | null,
    private readonly client: TelemetryDeckPrivateClient | null,
    options: TelemetryServiceOptions
  ) {
    this.appVersion = options.appVersion.trim()
    this.getLanguage = options.getLanguage
  }

  static async create(options: TelemetryServiceOptions): Promise<TelemetryService> {
    const appId = options.appId.trim()
    if (!appId) {
      return new TelemetryService(null, null, options)
    }

    const Store = await loadElectronStore()
    const store = new Store<TelemetryStoreShape>({
      name: TELEMETRY_STORE_NAME,
      defaults: createDefaultTelemetryState(),
      clearInvalidConfig: true
    })
    const state = sanitizeTelemetryState(store.store)
    store.store = state

    try {
      const client = new TelemetryDeck({
        appID: appId,
        clientUser: state.installId,
        sessionID: randomUUID(),
        testMode: !app.isPackaged || releaseChannel(options.appVersion) === 'dev',
        subtleCrypto: webcrypto.subtle as never
      }) as TelemetryDeckPrivateClient
      return new TelemetryService(store, client, options)
    } catch (error) {
      logWarning('telemetry', 'sdk init failed', error)
      return new TelemetryService(store, null, options)
    }
  }

  enabled(): boolean {
    return this.store !== null && this.client !== null
  }

  async trackAppLaunch(options: TrackAppLaunchOptions): Promise<void> {
    if (!this.enabled() || this.launched) {
      return
    }
    this.launched = true

    const state = this.updateState((current) => {
      const launchDate = localDateKey(new Date())
      return {
        ...current,
        launchCount: current.launchCount + 1,
        launchDates: appendUniqueLaunchDate(current.launchDates, launchDate)
      }
    })
    if (!state) {
      return
    }

    const payload = this.buildPayload(state)
    payload['Hush.App.launchCount'] = state.launchCount
    payload['Hush.App.launchOrdinalBucket'] = bucketLaunchOrdinal(state.launchCount)
    payload['Hush.App.startMode'] = options.startMode
    payload['Hush.App.launchedByAutoStart'] = options.startMode === 'autostart'
    payload['Hush.Install.firstLaunch'] = state.launchCount === 1

    await this.sendTrackedSignal('TelemetryDeck.Session.started', payload)
    if (state.launchCount === 1) {
      await this.sendTrackedSignal('TelemetryDeck.Acquisition.newInstallDetected', payload)
    }
  }

  async flushSessionSummary(): Promise<void> {
    if (!this.enabled() || !this.launched || this.flushed) {
      return
    }
    this.flushed = true

    const durationSeconds = roundSeconds((Date.now() - this.startedAt.getTime()) / 1000)
    const state = this.updateState((current) => ({
      ...current,
      completedSessionCount: current.completedSessionCount + 1,
      totalSessionSeconds: roundSeconds(current.totalSessionSeconds + durationSeconds),
      previousSessionSeconds: durationSeconds
    }))
    if (!state) {
      return
    }

    const payload = this.buildPayload(state)
    payload['TelemetryDeck.Signal.durationInSeconds'] = durationSeconds
    payload['Hush.Session.durationBucket'] = bucketSessionDuration(durationSeconds)

    await this.sendTrackedSignal('Hush.Session.summaryRecorded', payload, durationSeconds)
    await this.waitForPendingSignals(1500)
  }

  private updateState(
    update: (current: TelemetryStoreShape) => TelemetryStoreShape
  ): TelemetryStoreShape | null {
    if (!this.store) {
      return null
    }
    const current = sanitizeTelemetryState(this.store.store)
    const next = sanitizeTelemetryState(update(current))
    this.store.store = next
    return next
  }

  private buildPayload(state: TelemetryStoreShape): Record<string, unknown> {
    const appVersion = normalizeVersion(this.appVersion)
    const buildNumber = buildNumberFromVersion(this.appVersion)
    const platform = normalizedPlatform(process.platform)
    const now = new Date()
    const distinctDaysUsed = Math.max(state.launchDates.length, state.launchCount > 0 ? 1 : 0)
    const distinctDaysUsedLastMonth = Math.max(
      countLaunchDatesSince(state.launchDates, daysAgo(30)),
      state.launchCount > 0 ? 1 : 0
    )
    const completedSessionCount = Math.max(0, state.completedSessionCount)
    const payload: Record<string, unknown> = {
      'TelemetryDeck.AppInfo.version': appVersion,
      'TelemetryDeck.Device.architecture': process.arch,
      'TelemetryDeck.Device.modelName': desktopModelName(process.platform),
      'TelemetryDeck.Device.operatingSystem': platform,
      'TelemetryDeck.Device.platform': platform,
      'TelemetryDeck.Device.timeZone': utcOffsetName(now),
      'TelemetryDeck.RunContext.isDebug':
        !app.isPackaged || releaseChannel(this.appVersion) === 'dev',
      'TelemetryDeck.RunContext.targetEnvironment': 'desktop',
      'TelemetryDeck.Acquisition.firstSessionDate': localDateKey(
        parseDateOrFallback(state.installCreatedAt, now)
      ),
      'TelemetryDeck.Retention.distinctDaysUsed': distinctDaysUsed,
      'TelemetryDeck.Retention.distinctDaysUsedLastMonth': distinctDaysUsedLastMonth,
      'TelemetryDeck.Retention.totalSessionsCount': state.launchCount,
      'Hush.App.version': appVersion,
      'Hush.App.channel': releaseChannel(this.appVersion),
      'Hush.App.isDebugBuild': !app.isPackaged || releaseChannel(this.appVersion) === 'dev',
      'Hush.Platform.os': platform,
      'Hush.Platform.arch': process.arch,
      'Hush.Locale.timeZone': timeZoneName(),
      'Hush.Install.ageBucket': bucketInstallAge(
        now.getTime() - parseDateOrFallback(state.installCreatedAt, now).getTime()
      )
    }

    Object.assign(payload, calendarPayload(now))

    if (buildNumber) {
      payload['TelemetryDeck.AppInfo.buildNumber'] = buildNumber
      payload['TelemetryDeck.AppInfo.versionAndBuildNumber'] = `${appVersion} ${buildNumber}`
      payload['Hush.App.buildNumber'] = buildNumber
      payload['Hush.App.versionAndBuildNumber'] = `${appVersion} ${buildNumber}`
    }
    if (completedSessionCount > 0) {
      payload['TelemetryDeck.Retention.averageSessionSeconds'] = roundSeconds(
        state.totalSessionSeconds / completedSessionCount
      )
    }
    if (typeof state.previousSessionSeconds === 'number') {
      payload['TelemetryDeck.Retention.previousSessionSeconds'] = roundSeconds(
        state.previousSessionSeconds
      )
    }

    const locale = normalizeLocale(this.getLanguage())
    if (locale) {
      payload['TelemetryDeck.RunContext.locale'] = locale
      payload['Hush.Locale.language'] = locale
      const language = primaryLanguage(locale)
      if (language) {
        payload['TelemetryDeck.RunContext.language'] = language
        payload['TelemetryDeck.UserPreference.language'] = language
        payload['Hush.Locale.primaryLanguage'] = language
      }
      const region = regionFromLocale(locale)
      if (region) {
        payload['TelemetryDeck.UserPreference.region'] = region
        payload['Hush.Locale.region'] = region
      }
    }

    return payload
  }

  private sendTrackedSignal(
    type: string,
    payload: Record<string, unknown>,
    floatValue?: number
  ): Promise<void> {
    const pending = this.sendSignal(type, payload, floatValue)
      .catch((error) => {
        logWarning('telemetry', 'signal failed', { type, error })
      })
      .finally(() => {
        this.pendingSignals.delete(pending)
      })
    this.pendingSignals.add(pending)
    return pending
  }

  private async sendSignal(
    type: string,
    payload: Record<string, unknown>,
    floatValue?: number
  ): Promise<void> {
    if (!this.client) {
      return
    }

    const cleanPayload = sanitizedPayload(payload)
    const body = await this.client._build(type, cleanPayload)
    const bodyPayload = isRecord(body.payload) ? body.payload : {}
    body.payload = bodyPayload
    restoreTypedPayloadValues(bodyPayload, cleanPayload)
    appendSdkPayload(body, bodyPayload)
    if (typeof floatValue === 'number' && Number.isFinite(floatValue)) {
      body.floatValue = floatValue
      delete bodyPayload.floatValue
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 1500)
    try {
      const response = await fetch(this.client.target, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8'
        },
        body: JSON.stringify([body]),
        signal: controller.signal
      })
      if (!response.ok) {
        throw new Error(`TelemetryDeck post failed: HTTP ${response.status}`)
      }
    } finally {
      clearTimeout(timeout)
    }
  }

  private async waitForPendingSignals(timeoutMs: number): Promise<void> {
    if (this.pendingSignals.size === 0) {
      return
    }
    await Promise.race([
      Promise.allSettled(Array.from(this.pendingSignals)),
      new Promise((resolve) => setTimeout(resolve, timeoutMs))
    ])
  }
}

async function loadElectronStore(): Promise<ElectronStoreConstructor> {
  const dynamicImport = new Function('specifier', 'return import(specifier)') as (
    specifier: string
  ) => Promise<{ default: ElectronStoreConstructor }>
  const module = await dynamicImport('electron-store')
  return module.default
}

function createDefaultTelemetryState(): TelemetryStoreShape {
  const now = new Date()
  return {
    installId: randomUUID(),
    installCreatedAt: now.toISOString(),
    launchCount: 0,
    launchDates: [],
    completedSessionCount: 0,
    totalSessionSeconds: 0
  }
}

function sanitizeTelemetryState(raw: Partial<TelemetryStoreShape>): TelemetryStoreShape {
  const fallback = createDefaultTelemetryState()
  const installCreatedAt = validIsoDate(raw.installCreatedAt) || fallback.installCreatedAt
  return {
    installId: sanitizeString(raw.installId) || fallback.installId,
    installCreatedAt,
    launchCount: sanitizeNonNegativeInteger(raw.launchCount),
    launchDates: sanitizeLaunchDates(raw.launchDates),
    completedSessionCount: sanitizeNonNegativeInteger(raw.completedSessionCount),
    totalSessionSeconds: sanitizeNonNegativeNumber(raw.totalSessionSeconds),
    previousSessionSeconds:
      typeof raw.previousSessionSeconds === 'number' && Number.isFinite(raw.previousSessionSeconds)
        ? Math.max(0, raw.previousSessionSeconds)
        : undefined
  }
}

function sanitizedPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(payload)) {
    const trimmedKey = key.trim()
    if (!trimmedKey || FORBIDDEN_PAYLOAD_KEYS.has(trimmedKey)) {
      continue
    }
    result[trimmedKey] = value
  }
  return result
}

function restoreTypedPayloadValues(
  bodyPayload: Record<string, unknown>,
  sourcePayload: Record<string, unknown>
): void {
  for (const [key, value] of Object.entries(sourcePayload)) {
    if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) {
      bodyPayload[key] = value
    }
  }
}

function appendSdkPayload(
  body: Record<string, unknown>,
  bodyPayload: Record<string, unknown>
): void {
  const nameAndVersion =
    typeof body.telemetryClientVersion === 'string' ? body.telemetryClientVersion : ''
  if (!nameAndVersion) {
    return
  }
  bodyPayload['TelemetryDeck.SDK.nameAndVersion'] = nameAndVersion
  const [name, version] = nameAndVersion.split(/\s+/, 2)
  if (name) {
    bodyPayload['TelemetryDeck.SDK.name'] = name
  }
  if (version) {
    bodyPayload['TelemetryDeck.SDK.version'] = version
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function sanitizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function sanitizeNonNegativeInteger(value: unknown): number {
  return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : 0
}

function sanitizeNonNegativeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

function sanitizeLaunchDates(value: unknown): string[] {
  const dates = Array.isArray(value) ? value.map(sanitizeString).filter(isDateKey) : []
  return Array.from(new Set(dates)).slice(-400)
}

function validIsoDate(value: unknown): string {
  const date = typeof value === 'string' ? new Date(value) : null
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : ''
}

function parseDateOrFallback(value: string, fallback: Date): Date {
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date : fallback
}

function appendUniqueLaunchDate(dates: string[], value: string): string[] {
  return Array.from(new Set([...dates, value])).slice(-400)
}

function isDateKey(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00`))
}

function localDateKey(value: Date): string {
  const year = value.getFullYear()
  const month = String(value.getMonth() + 1).padStart(2, '0')
  const day = String(value.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000)
}

function countLaunchDatesSince(dates: string[], since: Date): number {
  const sinceDate = new Date(localDateKey(since))
  return dates.filter((date) => Date.parse(`${date}T00:00:00`) >= sinceDate.getTime()).length
}

function buildNumberFromVersion(version: string): string {
  const [, buildNumber] = version.trim().replace(/^v/, '').split('+', 2)
  return buildNumber?.trim() ?? ''
}

function normalizeVersion(version: string): string {
  const trimmed = version.trim()
  if (!trimmed) {
    return 'dev'
  }
  return trimmed.replace(/^v/, '').split('+', 1)[0]?.trim() || 'dev'
}

function normalizeLocale(locale: string): string {
  return locale.trim().replace(/_/g, '-')
}

function primaryLanguage(locale: string): string {
  return normalizeLocale(locale).split('-')[0]?.trim() ?? ''
}

function regionFromLocale(locale: string): string {
  const parts = normalizeLocale(locale)
    .split('-')
    .map((part) => part.trim())
    .filter(Boolean)
  return parts.length > 1 ? (parts[parts.length - 1] ?? '').toUpperCase() : ''
}

function calendarPayload(value: Date): Record<string, unknown> {
  const weekday = value.getDay() === 0 ? 7 : value.getDay()
  return {
    'TelemetryDeck.Calendar.dayOfMonth': value.getDate(),
    'TelemetryDeck.Calendar.dayOfWeek': weekday,
    'TelemetryDeck.Calendar.dayOfYear': dayOfYear(value),
    'TelemetryDeck.Calendar.weekOfYear': isoWeek(value),
    'TelemetryDeck.Calendar.isWeekend': value.getDay() === 0 || value.getDay() === 6,
    'TelemetryDeck.Calendar.monthOfYear': value.getMonth() + 1,
    'TelemetryDeck.Calendar.quarterOfYear': Math.floor(value.getMonth() / 3) + 1,
    'TelemetryDeck.Calendar.hourOfDay': value.getHours() + 1
  }
}

function dayOfYear(value: Date): number {
  const start = new Date(value.getFullYear(), 0, 0)
  return Math.floor((value.getTime() - start.getTime()) / 86400000)
}

function isoWeek(value: Date): number {
  const date = new Date(Date.UTC(value.getFullYear(), value.getMonth(), value.getDate()))
  const dayNumber = date.getUTCDay() || 7
  date.setUTCDate(date.getUTCDate() + 4 - dayNumber)
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1))
  return Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7)
}

function utcOffsetName(value: Date): string {
  const offsetMinutes = -value.getTimezoneOffset()
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const absolute = Math.abs(offsetMinutes)
  const hours = Math.floor(absolute / 60)
  const minutes = absolute % 60
  return minutes === 0
    ? `UTC${sign}${hours}`
    : `UTC${sign}${hours}:${String(minutes).padStart(2, '0')}`
}

function timeZoneName(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || ''
  } catch {
    return ''
  }
}

function normalizedPlatform(value: NodeJS.Platform): string {
  switch (value) {
    case 'darwin':
      return 'macOS'
    case 'win32':
      return 'Windows'
    case 'linux':
      return 'Linux'
    default:
      return value
  }
}

function desktopModelName(value: NodeJS.Platform): string {
  switch (value) {
    case 'darwin':
      return 'Mac'
    case 'win32':
      return 'Windows PC'
    case 'linux':
      return 'Linux PC'
    default:
      return value
  }
}

function releaseChannel(version: string): string {
  const normalized = normalizeVersion(version).toLowerCase()
  if (normalized === 'dev') {
    return 'dev'
  }
  if (normalized.includes('alpha')) {
    return 'alpha'
  }
  if (normalized.includes('beta')) {
    return 'beta'
  }
  if (normalized.includes('rc')) {
    return 'rc'
  }
  return 'stable'
}

function bucketInstallAge(durationMs: number): string {
  const days = Math.max(0, Math.floor(durationMs / 86400000))
  if (days <= 0) {
    return 'day0'
  }
  if (days < 7) {
    return 'day1-6'
  }
  if (days < 30) {
    return 'day7-29'
  }
  if (days < 90) {
    return 'day30-89'
  }
  return 'day90+'
}

function bucketLaunchOrdinal(launchCount: number): string {
  if (launchCount <= 1) {
    return '1'
  }
  if (launchCount <= 3) {
    return '2-3'
  }
  if (launchCount <= 9) {
    return '4-9'
  }
  if (launchCount <= 29) {
    return '10-29'
  }
  return '30+'
}

function bucketSessionDuration(durationSeconds: number): string {
  if (durationSeconds < 60) {
    return 'lt1m'
  }
  if (durationSeconds < 5 * 60) {
    return '1m-5m'
  }
  if (durationSeconds < 15 * 60) {
    return '5m-15m'
  }
  if (durationSeconds < 60 * 60) {
    return '15m-60m'
  }
  return '60m+'
}

function roundSeconds(value: number): number {
  if (!Number.isFinite(value)) {
    return 0
  }
  return Math.round(value * 100) / 100
}

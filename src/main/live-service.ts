import { createHash } from 'crypto'
import { net } from 'electron'

import { AppDatabase } from './database'
import type {
  LiveChannel,
  LiveChannelColumn,
  LiveChannelDraft,
  LiveChannelInput,
  LiveChannelsSnapshot,
  LivePlayerState,
  LivePlayerStatePatch,
  LiveStatus,
  LiveStatusValue
} from '../shared/live'
import { DEFAULT_LIVE_CHANNELS, LIVE_CATALOG_MANIFEST_URL } from '../shared/live-defaults'
import { logWarning } from './logger'

const YOUTUBE_VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/
const LIVE_CATALOG_TIMEOUT_MS = 20_000
const LIVE_STATUS_TIMEOUT_MS = 14_000
const YOUTUBE_METADATA_TIMEOUT_MS = 16_000
const AVATAR_TIMEOUT_MS = 12_000
const MAX_JSON_BYTES = 4 * 1024 * 1024
const MAX_HTML_BYTES = 4 * 1024 * 1024
const MAX_AVATAR_BYTES = 2 * 1024 * 1024
const GOOGLE_IMAGE_HOST_PATTERN = /(^|\.)googleusercontent\.com$|(^|\.)ggpht\.com$/i
const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'

interface LiveCatalogManifest {
  defaultChannel?: string
  hush?: {
    liveChannel?: {
      url?: string
    }
  }
  dreamFm?: {
    liveChannel?: {
      url?: string
    }
  }
  liveChannel?: {
    url?: string
  }
  channels?: Record<
    string,
    {
      hush?: {
        liveChannel?: {
          url?: string
        }
      }
      dreamFm?: {
        liveChannel?: {
          url?: string
        }
      }
      liveChannel?: {
        url?: string
      }
    }
  >
}

interface RemoteLiveCatalog {
  groups?: Array<{
    id?: string
    title?: string
    items?: RemoteLiveCatalogItem[]
  }>
}

interface RemoteLiveCatalogItem {
  id?: string
  group?: string
  videoId?: string
  title?: string
  channel?: string
  description?: string
  durationLabel?: string
  thumbnailUrl?: string
}

interface YouTubeMetadata {
  videoId: string
  title: string
  channel: string
  description: string
  thumbnailUrl: string
  avatarSourceUrl: string
  liveStatus: LiveStatusValue
}

type LiveChannelsChangedCallback = (snapshot: LiveChannelsSnapshot) => void

export class LiveService {
  private avatarRefreshPromise: Promise<void> | null = null
  private catalogRefreshPromise: Promise<LiveChannelsSnapshot> | null = null

  constructor(
    private readonly database: AppDatabase,
    private readonly onChannelsChanged?: LiveChannelsChangedCallback
  ) {}

  initialize(): void {
    this.refreshAvatarsInBackground()
    this.refreshCatalogInBackground()
  }

  async listChannels(): Promise<LiveChannelsSnapshot> {
    const snapshot = this.getChannelsSnapshot()
    this.refreshAvatarsInBackground()
    return snapshot
  }

  async refreshCatalog(): Promise<LiveChannelsSnapshot> {
    if (!this.catalogRefreshPromise) {
      this.catalogRefreshPromise = this.refreshCatalogNow().finally(() => {
        this.catalogRefreshPromise = null
      })
    }
    return this.catalogRefreshPromise
  }

  listColumns(): LiveChannelColumn[] {
    return this.database.listLiveChannelColumns()
  }

  addColumn(title: string): LiveChannelColumn[] {
    return this.database.addCustomLiveChannelColumn(title)
  }

  updateColumn(id: string, title: string): LiveChannelColumn[] {
    return this.database.updateCustomLiveChannelColumn(id, title)
  }

  removeColumn(id: string): LiveChannelColumn[] {
    return this.database.removeCustomLiveChannelColumn(id)
  }

  async previewCustomChannel(rawUrl: string): Promise<LiveChannelDraft> {
    const videoId = extractYouTubeVideoId(rawUrl)
    if (!videoId) {
      throw new Error('Invalid YouTube live link.')
    }
    const existing = this.database.listLiveChannels().find((channel) => channel.videoId === videoId)
    if (existing) {
      return {
        videoId: existing.videoId,
        title: existing.title,
        channel: existing.channel,
        groupTitle: existing.groupTitle,
        description: existing.description,
        durationLabel: existing.durationLabel,
        thumbnailUrl: existing.thumbnailUrl,
        avatarDataUrl: existing.avatarDataUrl
      }
    }

    const metadata = await fetchYouTubeMetadata(videoId)
    if (metadata.liveStatus !== 'live' && metadata.liveStatus !== 'upcoming') {
      throw new Error('This YouTube link is not a live stream.')
    }
    const avatar = await fetchAvatar(metadata.avatarSourceUrl).catch(() => null)

    return {
      videoId,
      title: metadata.title,
      channel: metadata.channel,
      groupTitle: '',
      description: metadata.description,
      durationLabel: metadata.liveStatus === 'upcoming' ? 'UPCOMING' : 'LIVE',
      thumbnailUrl: metadata.thumbnailUrl,
      avatarDataUrl: avatar ? avatarDataUrl(avatar) : ''
    }
  }

  async addCustomChannel(
    rawUrl: string,
    titleOverride = '',
    groupTitle = ''
  ): Promise<LiveChannel> {
    const videoId = extractYouTubeVideoId(rawUrl)
    if (!videoId) {
      throw new Error('Invalid YouTube live link.')
    }
    const existing = this.database.listLiveChannels().find((channel) => channel.videoId === videoId)
    const title = titleOverride.trim()
    const normalizedGroupTitle = groupTitle.trim()
    if (existing) {
      if (existing.source === 'custom' && (title || normalizedGroupTitle !== existing.groupTitle)) {
        return this.database.updateCustomLiveChannel(
          existing.id,
          title || existing.title,
          normalizedGroupTitle
        )
      }
      return existing
    }

    const metadata = await fetchYouTubeMetadata(videoId)
    if (metadata.liveStatus !== 'live' && metadata.liveStatus !== 'upcoming') {
      throw new Error('This YouTube link is not a live stream.')
    }

    const channel = this.database.upsertLiveChannel({
      id: `custom-${videoId.toLowerCase()}`,
      source: 'custom',
      videoId,
      title: title || metadata.title,
      channel: metadata.channel,
      groupTitle: normalizedGroupTitle,
      description: metadata.description,
      durationLabel: metadata.liveStatus === 'upcoming' ? 'UPCOMING' : 'LIVE',
      thumbnailUrl: metadata.thumbnailUrl,
      avatarSourceUrl: metadata.avatarSourceUrl,
      sortOrder: Date.now()
    })

    await this.ensureAvatar(channel.id, metadata.avatarSourceUrl)
    return this.database.getLiveChannelById(channel.id) ?? channel
  }

  async updateCustomChannel(
    id: string,
    title: string,
    groupTitle = ''
  ): Promise<LiveChannelsSnapshot> {
    this.database.updateCustomLiveChannel(id, title, groupTitle)
    return this.listChannels()
  }

  async removeCustomChannel(id: string): Promise<LiveChannelsSnapshot> {
    this.database.removeCustomLiveChannel(id)
    const snapshot = await this.listChannels()
    const state = this.database.getLivePlayerState()
    if (
      state.selectedChannelId &&
      !snapshot.channels.some((channel) => channel.id === state.selectedChannelId)
    ) {
      this.database.updateLivePlayerState({ selectedChannelId: snapshot.channels[0]?.id || '' })
      return this.listChannels()
    }
    return snapshot
  }

  async getStatuses(videoIds: string[]): Promise<LiveStatus[]> {
    const normalized = [...new Set(videoIds.map((id) => id.trim()).filter(Boolean))]
      .filter((id) => YOUTUBE_VIDEO_ID_PATTERN.test(id))
      .slice(0, 60)

    return Promise.all(
      normalized.map(async (videoId) => ({
        videoId,
        ...(await fetchYouTubeLiveStatus(videoId))
      }))
    )
  }

  getState(): LivePlayerState {
    return this.database.getLivePlayerState()
  }

  updateState(patch: LivePlayerStatePatch): LivePlayerState {
    return this.database.updateLivePlayerState(patch)
  }

  private async refreshCatalogNow(): Promise<LiveChannelsSnapshot> {
    try {
      this.database.replaceUpdateLiveChannels(await this.fetchRemoteCatalog())
    } catch (error) {
      logWarning('live:catalog', 'failed to refresh remote live catalog', error)
      if (!this.hasUpdateChannels()) {
        this.database.replaceUpdateLiveChannels(DEFAULT_LIVE_CHANNELS)
      }
    }

    const snapshot = this.getChannelsSnapshot()
    this.refreshAvatarsInBackground()
    return snapshot
  }

  private refreshCatalogInBackground(): void {
    void this.refreshCatalog()
      .then((snapshot) => {
        this.onChannelsChanged?.(snapshot)
      })
      .catch((error) => {
        logWarning('live:catalog', 'background live catalog refresh failed', error)
      })
  }

  private refreshAvatarsInBackground(): void {
    if (this.avatarRefreshPromise) {
      return
    }
    this.avatarRefreshPromise = this.ensureAvatars()
      .then((updated) => {
        if (updated) {
          this.onChannelsChanged?.(this.getChannelsSnapshot())
        }
      })
      .catch((error) => {
        logWarning('live:avatars', 'failed to refresh live channel avatars', error)
      })
      .finally(() => {
        this.avatarRefreshPromise = null
      })
  }

  private getChannelsSnapshot(): LiveChannelsSnapshot {
    const channels = this.database.listLiveChannels()
    const state = this.database.getLivePlayerState()
    return {
      channels,
      selectedChannelId: channels.some((channel) => channel.id === state.selectedChannelId)
        ? state.selectedChannelId
        : channels[0]?.id || '',
      catalogUpdatedAt: new Date().toISOString()
    }
  }

  private hasUpdateChannels(): boolean {
    return this.database.listLiveChannels().some((channel) => channel.source === 'updates')
  }

  private async fetchRemoteCatalog(): Promise<LiveChannelInput[]> {
    const manifest = await fetchJson<LiveCatalogManifest>(LIVE_CATALOG_MANIFEST_URL, {
      timeoutMs: LIVE_CATALOG_TIMEOUT_MS
    })
    const channelName = manifest.defaultChannel?.trim() || 'stable'
    const channel = manifest.channels?.[channelName]
    const liveRef =
      channel?.hush?.liveChannel ??
      channel?.dreamFm?.liveChannel ??
      channel?.liveChannel ??
      manifest.hush?.liveChannel ??
      manifest.dreamFm?.liveChannel ??
      manifest.liveChannel
    const catalogUrl = liveRef?.url?.trim()
    if (!catalogUrl) {
      throw new Error('Hush live catalog URL is empty.')
    }
    const catalog = await fetchJson<RemoteLiveCatalog>(catalogUrl, {
      timeoutMs: LIVE_CATALOG_TIMEOUT_MS
    })
    const channels: LiveChannelInput[] = []

    catalog.groups?.forEach((group, groupIndex) => {
      group.items?.forEach((item, itemIndex) => {
        const videoId = String(item.videoId ?? '').trim()
        if (!YOUTUBE_VIDEO_ID_PATTERN.test(videoId)) {
          return
        }
        const thumbnailUrl = cleanYouTubeImageUrl(item.thumbnailUrl ?? '')
        channels.push({
          id: String(item.id ?? '').trim() || `updates-${videoId.toLowerCase()}`,
          source: 'updates',
          videoId,
          title: String(item.title ?? '').trim() || videoId,
          channel: String(item.channel ?? '').trim() || 'YouTube Live',
          groupTitle: String(group.title ?? item.group ?? group.id ?? '').trim(),
          description: String(item.description ?? '').trim(),
          durationLabel: String(item.durationLabel ?? '').trim() || 'LIVE',
          thumbnailUrl,
          avatarSourceUrl: thumbnailUrl,
          sortOrder: groupIndex * 100 + itemIndex
        })
      })
    })

    return channels.length > 0 ? channels : DEFAULT_LIVE_CHANNELS
  }

  private async ensureAvatars(): Promise<boolean> {
    const missing = this.database.listLiveChannelsMissingAvatars()
    const results = await Promise.all(
      missing.map((channel) =>
        this.ensureAvatar(channel.id, channel.avatarSourceUrl).catch(() => false)
      )
    )
    return results.some(Boolean)
  }

  private async ensureAvatar(id: string, avatarSourceUrl: string): Promise<boolean> {
    const normalizedAvatarSourceUrl = cleanYouTubeImageUrl(avatarSourceUrl)
    const avatar = await fetchAvatar(normalizedAvatarSourceUrl)
    if (!avatar) {
      return false
    }
    this.database.updateLiveChannelAvatar(id, avatar, normalizedAvatarSourceUrl)
    return true
  }
}

function extractYouTubeVideoId(rawUrl: string): string {
  const value = rawUrl.trim()
  if (YOUTUBE_VIDEO_ID_PATTERN.test(value)) {
    return value
  }
  try {
    const parsed = new URL(value)
    const host = parsed.hostname.replace(/^www\./, '').toLowerCase()
    if (host === 'youtu.be') {
      const id = parsed.pathname.split('/').filter(Boolean)[0] ?? ''
      return YOUTUBE_VIDEO_ID_PATTERN.test(id) ? id : ''
    }
    if (!host.endsWith('youtube.com') && !host.endsWith('youtube-nocookie.com')) {
      return ''
    }
    const queryId = parsed.searchParams.get('v')?.trim() ?? ''
    if (YOUTUBE_VIDEO_ID_PATTERN.test(queryId)) {
      return queryId
    }
    const pathParts = parsed.pathname.split('/').filter(Boolean)
    for (const marker of ['embed', 'live', 'shorts']) {
      const index = pathParts.indexOf(marker)
      const id = index >= 0 ? (pathParts[index + 1] ?? '') : ''
      if (YOUTUBE_VIDEO_ID_PATTERN.test(id)) {
        return id
      }
    }
  } catch {
    return ''
  }
  return ''
}

async function fetchYouTubeMetadata(videoId: string): Promise<YouTubeMetadata> {
  const html = await fetchText(youtubeWatchUrl(videoId), {
    timeoutMs: YOUTUBE_METADATA_TIMEOUT_MS,
    headers: youtubeHeaders()
  })
  const liveStatus = resolveYouTubeLiveStatusFromHtml(html)
  const playerResponse = extractJsonObject(html, 'ytInitialPlayerResponse')
  const videoDetails = getRecord(playerResponse?.videoDetails)
  const microformat = getRecord(getRecord(playerResponse?.microformat)?.playerMicroformatRenderer)
  const title =
    stringValue(videoDetails?.title) ||
    simpleText(microformat?.title) ||
    stringValue(microformat?.title) ||
    videoId
  const channel =
    stringValue(videoDetails?.author) ||
    stringValue(microformat?.ownerChannelName) ||
    'YouTube Live'
  const description =
    stringValue(videoDetails?.shortDescription) || simpleText(microformat?.description)
  const thumbnailUrl =
    largestThumbnailUrl(microformat?.thumbnail) ||
    largestThumbnailUrl(videoDetails?.thumbnail) ||
    `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
  const avatarSourceUrl = extractChannelAvatarUrl(html) || thumbnailUrl

  return {
    videoId,
    title,
    channel,
    description,
    thumbnailUrl,
    avatarSourceUrl,
    liveStatus
  }
}

async function fetchYouTubeLiveStatus(videoId: string): Promise<Omit<LiveStatus, 'videoId'>> {
  try {
    const html = await fetchText(youtubeWatchUrl(videoId), {
      timeoutMs: LIVE_STATUS_TIMEOUT_MS,
      headers: youtubeHeaders()
    })
    return { status: resolveYouTubeLiveStatusFromHtml(html) }
  } catch (error) {
    return {
      status: 'unknown',
      detail: error instanceof Error ? error.message : String(error)
    }
  }
}

function resolveYouTubeLiveStatusFromHtml(html: string): LiveStatusValue {
  const compact = html.replaceAll(' ', '')
  const lower = html.toLowerCase()
  if (
    compact.includes('"isLiveNow":true') ||
    compact.includes('"isLive":true') ||
    compact.includes('"liveBroadcastContent":"live"')
  ) {
    return 'live'
  }
  if (
    compact.includes('"isUpcoming":true') ||
    compact.includes('"liveBroadcastContent":"upcoming"') ||
    compact.includes('"upcomingEventData"')
  ) {
    return 'upcoming'
  }
  if (compact.includes('"status":"LIVE_STREAM_OFFLINE"')) {
    return 'offline'
  }
  if (
    compact.includes('"status":"ERROR"') ||
    compact.includes('"status":"UNPLAYABLE"') ||
    compact.includes('"status":"LOGIN_REQUIRED"') ||
    lower.includes('video unavailable')
  ) {
    return 'unavailable'
  }
  if (
    compact.includes('"isLiveContent":true') ||
    compact.includes('"liveBroadcastContent":"none"')
  ) {
    return 'offline'
  }
  return 'unknown'
}

async function fetchJson<T>(url: string, options: { timeoutMs: number }): Promise<T> {
  const data = await fetchBytes(url, {
    timeoutMs: options.timeoutMs,
    maxBytes: MAX_JSON_BYTES,
    headers: { Accept: 'application/json' }
  })
  return JSON.parse(data.toString('utf8')) as T
}

async function fetchText(
  url: string,
  options: { timeoutMs: number; headers?: Record<string, string> }
): Promise<string> {
  return (
    await fetchBytes(url, {
      timeoutMs: options.timeoutMs,
      maxBytes: MAX_HTML_BYTES,
      headers: options.headers
    })
  ).toString('utf8')
}

async function fetchAvatar(rawUrl: string): Promise<{ data: Buffer; mime: string } | null> {
  const url = cleanYouTubeImageUrl(rawUrl)
  if (!url) {
    return null
  }
  const data = await fetchBytes(url, {
    timeoutMs: AVATAR_TIMEOUT_MS,
    maxBytes: MAX_AVATAR_BYTES,
    headers: {
      Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
      'User-Agent': BROWSER_USER_AGENT
    }
  })
  const mime = detectImageMime(data)
  if (!mime) {
    return null
  }
  return { data, mime }
}

function avatarDataUrl(avatar: { data: Buffer; mime: string }): string {
  return `data:${avatar.mime};base64,${avatar.data.toString('base64')}`
}

async function fetchBytes(
  url: string,
  options: { timeoutMs: number; maxBytes: number; headers?: Record<string, string> }
): Promise<Buffer> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs)
  try {
    const response = await net.fetch(url, {
      signal: controller.signal,
      headers: options.headers
    })
    if (!response.ok || !response.body) {
      throw new Error(`Request failed: HTTP ${response.status}`)
    }
    const contentLength = Number(response.headers.get('content-length') ?? 0)
    if (contentLength > options.maxBytes) {
      throw new Error('Response is too large.')
    }
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      size += value.byteLength
      if (size > options.maxBytes) {
        throw new Error('Response is too large.')
      }
      chunks.push(value)
    }
    return Buffer.concat(chunks)
  } finally {
    clearTimeout(timer)
  }
}

function youtubeWatchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&bpctr=9999999999&has_verified=1&hl=en`
}

function youtubeHeaders(): Record<string, string> {
  return {
    'User-Agent': BROWSER_USER_AGENT,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    Referer: 'https://www.youtube.com/'
  }
}

function extractJsonObject(html: string, marker: string): Record<string, unknown> | null {
  const markerIndex = html.indexOf(marker)
  if (markerIndex < 0) {
    return null
  }
  const start = html.indexOf('{', markerIndex)
  if (start < 0) {
    return null
  }
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < html.length; index += 1) {
    const char = html[index]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{') {
      depth += 1
    } else if (char === '}') {
      depth -= 1
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, index + 1)) as Record<string, unknown>
        } catch {
          return null
        }
      }
    }
  }
  return null
}

function extractChannelAvatarUrl(html: string): string {
  const patterns = [
    /"channelThumbnail"\s*:\s*\{\s*"thumbnails"\s*:\s*(\[[^\]]+\])/,
    /"avatar"\s*:\s*\{\s*"thumbnails"\s*:\s*(\[[^\]]+\])/
  ]
  for (const pattern of patterns) {
    const match = html.match(pattern)
    if (!match?.[1]) {
      continue
    }
    try {
      const thumbnails = JSON.parse(match[1]) as unknown
      const url = largestThumbnailUrl({ thumbnails })
      if (url) {
        return url
      }
    } catch {
      continue
    }
  }
  return ''
}

function largestThumbnailUrl(value: unknown): string {
  const record = getRecord(value)
  const thumbnails = Array.isArray(record?.thumbnails) ? record.thumbnails : []
  const sorted = thumbnails
    .map((thumbnail) => getRecord(thumbnail))
    .filter(Boolean)
    .sort((left, right) => numberValue(right?.width) - numberValue(left?.width))
  return cleanYouTubeImageUrl(stringValue(sorted[0]?.url))
}

function cleanYouTubeImageUrl(value: string): string {
  const normalized = value
    .trim()
    .replace(/\\u0026/g, '&')
    .replace(/&amp;/g, '&')
  if (!normalized) {
    return ''
  }
  if (normalized.startsWith('//')) {
    return stripGoogleImageTransform(`https:${normalized}`)
  }
  if (/^https?:\/\//i.test(normalized)) {
    return stripGoogleImageTransform(normalized)
  }
  return ''
}

function stripGoogleImageTransform(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl)
    if (!GOOGLE_IMAGE_HOST_PATTERN.test(parsed.hostname)) {
      return rawUrl
    }
    const pathname = parsed.pathname.replace(
      /=(?:s\d+|w\d+(?:-h\d+)?|h\d+)(?:-[A-Za-z0-9]+)*$/i,
      ''
    )
    if (pathname === parsed.pathname) {
      return rawUrl
    }
    parsed.pathname = pathname
    return parsed.toString()
  } catch {
    return rawUrl
  }
}

function simpleText(value: unknown): string {
  const record = getRecord(value)
  if (!record) {
    return ''
  }
  if (typeof record.simpleText === 'string') {
    return record.simpleText.trim()
  }
  if (Array.isArray(record.runs)) {
    return record.runs
      .map((run) => stringValue(getRecord(run)?.text))
      .join('')
      .trim()
  }
  return ''
}

function getRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function detectImageMime(data: Buffer): string {
  if (data.length >= 12 && data.slice(4, 12).toString('ascii') === 'ftypavif') {
    return 'image/avif'
  }
  if (data.length >= 12 && data.slice(0, 4).toString('ascii') === 'RIFF') {
    return 'image/webp'
  }
  if (data.length >= 8 && data[0] === 0x89 && data.slice(1, 4).toString('ascii') === 'PNG') {
    return 'image/png'
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return 'image/jpeg'
  }
  if (data.length >= 6 && data.slice(0, 3).toString('ascii') === 'GIF') {
    return 'image/gif'
  }
  if (data.slice(0, 256).toString('utf8').trimStart().startsWith('<svg')) {
    return 'image/svg+xml'
  }
  return ''
}

export function stableLiveChannelId(videoId: string): string {
  return `custom-${createHash('sha1').update(videoId).digest('hex').slice(0, 12)}`
}

export type LiveChannelSource = 'updates' | 'custom'
export type LiveChannelColumnSource = 'updates' | 'custom'
export type LivePlayerMode = 'audio' | 'mini' | 'video'
export type LiveAudioLayout = 'single' | 'double'
export type LivePlaybackState =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'playing'
  | 'paused'
  | 'stopped'
  | 'error'
export type LivePlaybackCommand = 'toggle-playback' | 'play' | 'pause' | 'stop'
export type LiveStatusValue =
  | 'checking'
  | 'live'
  | 'offline'
  | 'upcoming'
  | 'unavailable'
  | 'unknown'

export interface LiveChannel {
  id: string
  source: LiveChannelSource
  videoId: string
  title: string
  channel: string
  groupTitle: string
  description: string
  durationLabel: string
  thumbnailUrl: string
  avatarDataUrl: string
  createdAt: string
  updatedAt: string
}

export interface LiveChannelDraft {
  videoId: string
  title: string
  channel: string
  groupTitle?: string
  description: string
  durationLabel: string
  thumbnailUrl: string
  avatarDataUrl: string
}

export interface LiveChannelInput {
  id: string
  source: LiveChannelSource
  videoId: string
  title: string
  channel: string
  groupTitle?: string
  description: string
  durationLabel?: string
  thumbnailUrl?: string
  avatarSourceUrl?: string
  sortOrder?: number
}

export interface LiveChannelsSnapshot {
  channels: LiveChannel[]
  selectedChannelId: string
  catalogUpdatedAt: string
}

export interface LiveChannelColumn {
  id: string
  source: LiveChannelColumnSource
  title: string
  channelCount: number
}

export interface LiveStatus {
  videoId: string
  status: LiveStatusValue
  detail?: string
}

export interface LivePlayerState {
  selectedChannelId: string
  playerMode: LivePlayerMode
  audioLayout: LiveAudioLayout
  muted: boolean
  volume: number
  drawerHeight: number
}

export interface LivePlayerStatePatch {
  selectedChannelId?: string
  playerMode?: LivePlayerMode
  audioLayout?: LiveAudioLayout
  muted?: boolean
  volume?: number
  drawerHeight?: number
}

export interface AddLiveChannelRequest {
  url: string
  title?: string
  groupTitle?: string
}

export interface PreviewLiveChannelRequest {
  url: string
}

export interface UpdateLiveChannelRequest {
  id: string
  title: string
  groupTitle?: string
}

export interface AddLiveChannelColumnRequest {
  title: string
}

export interface UpdateLiveChannelColumnRequest {
  id: string
  title: string
}

export interface LiveApi {
  listLiveChannels: () => Promise<LiveChannelsSnapshot>
  listLiveChannelColumns: () => Promise<LiveChannelColumn[]>
  addLiveChannelColumn: (request: AddLiveChannelColumnRequest) => Promise<LiveChannelColumn[]>
  updateLiveChannelColumn: (request: UpdateLiveChannelColumnRequest) => Promise<LiveChannelColumn[]>
  removeLiveChannelColumn: (id: string) => Promise<LiveChannelColumn[]>
  refreshLiveCatalog: () => Promise<LiveChannelsSnapshot>
  previewLiveChannel: (request: PreviewLiveChannelRequest) => Promise<LiveChannelDraft>
  addLiveChannel: (request: AddLiveChannelRequest) => Promise<LiveChannel>
  updateLiveChannel: (request: UpdateLiveChannelRequest) => Promise<LiveChannelsSnapshot>
  removeLiveChannel: (id: string) => Promise<LiveChannelsSnapshot>
  getLiveStatuses: (videoIds: string[]) => Promise<LiveStatus[]>
  getLivePlayerState: () => Promise<LivePlayerState>
  updateLivePlayerState: (patch: LivePlayerStatePatch) => Promise<LivePlayerState>
  setLivePlayerMode: (mode: LivePlayerMode) => Promise<LivePlayerState>
  getLivePlaybackState: () => Promise<LivePlaybackState>
  updateLivePlaybackState: (state: LivePlaybackState) => Promise<LivePlaybackState>
  dispatchLivePlaybackCommand: (command: LivePlaybackCommand) => Promise<void>
  fitLiveVideoWindow: () => Promise<void>
  onLiveChannelsChanged: (callback: (snapshot: LiveChannelsSnapshot) => void) => () => void
  onLivePlayerStateChanged: (callback: (state: LivePlayerState) => void) => () => void
  onLivePlayerModeChanged: (callback: (mode: LivePlayerMode) => void) => () => void
  onLivePlaybackStateChanged: (callback: (state: LivePlaybackState) => void) => () => void
  onLivePlaybackCommand: (callback: (command: LivePlaybackCommand) => void) => () => void
}

export const LIVE_CHANNELS = {
  list: 'live:list',
  listColumns: 'live:list-columns',
  addColumn: 'live:add-column',
  updateColumn: 'live:update-column',
  removeColumn: 'live:remove-column',
  refreshCatalog: 'live:refresh-catalog',
  previewChannel: 'live:preview-channel',
  addChannel: 'live:add-channel',
  updateChannel: 'live:update-channel',
  removeChannel: 'live:remove-channel',
  statuses: 'live:statuses',
  getState: 'live:get-state',
  updateState: 'live:update-state',
  channelsChanged: 'live:channels-changed',
  stateChanged: 'live:state-changed',
  setMode: 'live:set-mode',
  modeChanged: 'live:mode-changed',
  getPlaybackState: 'live:get-playback-state',
  updatePlaybackState: 'live:update-playback-state',
  playbackStateChanged: 'live:playback-state-changed',
  dispatchPlaybackCommand: 'live:dispatch-playback-command',
  playbackCommand: 'live:playback-command',
  fitVideoWindow: 'live:fit-video-window'
} as const

export const LIVE_PLAYER_MODES: LivePlayerMode[] = ['audio', 'mini', 'video']
export const LIVE_AUDIO_LAYOUTS: LiveAudioLayout[] = ['single', 'double']
export const LIVE_AUDIO_DOUBLE_LAYOUT_MIN_WIDTH = 760
export const LIVE_PLAYBACK_COMMANDS: LivePlaybackCommand[] = [
  'toggle-playback',
  'play',
  'pause',
  'stop'
]

export function isLivePlayerMode(value: unknown): value is LivePlayerMode {
  return typeof value === 'string' && LIVE_PLAYER_MODES.includes(value as LivePlayerMode)
}

export function isLiveAudioLayout(value: unknown): value is LiveAudioLayout {
  return typeof value === 'string' && LIVE_AUDIO_LAYOUTS.includes(value as LiveAudioLayout)
}

export function isLivePlaybackCommand(value: unknown): value is LivePlaybackCommand {
  return typeof value === 'string' && LIVE_PLAYBACK_COMMANDS.includes(value as LivePlaybackCommand)
}

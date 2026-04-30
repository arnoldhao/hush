import {
  createElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import type * as React from 'react'
import type { JSX, PointerEvent as ReactPointerEvent } from 'react'
import {
  AlertCircle,
  AudioLines,
  Check,
  ChevronDown,
  ChevronUp,
  Columns3,
  Loader2,
  Pause,
  Pencil,
  Play,
  Plus,
  Radio,
  Ratio,
  RefreshCw,
  Search,
  SkipBack,
  SkipForward,
  Square,
  Trash2,
  Turntable,
  Video,
  Volume2,
  VolumeX
} from 'lucide-react'

import type { TextBundle } from '../../../shared/i18n'
import {
  LIVE_AUDIO_DOUBLE_LAYOUT_MIN_WIDTH,
  LIVE_CHANNELS,
  type LiveChannel,
  type LiveChannelColumn,
  type LiveChannelDraft,
  type LiveChannelsSnapshot,
  type LivePlaybackState,
  type LivePlayerMode,
  type LivePlayerState,
  type LiveStatus,
  type LiveStatusValue
} from '../../../shared/live'
import type { AppSettings } from '../../../shared/settings'

const DEFAULT_PLAYER_STATE: LivePlayerState = {
  selectedChannelId: '',
  playerMode: 'audio',
  audioLayout: 'single',
  muted: false,
  volume: 0.82,
  drawerHeight: 420
}

const LIVE_STATUS_REFRESH_MS = 120_000
const YOUTUBE_CLIENT_ORIGIN = 'https://com.dreamapp.hush'
const VIDEO_TOPBAR_HEIGHT = 74
const VIDEO_FRAME_MARGIN_X = 10
const VIDEO_FRAME_MARGIN_TOP = 8
const VIDEO_FRAME_MARGIN_BOTTOM = 10
const VIDEO_FRAME_ASPECT_RATIO = 16 / 9
const CHANNEL_GROUP_FILTER_PREFIX = 'group:' as const
const CHANNEL_DRAWER_MIN_HEIGHT = 260

type VideoFrameStyle = React.CSSProperties & Record<`--${string}`, string>

interface ScrollMetrics {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

type ChannelGroupFilter = `${typeof CHANNEL_GROUP_FILTER_PREFIX}${string}`
type ChannelFilter = 'all' | ChannelGroupFilter

type ChannelDialogState =
  | {
      kind: 'add'
      url: string
      draft: LiveChannelDraft | null
      title: string
      groupTitle: string
      error: string
      loading: boolean
      saving: boolean
    }
  | {
      kind: 'edit'
      channel: LiveChannel
      title: string
      groupTitle: string
      error: string
      saving: boolean
    }

interface LivePlayerProps {
  settings: AppSettings | null
  text: TextBundle
}

export function LivePlayer({ settings, text }: LivePlayerProps): JSX.Element {
  const [channels, setChannels] = useState<LiveChannel[]>([])
  const [columns, setColumns] = useState<LiveChannelColumn[]>([])
  const [catalogUpdatedAt, setCatalogUpdatedAt] = useState('')
  const [playerState, setPlayerState] = useState<LivePlayerState>(DEFAULT_PLAYER_STATE)
  const [playbackState, setPlaybackState] = useState<LivePlaybackState>('idle')
  const [statuses, setStatuses] = useState<Record<string, LiveStatus>>({})
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [videoAvatarPickerOpen, setVideoAvatarPickerOpen] = useState(false)
  const [stateLoaded, setStateLoaded] = useState(false)
  const [webviewElement, setWebviewElement] = useState<Electron.WebviewTag | null>(null)
  const [autoplayRequest, setAutoplayRequest] = useState<{ videoId: string; nonce: number } | null>(
    null
  )
  const [viewportSize, setViewportSize] = useState(() => ({
    width: window.innerWidth,
    height: window.innerHeight
  }))
  const pendingAutoplayRef = useRef(false)
  const layout = playerState.audioLayout

  const selectedChannel = useMemo(
    () =>
      channels.find((channel) => channel.id === playerState.selectedChannelId) ??
      channels[0] ??
      null,
    [channels, playerState.selectedChannelId]
  )
  const mode = playerState.playerMode
  const videoId = selectedChannel?.videoId ?? ''
  const autoplayNonce =
    autoplayRequest && autoplayRequest.videoId === videoId ? autoplayRequest.nonce : 0
  const webviewSrc = useMemo(
    () => buildYouTubeEmbedUrl(videoId, autoplayNonce),
    [autoplayNonce, videoId]
  )
  const videoFrameStyle = useMemo(() => buildVideoFrameStyle(viewportSize), [viewportSize])
  const selectedStatus = selectedChannel
    ? (statuses[selectedChannel.videoId]?.status ?? 'checking')
    : 'unknown'

  const patchPlayerState = useCallback(async (patch: Partial<LivePlayerState>) => {
    const next = await window.api.updateLivePlayerState(patch)
    setPlayerState(next)
    return next
  }, [])

  const setMode = useCallback(async (nextMode: LivePlayerMode) => {
    const next = await window.api.setLivePlayerMode(nextMode)
    setPlayerState(next)
    if (nextMode !== 'mini') {
      setDrawerOpen(false)
    }
  }, [])

  const refreshStatuses = useCallback(async (items: LiveChannel[]) => {
    if (items.length === 0) {
      return
    }
    try {
      const next = await window.api.getLiveStatuses(items.map((channel) => channel.videoId))
      setStatuses(Object.fromEntries(next.map((status) => [status.videoId, status])))
    } catch (error) {
      window.api.writeLog('warn', 'live:statuses', 'live status refresh failed', error)
    }
  }, [])

  useEffect(() => {
    let mounted = true
    void Promise.allSettled([
      window.api.getLivePlayerState(),
      window.api.listLiveChannels(),
      window.api.listLiveChannelColumns()
    ]).then(([stateResult, snapshotResult, columnsResult]) => {
      if (!mounted) {
        return
      }
      if (columnsResult.status === 'fulfilled') {
        setColumns(columnsResult.value)
      }
      if (stateResult.status === 'fulfilled') {
        setPlayerState(stateResult.value)
      }
      if (snapshotResult.status === 'fulfilled') {
        applyChannelsSnapshot(
          snapshotResult.value,
          setChannels,
          setCatalogUpdatedAt,
          setPlayerState
        )
      }
      setStateLoaded(true)
    })
    const disposeMode = window.api.onLivePlayerModeChanged((nextMode) => {
      setPlayerState((current) => ({ ...current, playerMode: nextMode }))
    })
    const disposeChannels = window.api.onLiveChannelsChanged((snapshot) => {
      applyChannelsSnapshot(snapshot, setChannels, setCatalogUpdatedAt, setPlayerState)
      void window.api
        .listLiveChannelColumns()
        .then(setColumns)
        .catch((error) =>
          window.api.writeLog('warn', 'live:columns', 'live columns refresh failed', error)
        )
    })
    const disposeState = window.api.onLivePlayerStateChanged(setPlayerState)
    return () => {
      mounted = false
      disposeMode()
      disposeChannels()
      disposeState()
    }
  }, [])

  useEffect(() => {
    const syncLayout = (): void => {
      if (!stateLoaded || mode !== 'audio') {
        return
      }
      const nextLayout =
        window.innerWidth >= LIVE_AUDIO_DOUBLE_LAYOUT_MIN_WIDTH ? 'double' : 'single'
      if (playerState.audioLayout !== nextLayout) {
        void patchPlayerState({ audioLayout: nextLayout })
      }
    }
    syncLayout()
    window.addEventListener('resize', syncLayout)
    return () => window.removeEventListener('resize', syncLayout)
  }, [mode, patchPlayerState, playerState.audioLayout, stateLoaded])

  useEffect(() => {
    const updateViewportSize = (): void => {
      setViewportSize({ width: window.innerWidth, height: window.innerHeight })
    }
    updateViewportSize()
    window.addEventListener('resize', updateViewportSize)
    return () => window.removeEventListener('resize', updateViewportSize)
  }, [])

  useEffect(() => {
    const initialTimer = window.setTimeout(() => {
      void refreshStatuses(channels)
    }, 0)
    const timer = window.setInterval(() => {
      void refreshStatuses(channels)
    }, LIVE_STATUS_REFRESH_MS)
    return () => {
      window.clearTimeout(initialTimer)
      window.clearInterval(timer)
    }
  }, [channels, refreshStatuses])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (!selectedChannel) {
        setPlaybackState('idle')
        return
      }
      setPlaybackState('loading')
    }, 0)
    return () => window.clearTimeout(timer)
  }, [selectedChannel])

  useEffect(() => {
    void window.api.updateLivePlaybackState(playbackState)
  }, [playbackState])

  useEffect(() => {
    runYouTubeCommand(webviewElement, 'setVolume', [Math.round(playerState.volume * 100)])
    runYouTubeCommand(webviewElement, playerState.muted ? 'mute' : 'unMute')
  }, [playerState.muted, playerState.volume, videoId, webviewElement])

  const selectChannel = useCallback(
    (channel: LiveChannel) => {
      pendingAutoplayRef.current = true
      setAutoplayRequest({ videoId: channel.videoId, nonce: Date.now() })
      setPlaybackState('loading')
      setVideoAvatarPickerOpen(false)
      void patchPlayerState({ selectedChannelId: channel.id })
    },
    [patchPlayerState]
  )

  const selectAdjacent = useCallback(
    (direction: -1 | 1) => {
      if (channels.length === 0 || !selectedChannel) {
        return
      }
      const index = channels.findIndex((channel) => channel.id === selectedChannel.id)
      const next = channels[(index + direction + channels.length) % channels.length]
      if (next) {
        selectChannel(next)
      }
    },
    [channels, selectChannel, selectedChannel]
  )

  const play = useCallback(() => {
    if (!selectedChannel) {
      return
    }
    pendingAutoplayRef.current = true
    setAutoplayRequest({ videoId: selectedChannel.videoId, nonce: Date.now() })
    setPlaybackState('loading')
    runYouTubeCommand(webviewElement, 'playVideo')
  }, [selectedChannel, webviewElement])

  const pause = useCallback(() => {
    pendingAutoplayRef.current = false
    runYouTubeCommand(webviewElement, 'pauseVideo')
    setPlaybackState('paused')
  }, [webviewElement])

  const stop = useCallback(() => {
    pendingAutoplayRef.current = false
    runYouTubeCommand(webviewElement, 'stopVideo')
    setPlaybackState('stopped')
  }, [webviewElement])

  const fitVideoHeight = useCallback(() => {
    if (typeof window.api.fitLiveVideoWindow === 'function') {
      void window.api.fitLiveVideoWindow()
      return
    }
    void window.electron.ipcRenderer.invoke(LIVE_CHANNELS.fitVideoWindow)
  }, [])

  const togglePlayback = useCallback(() => {
    if (playbackState === 'playing' || playbackState === 'loading') {
      pause()
      return
    }
    play()
  }, [pause, play, playbackState])

  useEffect(() => {
    return window.api.onLivePlaybackCommand((command) => {
      if (command === 'toggle-playback') {
        togglePlayback()
        return
      }
      if (command === 'play') {
        play()
        return
      }
      if (command === 'pause') {
        pause()
        return
      }
      stop()
    })
  }, [pause, play, stop, togglePlayback])

  const toggleMute = useCallback(() => {
    void patchPlayerState({ muted: !playerState.muted })
  }, [patchPlayerState, playerState.muted])

  const changeVolume = useCallback(
    (value: number) => {
      const volume = clamp(value, 0, 1)
      void patchPlayerState({ volume, muted: volume <= 0 ? true : false })
    },
    [patchPlayerState]
  )

  const handlePlayerLoad = useCallback(() => {
    window.setTimeout(() => {
      runYouTubeCommand(webviewElement, 'setVolume', [Math.round(playerState.volume * 100)])
      runYouTubeCommand(webviewElement, playerState.muted ? 'mute' : 'unMute')
      if (pendingAutoplayRef.current) {
        pendingAutoplayRef.current = false
        runYouTubeCommand(webviewElement, 'playVideo')
        setPlaybackState('playing')
        return
      }
      setPlaybackState((current) => (current === 'loading' ? 'ready' : current))
    }, 350)
  }, [playerState.muted, playerState.volume, webviewElement])

  useEffect(() => {
    if (!webviewElement) {
      return
    }
    const handleFinishLoad = (): void => handlePlayerLoad()
    const handleFailLoad = (event: Event): void => {
      const detail = event as Event & { errorCode?: number }
      if (detail.errorCode === -3) {
        return
      }
      setPlaybackState('error')
    }
    webviewElement.addEventListener('did-finish-load', handleFinishLoad)
    webviewElement.addEventListener('dom-ready', handleFinishLoad)
    webviewElement.addEventListener('did-fail-load', handleFailLoad)
    return () => {
      webviewElement.removeEventListener('did-finish-load', handleFinishLoad)
      webviewElement.removeEventListener('dom-ready', handleFinishLoad)
      webviewElement.removeEventListener('did-fail-load', handleFailLoad)
    }
  }, [handlePlayerLoad, webviewElement])

  const bindWebview = useCallback((element: Electron.WebviewTag | null): void => {
    setWebviewElement(element)
  }, [])

  async function refreshCatalog(): Promise<void> {
    setRefreshing(true)
    try {
      const snapshot = await window.api.refreshLiveCatalog()
      const nextColumns = await window.api.listLiveChannelColumns()
      setColumns(nextColumns)
      applyChannelsSnapshot(snapshot, setChannels, setCatalogUpdatedAt, setPlayerState)
      void refreshStatuses(snapshot.channels)
    } catch {
      // The toolbar keeps the channel surface compact; failed refreshes are non-blocking.
    } finally {
      setRefreshing(false)
    }
  }

  async function addChannel(url: string, title: string, groupTitle: string): Promise<void> {
    const channel = await window.api.addLiveChannel({ url, title, groupTitle })
    const snapshot = await window.api.listLiveChannels()
    const nextColumns = await window.api.listLiveChannelColumns()
    setColumns(nextColumns)
    applyChannelsSnapshot(snapshot, setChannels, setCatalogUpdatedAt, setPlayerState)
    void refreshStatuses(snapshot.channels)
    selectChannel(snapshot.channels.find((item) => item.id === channel.id) ?? channel)
  }

  async function updateChannel(
    channel: LiveChannel,
    title: string,
    groupTitle: string
  ): Promise<void> {
    const snapshot =
      typeof window.api.updateLiveChannel === 'function'
        ? await window.api.updateLiveChannel({ id: channel.id, title, groupTitle })
        : ((await window.electron.ipcRenderer.invoke(LIVE_CHANNELS.updateChannel, {
            id: channel.id,
            title,
            groupTitle
          })) as LiveChannelsSnapshot)
    const nextColumns = await window.api.listLiveChannelColumns()
    setColumns(nextColumns)
    applyChannelsSnapshot(snapshot, setChannels, setCatalogUpdatedAt, setPlayerState)
  }

  async function removeChannel(channel: LiveChannel): Promise<void> {
    const snapshot = await window.api.removeLiveChannel(channel.id)
    const nextColumns = await window.api.listLiveChannelColumns()
    setColumns(nextColumns)
    applyChannelsSnapshot(snapshot, setChannels, setCatalogUpdatedAt, setPlayerState)
  }

  async function addColumn(title: string): Promise<void> {
    setColumns(await window.api.addLiveChannelColumn({ title }))
  }

  async function updateColumn(column: LiveChannelColumn, title: string): Promise<void> {
    setColumns(await window.api.updateLiveChannelColumn({ id: column.id, title }))
    const snapshot = await window.api.listLiveChannels()
    applyChannelsSnapshot(snapshot, setChannels, setCatalogUpdatedAt, setPlayerState)
  }

  async function removeColumn(column: LiveChannelColumn): Promise<void> {
    setColumns(await window.api.removeLiveChannelColumn(column.id))
    const snapshot = await window.api.listLiveChannels()
    applyChannelsSnapshot(snapshot, setChannels, setCatalogUpdatedAt, setPlayerState)
  }

  return (
    <main className={`live-player-root live-main-window live-mode-${mode}`} data-layout={layout}>
      <div className="live-player-content">
        <div className="live-window-drag-region" aria-hidden="true" />
        <div className="live-player-body" style={mode === 'video' ? videoFrameStyle : undefined}>
          <div className={`youtube-frame-shell ${mode === 'video' ? 'is-visible' : 'is-hidden'}`}>
            {webviewSrc
              ? createElement('webview', {
                  ref: bindWebview,
                  key: webviewSrc,
                  title: selectedChannel?.title ?? text.live.videoMode,
                  src: webviewSrc,
                  httpreferrer: YOUTUBE_CLIENT_ORIGIN,
                  partition: 'persist:hush-youtube',
                  webpreferences: 'contextIsolation=yes,nodeIntegration=no,sandbox=yes'
                })
              : null}
          </div>

          {mode === 'mini' ? (
            <MiniPlayer
              channel={selectedChannel}
              state={playbackState}
              text={text}
              onTogglePlayback={togglePlayback}
            />
          ) : mode === 'video' ? (
            <VideoMode
              channels={channels}
              selectedChannel={selectedChannel}
              playbackState={playbackState}
              liveStatus={selectedStatus}
              muted={playerState.muted}
              volume={playerState.volume}
              text={text}
              avatarPickerOpen={videoAvatarPickerOpen}
              onToggleAvatarPicker={() => setVideoAvatarPickerOpen((current) => !current)}
              onSelectChannel={selectChannel}
              onAudioMode={() => void setMode('audio')}
              onTogglePlayback={togglePlayback}
              onStop={stop}
              onFitHeight={fitVideoHeight}
              onToggleMute={toggleMute}
              onVolumeChange={changeVolume}
            />
          ) : (
            <AudioMode
              channels={channels}
              columns={columns}
              selectedChannel={selectedChannel}
              playbackState={playbackState}
              liveStatus={selectedStatus}
              statuses={statuses}
              muted={playerState.muted}
              volume={playerState.volume}
              drawerOpen={drawerOpen}
              drawerHeight={playerState.drawerHeight}
              layout={layout}
              refreshing={refreshing}
              catalogUpdatedAt={catalogUpdatedAt}
              text={text}
              onSelectChannel={selectChannel}
              onPrevious={() => selectAdjacent(-1)}
              onNext={() => selectAdjacent(1)}
              onTogglePlayback={togglePlayback}
              onToggleMute={toggleMute}
              onVolumeChange={changeVolume}
              onMiniMode={() => void setMode('mini')}
              onVideoMode={() => void setMode('video')}
              onDrawerOpenChange={setDrawerOpen}
              onDrawerHeightChange={(height) => void patchPlayerState({ drawerHeight: height })}
              onAddChannel={addChannel}
              onUpdateChannel={updateChannel}
              onAddColumn={addColumn}
              onUpdateColumn={updateColumn}
              onRemoveColumn={removeColumn}
              onRefreshCatalog={() => void refreshCatalog()}
              onRemoveChannel={(channel) => void removeChannel(channel)}
              settings={settings}
            />
          )}
        </div>
      </div>
    </main>
  )
}

export function LiveMiniPlayer({ text }: LivePlayerProps): JSX.Element {
  const [channels, setChannels] = useState<LiveChannel[]>([])
  const [playerState, setPlayerState] = useState<LivePlayerState>(DEFAULT_PLAYER_STATE)
  const [playbackState, setPlaybackState] = useState<LivePlaybackState>('idle')
  const selectedChannel = useMemo(
    () =>
      channels.find((channel) => channel.id === playerState.selectedChannelId) ??
      channels[0] ??
      null,
    [channels, playerState.selectedChannelId]
  )

  useEffect(() => {
    let mounted = true
    void Promise.all([
      window.api.getLivePlayerState(),
      window.api.listLiveChannels(),
      window.api.getLivePlaybackState()
    ]).then(([state, snapshot, nextPlaybackState]) => {
      if (!mounted) {
        return
      }
      setChannels(snapshot.channels)
      setPlayerState({
        ...state,
        selectedChannelId: snapshot.selectedChannelId || state.selectedChannelId
      })
      setPlaybackState(nextPlaybackState)
    })
    const disposeMode = window.api.onLivePlayerModeChanged((nextMode) => {
      setPlayerState((current) => ({ ...current, playerMode: nextMode }))
    })
    const disposeChannels = window.api.onLiveChannelsChanged((snapshot) => {
      setChannels(snapshot.channels)
      setPlayerState((current) => ({
        ...current,
        selectedChannelId: snapshot.selectedChannelId || current.selectedChannelId
      }))
    })
    const disposeState = window.api.onLivePlayerStateChanged(setPlayerState)
    const disposePlayback = window.api.onLivePlaybackStateChanged(setPlaybackState)
    return () => {
      mounted = false
      disposeMode()
      disposeChannels()
      disposeState()
      disposePlayback()
    }
  }, [])

  return (
    <main className="live-player-root live-mode-mini" data-layout="single">
      <MiniPlayer
        channel={selectedChannel}
        state={playbackState}
        text={text}
        onTogglePlayback={() => void window.api.dispatchLivePlaybackCommand('toggle-playback')}
      />
    </main>
  )
}

function AudioMode(props: {
  channels: LiveChannel[]
  columns: LiveChannelColumn[]
  selectedChannel: LiveChannel | null
  playbackState: LivePlaybackState
  liveStatus: LiveStatusValue
  statuses: Record<string, LiveStatus>
  muted: boolean
  volume: number
  drawerOpen: boolean
  drawerHeight: number
  layout: 'single' | 'double'
  refreshing: boolean
  catalogUpdatedAt: string
  text: TextBundle
  settings: AppSettings | null
  onSelectChannel: (channel: LiveChannel) => void
  onPrevious: () => void
  onNext: () => void
  onTogglePlayback: () => void
  onToggleMute: () => void
  onVolumeChange: (value: number) => void
  onMiniMode: () => void
  onVideoMode: () => void
  onDrawerOpenChange: (open: boolean) => void
  onDrawerHeightChange: (height: number) => void
  onAddChannel: (url: string, title: string, groupTitle: string) => Promise<void>
  onUpdateChannel: (channel: LiveChannel, title: string, groupTitle: string) => Promise<void>
  onAddColumn: (title: string) => Promise<void>
  onUpdateColumn: (column: LiveChannelColumn, title: string) => Promise<void>
  onRemoveColumn: (column: LiveChannelColumn) => Promise<void>
  onRefreshCatalog: () => void
  onRemoveChannel: (channel: LiveChannel) => void
}): JSX.Element {
  const double = props.layout === 'double'
  return (
    <section className={`audio-shell ${double ? 'is-double' : 'is-single'}`}>
      <div className="audio-main">
        <PlayerStage
          channel={props.selectedChannel}
          state={props.playbackState}
          liveStatus={props.liveStatus}
          muted={props.muted}
          volume={props.volume}
          text={props.text}
          onPrevious={props.onPrevious}
          onNext={props.onNext}
          onTogglePlayback={props.onTogglePlayback}
          onToggleMute={props.onToggleMute}
          onVolumeChange={props.onVolumeChange}
          onMiniMode={props.onMiniMode}
        />
        <footer className="audio-footer">
          {double ? (
            <button
              className="footer-pill"
              type="button"
              aria-label={props.text.live.videoMode}
              title={props.text.live.videoMode}
              onClick={props.onVideoMode}
            >
              <Video size={16} />
            </button>
          ) : (
            <button
              className="footer-pill"
              type="button"
              aria-label={props.text.live.channel}
              title={props.text.live.channel}
              onClick={() => props.onDrawerOpenChange(true)}
            >
              <Radio size={16} />
            </button>
          )}
        </footer>
      </div>

      {double ? (
        <aside className="audio-channel-column">
          <ChannelPanel {...props} compact={false} />
        </aside>
      ) : (
        <ChannelDrawer
          open={props.drawerOpen}
          height={props.drawerHeight}
          closeLabel={props.text.actions.close}
          resizeLabel={props.text.live.channels}
          onOpenChange={props.onDrawerOpenChange}
          onHeightChange={props.onDrawerHeightChange}
        >
          <ChannelPanel {...props} compact />
        </ChannelDrawer>
      )}
    </section>
  )
}

function PlayerStage(props: {
  channel: LiveChannel | null
  state: LivePlaybackState
  liveStatus: LiveStatusValue
  muted: boolean
  volume: number
  text: TextBundle
  onPrevious: () => void
  onNext: () => void
  onTogglePlayback: () => void
  onToggleMute: () => void
  onVolumeChange: (value: number) => void
  onMiniMode: () => void
}): JSX.Element {
  const channel = props.channel
  return (
    <div className="player-stage">
      <div className="artwork-stack">
        <div className="artwork-glow" aria-hidden="true">
          <ChannelAvatar channel={channel} />
        </div>
        <div className="artwork-card">
          <ChannelAvatar channel={channel} />
        </div>
      </div>

      <div className="track-copy">
        <h1>{channel?.title || props.text.live.noChannels}</h1>
        <p>
          {channel
            ? channel.channel || props.text.live.selectChannel
            : props.text.live.selectChannel}
        </p>
      </div>

      <LiveProgress state={props.state} text={props.text} />

      <div className="transport-row">
        <AudioVolumeControl
          muted={props.muted}
          volume={props.volume}
          text={props.text}
          onToggleMute={props.onToggleMute}
          onVolumeChange={props.onVolumeChange}
        />
        <div className="transport-center">
          <IconButton
            className="panel-icon-button audio-control-button"
            label={props.text.live.previous}
            onClick={props.onPrevious}
          >
            <SkipBack size={18} />
          </IconButton>
          <button
            className="panel-icon-button audio-control-button audio-play-button"
            type="button"
            aria-label={props.state === 'playing' ? props.text.live.pause : props.text.live.play}
            title={props.state === 'playing' ? props.text.live.pause : props.text.live.play}
            onClick={props.onTogglePlayback}
          >
            {props.state === 'loading' ? (
              <Loader2 size={18} className="spin" />
            ) : props.state === 'playing' ? (
              <Pause size={18} />
            ) : (
              <Play size={18} fill="currentColor" />
            )}
          </button>
          <IconButton
            className="panel-icon-button audio-control-button"
            label={props.text.live.next}
            onClick={props.onNext}
          >
            <SkipForward size={18} />
          </IconButton>
        </div>
        <IconButton
          className="panel-icon-button audio-control-button"
          label={props.text.live.switchToMini}
          onClick={props.onMiniMode}
        >
          <Turntable size={18} />
        </IconButton>
      </div>
    </div>
  )
}

function VideoMode(props: {
  channels: LiveChannel[]
  selectedChannel: LiveChannel | null
  playbackState: LivePlaybackState
  liveStatus: LiveStatusValue
  muted: boolean
  volume: number
  text: TextBundle
  avatarPickerOpen: boolean
  onToggleAvatarPicker: () => void
  onSelectChannel: (channel: LiveChannel) => void
  onAudioMode: () => void
  onTogglePlayback: () => void
  onStop: () => void
  onFitHeight: () => void
  onToggleMute: () => void
  onVolumeChange: (value: number) => void
}): JSX.Element {
  const channel = props.selectedChannel
  const [pickerQuery, setPickerQuery] = useState('')
  const normalizedPickerQuery = normalizeChannelQuery(pickerQuery)
  const pickerChannels = useMemo(
    () => props.channels.filter((channel) => channelMatchesQuery(channel, normalizedPickerQuery)),
    [normalizedPickerQuery, props.channels]
  )

  function toggleAvatarPicker(): void {
    if (props.avatarPickerOpen) {
      setPickerQuery('')
    }
    props.onToggleAvatarPicker()
  }

  return (
    <section className="video-shell">
      <header className="video-topbar">
        <div className="video-info-area">
          <div className="video-identity">
            <button
              className="video-avatar-button"
              type="button"
              aria-label={props.text.live.avatarOverlay}
              onClick={toggleAvatarPicker}
            >
              <ChannelAvatar channel={channel} />
            </button>
            <div className="video-info">
              <div className="video-title-line">
                <h1>{channel?.title || props.text.live.noChannels}</h1>
                <span>{channel?.channel || props.text.live.selectChannel}</span>
              </div>
              <VideoStatusCluster
                liveStatus={props.liveStatus}
                playbackState={props.playbackState}
                text={props.text}
              />
            </div>
          </div>
          <div className="video-actions">
            <VideoVolumeControl
              muted={props.muted}
              volume={props.volume}
              text={props.text}
              onToggleMute={props.onToggleMute}
              onVolumeChange={props.onVolumeChange}
            />
            <IconButton
              label={
                props.playbackState === 'playing' ? props.text.live.pause : props.text.live.play
              }
              onClick={props.onTogglePlayback}
            >
              {props.playbackState === 'playing' ? (
                <Pause size={17} />
              ) : (
                <Play size={17} fill="currentColor" />
              )}
            </IconButton>
            <IconButton
              label={props.text.live.stop}
              disabled={props.playbackState === 'stopped'}
              onClick={props.onStop}
            >
              <Square size={15} fill="currentColor" />
            </IconButton>
          </div>
        </div>
      </header>
      <div className="video-area">
        <div className="video-bottom-actions">
          <IconButton
            className="video-bottom-button"
            label={props.text.live.fitHeight}
            onClick={props.onFitHeight}
          >
            <Ratio size={16} />
          </IconButton>
          <IconButton
            className="video-bottom-button"
            label={props.text.live.switchToAudio}
            onClick={props.onAudioMode}
          >
            <AudioLines size={17} />
          </IconButton>
        </div>
        {props.avatarPickerOpen ? (
          <div
            className="avatar-picker-layer"
            role="dialog"
            aria-label={props.text.live.avatarOverlay}
          >
            <button
              className="avatar-picker-scrim"
              type="button"
              aria-label={props.text.live.closeDialog}
              onClick={toggleAvatarPicker}
            />
            <div className="avatar-picker-panel">
              <label className="avatar-picker-search">
                <Search size={14} />
                <input
                  value={pickerQuery}
                  placeholder={props.text.live.searchChannels}
                  onChange={(event) => setPickerQuery(event.currentTarget.value)}
                />
              </label>
              <div className="avatar-picker-grid">
                {pickerChannels.map((channel) => (
                  <button
                    key={channel.id}
                    type="button"
                    className={`avatar-picker-item ${
                      channel.id === props.selectedChannel?.id ? 'is-selected' : ''
                    }`}
                    aria-current={channel.id === props.selectedChannel?.id ? 'true' : undefined}
                    title={channel.title}
                    onClick={() => props.onSelectChannel(channel)}
                  >
                    <span className="avatar-picker-avatar">
                      <ChannelAvatar channel={channel} />
                    </span>
                    <span className="avatar-picker-copy">
                      <strong>{channel.title}</strong>
                      <small>{channel.channel}</small>
                    </span>
                  </button>
                ))}
              </div>
              {pickerChannels.length === 0 ? (
                <div className="avatar-picker-empty">{props.text.live.searchNoResults}</div>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </section>
  )
}

function MiniPlayer(props: {
  channel: LiveChannel | null
  state: LivePlaybackState
  text: TextBundle
  onTogglePlayback: () => void
}): JSX.Element {
  const title = props.channel?.title || props.text.appName
  const subtitle = props.channel?.channel || props.text.live.statusIdle
  return (
    <section className="mini-shell">
      <div className="mini-art">
        <div className="mini-art-blur">
          <ChannelAvatar channel={props.channel} />
        </div>
        <ChannelAvatar channel={props.channel} />
      </div>
      <div className="mini-gradient" aria-hidden="true" />
      <div className="mini-content">
        <div className="mini-text">
          <strong>{title}</strong>
          <span>{subtitle}</span>
        </div>
        <div className="mini-controls">
          <button className="mini-play" type="button" onClick={props.onTogglePlayback}>
            {props.state === 'loading' ? (
              <Loader2 size={16} className="spin" />
            ) : props.state === 'playing' ? (
              <Pause size={16} />
            ) : (
              <Play size={16} fill="currentColor" />
            )}
          </button>
        </div>
        <LiveProgress compact state={props.state} text={props.text} />
      </div>
    </section>
  )
}

function ChannelPanel(
  props: Parameters<typeof AudioMode>[0] & {
    compact: boolean
  }
): JSX.Element {
  const { compact, drawerHeight, onDrawerHeightChange } = props
  const [query, setQuery] = useState('')
  const [channelFilter, setChannelFilter] = useState<ChannelFilter>('all')
  const [searchFocused, setSearchFocused] = useState(false)
  const [dialog, setDialog] = useState<ChannelDialogState | null>(null)
  const [columnDialogOpen, setColumnDialogOpen] = useState(false)
  const [deleteConfirmId, setDeleteConfirmId] = useState('')
  const panelRef = useRef<HTMLDivElement | null>(null)
  const requestedDrawerHeightRef = useRef(drawerHeight)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const scrollContentRef = useRef<HTMLDivElement | null>(null)
  const [scrollMetrics, setScrollMetrics] = useState<ScrollMetrics>({
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0
  })
  const normalizedQuery = normalizeChannelQuery(query)
  const columnOptions = useMemo(() => uniqueChannelColumns(props.columns), [props.columns])
  const channelFilterOptions = useMemo(
    () => [
      { id: 'all' as const, label: channelFilterLabel('all', props.text), kind: 'source' },
      ...columnOptions.map((column) => ({
        id: channelGroupFilterId(column.title),
        label: column.title,
        kind: 'group'
      }))
    ],
    [columnOptions, props.text]
  )
  const filteredChannels = useMemo(
    () =>
      props.channels
        .filter((channel) => channelMatchesFilter(channel, channelFilter))
        .filter((channel) => channelMatchesQuery(channel, normalizedQuery)),
    [channelFilter, normalizedQuery, props.channels]
  )
  const empty = filteredChannels.length === 0

  useEffect(() => {
    requestedDrawerHeightRef.current = drawerHeight
  }, [drawerHeight])

  const ensureDialogFitsDrawer = useCallback(
    (dialogElement: HTMLElement | null): void => {
      if (!compact || !dialogElement) {
        return
      }
      const requiredHeight = getDialogRequiredDrawerHeight(dialogElement)
      const nextHeight = clampChannelDrawerHeight(requiredHeight)
      const currentHeight = Math.max(drawerHeight, requestedDrawerHeightRef.current)
      if (nextHeight > currentHeight + 0.5) {
        requestedDrawerHeightRef.current = nextHeight
        onDrawerHeightChange(nextHeight)
      }
    },
    [compact, drawerHeight, onDrawerHeightChange]
  )

  useLayoutEffect(() => {
    if (!compact || (!dialog && !columnDialogOpen)) {
      return
    }
    const dialogElement = panelRef.current?.querySelector<HTMLElement>('.channel-dialog') ?? null
    if (!dialogElement) {
      return
    }
    ensureDialogFitsDrawer(dialogElement)

    const observer = new ResizeObserver(() => ensureDialogFitsDrawer(dialogElement))
    observer.observe(dialogElement)

    const handleWindowResize = (): void => ensureDialogFitsDrawer(dialogElement)
    window.addEventListener('resize', handleWindowResize)

    return () => {
      observer.disconnect()
      window.removeEventListener('resize', handleWindowResize)
    }
  }, [columnDialogOpen, compact, dialog, ensureDialogFitsDrawer])

  const updateScrollMetrics = useCallback((): void => {
    const element = scrollRef.current
    if (!element) {
      return
    }
    const next = {
      scrollTop: element.scrollTop,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight
    }
    setScrollMetrics((current) =>
      Math.abs(current.scrollTop - next.scrollTop) < 0.5 &&
      current.scrollHeight === next.scrollHeight &&
      current.clientHeight === next.clientHeight
        ? current
        : next
    )
  }, [])

  const setListScrollTop = useCallback(
    (value: number): void => {
      const element = scrollRef.current
      if (!element) {
        return
      }
      const maxScrollTop = Math.max(0, element.scrollHeight - element.clientHeight)
      element.scrollTop = clamp(value, 0, maxScrollTop)
      window.requestAnimationFrame(updateScrollMetrics)
    },
    [updateScrollMetrics]
  )

  useEffect(() => {
    const element = scrollRef.current
    const content = scrollContentRef.current
    const frame = window.requestAnimationFrame(updateScrollMetrics)
    if (!element || !content) {
      return () => window.cancelAnimationFrame(frame)
    }
    const observer = new ResizeObserver(updateScrollMetrics)
    observer.observe(element)
    observer.observe(content)
    return () => {
      window.cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [empty, filteredChannels.length, normalizedQuery, updateScrollMetrics])

  useEffect(() => {
    setListScrollTop(0)
  }, [channelFilter, normalizedQuery, setListScrollTop])

  useEffect(() => {
    if (
      isChannelGroupFilter(channelFilter) &&
      !columnOptions.some((column) => channelGroupFilterId(column.title) === channelFilter)
    ) {
      setChannelFilter('all')
    }
  }, [channelFilter, columnOptions])

  useEffect(() => {
    if (
      deleteConfirmId &&
      !props.channels.some(
        (channel) => channel.id === deleteConfirmId && channel.source === 'custom'
      )
    ) {
      setDeleteConfirmId('')
    }
  }, [deleteConfirmId, props.channels])

  function requestRemoveChannel(channel: LiveChannel): void {
    if (deleteConfirmId !== channel.id) {
      setDeleteConfirmId(channel.id)
      return
    }
    setDeleteConfirmId('')
    props.onRemoveChannel(channel)
  }

  async function resolveAddDialog(): Promise<void> {
    if (!dialog || dialog.kind !== 'add') {
      return
    }
    const url = dialog.url.trim()
    if (!url) {
      setDialog({ ...dialog, error: props.text.live.linkInvalid })
      return
    }
    setDialog({ ...dialog, url, error: '', loading: true })
    try {
      const draft =
        typeof window.api.previewLiveChannel === 'function'
          ? await window.api.previewLiveChannel({ url })
          : ((await window.electron.ipcRenderer.invoke(LIVE_CHANNELS.previewChannel, {
              url
            })) as LiveChannelDraft)
      setDialog({
        kind: 'add',
        url,
        draft,
        title: draft.title,
        groupTitle: dialog.groupTitle,
        error: '',
        loading: false,
        saving: false
      })
    } catch (error) {
      setDialog((current) =>
        current?.kind === 'add'
          ? { ...current, error: resolveAddChannelError(error, props.text), loading: false }
          : current
      )
    }
  }

  async function saveDialog(): Promise<void> {
    if (!dialog) {
      return
    }
    const title = dialog.title.trim()
    if (!title) {
      setDialog({ ...dialog, error: props.text.live.channelTitleRequired })
      return
    }
    setDialog({ ...dialog, error: '', saving: true })
    try {
      if (dialog.kind === 'add') {
        await props.onAddChannel(dialog.url, title, dialog.groupTitle)
      } else {
        await props.onUpdateChannel(dialog.channel, title, dialog.groupTitle)
      }
      setDialog(null)
    } catch (error) {
      setDialog((current) =>
        current
          ? { ...current, error: resolveAddChannelError(error, props.text), saving: false }
          : current
      )
    }
  }

  return (
    <div ref={panelRef} className="channel-panel">
      <div className={`channel-toolbar ${searchFocused ? 'is-searching' : ''}`}>
        <label className="channel-search-field">
          <Search size={15} />
          <input
            value={query}
            placeholder={props.text.live.searchChannels}
            onBlur={() => setSearchFocused(false)}
            onChange={(event) => setQuery(event.currentTarget.value)}
            onFocus={() => setSearchFocused(true)}
          />
        </label>
        <button
          className="panel-icon-button channel-toolbar-action is-add"
          type="button"
          aria-label={props.text.live.addChannel}
          onClick={() =>
            setDialog({
              kind: 'add',
              url: '',
              draft: null,
              title: '',
              groupTitle: filterGroupTitle(channelFilter),
              error: '',
              loading: false,
              saving: false
            })
          }
        >
          <Plus size={15} />
        </button>
        <button
          className="panel-icon-button channel-toolbar-action is-columns"
          type="button"
          aria-label={props.text.live.manageColumns}
          title={props.text.live.manageColumns}
          onClick={() => setColumnDialogOpen(true)}
        >
          <Columns3 size={15} />
        </button>
        <button
          className="panel-icon-button channel-toolbar-action is-refresh"
          type="button"
          aria-label={props.text.live.refreshCatalog}
          title={
            props.catalogUpdatedAt
              ? new Date(props.catalogUpdatedAt).toLocaleTimeString()
              : props.text.live.refreshCatalog
          }
          disabled={props.refreshing}
          onClick={props.onRefreshCatalog}
        >
          {props.refreshing ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />}
        </button>
      </div>

      <div className="channel-list-frame">
        <div ref={scrollRef} className="channel-list-scroll" onScroll={updateScrollMetrics}>
          <div ref={scrollContentRef} className="channel-list-content">
            <div className="channel-filter-row" aria-label={props.text.live.channelFilter}>
              {channelFilterOptions.map((filter) => (
                <button
                  key={filter.id}
                  className={`channel-filter-chip is-${filter.kind} ${
                    channelFilter === filter.id ? 'is-selected' : ''
                  }`}
                  type="button"
                  onClick={() => setChannelFilter(filter.id)}
                >
                  {filter.label}
                </button>
              ))}
            </div>
            <ChannelGroup
              channels={filteredChannels}
              confirmingRemoveId={deleteConfirmId}
              selectedId={props.selectedChannel?.id ?? ''}
              statuses={props.statuses}
              text={props.text}
              onSelect={props.onSelectChannel}
              onEdit={(channel) =>
                setDialog({
                  kind: 'edit',
                  channel,
                  title: channel.title,
                  groupTitle: channel.groupTitle,
                  error: '',
                  saving: false
                })
              }
              onRemove={requestRemoveChannel}
            />
            {empty ? (
              <div className="channel-empty">
                {normalizedQuery ? props.text.live.searchNoResults : props.text.live.noChannels}
              </div>
            ) : null}
          </div>
        </div>
        <ChannelListScrollbar
          metrics={scrollMetrics}
          text={props.text}
          onMetricsChange={updateScrollMetrics}
          onScrollTopChange={setListScrollTop}
        />
      </div>
      {dialog ? (
        <ChannelDialog
          state={dialog}
          text={props.text}
          onCancel={() => setDialog(null)}
          columns={columnOptions}
          onResolve={() => void resolveAddDialog()}
          onSave={() => void saveDialog()}
          onGroupTitleChange={(groupTitle) =>
            setDialog((current) => (current ? { ...current, groupTitle } : current))
          }
          onTitleChange={(title) =>
            setDialog((current) => (current ? { ...current, title, error: '' } : current))
          }
          onUrlChange={(url) =>
            setDialog((current) =>
              current?.kind === 'add' ? { ...current, url, error: '' } : current
            )
          }
        />
      ) : null}
      {columnDialogOpen ? (
        <ChannelColumnsDialog
          columns={props.columns}
          text={props.text}
          onAddColumn={props.onAddColumn}
          onCancel={() => setColumnDialogOpen(false)}
          onRemoveColumn={props.onRemoveColumn}
          onUpdateColumn={props.onUpdateColumn}
        />
      ) : null}
    </div>
  )
}

function ChannelListScrollbar(props: {
  metrics: ScrollMetrics
  text: TextBundle
  onMetricsChange: () => void
  onScrollTopChange: (value: number) => void
}): JSX.Element {
  const trackRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<{
    startY: number
    startScrollTop: number
    maxScrollTop: number
    maxThumbTop: number
  } | null>(null)
  const [trackHeight, setTrackHeight] = useState(0)
  const maxScrollTop = Math.max(0, props.metrics.scrollHeight - props.metrics.clientHeight)
  const scrollable = maxScrollTop > 1 && trackHeight > 0
  const thumbHeight = scrollable
    ? clamp(
        (props.metrics.clientHeight / props.metrics.scrollHeight) * trackHeight,
        28,
        trackHeight
      )
    : trackHeight
  const maxThumbTop = Math.max(0, trackHeight - thumbHeight)
  const thumbTop = scrollable ? (props.metrics.scrollTop / maxScrollTop) * maxThumbTop : 0

  const updateTrackHeight = useCallback((): void => {
    setTrackHeight(trackRef.current?.clientHeight ?? 0)
  }, [])

  useEffect(() => {
    updateTrackHeight()
    const track = trackRef.current
    if (!track) {
      return
    }
    const observer = new ResizeObserver(updateTrackHeight)
    observer.observe(track)
    return () => observer.disconnect()
  }, [updateTrackHeight])

  function scrollToTop(): void {
    props.onScrollTopChange(0)
  }

  function scrollToBottom(): void {
    props.onScrollTopChange(maxScrollTop)
  }

  function handleTrackPointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
    if (!scrollable || event.target !== event.currentTarget) {
      return
    }
    const bounds = event.currentTarget.getBoundingClientRect()
    if (bounds.height <= 0 || maxThumbTop <= 0) {
      return
    }
    const nextThumbCenter = clamp(
      event.clientY - bounds.top,
      thumbHeight / 2,
      bounds.height - thumbHeight / 2
    )
    const nextThumbTop = nextThumbCenter - thumbHeight / 2
    props.onScrollTopChange((nextThumbTop / maxThumbTop) * maxScrollTop)
  }

  function handleThumbPointerDown(event: ReactPointerEvent<HTMLButtonElement>): void {
    if (!scrollable) {
      return
    }
    event.preventDefault()
    event.stopPropagation()
    dragRef.current = {
      startY: event.clientY,
      startScrollTop: props.metrics.scrollTop,
      maxScrollTop,
      maxThumbTop
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function handleThumbPointerMove(event: ReactPointerEvent<HTMLButtonElement>): void {
    const drag = dragRef.current
    if (!drag || drag.maxThumbTop <= 0) {
      return
    }
    const delta = event.clientY - drag.startY
    props.onScrollTopChange(drag.startScrollTop + (delta / drag.maxThumbTop) * drag.maxScrollTop)
    props.onMetricsChange()
  }

  function handleThumbPointerUp(event: ReactPointerEvent<HTMLButtonElement>): void {
    if (!dragRef.current) {
      return
    }
    dragRef.current = null
    event.currentTarget.releasePointerCapture(event.pointerId)
  }

  function handleThumbKeyDown(event: React.KeyboardEvent<HTMLButtonElement>): void {
    if (!scrollable) {
      return
    }
    if (event.key === 'Home') {
      event.preventDefault()
      scrollToTop()
    } else if (event.key === 'End') {
      event.preventDefault()
      scrollToBottom()
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      props.onScrollTopChange(props.metrics.scrollTop - 40)
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      props.onScrollTopChange(props.metrics.scrollTop + 40)
    }
  }

  return (
    <div className={`channel-custom-scrollbar ${scrollable ? '' : 'is-disabled'}`}>
      <button
        className="channel-scroll-arrow is-top"
        type="button"
        aria-label={props.text.live.scrollToTop}
        disabled={!scrollable}
        onClick={scrollToTop}
      >
        <ChevronUp size={12} strokeWidth={2.4} />
      </button>
      <div ref={trackRef} className="channel-scroll-track" onPointerDown={handleTrackPointerDown}>
        <button
          className="channel-scroll-thumb"
          type="button"
          aria-label={props.text.live.channels}
          disabled={!scrollable}
          style={{
            height: `${Math.max(0, thumbHeight)}px`,
            transform: `translateY(${Math.max(0, thumbTop)}px)`
          }}
          onKeyDown={handleThumbKeyDown}
          onPointerDown={handleThumbPointerDown}
          onPointerMove={handleThumbPointerMove}
          onPointerUp={handleThumbPointerUp}
          onPointerCancel={handleThumbPointerUp}
        />
      </div>
      <button
        className="channel-scroll-arrow is-bottom"
        type="button"
        aria-label={props.text.live.scrollToBottom}
        disabled={!scrollable}
        onClick={scrollToBottom}
      >
        <ChevronDown size={12} strokeWidth={2.4} />
      </button>
    </div>
  )
}

function ChannelDialog(props: {
  state: ChannelDialogState
  columns: LiveChannelColumn[]
  text: TextBundle
  onCancel: () => void
  onGroupTitleChange: (groupTitle: string) => void
  onResolve: () => void
  onSave: () => void
  onTitleChange: (title: string) => void
  onUrlChange: (url: string) => void
}): JSX.Element {
  const draft =
    props.state.kind === 'add' ? props.state.draft : liveChannelToDraft(props.state.channel)
  const resolving = props.state.kind === 'add' && props.state.loading
  const saving = props.state.saving
  const primaryLabel =
    props.state.kind === 'edit' ? props.text.live.modifyChannel : props.text.live.addChannel
  const columnOptions = useMemo(
    () => channelDialogColumnOptions(props.columns, props.state.groupTitle),
    [props.columns, props.state.groupTitle]
  )

  return (
    <div className="channel-dialog-backdrop">
      <button
        className="channel-dialog-scrim"
        type="button"
        aria-label={props.text.live.cancel}
        onClick={props.onCancel}
      />
      <form
        className={`channel-dialog ${draft ? 'has-preview' : 'is-url-only'}`}
        onSubmit={(event) => {
          event.preventDefault()
          if (props.state.kind === 'add' && !draft) {
            props.onResolve()
            return
          }
          props.onSave()
        }}
      >
        {draft ? (
          <>
            <div className="channel-dialog-identity">
              <span className="channel-dialog-avatar">
                <AvatarImage
                  avatarDataUrl={draft.avatarDataUrl}
                  label={draft.channel || draft.title}
                />
              </span>
              <strong>{draft.channel || props.text.live.selectChannel}</strong>
              <span>{draft.description || draft.durationLabel}</span>
            </div>
            <label className="channel-dialog-title-field">
              <span>{props.text.live.channelTitle}</span>
              <input
                autoFocus
                value={props.state.title}
                placeholder={props.text.live.channelTitle}
                onChange={(event) => props.onTitleChange(event.currentTarget.value)}
              />
            </label>
            <label className="channel-dialog-column-field">
              <span>{props.text.live.channelColumn}</span>
              <select
                value={props.state.groupTitle}
                onChange={(event) => props.onGroupTitleChange(event.currentTarget.value)}
              >
                <option value="">{props.text.live.noColumn}</option>
                {columnOptions.map((column) => (
                  <option key={column.id} value={column.title}>
                    {column.title}
                  </option>
                ))}
              </select>
            </label>
          </>
        ) : (
          <label className="channel-dialog-url-field">
            <input
              autoFocus
              value={props.state.kind === 'add' ? props.state.url : ''}
              placeholder={props.text.live.addChannelPlaceholder}
              onChange={(event) => props.onUrlChange(event.currentTarget.value)}
            />
          </label>
        )}
        {props.state.error ? <div className="channel-dialog-error">{props.state.error}</div> : null}
        <div className="channel-dialog-actions">
          <button className="channel-dialog-button" type="button" onClick={props.onCancel}>
            {props.text.live.closeDialog}
          </button>
          <button
            className="channel-dialog-button is-primary"
            type="submit"
            disabled={resolving || saving}
          >
            {resolving || saving ? <Loader2 size={14} className="spin" /> : null}
            <span>{primaryLabel}</span>
          </button>
        </div>
      </form>
    </div>
  )
}

function ChannelColumnsDialog(props: {
  columns: LiveChannelColumn[]
  text: TextBundle
  onAddColumn: (title: string) => Promise<void>
  onCancel: () => void
  onRemoveColumn: (column: LiveChannelColumn) => Promise<void>
  onUpdateColumn: (column: LiveChannelColumn, title: string) => Promise<void>
}): JSX.Element {
  const [draftTitle, setDraftTitle] = useState('')
  const [edits, setEdits] = useState<Record<string, string>>({})
  const [busyId, setBusyId] = useState('')
  const [confirmRemoveId, setConfirmRemoveId] = useState('')
  const [error, setError] = useState('')
  const updateColumns = props.columns.filter((column) => column.source === 'updates')
  const customColumns = props.columns.filter((column) => column.source === 'custom')

  async function addColumn(): Promise<void> {
    const title = draftTitle.trim()
    if (!title) {
      setError(props.text.live.columnTitleRequired)
      return
    }
    setBusyId('new')
    setError('')
    try {
      await props.onAddColumn(title)
      setDraftTitle('')
    } catch (nextError) {
      setError(resolveColumnError(nextError, props.text))
    } finally {
      setBusyId('')
    }
  }

  async function updateColumn(column: LiveChannelColumn): Promise<void> {
    const title = (edits[column.id] ?? column.title).trim()
    if (!title) {
      setError(props.text.live.columnTitleRequired)
      return
    }
    setBusyId(column.id)
    setError('')
    try {
      await props.onUpdateColumn(column, title)
      setEdits((current) => {
        const next = { ...current }
        delete next[column.id]
        return next
      })
    } catch (nextError) {
      setError(resolveColumnError(nextError, props.text))
    } finally {
      setBusyId('')
    }
  }

  async function removeColumn(column: LiveChannelColumn): Promise<void> {
    if (confirmRemoveId !== column.id) {
      setConfirmRemoveId(column.id)
      return
    }
    setBusyId(column.id)
    setError('')
    try {
      await props.onRemoveColumn(column)
      setConfirmRemoveId('')
    } catch (nextError) {
      setError(resolveColumnError(nextError, props.text))
    } finally {
      setBusyId('')
    }
  }

  return (
    <div className="channel-dialog-backdrop">
      <button
        className="channel-dialog-scrim"
        type="button"
        aria-label={props.text.live.cancel}
        onClick={props.onCancel}
      />
      <section className="channel-dialog column-dialog" role="dialog">
        <header className="column-dialog-header">
          <strong>{props.text.live.manageColumns}</strong>
        </header>
        <label className="column-dialog-add-row">
          <input
            autoFocus
            value={draftTitle}
            placeholder={props.text.live.customColumnPlaceholder}
            onChange={(event) => {
              setDraftTitle(event.currentTarget.value)
              setError('')
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                void addColumn()
              }
            }}
          />
          <button
            className="panel-icon-button"
            type="button"
            aria-label={props.text.live.addColumn}
            disabled={busyId === 'new'}
            onClick={() => void addColumn()}
          >
            {busyId === 'new' ? <Loader2 size={14} className="spin" /> : <Plus size={14} />}
          </button>
        </label>

        <div className="column-dialog-section">
          <h3>{props.text.live.builtInColumns}</h3>
          <div className="column-dialog-list">
            {updateColumns.length > 0 ? (
              updateColumns.map((column) => (
                <div key={column.id} className="column-dialog-row is-readonly">
                  <span>{column.title}</span>
                  <em>{column.channelCount}</em>
                  <small>{props.text.live.readonlyColumn}</small>
                </div>
              ))
            ) : (
              <div className="column-dialog-empty">{props.text.live.noColumns}</div>
            )}
          </div>
        </div>

        <div className="column-dialog-section">
          <h3>{props.text.live.customColumns}</h3>
          <div className="column-dialog-list">
            {customColumns.length > 0 ? (
              customColumns.map((column) => {
                const value = edits[column.id] ?? column.title
                const changed = value.trim() !== column.title
                const busy = busyId === column.id
                const confirming = confirmRemoveId === column.id
                return (
                  <div key={column.id} className="column-dialog-row">
                    <input
                      value={value}
                      onChange={(event) => {
                        setEdits((current) => ({
                          ...current,
                          [column.id]: event.currentTarget.value
                        }))
                        setError('')
                      }}
                    />
                    <em>{column.channelCount}</em>
                    <button
                      className="panel-icon-button"
                      type="button"
                      aria-label={props.text.live.saveColumn}
                      disabled={!changed || busy}
                      onClick={() => void updateColumn(column)}
                    >
                      {busy && changed ? (
                        <Loader2 size={13} className="spin" />
                      ) : (
                        <Check size={13} />
                      )}
                    </button>
                    <button
                      className={`panel-icon-button is-danger ${confirming ? 'is-confirming' : ''}`}
                      type="button"
                      aria-label={
                        confirming
                          ? props.text.live.confirmRemoveChannel
                          : props.text.live.removeColumn
                      }
                      disabled={busy}
                      onClick={() => void removeColumn(column)}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                )
              })
            ) : (
              <div className="column-dialog-empty">{props.text.live.noColumns}</div>
            )}
          </div>
        </div>

        {error ? <div className="channel-dialog-error">{error}</div> : null}
        <div className="channel-dialog-actions is-single">
          <button
            className="channel-dialog-button is-primary"
            type="button"
            onClick={props.onCancel}
          >
            {props.text.live.closeDialog}
          </button>
        </div>
      </section>
    </div>
  )
}

function ChannelDrawer(props: {
  open: boolean
  height: number
  closeLabel: string
  resizeLabel: string
  children: JSX.Element
  onOpenChange: (open: boolean) => void
  onHeightChange: (height: number) => void
}): JSX.Element {
  const dragStartRef = useRef<{ startY: number; startHeight: number } | null>(null)

  if (!props.open) {
    return <></>
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLButtonElement>): void {
    dragStartRef.current = {
      startY: event.clientY,
      startHeight: props.height
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLButtonElement>): void {
    const start = dragStartRef.current
    if (!start) {
      return
    }
    const nextHeight = clamp(
      start.startHeight + start.startY - event.clientY,
      CHANNEL_DRAWER_MIN_HEIGHT,
      getMaxChannelDrawerHeight()
    )
    props.onHeightChange(nextHeight)
  }

  function handlePointerUp(): void {
    dragStartRef.current = null
  }

  return (
    <div className="channel-drawer-backdrop is-open">
      <button
        className="drawer-scrim"
        type="button"
        aria-label={props.closeLabel}
        onClick={() => props.onOpenChange(false)}
      />
      <div className="channel-drawer" style={{ height: props.height }}>
        <button
          className="drawer-handle"
          type="button"
          aria-label={props.resizeLabel}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
        >
          <span />
        </button>
        {props.children}
      </div>
    </div>
  )
}

function ChannelGroup(props: {
  channels: LiveChannel[]
  confirmingRemoveId: string
  selectedId: string
  statuses: Record<string, LiveStatus>
  text: TextBundle
  onSelect: (channel: LiveChannel) => void
  onEdit?: (channel: LiveChannel) => void
  onRemove?: (channel: LiveChannel) => void
}): JSX.Element | null {
  if (props.channels.length === 0) {
    return null
  }
  return (
    <section className="channel-group">
      <div className="channel-items">
        {props.channels.map((channel) => {
          const custom = channel.source === 'custom'
          const hasActions = custom && (props.onEdit || props.onRemove)
          const confirmingRemove = props.confirmingRemoveId === channel.id
          return (
            <button
              key={channel.id}
              className={`channel-item ${channel.id === props.selectedId ? 'is-selected' : ''} ${
                hasActions ? 'has-actions' : ''
              }`}
              type="button"
              onClick={() => props.onSelect(channel)}
            >
              <ChannelAvatar channel={channel} />
              <span className="channel-item-copy">
                <strong>{channel.title}</strong>
                <span className="channel-item-meta">
                  <small>{channel.channel}</small>
                </span>
              </span>
              <span className="channel-item-trailing">
                <LiveStatusBadge
                  status={props.statuses[channel.videoId]?.status ?? 'checking'}
                  text={props.text}
                />
                {hasActions ? (
                  <span className="channel-row-actions">
                    {props.onEdit ? (
                      <span
                        role="button"
                        tabIndex={0}
                        className="channel-row-action"
                        aria-label={props.text.live.editChannel}
                        onClick={(event) => {
                          event.stopPropagation()
                          props.onEdit?.(channel)
                        }}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault()
                            event.stopPropagation()
                            props.onEdit?.(channel)
                          }
                        }}
                      >
                        <Pencil size={13} />
                      </span>
                    ) : null}
                    {props.onRemove ? (
                      <span
                        role="button"
                        tabIndex={0}
                        className={`channel-row-action is-danger ${
                          confirmingRemove ? 'is-confirming' : ''
                        }`}
                        aria-label={
                          confirmingRemove
                            ? props.text.live.confirmRemoveChannel
                            : props.text.live.removeChannel
                        }
                        title={
                          confirmingRemove
                            ? props.text.live.confirmRemoveChannel
                            : props.text.live.removeChannel
                        }
                        onClick={(event) => {
                          event.stopPropagation()
                          props.onRemove?.(channel)
                        }}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault()
                            event.stopPropagation()
                            props.onRemove?.(channel)
                          }
                        }}
                      >
                        <Trash2 size={14} />
                      </span>
                    ) : null}
                  </span>
                ) : null}
              </span>
            </button>
          )
        })}
      </div>
    </section>
  )
}

function LiveProgress(props: {
  state: LivePlaybackState
  text: TextBundle
  compact?: boolean
}): JSX.Element {
  const label = playbackLabel(props.state, props.text)
  return (
    <div
      className={`live-progress ${props.compact ? 'is-compact' : ''}`}
      data-state={props.state}
      title={props.compact ? undefined : label}
      aria-label={label}
    >
      <div className="live-progress-bar">
        <span />
      </div>
      <strong>{label}</strong>
    </div>
  )
}

function ChannelAvatar(props: { channel: LiveChannel | null }): JSX.Element {
  const channel = props.channel
  return (
    <AvatarImage
      avatarDataUrl={channel?.avatarDataUrl ?? ''}
      label={channel?.channel || channel?.title || 'FM'}
    />
  )
}

function AvatarImage(props: { avatarDataUrl: string; label: string }): JSX.Element {
  if (props.avatarDataUrl) {
    return <img src={props.avatarDataUrl} alt="" draggable={false} />
  }
  const initials = (props.label || 'FM').slice(0, 2).toUpperCase()
  return <span className="avatar-fallback">{initials}</span>
}

function LiveStatusBadge(props: { status: LiveStatusValue; text: TextBundle }): JSX.Element {
  return (
    <span className={`live-status-badge is-${props.status}`}>
      {props.status === 'checking' ? <Loader2 size={12} className="spin" /> : <Radio size={12} />}
      <span>{liveStatusLabel(props.status, props.text)}</span>
    </span>
  )
}

function VideoStatusText(props: { status: LiveStatusValue; text: TextBundle }): JSX.Element {
  const label = liveStatusLabel(props.status, props.text)
  return (
    <span className={`video-status-text is-${props.status}`} title={label}>
      {props.status === 'checking' ? (
        <Loader2 size={13} className="spin" />
      ) : props.status === 'unavailable' || props.status === 'unknown' ? (
        <AlertCircle size={13} />
      ) : (
        <Radio size={13} />
      )}
      <span>{label}</span>
    </span>
  )
}

function VideoStatusCluster(props: {
  liveStatus: LiveStatusValue
  playbackState: LivePlaybackState
  text: TextBundle
}): JSX.Element {
  const playback = playbackLabel(props.playbackState, props.text)
  const live = liveStatusLabel(props.liveStatus, props.text)
  return (
    <div className="video-status-cluster" aria-label={`${playback} ${live}`}>
      <span className={`video-playback-status is-${props.playbackState}`} title={playback}>
        {props.playbackState === 'loading' ? (
          <Loader2 size={12} className="spin" />
        ) : props.playbackState === 'playing' ? (
          <Play size={12} fill="currentColor" />
        ) : props.playbackState === 'paused' ? (
          <Pause size={12} />
        ) : props.playbackState === 'error' ? (
          <AlertCircle size={12} />
        ) : (
          <Radio size={12} />
        )}
        <span>{playback}</span>
      </span>
      <VideoStatusText status={props.liveStatus} text={props.text} />
    </div>
  )
}

function AudioVolumeControl(props: {
  muted: boolean
  volume: number
  text: TextBundle
  onToggleMute: () => void
  onVolumeChange: (value: number) => void
}): JSX.Element {
  const muted = props.muted || props.volume <= 0
  function handleToggleMute(): void {
    if (muted && props.volume <= 0) {
      props.onVolumeChange(0.82)
      return
    }
    props.onToggleMute()
  }

  return (
    <div className="audio-volume">
      <IconButton
        className="panel-icon-button audio-control-button"
        label={muted ? props.text.live.unmute : props.text.live.mute}
        onClick={handleToggleMute}
      >
        {muted ? <VolumeX size={16} /> : <Volume2 size={16} />}
      </IconButton>
      <div className="audio-volume-slider">
        <VolumeSlider
          className="is-vertical"
          value={props.muted ? 0 : props.volume}
          text={props.text}
          onVolumeChange={props.onVolumeChange}
        />
      </div>
    </div>
  )
}

function VideoVolumeControl(props: {
  muted: boolean
  volume: number
  text: TextBundle
  onToggleMute: () => void
  onVolumeChange: (value: number) => void
}): JSX.Element {
  return (
    <div className="video-volume">
      <IconButton
        label={props.muted ? props.text.live.unmute : props.text.live.mute}
        onClick={props.onToggleMute}
      >
        {props.muted || props.volume <= 0 ? <VolumeX size={17} /> : <Volume2 size={17} />}
      </IconButton>
      <div className="video-volume-slider">
        <VolumeSlider
          className="is-vertical"
          value={props.muted ? 0 : props.volume}
          text={props.text}
          onVolumeChange={props.onVolumeChange}
        />
      </div>
    </div>
  )
}

function VolumeSlider(props: {
  value: number
  text: TextBundle
  className?: string
  onVolumeChange: (value: number) => void
}): JSX.Element {
  const visibleVolume = clamp(props.value, 0, 1)
  const volumePercent = Math.round(visibleVolume * 1000) / 10
  return (
    <div className={`volume-slider ${props.className ?? ''}`}>
      <div className="volume-slider-track" aria-hidden="true">
        <span style={{ width: `${volumePercent}%` }} />
      </div>
      <span
        className="volume-slider-thumb"
        aria-hidden="true"
        style={{ left: `${volumePercent}%` }}
      />
      <input
        className="volume-range"
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={visibleVolume}
        aria-label={props.text.live.volume}
        title={props.text.live.volume}
        onChange={(event) => props.onVolumeChange(Number(event.currentTarget.value))}
      />
    </div>
  )
}

function IconButton(props: {
  label: string
  className?: string
  disabled?: boolean
  children: JSX.Element
  onClick?: () => void
}): JSX.Element {
  return (
    <button
      className={props.className ?? 'icon-button'}
      type="button"
      disabled={props.disabled}
      aria-label={props.label}
      title={props.label}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  )
}

function applyChannelsSnapshot(
  snapshot: LiveChannelsSnapshot,
  setChannels: (channels: LiveChannel[]) => void,
  setCatalogUpdatedAt: (value: string) => void,
  setPlayerState: React.Dispatch<React.SetStateAction<LivePlayerState>>
): void {
  setChannels(snapshot.channels)
  setCatalogUpdatedAt(snapshot.catalogUpdatedAt)
  setPlayerState((current) => ({
    ...current,
    selectedChannelId: snapshot.selectedChannelId || current.selectedChannelId
  }))
}

function buildVideoFrameStyle(size: { width: number; height: number }): VideoFrameStyle {
  const viewportWidth = Math.max(0, size.width)
  const viewportHeight = Math.max(0, size.height)
  const availableWidth = Math.max(1, viewportWidth - VIDEO_FRAME_MARGIN_X * 2)
  const availableHeight = Math.max(
    1,
    viewportHeight - VIDEO_TOPBAR_HEIGHT - VIDEO_FRAME_MARGIN_TOP - VIDEO_FRAME_MARGIN_BOTTOM
  )

  let frameWidth = availableWidth
  let frameHeight = frameWidth / VIDEO_FRAME_ASPECT_RATIO
  if (frameHeight > availableHeight) {
    frameHeight = availableHeight
    frameWidth = frameHeight * VIDEO_FRAME_ASPECT_RATIO
  }

  const frameLeft = Math.round((viewportWidth - frameWidth) / 2)
  const frameTop = Math.round(
    VIDEO_TOPBAR_HEIGHT + VIDEO_FRAME_MARGIN_TOP + (availableHeight - frameHeight) / 2
  )

  return {
    '--video-topbar-height': `${VIDEO_TOPBAR_HEIGHT}px`,
    '--video-frame-left': `${frameLeft}px`,
    '--video-frame-top': `${frameTop}px`,
    '--video-frame-width': `${Math.round(frameWidth)}px`,
    '--video-frame-height': `${Math.round(frameHeight)}px`
  }
}

function buildYouTubeEmbedUrl(videoId: string, autoplayNonce = 0): string {
  if (!videoId) {
    return ''
  }
  const params = new URLSearchParams({
    controls: '1',
    enablejsapi: '1',
    fs: '1',
    iv_load_policy: '3',
    modestbranding: '1',
    origin: YOUTUBE_CLIENT_ORIGIN,
    playsinline: '1',
    rel: '0',
    widget_referrer: YOUTUBE_CLIENT_ORIGIN
  })
  if (autoplayNonce > 0) {
    params.set('autoplay', '1')
    params.set('mute', '0')
    params.set('hush_play', String(autoplayNonce))
  }
  return `https://www.youtube.com/embed/${encodeURIComponent(videoId)}?${params.toString()}`
}

function runYouTubeCommand(
  webview: Electron.WebviewTag | null,
  command: string,
  args: unknown[] = []
): void {
  if (!webview) {
    return
  }
  try {
    void webview
      .executeJavaScript(buildYouTubeCommandScript(command, args), true)
      .catch(() => undefined)
  } catch {
    // Electron throws synchronously if the webview has not emitted dom-ready yet.
  }
}

function buildYouTubeCommandScript(command: string, args: unknown[]): string {
  const payload = JSON.stringify({ command, args })
  return `
    (() => {
      const payload = ${payload};
      const command = payload.command;
      const args = Array.isArray(payload.args) ? payload.args : [];
      const state = window.__hushLiveControlState || (window.__hushLiveControlState = {
        volume: 82,
        muted: false,
        playTimer: 0,
        playAttempts: 0
      });
      const maxPlayAttempts = 32;
      const playIntervalMs = 350;

      function playerApi() {
        return document.getElementById('movie_player') || null;
      }

      function videoElements() {
        return Array.from(document.querySelectorAll('video'));
      }

      function videoElement() {
        const videos = videoElements();
        return videos.find((item) => !item.paused && !item.ended) ||
          videos.find((item) => item.readyState > 0) ||
          videos[0] ||
          null;
      }

      function playerStateCode() {
        const api = playerApi();
        if (!api || typeof api.getPlayerState !== 'function') {
          return null;
        }
        try {
          const value = Number(api.getPlayerState());
          return Number.isFinite(value) ? value : null;
        } catch {
          return null;
        }
      }

      function applyVolume(nextVolume, nextMuted) {
        if (Number.isFinite(Number(nextVolume))) {
          state.volume = Math.max(0, Math.min(100, Number(nextVolume)));
        }
        if (typeof nextMuted === 'boolean') {
          state.muted = nextMuted;
        }

        const normalizedVolume = state.volume / 100;
        videoElements().forEach((item) => {
          try {
            item.volume = normalizedVolume;
            item.muted = state.muted;
          } catch {}
        });

        const api = playerApi();
        if (api && typeof api.setVolume === 'function') {
          try {
            api.setVolume(Math.round(state.volume));
          } catch {}
        }
        if (api && typeof api.mute === 'function' && typeof api.unMute === 'function') {
          try {
            if (state.muted) {
              api.mute();
            } else {
              api.unMute();
            }
          } catch {}
        }
      }

      function isPlaying() {
        if (playerStateCode() === 1) {
          return true;
        }
        const current = videoElement();
        return Boolean(current && !current.paused && !current.ended);
      }

      function clearPlayTimer() {
        if (!state.playTimer) {
          return;
        }
        window.clearInterval(state.playTimer);
        state.playTimer = 0;
        state.playAttempts = 0;
      }

      function playOnce() {
        applyVolume();
        const api = playerApi();
        let requested = false;
        if (api && typeof api.playVideo === 'function') {
          try {
            api.playVideo();
            requested = true;
          } catch {}
        }

        const current = videoElement();
        if (current) {
          try {
            const result = current.play();
            requested = true;
            if (result && typeof result.catch === 'function') {
              result.catch(() => undefined);
            }
          } catch {}
        }
        applyVolume();
        return requested;
      }

      function schedulePlay() {
        clearPlayTimer();
        playOnce();
        if (isPlaying()) {
          return true;
        }
        state.playTimer = window.setInterval(() => {
          if (isPlaying()) {
            applyVolume();
            clearPlayTimer();
            return;
          }
          state.playAttempts += 1;
          playOnce();
          if (state.playAttempts >= maxPlayAttempts) {
            clearPlayTimer();
          }
        }, playIntervalMs);
        return true;
      }

      function pauseAll() {
        clearPlayTimer();
        const api = playerApi();
        if (api && typeof api.pauseVideo === 'function') {
          try {
            api.pauseVideo();
          } catch {}
        }
        videoElements().forEach((item) => {
          try {
            item.pause();
          } catch {}
        });
        return true;
      }

      if (command === 'playVideo') {
        return schedulePlay();
      }
      if (command === 'pauseVideo') {
        return pauseAll();
      }
      if (command === 'stopVideo') {
        clearPlayTimer();
        const api = playerApi();
        if (api && typeof api.stopVideo === 'function') {
          try {
            api.stopVideo();
            return true;
          } catch {}
        }
        pauseAll();
        return true;
      }
      if (command === 'setVolume') {
        applyVolume(Math.max(0, Math.min(100, Number(args[0] || 0))), state.muted);
        return true;
      }
      if (command === 'mute') {
        applyVolume(state.volume, true);
        return true;
      }
      if (command === 'unMute') {
        applyVolume(state.volume, false);
        return true;
      }
      return false;
    })();
  `
}

function playbackLabel(state: LivePlaybackState, text: TextBundle): string {
  switch (state) {
    case 'loading':
      return text.live.statusLoading
    case 'ready':
      return text.live.statusReady
    case 'playing':
      return text.live.statusPlaying
    case 'paused':
      return text.live.statusPaused
    case 'stopped':
      return text.live.statusStopped
    case 'error':
      return text.live.statusError
    default:
      return text.live.statusIdle
  }
}

function liveStatusLabel(status: LiveStatusValue, text: TextBundle): string {
  switch (status) {
    case 'live':
      return text.live.liveStatusLive
    case 'offline':
      return text.live.liveStatusOffline
    case 'upcoming':
      return text.live.liveStatusUpcoming
    case 'unavailable':
      return text.live.liveStatusUnavailable
    case 'checking':
      return text.live.liveStatusChecking
    default:
      return text.live.liveStatusUnknown
  }
}

function resolveAddChannelError(error: unknown, text: TextBundle): string {
  const message = error instanceof Error ? error.message : String(error)
  if (/not a live/i.test(message)) {
    return text.live.linkNotLive
  }
  if (/invalid/i.test(message)) {
    return text.live.linkInvalid
  }
  return message || text.live.linkInvalid
}

function resolveColumnError(error: unknown, text: TextBundle): string {
  const message = error instanceof Error ? error.message : String(error)
  if (/already exists/i.test(message)) {
    return text.live.columnAlreadyExists
  }
  if (/required/i.test(message)) {
    return text.live.columnTitleRequired
  }
  return message || text.live.columnTitleRequired
}

function liveChannelToDraft(channel: LiveChannel): LiveChannelDraft {
  return {
    videoId: channel.videoId,
    title: channel.title,
    channel: channel.channel,
    groupTitle: channel.groupTitle,
    description: channel.description,
    durationLabel: channel.durationLabel,
    thumbnailUrl: channel.thumbnailUrl,
    avatarDataUrl: channel.avatarDataUrl
  }
}

function normalizeChannelQuery(value: string): string {
  return value.trim().toLocaleLowerCase()
}

function channelFilterLabel(filter: ChannelFilter, text: TextBundle): string {
  if (isChannelGroupFilter(filter)) {
    return channelGroupFilterLabel(filter)
  }
  return text.live.allChannels
}

function channelMatchesQuery(channel: LiveChannel, query: string): boolean {
  if (!query) {
    return true
  }
  return [channel.title, channel.channel, channel.groupTitle, channel.description, channel.videoId]
    .join(' ')
    .toLocaleLowerCase()
    .includes(query)
}

function channelMatchesFilter(channel: LiveChannel, filter: ChannelFilter): boolean {
  if (filter === 'all') {
    return true
  }
  return channelGroupFilterId(channel.groupTitle) === filter
}

function channelGroupFilterId(groupTitle: string): ChannelGroupFilter {
  return `${CHANNEL_GROUP_FILTER_PREFIX}${encodeURIComponent(groupTitle)}` as ChannelGroupFilter
}

function isChannelGroupFilter(filter: ChannelFilter): filter is ChannelGroupFilter {
  return filter.startsWith(CHANNEL_GROUP_FILTER_PREFIX)
}

function channelGroupFilterLabel(filter: ChannelGroupFilter): string {
  return decodeURIComponent(filter.slice(CHANNEL_GROUP_FILTER_PREFIX.length))
}

function filterGroupTitle(filter: ChannelFilter): string {
  return isChannelGroupFilter(filter) ? channelGroupFilterLabel(filter) : ''
}

function uniqueChannelColumns(columns: LiveChannelColumn[]): LiveChannelColumn[] {
  const seen = new Set<string>()
  const result: LiveChannelColumn[] = []
  for (const column of columns) {
    const key = normalizeChannelQuery(column.title)
    if (!key || seen.has(key)) {
      continue
    }
    seen.add(key)
    result.push(column)
  }
  return result
}

function channelDialogColumnOptions(
  columns: LiveChannelColumn[],
  currentGroupTitle: string
): LiveChannelColumn[] {
  const result = uniqueChannelColumns(columns)
  const current = currentGroupTitle.trim()
  if (
    current &&
    !result.some((column) => normalizeChannelQuery(column.title) === normalizeChannelQuery(current))
  ) {
    result.push({
      id: `current:${encodeURIComponent(current)}`,
      source: 'custom',
      title: current,
      channelCount: 0
    })
  }
  return result
}

function getDialogRequiredDrawerHeight(dialogElement: HTMLElement): number {
  const backdropElement = dialogElement.closest<HTMLElement>('.channel-dialog-backdrop')
  const backdropStyle = backdropElement ? window.getComputedStyle(backdropElement) : null
  const paddingTop = backdropStyle ? Number.parseFloat(backdropStyle.paddingTop) || 0 : 0
  const paddingBottom = backdropStyle ? Number.parseFloat(backdropStyle.paddingBottom) || 0 : 0
  return Math.ceil(dialogElement.getBoundingClientRect().height + paddingTop + paddingBottom)
}

function clampChannelDrawerHeight(height: number): number {
  return clamp(height, CHANNEL_DRAWER_MIN_HEIGHT, getMaxChannelDrawerHeight())
}

function getMaxChannelDrawerHeight(): number {
  return Math.max(CHANNEL_DRAWER_MIN_HEIGHT, window.innerHeight)
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min
  }
  return Math.min(Math.max(value, min), max)
}

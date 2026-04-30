import { app } from 'electron'
import Database from 'better-sqlite3'
import { randomUUID } from 'crypto'
import { mkdirSync } from 'fs'
import { dirname, join } from 'path'

import type { AppliedMigration, DatabaseHealth } from '../shared/database'
import type {
  LiveAudioLayout,
  LiveChannel,
  LiveChannelColumn,
  LiveChannelColumnSource,
  LiveChannelInput,
  LiveChannelSource,
  LivePlayerMode,
  LivePlayerState,
  LivePlayerStatePatch
} from '../shared/live'
import { DEFAULT_LIVE_CHANNELS } from '../shared/live-defaults'

interface Migration {
  id: number
  name: string
  up: (database: Database.Database) => void
}

interface SqliteVersionRow {
  version: string
}

interface UserVersionRow {
  user_version: number
}

interface JournalModeRow {
  journal_mode: string
}

interface MigrationRow {
  id: number
  name: string
  applied_at: string
}

interface CountRow {
  count: number
}

interface SqliteMasterRow {
  name: string
}

interface LiveChannelRow {
  id: string
  source: LiveChannelSource
  video_id: string
  title: string
  channel: string
  group_title: string
  description: string
  duration_label: string
  thumbnail_url: string
  avatar_blob: Buffer | null
  avatar_mime: string
  created_at: string
  updated_at: string
}

interface LiveAvatarRow {
  id: string
  avatar_source_url: string
  avatar_blob: Buffer | null
}

interface LivePreferenceRow {
  value: string
}

interface LiveChannelColumnRow {
  id: string
  title: string
  channel_count: number
}

interface LiveChannelColumnCountRow {
  title: string
  channel_count: number
  first_sort_order: number
}

interface MaxSortOrderRow {
  sort_order: number
}

const DEFAULT_LIVE_PLAYER_STATE: LivePlayerState = {
  selectedChannelId: '',
  playerMode: 'audio',
  audioLayout: 'single',
  muted: false,
  volume: 0.82,
  drawerHeight: 420
}

const MIGRATIONS: Migration[] = [
  {
    id: 1,
    name: 'create_live_channels',
    up: (database) => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS live_channels (
          id TEXT PRIMARY KEY,
          source TEXT NOT NULL CHECK (source IN ('updates', 'custom')),
          video_id TEXT NOT NULL UNIQUE,
          title TEXT NOT NULL,
          channel TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          duration_label TEXT NOT NULL DEFAULT 'LIVE',
          thumbnail_url TEXT NOT NULL DEFAULT '',
          avatar_source_url TEXT NOT NULL DEFAULT '',
          avatar_blob BLOB,
          avatar_mime TEXT NOT NULL DEFAULT '',
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_live_channels_source_sort
          ON live_channels (source, sort_order, title);

        CREATE TABLE IF NOT EXISTS live_preferences (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
      `)
    }
  },
  {
    id: 2,
    name: 'add_live_channel_group_title',
    up: (database) => {
      ensureLiveChannelColumn(
        database,
        'group_title',
        `
        ALTER TABLE live_channels
          ADD COLUMN group_title TEXT NOT NULL DEFAULT '';
        `
      )
    }
  },
  {
    id: 3,
    name: 'create_live_channel_groups',
    up: (database) => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS live_channel_groups (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL COLLATE NOCASE UNIQUE,
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
      `)
    }
  }
]

export class AppDatabase {
  private database: Database.Database | null = null

  constructor(private readonly databasePath = defaultDatabasePath()) {}

  initialize(): void {
    if (this.database?.open) {
      return
    }

    mkdirSync(dirname(this.databasePath), { recursive: true })
    this.database = new Database(this.databasePath)
    this.applyPragmas()
    this.cleanupEmptyMigrationTable()
    this.applyMigrations()
    this.ensureLiveSchema()
    this.seedDefaultLiveChannels()
  }

  getHealth(): DatabaseHealth {
    const database = this.requireDatabase()
    const sqliteVersion = database
      .prepare<[], SqliteVersionRow>('SELECT sqlite_version() AS version')
      .get()?.version
    const userVersion = database
      .prepare<[], UserVersionRow>('PRAGMA user_version')
      .get()?.user_version
    const journalMode = database
      .prepare<[], JournalModeRow>('PRAGMA journal_mode')
      .get()?.journal_mode

    return {
      path: this.databasePath,
      open: database.open,
      sqliteVersion: sqliteVersion ?? '',
      userVersion: userVersion ?? 0,
      journalMode: journalMode ?? '',
      migrations: this.listMigrations()
    }
  }

  close(): void {
    if (!this.database?.open) {
      return
    }
    this.database.close()
  }

  listLiveChannels(): LiveChannel[] {
    const rows = this.requireDatabase()
      .prepare<[], LiveChannelRow>(
        `
        SELECT
          id,
          source,
          video_id,
          title,
          channel,
          group_title,
          description,
          duration_label,
          thumbnail_url,
          avatar_blob,
          avatar_mime,
          created_at,
          updated_at
        FROM live_channels
        ORDER BY
          CASE source WHEN 'updates' THEN 0 ELSE 1 END,
          sort_order ASC,
          title COLLATE NOCASE ASC
        `
      )
      .all()

    return rows.map((row) => liveChannelFromRow(row))
  }

  listLiveChannelColumns(): LiveChannelColumn[] {
    const database = this.requireDatabase()
    const updateRows = database
      .prepare<[], LiveChannelColumnCountRow>(
        `
        SELECT
          channels.group_title AS title,
          COUNT(*) AS channel_count,
          MIN(
            CASE channels.source
              WHEN 'updates' THEN channels.sort_order
              ELSE 1000000000
            END
          ) AS first_sort_order
        FROM live_channels channels
        WHERE TRIM(channels.group_title) <> ''
          AND EXISTS (
            SELECT 1
            FROM live_channels builtin
            WHERE builtin.source = 'updates'
              AND builtin.group_title = channels.group_title COLLATE NOCASE
          )
        GROUP BY channels.group_title
        ORDER BY first_sort_order ASC, title COLLATE NOCASE ASC
        `
      )
      .all()
    const customCounts = new Map(
      database
        .prepare<[], LiveChannelColumnCountRow>(
          `
          SELECT
            group_title AS title,
            COUNT(*) AS channel_count,
            MIN(sort_order) AS first_sort_order
          FROM live_channels
          WHERE source = 'custom'
            AND TRIM(group_title) <> ''
          GROUP BY group_title
          `
        )
        .all()
        .map((row) => [columnTitleKey(row.title), row.channel_count])
    )
    const customRows = database
      .prepare<[], LiveChannelColumnRow>(
        `
        SELECT
          id,
          title,
          0 AS channel_count
        FROM live_channel_groups
        ORDER BY sort_order ASC, title COLLATE NOCASE ASC
        `
      )
      .all()

    return [
      ...updateRows.map((row) =>
        liveChannelColumnFromParts(
          'updates',
          `updates:${encodeURIComponent(row.title)}`,
          row.title,
          row.channel_count
        )
      ),
      ...customRows.map((row) =>
        liveChannelColumnFromParts(
          'custom',
          row.id,
          row.title,
          customCounts.get(columnTitleKey(row.title)) ?? 0
        )
      )
    ]
  }

  addCustomLiveChannelColumn(title: string): LiveChannelColumn[] {
    const normalizedTitle = sanitizeString(title)
    if (!normalizedTitle) {
      throw new Error('Column title is required')
    }
    const database = this.requireDatabase()
    this.assertLiveChannelColumnTitleAvailable(normalizedTitle)
    const nextSortOrder =
      database
        .prepare<
          [],
          MaxSortOrderRow
        >('SELECT COALESCE(MAX(sort_order), 0) + 10 AS sort_order FROM live_channel_groups')
        .get()?.sort_order ?? 10
    database
      .prepare<[string, string, number]>(
        `
        INSERT INTO live_channel_groups (id, title, sort_order, updated_at)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP)
        `
      )
      .run(`custom-column-${randomUUID()}`, normalizedTitle, nextSortOrder)
    return this.listLiveChannelColumns()
  }

  updateCustomLiveChannelColumn(id: string, title: string): LiveChannelColumn[] {
    const normalizedId = sanitizeString(id)
    const normalizedTitle = sanitizeString(title)
    if (!normalizedId || !normalizedTitle) {
      throw new Error('Column title is required')
    }
    const database = this.requireDatabase()
    const existing = this.getCustomLiveChannelColumn(normalizedId)
    if (!existing) {
      throw new Error('Column was not found')
    }
    this.assertLiveChannelColumnTitleAvailable(normalizedTitle, normalizedId)
    const transaction = database.transaction(() => {
      database
        .prepare<[string, string]>(
          `
          UPDATE live_channel_groups
          SET title = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
          `
        )
        .run(normalizedTitle, normalizedId)
      database
        .prepare<[string, string]>(
          `
          UPDATE live_channels
          SET group_title = ?, updated_at = CURRENT_TIMESTAMP
          WHERE source = 'custom'
            AND group_title = ? COLLATE NOCASE
          `
        )
        .run(normalizedTitle, existing.title)
    })
    transaction()
    return this.listLiveChannelColumns()
  }

  removeCustomLiveChannelColumn(id: string): LiveChannelColumn[] {
    const normalizedId = sanitizeString(id)
    if (!normalizedId) {
      throw new Error('Column was not found')
    }
    const database = this.requireDatabase()
    const existing = this.getCustomLiveChannelColumn(normalizedId)
    if (!existing) {
      throw new Error('Column was not found')
    }
    const transaction = database.transaction(() => {
      database.prepare<[string]>('DELETE FROM live_channel_groups WHERE id = ?').run(normalizedId)
      database
        .prepare<[string]>(
          `
          UPDATE live_channels
          SET group_title = '', updated_at = CURRENT_TIMESTAMP
          WHERE source = 'custom'
            AND group_title = ? COLLATE NOCASE
          `
        )
        .run(existing.title)
    })
    transaction()
    return this.listLiveChannelColumns()
  }

  listLiveChannelsMissingAvatars(limit = 24): Array<{ id: string; avatarSourceUrl: string }> {
    return this.requireDatabase()
      .prepare<[], LiveAvatarRow>(
        `
        SELECT id, avatar_source_url, avatar_blob
        FROM live_channels
        WHERE TRIM(avatar_source_url) <> ''
          AND (
            avatar_blob IS NULL
            OR avatar_source_url GLOB '*=s[0-9]*'
            OR avatar_source_url GLOB '*=w[0-9]*'
            OR avatar_source_url GLOB '*=h[0-9]*'
          )
        ORDER BY
          CASE source WHEN 'updates' THEN 0 ELSE 1 END,
          sort_order ASC,
          title COLLATE NOCASE ASC
        LIMIT ${Math.max(1, Math.min(120, Math.trunc(limit)))}
        `
      )
      .all()
      .map((row) => ({ id: row.id, avatarSourceUrl: row.avatar_source_url }))
  }

  replaceUpdateLiveChannels(channels: LiveChannelInput[]): void {
    const normalized = channels
      .map((channel, index) => normalizeLiveChannelInput(channel, 'updates', index))
      .filter((channel) => channel.id && channel.videoId)
    const database = this.requireDatabase()
    const upsert = this.prepareUpsertLiveChannel()
    const transaction = database.transaction((items: LiveChannelInput[]) => {
      for (const item of items) {
        runLiveChannelUpsert(upsert, item)
      }
      const ids = items.map((channel) => channel.id)
      if (ids.length > 0) {
        database
          .prepare(
            `
            DELETE FROM live_channels
            WHERE source = 'updates'
              AND id NOT IN (${ids.map(() => '?').join(',')})
            `
          )
          .run(...ids)
      }
    })
    transaction(normalized)
  }

  upsertLiveChannel(channel: LiveChannelInput): LiveChannel {
    const normalized = normalizeLiveChannelInput(channel, channel.source)
    runLiveChannelUpsert(this.prepareUpsertLiveChannel(), normalized)
    const saved = this.getLiveChannelById(normalized.id)
    if (!saved) {
      throw new Error('Live channel was not saved')
    }
    return saved
  }

  removeCustomLiveChannel(id: string): void {
    this.requireDatabase()
      .prepare<[string]>("DELETE FROM live_channels WHERE id = ? AND source = 'custom'")
      .run(id.trim())
  }

  updateCustomLiveChannel(id: string, title: string, groupTitle = ''): LiveChannel {
    const normalizedId = id.trim()
    const normalizedTitle = sanitizeString(title)
    if (!normalizedId || !normalizedTitle) {
      throw new Error('Live channel title is required')
    }
    const normalizedGroupTitle = sanitizeString(groupTitle)
    this.requireDatabase()
      .prepare<[string, string, string]>(
        `
        UPDATE live_channels
        SET
          title = ?,
          group_title = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND source = 'custom'
        `
      )
      .run(normalizedTitle, normalizedGroupTitle, normalizedId)
    const saved = this.getLiveChannelById(normalizedId)
    if (!saved || saved.source !== 'custom') {
      throw new Error('Custom live channel was not found')
    }
    return saved
  }

  getLiveChannelById(id: string): LiveChannel | null {
    const row = this.requireDatabase()
      .prepare<[string], LiveChannelRow>(
        `
        SELECT
          id,
          source,
          video_id,
          title,
          channel,
          group_title,
          description,
          duration_label,
          thumbnail_url,
          avatar_blob,
          avatar_mime,
          created_at,
          updated_at
        FROM live_channels
        WHERE id = ?
        `
      )
      .get(id.trim())
    return row ? liveChannelFromRow(row) : null
  }

  updateLiveChannelAvatar(
    id: string,
    avatar: { data: Buffer; mime: string },
    avatarSourceUrl = ''
  ): void {
    this.requireDatabase()
      .prepare<[Buffer, string, string, string]>(
        `
        UPDATE live_channels
        SET
          avatar_blob = ?,
          avatar_mime = ?,
          avatar_source_url = COALESCE(NULLIF(?, ''), avatar_source_url),
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
        `
      )
      .run(avatar.data, avatar.mime, avatarSourceUrl.trim(), id.trim())
  }

  getLivePlayerState(): LivePlayerState {
    const selectedChannelId = this.getLivePreference('selectedChannelId')
    const playerMode = sanitizeLivePlayerMode(this.getLivePreference('playerMode'))
    const audioLayout = sanitizeLiveAudioLayout(this.getLivePreference('audioLayout'))
    const muted = this.getLivePreference('muted') === 'true'
    const volume = clampNumber(
      Number(this.getLivePreference('volume')),
      0,
      1,
      DEFAULT_LIVE_PLAYER_STATE.volume
    )
    const drawerHeight = clampNumber(
      Number(this.getLivePreference('drawerHeight')),
      260,
      900,
      DEFAULT_LIVE_PLAYER_STATE.drawerHeight
    )
    const channels = this.listLiveChannels()
    const selectedExists = channels.some((channel) => channel.id === selectedChannelId)

    return {
      selectedChannelId: selectedExists ? selectedChannelId : channels[0]?.id || '',
      playerMode,
      audioLayout,
      muted,
      volume,
      drawerHeight
    }
  }

  updateLivePlayerState(patch: LivePlayerStatePatch): LivePlayerState {
    const current = this.getLivePlayerState()
    const next: LivePlayerState = {
      selectedChannelId:
        typeof patch.selectedChannelId === 'string'
          ? patch.selectedChannelId.trim()
          : current.selectedChannelId,
      playerMode:
        patch.playerMode !== undefined
          ? sanitizeLivePlayerMode(patch.playerMode)
          : current.playerMode,
      audioLayout:
        patch.audioLayout !== undefined
          ? sanitizeLiveAudioLayout(patch.audioLayout)
          : current.audioLayout,
      muted: typeof patch.muted === 'boolean' ? patch.muted : current.muted,
      volume:
        patch.volume !== undefined
          ? clampNumber(Number(patch.volume), 0, 1, current.volume)
          : current.volume,
      drawerHeight:
        patch.drawerHeight !== undefined
          ? clampNumber(Number(patch.drawerHeight), 260, 900, current.drawerHeight)
          : current.drawerHeight
    }

    const database = this.requireDatabase()
    const setPreference = database.prepare<[string, string]>(
      `
      INSERT INTO live_preferences (key, value, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = CURRENT_TIMESTAMP
      `
    )
    const transaction = database.transaction((state: LivePlayerState) => {
      setPreference.run('selectedChannelId', state.selectedChannelId)
      setPreference.run('playerMode', state.playerMode)
      setPreference.run('audioLayout', state.audioLayout)
      setPreference.run('muted', String(state.muted))
      setPreference.run('volume', String(state.volume))
      setPreference.run('drawerHeight', String(state.drawerHeight))
    })
    transaction(next)
    return this.getLivePlayerState()
  }

  private applyPragmas(): void {
    const database = this.requireDatabase()
    database.pragma('journal_mode = WAL')
    database.pragma('foreign_keys = ON')
    database.pragma('busy_timeout = 5000')
  }

  private ensureMigrationTable(): void {
    this.requireDatabase().exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `)
  }

  private applyMigrations(): void {
    if (MIGRATIONS.length === 0) {
      return
    }

    const database = this.requireDatabase()
    this.ensureMigrationTable()
    const appliedIds = new Set(this.listMigrations().map((migration) => migration.id))
    const pending = MIGRATIONS.filter((migration) => !appliedIds.has(migration.id))

    if (pending.length === 0) {
      return
    }

    const insertMigration = database.prepare<[number, string]>(
      'INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, CURRENT_TIMESTAMP)'
    )
    const migrate = database.transaction((migrations: Migration[]) => {
      for (const migration of migrations) {
        migration.up(database)
        insertMigration.run(migration.id, migration.name)
        database.pragma(`user_version = ${migration.id}`)
      }
    })

    migrate(pending)
  }

  private cleanupEmptyMigrationTable(): void {
    if (MIGRATIONS.length > 0 || !this.hasMigrationTable()) {
      return
    }

    const row = this.requireDatabase()
      .prepare<[], CountRow>('SELECT COUNT(*) AS count FROM schema_migrations')
      .get()

    if ((row?.count ?? 0) === 0) {
      this.requireDatabase().exec('DROP TABLE schema_migrations')
    }
  }

  private listMigrations(): AppliedMigration[] {
    if (!this.hasMigrationTable()) {
      return []
    }

    return this.requireDatabase()
      .prepare<[], MigrationRow>(
        'SELECT id, name, applied_at FROM schema_migrations ORDER BY id ASC'
      )
      .all()
      .map((row) => ({
        id: row.id,
        name: row.name,
        appliedAt: row.applied_at
      }))
  }

  private hasMigrationTable(): boolean {
    const row = this.requireDatabase()
      .prepare<
        [string],
        SqliteMasterRow
      >("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get('schema_migrations')
    return Boolean(row)
  }

  private seedDefaultLiveChannels(): void {
    const count = this.requireDatabase()
      .prepare<[], CountRow>("SELECT COUNT(*) AS count FROM live_channels WHERE source = 'updates'")
      .get()?.count
    if ((count ?? 0) > 0) {
      return
    }
    this.replaceUpdateLiveChannels(DEFAULT_LIVE_CHANNELS)
  }

  private ensureLiveSchema(): void {
    const database = this.requireDatabase()
    database.exec(`
      CREATE TABLE IF NOT EXISTS live_channels (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL CHECK (source IN ('updates', 'custom')),
        video_id TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        channel TEXT NOT NULL,
        group_title TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        duration_label TEXT NOT NULL DEFAULT 'LIVE',
        thumbnail_url TEXT NOT NULL DEFAULT '',
        avatar_source_url TEXT NOT NULL DEFAULT '',
        avatar_blob BLOB,
        avatar_mime TEXT NOT NULL DEFAULT '',
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `)

    ensureLiveChannelColumn(
      database,
      'group_title',
      `
      ALTER TABLE live_channels
        ADD COLUMN group_title TEXT NOT NULL DEFAULT '';
      `
    )

    database.exec(`
      CREATE INDEX IF NOT EXISTS idx_live_channels_source_sort
        ON live_channels (source, sort_order, title);

      CREATE TABLE IF NOT EXISTS live_preferences (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS live_channel_groups (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL COLLATE NOCASE UNIQUE,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `)
  }

  private getCustomLiveChannelColumn(id: string): LiveChannelColumnRow | null {
    return (
      this.requireDatabase()
        .prepare<[string], LiveChannelColumnRow>(
          `
          SELECT
            id,
            title,
            0 AS channel_count
          FROM live_channel_groups
          WHERE id = ?
          `
        )
        .get(id) ?? null
    )
  }

  private assertLiveChannelColumnTitleAvailable(title: string, currentId = ''): void {
    const database = this.requireDatabase()
    const updateCount = database
      .prepare<[string], CountRow>(
        `
        SELECT COUNT(*) AS count
        FROM live_channels
        WHERE source = 'updates'
          AND group_title = ? COLLATE NOCASE
        `
      )
      .get(title)?.count
    const customCount = database
      .prepare<[string, string], CountRow>(
        `
        SELECT COUNT(*) AS count
        FROM live_channel_groups
        WHERE title = ? COLLATE NOCASE
          AND id <> ?
        `
      )
      .get(title, currentId)?.count
    if ((updateCount ?? 0) > 0 || (customCount ?? 0) > 0) {
      throw new Error('Column already exists')
    }
  }

  private prepareUpsertLiveChannel(): Database.Statement<LiveChannelUpsertParams> {
    return this.requireDatabase().prepare<LiveChannelUpsertParams>(
      `
      INSERT INTO live_channels (
        id,
        source,
        video_id,
        title,
        channel,
        group_title,
        description,
        duration_label,
        thumbnail_url,
        avatar_source_url,
        sort_order,
        updated_at
      )
      VALUES (
        @id,
        @source,
        @videoId,
        @title,
        @channel,
        @groupTitle,
        @description,
        @durationLabel,
        @thumbnailUrl,
        @avatarSourceUrl,
        @sortOrder,
        CURRENT_TIMESTAMP
      )
      ON CONFLICT(video_id) DO UPDATE SET
        id = excluded.id,
        source = excluded.source,
        title = excluded.title,
        channel = excluded.channel,
        group_title = excluded.group_title,
        description = excluded.description,
        duration_label = excluded.duration_label,
        thumbnail_url = excluded.thumbnail_url,
        avatar_source_url = excluded.avatar_source_url,
        sort_order = excluded.sort_order,
        updated_at = CURRENT_TIMESTAMP
      `
    )
  }

  private getLivePreference(key: string): string {
    return (
      this.requireDatabase()
        .prepare<[string], LivePreferenceRow>('SELECT value FROM live_preferences WHERE key = ?')
        .get(key)?.value ?? ''
    )
  }

  private requireDatabase(): Database.Database {
    if (!this.database?.open) {
      throw new Error('Database is not initialized')
    }
    return this.database
  }
}

interface LiveChannelUpsertParams {
  id: string
  source: LiveChannelSource
  videoId: string
  title: string
  channel: string
  groupTitle: string
  description: string
  durationLabel: string
  thumbnailUrl: string
  avatarSourceUrl: string
  sortOrder: number
}

function liveChannelFromRow(row: LiveChannelRow): LiveChannel {
  return {
    id: row.id,
    source: row.source,
    videoId: row.video_id,
    title: row.title,
    channel: row.channel,
    groupTitle: row.group_title,
    description: row.description,
    durationLabel: row.duration_label,
    thumbnailUrl: row.thumbnail_url,
    avatarDataUrl: avatarDataUrl(row.avatar_blob, row.avatar_mime),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function liveChannelColumnFromParts(
  source: LiveChannelColumnSource,
  id: string,
  title: string,
  channelCount: number
): LiveChannelColumn {
  return {
    id,
    source,
    title,
    channelCount
  }
}

function avatarDataUrl(data: Buffer | null, mime: string): string {
  if (!data || data.length === 0) {
    return ''
  }
  const contentType = mime.trim() || 'image/jpeg'
  return `data:${contentType};base64,${data.toString('base64')}`
}

function normalizeLiveChannelInput(
  channel: LiveChannelInput,
  source: LiveChannelSource = channel.source,
  fallbackSortOrder = 0
): LiveChannelInput &
  Required<
    Pick<
      LiveChannelInput,
      'durationLabel' | 'thumbnailUrl' | 'avatarSourceUrl' | 'sortOrder' | 'groupTitle'
    >
  > {
  const videoId = sanitizeString(channel.videoId)
  const id = sanitizeString(channel.id) || `live-${source}-${videoId.toLowerCase()}`
  const thumbnailUrl = sanitizeString(channel.thumbnailUrl)
  return {
    ...channel,
    id,
    source,
    videoId,
    title: sanitizeString(channel.title) || videoId,
    channel: sanitizeString(channel.channel) || 'YouTube Live',
    groupTitle: sanitizeString(channel.groupTitle),
    description: sanitizeString(channel.description),
    durationLabel: sanitizeString(channel.durationLabel) || 'LIVE',
    thumbnailUrl,
    avatarSourceUrl: sanitizeString(channel.avatarSourceUrl) || thumbnailUrl,
    sortOrder:
      Number.isFinite(channel.sortOrder) && channel.sortOrder !== undefined
        ? Math.trunc(channel.sortOrder)
        : fallbackSortOrder
  }
}

function runLiveChannelUpsert(
  statement: Database.Statement<LiveChannelUpsertParams>,
  channel: LiveChannelInput
): void {
  const normalized = normalizeLiveChannelInput(channel, channel.source)
  statement.run({
    id: normalized.id,
    source: normalized.source,
    videoId: normalized.videoId,
    title: normalized.title,
    channel: normalized.channel,
    groupTitle: normalized.groupTitle,
    description: normalized.description,
    durationLabel: normalized.durationLabel,
    thumbnailUrl: normalized.thumbnailUrl,
    avatarSourceUrl: normalized.avatarSourceUrl,
    sortOrder: normalized.sortOrder
  })
}

function sanitizeLivePlayerMode(value: unknown): LivePlayerMode {
  return value === 'mini' || value === 'video' || value === 'audio'
    ? value
    : DEFAULT_LIVE_PLAYER_STATE.playerMode
}

function sanitizeLiveAudioLayout(value: unknown): LiveAudioLayout {
  return value === 'double' || value === 'single' ? value : DEFAULT_LIVE_PLAYER_STATE.audioLayout
}

function sanitizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function columnTitleKey(value: string): string {
  return value.trim().toLocaleLowerCase()
}

function clampNumber(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback
  }
  return Math.min(Math.max(value, min), max)
}

function ensureLiveChannelColumn(
  database: Database.Database,
  columnName: string,
  alterTableSql: string
): void {
  const columns = database.prepare<[], { name: string }>('PRAGMA table_info(live_channels)').all()
  if (!columns.some((column) => column.name === columnName)) {
    database.exec(alterTableSql)
  }
}

function defaultDatabasePath(): string {
  return join(app.getPath('userData'), 'database', 'hush.sqlite3')
}

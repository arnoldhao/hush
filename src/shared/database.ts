export interface AppliedMigration {
  id: number
  name: string
  appliedAt: string
}

export interface DatabaseHealth {
  path: string
  open: boolean
  sqliteVersion: string
  userVersion: number
  journalMode: string
  migrations: AppliedMigration[]
}

export interface DatabaseApi {
  getDatabaseHealth: () => Promise<DatabaseHealth>
}

export const DATABASE_CHANNELS = {
  health: 'database:health'
} as const

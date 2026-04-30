export type AppLogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface RendererLogEntry {
  level: AppLogLevel
  scope: string
  message: string
  details?: unknown
}

export interface LoggingApi {
  writeLog: (level: AppLogLevel, scope: string, message: string, details?: unknown) => void
}

export const LOGGING_CHANNELS = {
  write: 'logging:write'
} as const

export function isAppLogLevel(value: unknown): value is AppLogLevel {
  return value === 'debug' || value === 'info' || value === 'warn' || value === 'error'
}

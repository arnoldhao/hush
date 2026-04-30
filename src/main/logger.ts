import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'fs'
import { join } from 'path'
import { inspect } from 'util'
import type { AppLogLevel } from '../shared/logging'

export type { AppLogLevel } from '../shared/logging'

const LOG_FILE_NAME = 'hush.log'
const MAX_LOG_FILE_BYTES = 5 * 1024 * 1024
const MAX_ROTATED_LOG_FILES = 5
const LEVEL_WEIGHTS: Record<AppLogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
}

let logDir = ''
let logFilePath = ''
let currentLevel: AppLogLevel = 'info'
let mirrorToConsole = false

const originalConsole = {
  debug: console.debug.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console)
}

export function initializeLogger(options: {
  logDir: string
  level?: string
  mirrorToConsole?: boolean
  metadata?: Record<string, unknown>
}): void {
  logDir = options.logDir
  logFilePath = join(logDir, LOG_FILE_NAME)
  currentLevel = sanitizeLogLevel(options.level)
  mirrorToConsole = Boolean(options.mirrorToConsole)
  mkdirSync(logDir, { recursive: true })
  logInfo('logger', 'initialized', {
    file: logFilePath,
    level: currentLevel,
    ...options.metadata
  })
}

export function setLoggerLevel(level: string): void {
  const nextLevel = sanitizeLogLevel(level)
  if (nextLevel === currentLevel) {
    return
  }
  currentLevel = nextLevel
  logInfo('logger', 'level changed', { level: currentLevel })
}

export function logDebug(scope: string, message: string, details?: unknown): void {
  writeLog('debug', scope, message, details)
}

export function logInfo(scope: string, message: string, details?: unknown): void {
  writeLog('info', scope, message, details)
}

export function logWarning(scope: string, message: string, details?: unknown): void {
  writeLog('warn', scope, message, details)
}

export function logError(scope: string, message: string, details?: unknown): void {
  writeLog('error', scope, message, details)
}

export function getLogFilePath(): string {
  return logFilePath
}

function writeLog(level: AppLogLevel, scope: string, message: string, details?: unknown): void {
  if (LEVEL_WEIGHTS[level] < LEVEL_WEIGHTS[currentLevel]) {
    return
  }

  const line = formatLogLine(level, scope, message, details)
  try {
    ensureLogFileReady(line)
    appendFileSync(logFilePath, line, 'utf8')
  } catch (error) {
    originalConsole.error('[logger:write]', error)
  }

  if (mirrorToConsole) {
    originalConsole[level === 'warn' ? 'warn' : level](line.trimEnd())
  }
}

function ensureLogFileReady(line: string): void {
  if (!logFilePath) {
    throw new Error('Logger is not initialized')
  }
  mkdirSync(logDir, { recursive: true })
  const incomingBytes = Buffer.byteLength(line)
  const currentBytes = existsSync(logFilePath) ? statSync(logFilePath).size : 0
  if (currentBytes + incomingBytes <= MAX_LOG_FILE_BYTES) {
    return
  }
  rotateLogFiles()
}

function rotateLogFiles(): void {
  const oldestPath = `${logFilePath}.${MAX_ROTATED_LOG_FILES}`
  if (existsSync(oldestPath)) {
    unlinkSync(oldestPath)
  }
  for (let index = MAX_ROTATED_LOG_FILES - 1; index >= 1; index -= 1) {
    const currentPath = `${logFilePath}.${index}`
    if (existsSync(currentPath)) {
      renameSync(currentPath, `${logFilePath}.${index + 1}`)
    }
  }
  if (existsSync(logFilePath)) {
    renameSync(logFilePath, `${logFilePath}.1`)
  }
}

function formatLogLine(
  level: AppLogLevel,
  scope: string,
  message: string,
  details?: unknown
): string {
  const detailText = details === undefined ? '' : ` ${formatDetails(details)}`
  return `${new Date().toISOString()} pid=${process.pid} level=${level} scope=${sanitizeScope(scope)} ${sanitizeText(message)}${detailText}\n`
}

function formatDetails(details: unknown): string {
  if (details instanceof Error) {
    return sanitizeText(
      `error=${details.name}: ${details.message}${details.stack ? ` stack=${details.stack}` : ''}`
    )
  }
  if (typeof details === 'string') {
    return sanitizeText(`details=${details}`)
  }
  return sanitizeText(`details=${inspect(details, { depth: 5, breakLength: 140, compact: true })}`)
}

function sanitizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function sanitizeScope(value: string): string {
  return sanitizeText(value).replace(/[^\w:.-]+/g, '_') || 'app'
}

function sanitizeLogLevel(level: string | undefined): AppLogLevel {
  switch (level) {
    case 'debug':
    case 'warn':
    case 'error':
      return level
    case 'info':
    default:
      return 'info'
  }
}

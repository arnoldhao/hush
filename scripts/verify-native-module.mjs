#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const [, , expectedPlatform, expectedArch, rootArg = 'dist'] = process.argv

if (!expectedPlatform || !expectedArch) {
  console.error(
    'Usage: node scripts/verify-native-module.mjs <darwin|win32> <arm64|x64|universal> [root]'
  )
  process.exit(2)
}

const expected = `${expectedPlatform}-${expectedArch}`
const root = join(process.cwd(), rootArg)
const nativeModules = findNativeModules(root)

if (nativeModules.length === 0) {
  console.error(`No better_sqlite3.node files found under ${rootArg}`)
  process.exit(1)
}

const mismatches = []

for (const filePath of nativeModules) {
  const actual = inspectNativeModule(filePath)
  const displayPath = relative(process.cwd(), filePath)
  console.log(`${displayPath}: ${actual}`)

  if (actual !== expected) {
    mismatches.push(`${displayPath}: expected ${expected}, got ${actual}`)
  }
}

if (mismatches.length > 0) {
  console.error(mismatches.join('\n'))
  process.exit(1)
}

function findNativeModules(directory) {
  const results = []

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = join(directory, entry.name)

    if (entry.isDirectory()) {
      results.push(...findNativeModules(entryPath))
      continue
    }

    if (entry.isFile() && entry.name === 'better_sqlite3.node') {
      results.push(entryPath)
    }
  }

  return results
}

function inspectNativeModule(filePath) {
  const buffer = readFileSync(filePath)

  if (buffer[0] === 0x4d && buffer[1] === 0x5a) {
    return inspectPe(buffer)
  }

  return inspectMachO(buffer)
}

function inspectPe(buffer) {
  const peOffset = buffer.readUInt32LE(0x3c)
  const signature = buffer.toString('ascii', peOffset, peOffset + 4)

  if (signature !== 'PE\u0000\u0000') {
    return 'unknown-pe'
  }

  const machine = buffer.readUInt16LE(peOffset + 4)
  switch (machine) {
    case 0x8664:
      return 'win32-x64'
    case 0xaa64:
      return 'win32-arm64'
    default:
      return `win32-unknown-0x${machine.toString(16)}`
  }
}

function inspectMachO(buffer) {
  const universal = inspectUniversalMachO(buffer)
  if (universal) {
    return universal
  }

  const magic = buffer.readUInt32LE(0)

  if (magic !== 0xfeedfacf && magic !== 0xfeedface) {
    return 'unknown'
  }

  const cpuType = buffer.readUInt32LE(4)
  switch (cpuType) {
    case 0x01000007:
      return 'darwin-x64'
    case 0x0100000c:
      return 'darwin-arm64'
    default:
      return `darwin-unknown-0x${cpuType.toString(16)}`
  }
}

function inspectUniversalMachO(buffer) {
  const magic = buffer.readUInt32BE(0)

  if (magic !== 0xcafebabe && magic !== 0xcafebabf) {
    return null
  }

  const archCount = buffer.readUInt32BE(4)
  const cpuTypes = new Set()
  const archEntrySize = magic === 0xcafebabf ? 32 : 20

  for (let index = 0; index < archCount; index += 1) {
    const entryOffset = 8 + index * archEntrySize
    cpuTypes.add(buffer.readUInt32BE(entryOffset))
  }

  if (cpuTypes.has(0x01000007) && cpuTypes.has(0x0100000c)) {
    return 'darwin-universal'
  }

  if (cpuTypes.has(0x01000007)) {
    return 'darwin-x64'
  }

  if (cpuTypes.has(0x0100000c)) {
    return 'darwin-arm64'
  }

  return `darwin-universal-unknown-${Array.from(cpuTypes)
    .map((cpuType) => `0x${cpuType.toString(16)}`)
    .join('-')}`
}

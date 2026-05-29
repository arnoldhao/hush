#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { existsSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { spawnSync } from 'node:child_process'

const args = process.argv.slice(2)
const supportedFlags = new Set(['--require-developer-id'])

for (const arg of args) {
  if (arg.startsWith('--') && !supportedFlags.has(arg)) {
    console.error(`Unknown option: ${arg}`)
    process.exit(2)
  }
}

const requireDeveloperId = args.includes('--require-developer-id')
const appPathArg = args.find((arg) => !arg.startsWith('--')) ?? 'dist/mac-universal/Hush.app'
const appPath = isAbsolute(appPathArg) ? appPathArg : join(process.cwd(), appPathArg)

if (process.platform !== 'darwin') {
  console.error('macOS signing verification can only run on darwin')
  process.exit(2)
}

if (!existsSync(appPath)) {
  console.error(`App bundle not found: ${appPath}`)
  process.exit(1)
}

run('codesign', ['--verify', '--deep', '--strict', '--verbose=4', appPath], { capture: true })

if (requireDeveloperId) {
  const signatureInfo = run('codesign', ['-dv', '--verbose=4', appPath], {
    capture: true,
    includeStderr: true
  })

  if (/Signature=adhoc/.test(signatureInfo)) {
    console.error('App bundle is ad-hoc signed, not Developer ID signed')
    process.exit(1)
  }

  if (!signatureInfo.includes('Authority=Developer ID Application:')) {
    console.error('App bundle is not signed with a Developer ID Application certificate')
    process.exit(1)
  }

  if (!/TeamIdentifier=\S+/.test(signatureInfo)) {
    console.error('App bundle signature is missing a TeamIdentifier')
    process.exit(1)
  }
}

const entitlements = run('codesign', ['-d', '--entitlements', ':-', appPath], { capture: true })
const requiredEntitlements = [
  'com.apple.security.cs.allow-jit',
  'com.apple.security.cs.allow-unsigned-executable-memory',
  'com.apple.security.cs.disable-library-validation'
]

for (const entitlement of requiredEntitlements) {
  if (!entitlements.includes(`<key>${entitlement}</key>`)) {
    console.error(`Missing required entitlement: ${entitlement}`)
    process.exit(1)
  }
}

const infoPlistPath = join(appPath, 'Contents', 'Info.plist')
const executableName = run(
  'plutil',
  ['-extract', 'CFBundleExecutable', 'raw', '-o', '-', infoPlistPath],
  {
    capture: true
  }
).trim()
const executablePath = join(appPath, 'Contents', 'MacOS', executableName)
const electronVersion = run(
  executablePath,
  ['-e', 'process.stdout.write(process.versions.electron || "")'],
  {
    capture: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  }
).trim()

if (!electronVersion) {
  console.error('Electron dyld smoke test did not return an Electron version')
  process.exit(1)
}

console.log(`macOS signing verification passed for ${appPathArg} (Electron ${electronVersion})`)

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env: options.env ?? process.env
  })

  if (result.status !== 0) {
    if (result.stdout) process.stdout.write(result.stdout)
    if (result.stderr) process.stderr.write(result.stderr)
    console.error(`${command} ${args.join(' ')} failed`)
    process.exit(result.status ?? 1)
  }

  if (options.capture) {
    return `${result.stdout}${options.includeStderr ? result.stderr : ''}`
  }

  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  return result.stdout
}

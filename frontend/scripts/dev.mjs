import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const frontendDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const backendDir = resolve(frontendDir, '..', 'backend')

function startNpm(args, cwd) {
  const isWindows = process.platform === 'win32'
  const command = isWindows ? process.env.ComSpec ?? 'cmd.exe' : 'npm'
  const commandArgs = isWindows ? ['/d', '/s', '/c', `npm.cmd ${args.join(' ')}`] : args

  return spawn(command, commandArgs, {
    cwd,
    env: process.env,
    stdio: 'inherit',
  })
}

async function isBackendRunning() {
  const baseUrl = (process.env.VITE_API_BASE_URL ?? 'https://hubsync-backend.onrender.com').replace(/\/$/, '')
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 750)

  try {
    const response = await fetch(`${baseUrl}/api/health`, { signal: controller.signal })
    if (!response.ok) return false
    const payload = await response.json()
    return payload?.success === true && payload?.message === 'HubSync API is running'
  } catch {
    return false
  } finally {
    clearTimeout(timeout)
  }
}

async function isFrontendRunning() {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 750)

  try {
    const response = await fetch('https://hubsync-fe.vercel.app//', { signal: controller.signal })
    if (!response.ok) return false
    const html = await response.text()
    return html.includes('<div id="root"></div>')
  } catch {
    return false
  } finally {
    clearTimeout(timeout)
  }
}

const children = []
if (await isBackendRunning()) {
  console.log('HubSync API already running; starting the frontend only.')
} else {
  children.push(startNpm(['run', 'dev'], backendDir))
}

if (await isFrontendRunning()) {
  console.log('HubSync frontend already running on https://hubsync-fe.vercel.app/.')
} else {
  children.push(startNpm(['run', 'dev:frontend'], frontendDir))
}

let shuttingDown = false

function stopChildren(exitCode = 0) {
  if (shuttingDown) return
  shuttingDown = true

  for (const child of children) {
    if (child.exitCode === null && !child.killed) {
      child.kill('SIGINT')
    }
  }

  const forceExit = setTimeout(() => process.exit(exitCode), 1_500)
  forceExit.unref()
}

for (const child of children) {
  child.on('error', (error) => {
    console.error(`Unable to start development process: ${error.message}`)
    stopChildren(1)
  })

  child.on('exit', (code, signal) => {
    if (shuttingDown) return

    const failed = signal !== null || (code ?? 0) !== 0
    stopChildren(failed ? code ?? 1 : 0)
  })
}

process.on('SIGINT', () => stopChildren(0))
process.on('SIGTERM', () => stopChildren(0))

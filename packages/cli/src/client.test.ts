import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, posix, win32 } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ApiClient, SseParser, apiFileCandidates, findApiFile, isProcessAlive, readDiscovery } from './client'
import { CliError, EXIT } from './errors'
import { deadPid } from './fake-server'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'reborn-discovery-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function writeApi(file: string, pid = process.pid, mtime?: Date): Promise<string> {
  await mkdir(join(file, '..'), { recursive: true })
  await writeFile(file, JSON.stringify({ version: 1, port: 1, pid, readToken: 'r', writeToken: 'w', startedAt: '2026-10-16T00:00:00Z' }))
  if (mtime) await utimes(file, mtime, mtime)
  return file
}

describe('apiFileCandidates', () => {
  it('uses APPDATA on Windows, trying the desktop folder first', () => {
    expect(apiFileCandidates({ platform: 'win32', env: { APPDATA: 'C:\\Users\\d\\AppData\\Roaming' }, home: 'C:\\Users\\d' })).toEqual([
      win32.join('C:\\Users\\d\\AppData\\Roaming', 'RE-BORN', 'api.json'),
      win32.join('C:\\Users\\d\\AppData\\Roaming', 'RE:BORN', 'api.json'),
      win32.join('C:\\Users\\d\\AppData\\Roaming', '@reborn', 'desktop', 'api.json'),
    ])
  })

  it('uses Application Support on macOS', () => {
    expect(apiFileCandidates({ platform: 'darwin', env: {}, home: '/Users/d' })[0]).toBe('/Users/d/Library/Application Support/RE-BORN/api.json')
  })

  it('uses XDG_CONFIG_HOME on Linux, falling back to ~/.config', () => {
    expect(apiFileCandidates({ platform: 'linux', env: { XDG_CONFIG_HOME: '/cfg' }, home: '/home/d' })[2]).toBe('/cfg/@reborn/desktop/api.json')
    expect(apiFileCandidates({ platform: 'linux', env: {}, home: '/home/d' })[0]).toBe(posix.join('/home/d', '.config', 'RE-BORN', 'api.json'))
  })
})

describe('findApiFile', () => {
  it('prefers --api-file, then REBORN_API_FILE, then REBORN_USER_DATA', async () => {
    const env = { REBORN_API_FILE: '/env/api.json', REBORN_USER_DATA: '/data' }
    expect(await findApiFile({ apiFile: '/flag/api.json', env, platform: 'linux' })).toBe('/flag/api.json')
    expect(await findApiFile({ env, platform: 'linux' })).toBe('/env/api.json')
    expect(await findApiFile({ env: { REBORN_USER_DATA: '/data' }, platform: 'linux' })).toBe('/data/api.json')
  })

  it('picks the newest candidate by modification time', async () => {
    // Windows paths cannot contain ":", so the test swaps in a colon-free name.
    const options = { platform: 'linux' as const, env: { XDG_CONFIG_HOME: root }, appNames: ['RE-BORN', '@reborn/desktop'] }
    const [first, second] = apiFileCandidates(options)
    await writeApi(first, process.pid, new Date('2026-01-01T00:00:00Z'))
    await writeApi(second, process.pid, new Date('2026-06-01T00:00:00Z'))
    expect(await findApiFile(options)).toBe(second)
    await utimes(first, new Date('2026-09-01T00:00:00Z'), new Date('2026-09-01T00:00:00Z'))
    expect(await findApiFile(options)).toBe(first)
  })

  it('returns null when no candidate exists', async () => {
    expect(await findApiFile({ platform: 'linux', env: { XDG_CONFIG_HOME: root } })).toBeNull()
  })
})

describe('readDiscovery', () => {
  it('reads a live api.json', async () => {
    const file = await writeApi(join(root, 'api.json'))
    const { discovery } = await readDiscovery({ apiFile: file })
    expect(discovery.writeToken).toBe('w')
  })

  it('reports "not running" when the PID has exited', async () => {
    const file = await writeApi(join(root, 'api.json'), await deadPid())
    const error = await readDiscovery({ apiFile: file }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(CliError)
    expect((error as CliError).exitCode).toBe(EXIT.notRunning)
    expect((error as CliError).message).toMatch(/RE:BORN is not running/)
    expect((error as CliError).hint).toMatch(/Start the RE:BORN desktop app/)
  })

  it('reports "not running" when no api.json exists', async () => {
    const error = await readDiscovery({ platform: 'linux', env: { XDG_CONFIG_HOME: root } }).catch((e: unknown) => e)
    expect((error as CliError).exitCode).toBe(EXIT.notRunning)
  })

  it('rejects an api.json without tokens', async () => {
    await writeFile(join(root, 'api.json'), JSON.stringify({ port: 1, pid: process.pid }))
    const error = await readDiscovery({ apiFile: join(root, 'api.json') }).catch((e: unknown) => e)
    expect((error as CliError).exitCode).toBe(EXIT.generic)
  })
})

describe('isProcessAlive', () => {
  it('detects the current process and rejects invalid PIDs', async () => {
    expect(isProcessAlive(process.pid)).toBe(true)
    expect(isProcessAlive(0)).toBe(false)
    expect(isProcessAlive(await deadPid())).toBe(false)
  })
})

describe('ApiClient', () => {
  it('maps a refused connection to "not running"', async () => {
    const client = new ApiClient({ port: 1, token: 'x', timeoutMs: 2000 })
    const error = await client.status().catch((e: unknown) => e)
    expect((error as CliError).exitCode).toBe(EXIT.notRunning)
  })
})

describe('SseParser', () => {
  it('reassembles events split across chunks and skips comments', () => {
    const parser = new SseParser()
    expect(parser.push(': hello\n\ndata: {"a"')).toEqual([])
    expect(parser.push(':1}\r\n\r\ndata: 2\n')).toEqual(['{"a":1}'])
    expect(parser.push('\n')).toEqual(['2'])
  })
})

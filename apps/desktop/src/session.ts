import { appendFile, mkdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { LogLevel, ProjectState, RecentProject, RecoveryState, studio } from '@reborn/studio-core'
import { writeAtomic } from './project-dir'

// Per-user desktop state that never belongs inside a project: recent files,
// crash-recovery snapshots, and the log.

const RECENT_LIMIT = 10
const LOG_LIMIT = 1024 * 1024

export class SessionStore {
  private readonly recentFile: string
  private readonly recoveryFile: string
  private readonly lockFile: string
  private readonly logFile: string
  private recoveryWrite: Promise<void> = Promise.resolve()
  /** True when the previous session ended without a clean shutdown. */
  crashed = false

  constructor(private readonly directory: string) {
    this.recentFile = join(directory, 'recent.json')
    this.recoveryFile = join(directory, 'recovery', 'current.json')
    this.lockFile = join(directory, 'session.lock')
    this.logFile = join(directory, 'logs', 'reborn.log')
  }

  async start(): Promise<void> {
    await mkdir(join(this.directory, 'recovery'), { recursive: true })
    await mkdir(join(this.directory, 'logs'), { recursive: true })
    this.crashed = existsSync(this.lockFile) && existsSync(this.recoveryFile)
    await writeAtomic(this.lockFile, String(process.pid))
    await this.log('info', `Session started${this.crashed ? ' after an unclean shutdown' : ''}.`)
  }

  /** Marks a clean shutdown. Recovery data is discarded only here. */
  async finish(): Promise<void> {
    await this.recoveryWrite
    await rm(this.recoveryFile, { force: true })
    await rm(this.lockFile, { force: true })
    await this.log('info', 'Session ended cleanly.')
  }

  async listRecent(): Promise<RecentProject[]> {
    try {
      const items = JSON.parse(await readFile(this.recentFile, 'utf8')) as RecentProject[]
      return Array.isArray(items) ? items.filter((item) => typeof item.path === 'string' && existsSync(item.path)) : []
    } catch {
      return []
    }
  }

  async addRecent(path: string, name: string): Promise<RecentProject[]> {
    const items = [{ path, name, openedAt: new Date().toISOString() }, ...(await this.listRecent()).filter((item) => item.path !== path)].slice(0, RECENT_LIMIT)
    await writeAtomic(this.recentFile, JSON.stringify(items, null, 2))
    return items
  }

  writeRecovery(content: { project?: ProjectState; studio?: studio.StudioProject }, path: string | null): Promise<void> {
    const state: RecoveryState = { ...content, path, savedAt: new Date().toISOString() }
    this.recoveryWrite = this.recoveryWrite.then(() => writeAtomic(this.recoveryFile, JSON.stringify(state))).catch((error: unknown) => this.log('error', `Recovery write failed: ${String(error)}`))
    return this.recoveryWrite
  }

  /** Returns the snapshot from a crashed session once, then clears the flag. */
  async takeRecovery(): Promise<RecoveryState | null> {
    if (!this.crashed) return null
    this.crashed = false
    try {
      const state = JSON.parse(await readFile(this.recoveryFile, 'utf8')) as RecoveryState
      await this.log('info', `Offered recovery snapshot from ${state.savedAt}.`)
      return state
    } catch (error) {
      await this.log('warn', `Recovery snapshot unreadable: ${String(error)}`)
      return null
    }
  }

  async log(level: LogLevel, message: string): Promise<void> {
    const line = `${new Date().toISOString()} ${level.toUpperCase()} ${message.replace(/\s+/g, ' ').slice(0, 2000)}\n`
    try {
      if (existsSync(this.logFile) && (await stat(this.logFile)).size > LOG_LIMIT) await rename(this.logFile, `${this.logFile}.1`)
      await appendFile(this.logFile, line)
    } catch {
      // Logging must never take the app down.
    }
  }
}

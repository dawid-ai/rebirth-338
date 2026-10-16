import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

// Supervises the optional Python analysis sidecar (python/ismail-bridge).
// The sidecar speaks JSON lines over stdio; see PROTOCOL.md in that folder.
// Nothing here throws into the caller's event loop: process failures reject
// the affected requests and are reported through onStatus and onLog.

export type SidecarStatus = 'stopped' | 'starting' | 'ready' | 'crashed' | 'unavailable'

export type SidecarRemoteErrorCode = 'invalid_params' | 'not_found' | 'unsupported_format' | 'cancelled' | 'backend_error' | 'internal'

export type SidecarErrorCode = SidecarRemoteErrorCode | 'timeout' | 'crashed' | 'stopped' | 'unavailable' | 'protocol'

const remoteErrorCodes: ReadonlySet<string> = new Set<SidecarRemoteErrorCode>(['invalid_params', 'not_found', 'unsupported_format', 'cancelled', 'backend_error', 'internal'])

export const SIDECAR_PROTOCOL_VERSION = 1
export const SIDECAR_MODULE_ARGS: readonly string[] = ['-m', 'reborn_sidecar']

export class SidecarError extends Error {
  readonly code: SidecarErrorCode

  constructor(code: SidecarErrorCode, message: string) {
    super(message)
    this.name = 'SidecarError'
    this.code = code
  }
}

export interface SidecarProgress {
  completed: number
  total: number
  message: string
}

export interface SidecarOptions {
  /** Python executable, for example the venv interpreter or `findPython()?.executable`. */
  python: string
  /** Arguments after the executable. Defaults to `-m reborn_sidecar`. */
  args?: string[]
  /** Working directory, normally `python/ismail-bridge`. */
  cwd: string
  env?: NodeJS.ProcessEnv
  onLog: (line: string) => void
  onStatus?: (status: SidecarStatus) => void
  /** Default per-request timeout. Defaults to 120 s. */
  requestTimeoutMs?: number
  /** Restarts allowed within `restartWindowMs` before the status becomes `unavailable`. Defaults to 3. */
  maxRestarts?: number
  restartWindowMs?: number
  /** First restart delay; doubles per restart in the window. Defaults to 500 ms. */
  restartBackoffMs?: number
  maxBackoffMs?: number
  /** How long a `hello` health ping may take after a request times out. Defaults to 5 s. */
  pingTimeoutMs?: number
  /** How long the startup `hello` handshake may take. Defaults to 20 s. */
  startTimeoutMs?: number
  /** How long `stop()` waits for a clean exit before killing the process. Defaults to 3 s. */
  stopTimeoutMs?: number
}

export interface SidecarRequestOptions {
  onProgress?: (progress: SidecarProgress) => void
  signal?: AbortSignal
  timeoutMs?: number
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: SidecarError) => void
  onProgress?: (progress: SidecarProgress) => void
  cleanup: () => void
}

interface ReadyWaiter {
  resolve: () => void
  reject: (error: SidecarError) => void
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

export class SidecarSupervisor {
  private readonly options: SidecarOptions
  private child: ChildProcessWithoutNullStreams | null = null
  private currentStatus: SidecarStatus = 'stopped'
  private readonly pending = new Map<string, Pending>()
  private readyWaiters: ReadyWaiter[] = []
  private restartTimes: number[] = []
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private nextId = 1
  private generation = 0
  private handledExit = 0
  private wanted = false
  private checkingHealth = false
  private hello: Record<string, unknown> | null = null

  constructor(options: SidecarOptions) {
    this.options = options
  }

  get status(): SidecarStatus {
    return this.currentStatus
  }

  /** Process id of the running sidecar, if any. */
  get pid(): number | undefined {
    return this.child?.pid
  }

  /** The `hello` result from the current process, if ready. */
  get info(): Record<string, unknown> | null {
    return this.hello
  }

  /** Launches the sidecar and resolves after the `hello` handshake. */
  start(): Promise<void> {
    this.wanted = true
    if (this.currentStatus === 'ready' || this.currentStatus === 'starting') return this.waitReady()
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    this.restartTimes = []
    this.launch()
    return this.waitReady()
  }

  /** Asks the sidecar to shut down, then kills it if it does not exit in time. */
  async stop(): Promise<void> {
    this.wanted = false
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    const stopped = new SidecarError('stopped', 'The sidecar was stopped.')
    this.rejectPending(stopped)
    this.rejectWaiters(stopped)
    this.setStatus('stopped')
    this.hello = null
    const child = this.child
    this.child = null
    if (!child || child.exitCode !== null || child.signalCode !== null) return
    const timeoutMs = this.options.stopTimeoutMs ?? 3000
    await new Promise<void>((resolve) => {
      const kill = setTimeout(() => child.kill(), timeoutMs)
      const giveUp = setTimeout(resolve, timeoutMs * 2)
      child.once('exit', () => {
        clearTimeout(kill)
        clearTimeout(giveUp)
        resolve()
      })
      try {
        child.stdin.write(`${JSON.stringify({ id: 'shutdown', method: 'shutdown', params: {} })}\n`)
        child.stdin.end()
      } catch {
        child.kill()
      }
    })
  }

  /**
   * Sends a request and resolves with its result. Rejects with a
   * `SidecarError`; `signal` sends `cancel` to the sidecar and rejects with
   * `cancelled`. A timeout rejects with `timeout` and only restarts the
   * process if it also stops answering a `hello` ping.
   */
  async request<T = unknown>(method: string, params: Record<string, unknown> = {}, options: SidecarRequestOptions = {}): Promise<T> {
    const timeoutMs = options.timeoutMs ?? this.options.requestTimeoutMs ?? 120_000
    if (options.signal?.aborted) throw new SidecarError('cancelled', `The ${method} request was cancelled.`)
    const deadline = Date.now() + timeoutMs
    if (this.currentStatus !== 'ready') await this.waitReady(timeoutMs, options.signal)
    const result = await this.dispatch(method, params, { ...options, timeoutMs: Math.max(1, deadline - Date.now()) }, true)
    return result as T
  }

  private launch(): void {
    const generation = ++this.generation
    this.hello = null
    this.setStatus('starting')
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(this.options.python, this.options.args ?? [...SIDECAR_MODULE_ARGS], {
        cwd: this.options.cwd,
        env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8', ...this.options.env },
        stdio: 'pipe',
        windowsHide: true,
      })
    } catch (error) {
      this.handleExit(generation, `could not start: ${errorText(error)}`, true)
      return
    }
    this.child = child
    child.on('error', (error) => {
      this.log(`Sidecar process error: ${error.message}`)
      if (child.pid === undefined) this.handleExit(generation, `could not start: ${error.message}`, true)
    })
    child.stdin.on('error', (error) => this.log(`Sidecar stdin error: ${error.message}`))
    createInterface({ input: child.stdout }).on('line', (line) => {
      if (generation === this.generation) this.handleLine(line)
    })
    createInterface({ input: child.stderr }).on('line', (line) => this.log(line))
    child.on('exit', (code, signal) => this.handleExit(generation, signal ? `exited on ${signal}` : `exited with code ${code}`))

    this.dispatch('hello', {}, { timeoutMs: this.options.startTimeoutMs ?? 20_000 }, false)
      .then((result) => {
        if (generation !== this.generation) return
        if (!isRecord(result) || result.protocol !== SIDECAR_PROTOCOL_VERSION) {
          const reason = `Sidecar speaks protocol ${isRecord(result) ? String(result.protocol) : 'unknown'}, expected ${SIDECAR_PROTOCOL_VERSION}.`
          this.log(reason)
          this.generation++
          this.child = null
          child.kill()
          this.rejectPending(new SidecarError('unavailable', reason))
          this.becomeUnavailable(reason)
          return
        }
        this.hello = result
        this.setStatus('ready')
        for (const waiter of [...this.readyWaiters]) waiter.resolve()
      })
      .catch((error: unknown) => {
        if (generation !== this.generation || this.child !== child) return
        this.log(`Sidecar handshake failed: ${errorText(error)}`)
        child.kill()
      })
  }

  private handleExit(generation: number, reason: string, permanent = false): void {
    if (generation !== this.generation || this.handledExit === generation) return
    this.handledExit = generation
    this.child = null
    this.hello = null
    if (!this.wanted) {
      this.rejectPending(new SidecarError('stopped', 'The sidecar was stopped.'))
      this.setStatus('stopped')
      return
    }
    this.log(`Sidecar ${reason}.`)
    this.rejectPending(new SidecarError('crashed', `The sidecar ${reason}.`))
    this.setStatus('crashed')
    if (permanent) {
      this.becomeUnavailable(`The sidecar ${reason}.`)
      return
    }
    const now = Date.now()
    const windowMs = this.options.restartWindowMs ?? 60_000
    this.restartTimes = this.restartTimes.filter((time) => now - time < windowMs)
    const maxRestarts = this.options.maxRestarts ?? 3
    if (this.restartTimes.length >= maxRestarts) {
      this.becomeUnavailable(`The sidecar crashed ${this.restartTimes.length + 1} times within ${windowMs} ms.`)
      return
    }
    const base = this.options.restartBackoffMs ?? 500
    const delay = Math.min(this.options.maxBackoffMs ?? 10_000, base * 2 ** this.restartTimes.length)
    this.restartTimes.push(now)
    this.log(`Restarting the sidecar in ${delay} ms.`)
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      if (this.wanted) this.launch()
    }, delay)
  }

  private becomeUnavailable(reason: string): void {
    this.log(`Sidecar unavailable: ${reason}`)
    this.setStatus('unavailable')
    this.rejectWaiters(new SidecarError('unavailable', reason))
  }

  private handleLine(line: string): void {
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch {
      this.log(`Ignoring non-JSON sidecar output: ${line}`)
      return
    }
    if (!isRecord(message)) return
    const id = message.id
    if (typeof id !== 'string') {
      if (isRecord(message.error)) this.log(`Sidecar error without id: ${String(message.error.message)}`)
      return
    }
    const pending = this.pending.get(id)
    if (!pending) return
    if (isRecord(message.progress)) {
      const { completed, total } = message.progress
      if (pending.onProgress && typeof completed === 'number' && typeof total === 'number') {
        const progress = { completed, total, message: typeof message.progress.message === 'string' ? message.progress.message : '' }
        const onProgress = pending.onProgress
        this.safely(() => onProgress(progress))
      }
      return
    }
    if (isRecord(message.error)) {
      const rawCode = message.error.code
      const code: SidecarErrorCode = typeof rawCode === 'string' && remoteErrorCodes.has(rawCode) ? (rawCode as SidecarRemoteErrorCode) : 'protocol'
      pending.cleanup()
      pending.reject(new SidecarError(code, typeof message.error.message === 'string' ? message.error.message : 'The sidecar returned an error.'))
      return
    }
    if ('result' in message) {
      pending.cleanup()
      pending.resolve(message.result)
    }
  }

  private dispatch(method: string, params: Record<string, unknown>, options: SidecarRequestOptions & { timeoutMs: number }, healthCheck: boolean): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      const child = this.child
      if (!child || !child.stdin.writable) {
        reject(new SidecarError('crashed', 'The sidecar is not running.'))
        return
      }
      const id = `r${this.nextId++}`
      const { signal } = options
      const onAbort = () => {
        entry.cleanup()
        this.sendCancel(id)
        reject(new SidecarError('cancelled', `The ${method} request was cancelled.`))
      }
      const timer = setTimeout(() => {
        entry.cleanup()
        this.sendCancel(id)
        reject(new SidecarError('timeout', `The ${method} request timed out after ${options.timeoutMs} ms.`))
        if (healthCheck) this.checkHealth()
      }, options.timeoutMs)
      const entry: Pending = {
        resolve,
        reject,
        onProgress: options.onProgress,
        cleanup: () => {
          clearTimeout(timer)
          signal?.removeEventListener('abort', onAbort)
          this.pending.delete(id)
        },
      }
      this.pending.set(id, entry)
      if (signal?.aborted) {
        entry.cleanup()
        reject(new SidecarError('cancelled', `The ${method} request was cancelled.`))
        return
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      try {
        child.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
      } catch (error) {
        entry.cleanup()
        reject(new SidecarError('crashed', `Could not write to the sidecar: ${errorText(error)}`))
      }
    })
  }

  private sendCancel(target: string): void {
    if (this.currentStatus !== 'ready') return
    this.dispatch('cancel', { target }, { timeoutMs: this.options.pingTimeoutMs ?? 5000 }, false).catch(() => undefined)
  }

  private checkHealth(): void {
    if (this.checkingHealth || this.currentStatus !== 'ready') return
    this.checkingHealth = true
    const child = this.child
    this.dispatch('hello', {}, { timeoutMs: this.options.pingTimeoutMs ?? 5000 }, false)
      .catch((error: unknown) => {
        if (error instanceof SidecarError && error.code === 'timeout' && child && this.child === child) {
          this.log('The sidecar stopped answering hello pings; restarting it.')
          child.kill()
        }
      })
      .finally(() => {
        this.checkingHealth = false
      })
  }

  private waitReady(timeoutMs?: number, signal?: AbortSignal): Promise<void> {
    if (this.currentStatus === 'ready') return Promise.resolve()
    if (this.currentStatus === 'unavailable') return Promise.reject(new SidecarError('unavailable', 'The sidecar is unavailable.'))
    if (!this.wanted) return Promise.reject(new SidecarError('stopped', 'The sidecar is not running. Call start() first.'))
    return new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const onAbort = () => waiter.reject(new SidecarError('cancelled', 'The request was cancelled.'))
      const done = () => {
        if (timer) clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        this.readyWaiters = this.readyWaiters.filter((item) => item !== waiter)
      }
      const waiter: ReadyWaiter = {
        resolve: () => {
          done()
          resolve()
        },
        reject: (error) => {
          done()
          reject(error)
        },
      }
      if (timeoutMs !== undefined) timer = setTimeout(() => waiter.reject(new SidecarError('timeout', `The sidecar was not ready within ${timeoutMs} ms.`)), timeoutMs)
      signal?.addEventListener('abort', onAbort, { once: true })
      this.readyWaiters.push(waiter)
    })
  }

  private rejectPending(error: SidecarError): void {
    for (const entry of [...this.pending.values()]) {
      entry.cleanup()
      entry.reject(error)
    }
  }

  private rejectWaiters(error: SidecarError): void {
    for (const waiter of [...this.readyWaiters]) waiter.reject(error)
  }

  private setStatus(status: SidecarStatus): void {
    if (this.currentStatus === status) return
    this.currentStatus = status
    const { onStatus } = this.options
    if (onStatus) this.safely(() => onStatus(status))
  }

  private log(line: string): void {
    this.safely(() => this.options.onLog(line))
  }

  private safely(callback: () => void): void {
    try {
      callback()
    } catch (error) {
      try {
        this.options.onLog(`Sidecar callback threw: ${errorText(error)}`)
      } catch {
        // The log callback itself failed; there is nowhere left to report it.
      }
    }
  }
}

export interface PythonInfo {
  /** Absolute interpreter path (`sys.executable`), so launchers such as `py` are resolved. */
  executable: string
  version: string
}

export interface SyncCommandResult {
  status: number | null
  stdout: string
  stderr: string
  error?: Error
}

export type SyncCommandRunner = (command: string, args: string[]) => SyncCommandResult

const runSync: SyncCommandRunner = (command, args) => {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 10_000, windowsHide: true })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error }
}

/** Finds a Python 3 interpreter: `REBORN_PYTHON`, then `py -3`, `python`, and `python3` on PATH. */
export function findPython(env: NodeJS.ProcessEnv = process.env, run: SyncCommandRunner = runSync): PythonInfo | null {
  const candidates: Array<[string, string[]]> = []
  if (env.REBORN_PYTHON) candidates.push([env.REBORN_PYTHON, []])
  candidates.push(['py', ['-3']], ['python', []], ['python3', []])
  for (const [command, prefix] of candidates) {
    const probe = run(command, [...prefix, '--version'])
    if (probe.error || probe.status !== 0) continue
    const match = /Python (3\.\d+(?:\.\d+)?)/.exec(`${probe.stdout}${probe.stderr}`)
    if (!match) continue
    const located = run(command, [...prefix, '-c', 'import sys; print(sys.executable)'])
    const executable = !located.error && located.status === 0 && located.stdout.trim() ? located.stdout.trim() : command
    return { executable, version: match[1] }
  }
  return null
}

export type CommandRunner = (command: string, args: string[], options: { cwd?: string; onLine: (line: string) => void }) => Promise<number | null>

const runCommand: CommandRunner = (command, args, { cwd, onLine }) =>
  new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(command, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      onLine(errorText(error))
      resolve(null)
      return
    }
    if (child.stdout) createInterface({ input: child.stdout }).on('line', onLine)
    if (child.stderr) createInterface({ input: child.stderr }).on('line', onLine)
    child.on('error', (error) => {
      onLine(error.message)
      resolve(null)
    })
    child.on('close', (code) => resolve(code))
  })

export interface EnsureEnvironmentOptions {
  /** Folder that holds (or will hold) `venv/`, for example the app's user-data folder. */
  baseDir: string
  /** Python used to create the venv. */
  python: string
  onProgress?: (line: string) => void
  /** Injectable for tests; defaults to spawning the command. */
  run?: CommandRunner
  platform?: NodeJS.Platform
}

export interface EnvironmentResult {
  /** Interpreter inside the venv; pass it to `SidecarSupervisor`. */
  python: string
  created: boolean
  installed: boolean
}

export function venvPython(venvDir: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? join(venvDir, 'Scripts', 'python.exe') : join(venvDir, 'bin', 'python')
}

/** Creates `baseDir/venv` and installs numpy when they are missing. */
export async function ensureEnvironment(options: EnsureEnvironmentOptions): Promise<EnvironmentResult> {
  const run = options.run ?? runCommand
  const report = (line: string) => {
    try {
      options.onProgress?.(line)
    } catch {
      // Progress reporting must not break installation.
    }
  }
  const venvDir = join(options.baseDir, 'venv')
  const python = venvPython(venvDir, options.platform)
  const exec = async (command: string, args: string[]) => run(command, args, { cwd: options.baseDir, onLine: report })
  const hasNumpy = async () => (await exec(python, ['-c', 'import numpy'])) === 0

  if (existsSync(python)) {
    report('Checking the analysis environment.')
    if (await hasNumpy()) {
      report('The analysis environment is ready.')
      return { python, created: false, installed: false }
    }
  }

  let created = false
  if (!existsSync(python)) {
    report(`Creating a Python environment in ${venvDir}.`)
    const code = await exec(options.python, ['-m', 'venv', venvDir])
    if (code !== 0 || !existsSync(python)) throw new SidecarError('unavailable', `Could not create a Python environment in ${venvDir} (exit code ${code}).`)
    created = true
  }

  report('Installing numpy.')
  const code = await exec(python, ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', 'numpy'])
  if (code !== 0) throw new SidecarError('unavailable', `Installing numpy failed (exit code ${code}).`)
  if (!(await hasNumpy())) throw new SidecarError('unavailable', 'numpy is installed but cannot be imported.')
  report('The analysis environment is ready.')
  return { python, created, installed: true }
}

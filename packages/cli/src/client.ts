import { request as httpRequest, type IncomingMessage } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'
import {
  API_DISCOVERY_FILE,
  type ApiDiscovery,
  type ApiEvent,
  type ApiStatus,
  type CommandInfo,
  type ExecuteRequest,
  type ExecuteResponse,
  type JobState,
  type RuntimeRequest,
  type RuntimeResponse,
} from '@reborn/studio-core/api'
import { CliError, EXIT, apiError, errorMessage, notRunningError } from './errors'

// Discovery and transport for the desktop's local service (see
// `@reborn/studio-core/api`). A client holds one port and token, so call
// `connect()` again when the app may have restarted since.

/** Electron derives userData from the app name; check both spellings. */
export const APP_DIRECTORY_NAMES = ['RE-BORN', 'RE:BORN', '@reborn/desktop']

export interface DiscoveryOptions {
  /** Explicit path from `--api-file`. Wins over everything. */
  apiFile?: string
  env?: Record<string, string | undefined>
  platform?: NodeJS.Platform
  home?: string
  appNames?: readonly string[]
}

/** Candidate api.json paths in the platform's userData locations. */
export function apiFileCandidates(options: DiscoveryOptions = {}): string[] {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const home = options.home ?? homedir()
  const names = options.appNames ?? APP_DIRECTORY_NAMES
  const path = platform === 'win32' ? win32 : posix
  const base =
    platform === 'win32'
      ? env.APPDATA || path.join(home, 'AppData', 'Roaming')
      : platform === 'darwin'
        ? path.join(home, 'Library', 'Application Support')
        : env.XDG_CONFIG_HOME || path.join(home, '.config')
  return names.map((name) => path.join(base, ...name.split('/'), API_DISCOVERY_FILE))
}

/**
 * Finds api.json: `--api-file`, then `REBORN_API_FILE`, then
 * `REBORN_USER_DATA` (the desktop's userData override), then the newest of
 * the platform candidates. Returns null when none exists.
 */
export async function findApiFile(options: DiscoveryOptions = {}): Promise<string | null> {
  const env = options.env ?? process.env
  if (options.apiFile) return options.apiFile
  if (env.REBORN_API_FILE) return env.REBORN_API_FILE
  const platform = options.platform ?? process.platform
  if (env.REBORN_USER_DATA) return (platform === 'win32' ? win32 : posix).join(env.REBORN_USER_DATA, API_DISCOVERY_FILE)
  let best: { file: string; mtime: number } | null = null
  for (const file of apiFileCandidates(options)) {
    try {
      const info = await stat(file)
      if (info.isFile() && (!best || info.mtimeMs > best.mtime)) best = { file, mtime: info.mtimeMs }
    } catch {
      // Missing or unreadable candidates are skipped.
    }
  }
  return best?.file ?? null
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export async function readDiscovery(options: DiscoveryOptions = {}): Promise<{ file: string; discovery: ApiDiscovery }> {
  const file = await findApiFile(options)
  if (!file) throw notRunningError('no api.json found')
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') throw notRunningError(`${file} does not exist`)
    throw new CliError(`Cannot read ${file}: ${errorMessage(error)}`, EXIT.generic)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new CliError(`${file} is not valid JSON.`, EXIT.generic, 'internal', 'Restart RE:BORN to rewrite it.')
  }
  const discovery = parsed as Partial<ApiDiscovery>
  if (typeof discovery.port !== 'number' || typeof discovery.pid !== 'number' || typeof discovery.readToken !== 'string' || typeof discovery.writeToken !== 'string') {
    throw new CliError(`${file} is missing port, pid, or tokens.`, EXIT.generic, 'internal', 'Restart RE:BORN to rewrite it.')
  }
  if (!isProcessAlive(discovery.pid)) throw notRunningError(`process ${discovery.pid} from ${file} has exited`)
  return { file, discovery: discovery as ApiDiscovery }
}

export interface ConnectOptions extends DiscoveryOptions {
  /** Use the read token. Mutations fail with "forbidden". */
  readOnly?: boolean
  timeoutMs?: number
}

export async function connect(options: ConnectOptions = {}): Promise<ApiClient> {
  const { discovery } = await readDiscovery(options)
  return new ApiClient({ port: discovery.port, token: options.readOnly ? discovery.readToken : discovery.writeToken, timeoutMs: options.timeoutMs })
}

export interface WaitOptions {
  intervalMs?: number
  timeoutMs?: number
  onProgress?: (job: JobState) => void
  signal?: AbortSignal
}

export class ApiClient {
  readonly port: number
  private readonly token: string
  private readonly timeoutMs: number

  constructor(options: { port: number; token: string; timeoutMs?: number }) {
    this.port = options.port
    this.token = options.token
    this.timeoutMs = options.timeoutMs ?? 30_000
  }

  status(): Promise<ApiStatus> {
    return this.request<ApiStatus>('GET', '/v1/status')
  }

  commands(): Promise<CommandInfo[]> {
    return this.request<CommandInfo[]>('GET', '/v1/commands')
  }

  execute(body: ExecuteRequest): Promise<ExecuteResponse> {
    return this.request<ExecuteResponse>('POST', '/v1/execute', body)
  }

  runtime(body: RuntimeRequest): Promise<RuntimeResponse> {
    return this.request<RuntimeResponse>('POST', '/v1/runtime', body)
  }

  job(id: string): Promise<JobState> {
    return this.request<JobState>('GET', `/v1/jobs/${encodeURIComponent(id)}`)
  }

  /** Cancels a running job. Finished jobs come back unchanged. */
  cancelJob(id: string): Promise<JobState> {
    return this.request<JobState>('DELETE', `/v1/jobs/${encodeURIComponent(id)}`)
  }

  /** Polls a job until it leaves "running". Returns the last state seen on timeout. */
  async waitForJob(id: string, options: WaitOptions = {}): Promise<{ job: JobState; timedOut: boolean }> {
    const interval = options.intervalMs ?? 250
    const deadline = Date.now() + (options.timeoutMs ?? 600_000)
    for (;;) {
      const job = await this.job(id)
      options.onProgress?.(job)
      if (job.status !== 'running') return { job, timedOut: false }
      if (Date.now() + interval > deadline) return { job, timedOut: true }
      await delay(interval, options.signal)
      if (options.signal?.aborted) return { job, timedOut: true }
    }
  }

  /** Streams `/v1/events` until the server closes it or `signal` aborts. */
  async *events(signal?: AbortSignal): AsyncGenerator<ApiEvent> {
    const response = await this.open('GET', '/v1/events', undefined, { accept: 'text/event-stream' }, signal, false)
    if ((response.statusCode ?? 500) >= 400) throw apiError(response.statusCode ?? 500, parseJson(await readBody(response)))
    response.setEncoding('utf8')
    const parser = new SseParser()
    try {
      for await (const chunk of response) {
        for (const data of parser.push(String(chunk))) {
          const event = parseJson(data)
          if (event && typeof event === 'object') yield event as ApiEvent
        }
      }
    } catch (error) {
      if (!signal?.aborted) throw error
    } finally {
      response.destroy()
    }
  }

  async request<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<T> {
    const response = await this.open(method, path, body, { accept: 'application/json' })
    const text = await readBody(response)
    const status = response.statusCode ?? 500
    const parsed = parseJson(text)
    if (status >= 400) throw apiError(status, parsed)
    if (parsed === undefined) throw new CliError(`RE:BORN sent an unreadable response to ${method} ${path}.`, EXIT.generic)
    return parsed as T
  }

  private open(method: string, path: string, body: unknown, headers: Record<string, string>, signal?: AbortSignal, timeout = true): Promise<IncomingMessage> {
    const payload = body === undefined ? undefined : JSON.stringify(body)
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port: this.port,
          path,
          method,
          signal,
          headers: {
            ...headers,
            authorization: `Bearer ${this.token}`,
            ...(payload !== undefined && { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) }),
          },
        },
        resolve,
      )
      if (timeout) {
        req.setTimeout(this.timeoutMs, () => req.destroy(new CliError(`RE:BORN did not answer ${method} ${path} within ${Math.round(this.timeoutMs / 1000)} s.`, EXIT.generic, 'unavailable')))
      }
      req.on('error', (error: NodeJS.ErrnoException) => {
        if (error instanceof CliError) reject(error)
        else if (error.code === 'ECONNREFUSED' || error.code === 'ECONNRESET') reject(notRunningError(`nothing is listening on port ${this.port}`))
        else reject(new CliError(`Cannot reach RE:BORN: ${error.message}`, EXIT.generic, 'unavailable'))
      })
      req.end(payload)
    })
  }
}

/** Incremental parser for `text/event-stream`; yields each event's data. */
export class SseParser {
  private buffer = ''
  private data: string[] = []

  push(chunk: string): string[] {
    this.buffer += chunk
    const out: string[] = []
    const lines = this.buffer.split(/\r?\n/)
    this.buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (line === '') {
        if (this.data.length) out.push(this.data.join('\n'))
        this.data = []
      } else if (line.startsWith('data:')) {
        this.data.push(line.slice(5).replace(/^ /, ''))
      }
      // Comments (":"), "event:", "id:", and "retry:" lines carry nothing we use.
    }
    return out
  }
}

function readBody(response: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    response.on('data', (chunk: Buffer) => chunks.push(chunk))
    response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    response.on('error', reject)
  })
}

function parseJson(text: string): unknown {
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    signal?.addEventListener('abort', done, { once: true })
  })
}

import { randomBytes, randomUUID } from 'node:crypto'
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { API_DISCOVERY_FILE, API_VERSION, type ApiDiscovery, type ApiErrorBody, type ApiEvent, type ExecuteRequest, type JobState, type RuntimeRequest, studio } from '@reborn/studio-core'
import { writeAtomic } from './project-dir'

// The desktop's local API (see packages/studio-core/src/api.ts). It listens
// on loopback only, requires a bearer token, refuses browser-originated
// requests, and forwards project work to the renderer, which owns the project.

export interface RendererRpc {
  request(route: 'status' | 'execute' | 'runtime', body: unknown, timeoutMs?: number): Promise<{ status: number; body: unknown }>
}

export interface RenderedFile {
  name: string
  data: ArrayBuffer | Uint8Array
}

export interface ApiServerOptions {
  directory: string
  version: string
  rpc: RendererRpc
  /** Writes rendered files and returns their paths. */
  writeFiles: (files: RenderedFile[], target?: string) => Promise<string[]>
  log: (message: string) => void
  port?: number
}

const STATUS: Record<ApiErrorBody['error']['code'], number> = { unauthorized: 401, forbidden: 403, invalid: 400, not_found: 404, conflict: 409, unavailable: 503, internal: 500 }
const READ_RUNTIME = ['analysis.run', 'proposal.list', 'proposal.status', 'ismail.presets']
const JOB_RUNTIME = ['render.mix', 'render.stems', 'analysis.run', 'ismail.generate', 'ismail.separate']
const MAX_BODY = 2 * 1024 * 1024

class HttpError extends Error {
  constructor(
    readonly code: ApiErrorBody['error']['code'],
    message: string,
  ) {
    super(message)
  }
}

export class ApiServer {
  private server: Server | null = null
  private discovery: ApiDiscovery | null = null
  private readonly jobs = new Map<string, JobState>()
  private readonly cancelled = new Set<string>()
  private readonly streams = new Set<ServerResponse>()
  private readonly seen = new Map<string, number>()
  private heartbeat: ReturnType<typeof setInterval> | null = null

  constructor(private readonly options: ApiServerOptions) {}

  get file(): string {
    return join(this.options.directory, API_DISCOVERY_FILE)
  }

  async start(): Promise<ApiDiscovery> {
    const server = createServer((req, res) => void this.handle(req, res))
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.options.port ?? 0, '127.0.0.1', () => resolve())
    })
    this.server = server
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    this.discovery = { version: API_VERSION, port, pid: process.pid, readToken: randomBytes(24).toString('hex'), writeToken: randomBytes(24).toString('hex'), startedAt: new Date().toISOString() }
    await writeAtomic(this.file, JSON.stringify(this.discovery, null, 2))
    this.heartbeat = setInterval(() => {
      for (const stream of this.streams) stream.write(': keep-alive\n\n')
    }, 15000)
    this.options.log(`Local API listening on 127.0.0.1:${port}.`)
    return this.discovery
  }

  async stop(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat)
    for (const stream of this.streams) stream.end()
    this.streams.clear()
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()))
    this.server = null
    await rm(this.file, { force: true })
  }

  emit(event: ApiEvent): void {
    // Progress from the app updates the job the server tracks; the app cannot
    // change a job's status, which only the server sets.
    if (event.type === 'job') {
      const state = this.jobs.get(event.job.id)
      if (!state) return
      if (state.status !== 'running') return
      const next = { ...state, completed: event.job.completed, total: event.job.total }
      this.jobs.set(state.id, next)
      event = { type: 'job', job: next }
    }
    const line = `data: ${JSON.stringify(event)}\n\n`
    for (const stream of this.streams) stream.write(line)
  }

  /** Distinct clients seen in the last minute, plus open event streams. */
  clientCount(): number {
    const cutoff = Date.now() - 60_000
    for (const [key, at] of this.seen) if (at < cutoff) this.seen.delete(key)
    return Math.max(this.seen.size, this.streams.size)
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const send = (status: number, value: unknown) => {
      if (res.headersSent) return
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify(value))
    }
    try {
      const discovery = this.discovery
      if (!discovery) throw new HttpError('unavailable', 'The API is starting.')
      if (![`127.0.0.1:${discovery.port}`, `localhost:${discovery.port}`].includes(req.headers.host ?? '')) throw new HttpError('forbidden', 'Requests must address 127.0.0.1.')
      if (req.headers.origin !== undefined) throw new HttpError('forbidden', 'Browser requests are not allowed.')
      const auth = req.headers.authorization ?? ''
      const role = auth === `Bearer ${discovery.writeToken}` ? 'write' : auth === `Bearer ${discovery.readToken}` ? 'read' : null
      if (!role) throw new HttpError('unauthorized', 'Missing or wrong token. Read it from api.json.')
      this.seen.set(`${role}:${req.headers['user-agent'] ?? ''}:${req.socket.remoteAddress}`, Date.now())
      const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
      const body = req.method === 'POST' ? await readJson(req) : undefined
      const result = await this.route(req, res, role, path, body)
      if (result !== undefined) send(200, result)
    } catch (error) {
      const code = error instanceof HttpError ? error.code : 'internal'
      if (code === 'internal') this.options.log(`API error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
      send(STATUS[code], { error: { code, message: error instanceof Error ? error.message : String(error) } } satisfies ApiErrorBody)
    }
  }

  private async forward(route: 'status' | 'execute' | 'runtime', body: unknown, timeoutMs?: number): Promise<unknown> {
    let reply: { status: number; body: unknown }
    try {
      reply = await this.options.rpc.request(route, body, timeoutMs)
    } catch (error) {
      throw new HttpError('unavailable', error instanceof Error ? error.message : 'The RE:BORN window is not ready.')
    }
    if (reply.status >= 400) {
      const failure = reply.body as ApiErrorBody
      throw new HttpError(failure?.error?.code ?? 'internal', failure?.error?.message ?? 'Request failed.')
    }
    return reply.body
  }

  private async route(req: IncomingMessage, res: ServerResponse, role: 'read' | 'write', path: string, body: unknown): Promise<unknown> {
    if (req.method === 'GET' && path === '/v1/status') {
      const status = (await this.forward('status', {})) as Record<string, unknown>
      return { app: 'RE:BORN', version: this.options.version, api: API_VERSION, clients: this.clientCount(), ...status }
    }
    if (req.method === 'GET' && path === '/v1/commands') return studio.listCommands()
    if (req.method === 'POST' && path === '/v1/execute') {
      const request = body as ExecuteRequest
      if (!Array.isArray(request?.commands)) throw new HttpError('invalid', 'commands must be a list.')
      const unknown = request.commands.find((c) => !studio.COMMANDS.has(c?.type))
      if (unknown) throw new HttpError('invalid', `Unknown command "${String(unknown?.type)}".`)
      if (role !== 'write' && request.commands.some((c) => studio.COMMANDS.get(c.type)?.mutates)) throw new HttpError('forbidden', 'The read token cannot edit the project.')
      return this.forward('execute', request)
    }
    if (req.method === 'POST' && path === '/v1/runtime') {
      const request = body as RuntimeRequest
      if (role !== 'write' && !READ_RUNTIME.includes(request?.action)) throw new HttpError('forbidden', `The read token cannot run ${String(request?.action)}.`)
      if (JOB_RUNTIME.includes(request.action)) return { jobId: this.startJob(request) }
      return this.forward('runtime', request)
    }
    const job = /^\/v1\/jobs\/([^/]+)$/.exec(path)
    if (req.method === 'GET' && job) {
      const state = this.jobs.get(decodeURIComponent(job[1]))
      if (!state) throw new HttpError('not_found', 'No such job.')
      return state
    }
    if (req.method === 'DELETE' && job) {
      if (role !== 'write') throw new HttpError('forbidden', 'The read token cannot cancel jobs.')
      const id = decodeURIComponent(job[1])
      const state = this.jobs.get(id)
      if (!state) throw new HttpError('not_found', 'No such job.')
      if (state.status !== 'running') return state
      this.cancelled.add(id)
      const next: JobState = { ...state, status: 'cancelled' }
      this.jobs.set(id, next)
      this.emit({ type: 'job', job: next })
      await this.forward('runtime', { action: 'job.cancel', params: { jobId: id } }).catch(() => undefined)
      return next
    }
    if (req.method === 'GET' && path === '/v1/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      res.write(': connected\n\n')
      this.streams.add(res)
      req.on('close', () => this.streams.delete(res))
      return undefined
    }
    throw new HttpError('not_found', `No route ${req.method} ${path}.`)
  }

  private startJob(request: RuntimeRequest): string {
    const id = `job_${randomUUID()}`
    const kind = request.action.startsWith('render') ? 'render' : request.action.startsWith('ismail') ? 'ismail' : 'analysis'
    const update = (patch: Partial<JobState>) => {
      const next = { ...(this.jobs.get(id) as JobState), ...patch }
      this.jobs.set(id, next)
      this.emit({ type: 'job', job: next })
    }
    this.jobs.set(id, { id, kind, status: 'running', completed: 0, total: 1 })
    void (async () => {
      try {
        const reply = (await this.forward('runtime', { ...request, params: { ...request.params, jobId: id } }, 600_000)) as { result?: { files?: RenderedFile[] } & Record<string, unknown> }
        if (this.cancelled.delete(id)) return
        if (kind === 'render') {
          const target = typeof request.params?.path === 'string' ? request.params.path : undefined
          const paths = await this.options.writeFiles(reply.result?.files ?? [], target)
          update({ status: 'done', completed: 1, result: request.action === 'render.mix' ? { path: paths[0] } : { paths } })
        } else update({ status: 'done', completed: 1, result: reply.result })
      } catch (error) {
        if (this.cancelled.delete(id)) return
        update({ status: 'failed', message: error instanceof Error ? error.message : String(error) })
      }
    })()
    // Finished jobs are kept for ten minutes so slow clients can read them.
    setTimeout(() => this.jobs.delete(id), 600_000).unref()
    return id
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY) throw new HttpError('invalid', 'Request body is too large.')
    chunks.push(chunk as Buffer)
  }
  if (!size) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError('invalid', 'Request body is not valid JSON.')
  }
}

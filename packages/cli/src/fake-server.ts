import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ApiDiscovery, ApiErrorBody, ApiEvent, ApiStatus, ExecuteRequest, ExecuteResponse, JobState, RuntimeRequest } from '@reborn/studio-core/api'
import { COMMANDS, type Command, type StudioProject, StudioError, createDefaultStudioProject, executeBatch, listCommands } from '@reborn/studio-core/studio'

// Test double for the desktop's local service. It implements the routes in
// `@reborn/studio-core/api` against an in-memory project with the real
// command registry, including the Host, Origin, and token checks.

export interface FakeProposal {
  id: string
  commands: Command[]
  intent?: string
  status: 'pending' | 'applied' | 'partial' | 'rejected'
}

export interface RecordedRequest {
  method: string
  path: string
  body: unknown
  role: 'read' | 'write' | null
}

export interface FakeServerOptions {
  directAgentEdits?: boolean
  /** How many job polls report "running" before the job finishes. */
  jobPolls?: number
  failJobs?: boolean
}

export interface FakeServer {
  port: number
  dir: string
  apiFile: string
  discovery: ApiDiscovery
  state: {
    project: StudioProject
    playing: boolean
    bar: number
    directAgentEdits: boolean
    proposals: FakeProposal[]
    undo: StudioProject[]
    redo: StudioProject[]
  }
  requests: RecordedRequest[]
  subscribers: () => number
  emit: (event: ApiEvent) => void
  close: () => Promise<void>
}

const READ_RUNTIME = ['analysis.run', 'proposal.list', 'proposal.status']
const STATUS: Record<ApiErrorBody['error']['code'], number> = { unauthorized: 401, forbidden: 403, invalid: 400, not_found: 404, conflict: 409, unavailable: 503, internal: 500 }

class HttpError extends Error {
  constructor(
    readonly code: ApiErrorBody['error']['code'],
    message: string,
  ) {
    super(message)
  }
}

export async function startFakeServer(options: FakeServerOptions = {}): Promise<FakeServer> {
  const dir = await mkdtemp(join(tmpdir(), 'reborn-cli-'))
  const discovery: ApiDiscovery = { version: 1, port: 0, pid: process.pid, readToken: 'read-token', writeToken: 'write-token', startedAt: new Date().toISOString() }
  const state: FakeServer['state'] = { project: createDefaultStudioProject('Test Beat'), playing: false, bar: 1, directAgentEdits: options.directAgentEdits ?? false, proposals: [], undo: [], redo: [] }
  const requests: RecordedRequest[] = []
  const jobs = new Map<string, { job: JobState; polls: number; result: unknown }>()
  const streams = new Set<ServerResponse>()
  let nextId = 1

  const emit = (event: ApiEvent) => {
    for (const stream of streams) stream.write(`data: ${JSON.stringify(event)}\n\n`)
  }

  const startJob = (kind: string, result: unknown): string => {
    const id = `job_${nextId++}`
    jobs.set(id, { job: { id, kind, status: 'running', completed: 0, total: 4 }, polls: options.jobPolls ?? 2, result })
    return id
  }

  const apply = (project: StudioProject) => {
    state.undo.push(state.project)
    state.redo = []
    state.project = project
  }

  const execute = (role: 'read' | 'write', body: ExecuteRequest): ExecuteResponse => {
    if (!Array.isArray(body.commands)) throw new HttpError('invalid', 'commands must be a list.')
    const mutates = body.commands.some((c) => COMMANDS.get(c.type)?.mutates)
    if (mutates && role !== 'write') throw new HttpError('forbidden', 'The read token cannot edit the project.')
    const result = executeBatch(state.project, body.commands, { origin: body.origin ?? 'script', label: body.label, expectedRevision: body.expectedRevision })
    if (mutates && body.origin === 'agent' && !state.directAgentEdits) {
      const proposal: FakeProposal = { id: `prop_${nextId++}`, commands: body.commands, intent: body.intent, status: 'pending' }
      state.proposals.push(proposal)
      emit({ type: 'proposal', id: proposal.id, status: 'pending' })
      return { revision: state.project.revision, results: [], changed: false, proposalId: proposal.id, status: 'proposed' }
    }
    if (result.changed) {
      apply(result.project)
      emit({ type: 'project', revision: result.project.revision, origin: body.origin ?? 'script', label: body.label ?? body.commands.map((c) => c.type).join(', ') })
    }
    return { revision: state.project.revision, results: result.results, changed: result.changed, status: result.changed ? 'applied' : 'read' }
  }

  const runtime = (role: 'read' | 'write', body: RuntimeRequest): unknown => {
    if (role !== 'write' && !READ_RUNTIME.includes(body.action)) throw new HttpError('forbidden', `The read token cannot run ${body.action}.`)
    const params = body.params ?? {}
    switch (body.action) {
      case 'transport.play':
      case 'transport.stop':
        state.playing = body.action === 'transport.play'
        emit({ type: 'transport', playing: state.playing, bar: state.bar })
        return { result: { playing: state.playing, bar: state.bar } }
      case 'transport.seek':
        if (!Number.isInteger(params.bar) || (params.bar as number) < 1) throw new HttpError('invalid', 'bar must be a whole number from 1.')
        state.bar = params.bar as number
        return { result: { bar: state.bar } }
      case 'scene.launch':
        if (!state.project.scenes.some((s) => s.id === params.sceneId)) throw new HttpError('not_found', `No scene "${String(params.sceneId)}".`)
        return { result: { sceneId: params.sceneId } }
      case 'history.undo':
      case 'history.redo': {
        const from = body.action === 'history.undo' ? state.undo : state.redo
        const to = body.action === 'history.undo' ? state.redo : state.undo
        const previous = from.pop()
        if (!previous) throw new HttpError('invalid', 'Nothing to undo.')
        to.push(state.project)
        state.project = previous
        return { result: { revision: state.project.revision } }
      }
      case 'project.save':
        return { result: { path: join(dir, 'Test Beat.reborn') } }
      case 'render.mix':
        return { jobId: startJob('render', { path: typeof params.path === 'string' ? params.path : join(dir, 'mix.wav') }) }
      case 'render.stems':
        return { jobId: startJob('render', { paths: state.project.tracks.map((t) => join(dir, 'stems', `${t.name}.wav`)) }) }
      case 'analysis.run':
        return { jobId: startJob('analysis', { from: params.from ?? 1, to: params.to ?? state.project.length, lufs: -9.24, peak: -0.8, notes: ['Kick and Acid 1 overlap at 60 Hz'] }) }
      case 'project.open':
        if (state.project.revision > 0 && params.discardChanges !== true) throw new HttpError('conflict', 'The open project has unsaved changes.')
        return { result: { name: 'Opened', path: params.path, revision: 0 } }
      case 'proposal.list':
        return { result: state.proposals }
      case 'proposal.status': {
        const proposal = state.proposals.find((p) => p.id === params.proposalId)
        if (!proposal) throw new HttpError('not_found', `No proposal "${String(params.proposalId)}".`)
        return { result: proposal }
      }
      default:
        throw new HttpError('invalid', `Unknown action "${String(body.action)}".`)
    }
  }

  const status = (): ApiStatus => ({
    app: 'RE:BORN',
    version: '2.0.0-dev',
    api: 1,
    project: { name: state.project.name, revision: state.project.revision, path: null, bars: state.project.length, tempo: state.project.tempo },
    transport: { playing: state.playing, bar: state.bar },
    clients: streams.size,
    directAgentEdits: state.directAgentEdits,
  })

  const route = async (req: IncomingMessage, res: ServerResponse, role: 'read' | 'write', path: string, body: unknown): Promise<unknown> => {
    if (req.method === 'GET' && path === '/v1/status') return status()
    if (req.method === 'GET' && path === '/v1/commands') return listCommands()
    if (req.method === 'POST' && path === '/v1/execute') return execute(role, body as ExecuteRequest)
    if (req.method === 'POST' && path === '/v1/runtime') return runtime(role, body as RuntimeRequest)
    const jobMatch = /^\/v1\/jobs\/([^/]+)$/.exec(path)
    if (req.method === 'GET' && jobMatch) {
      const entry = jobs.get(decodeURIComponent(jobMatch[1]))
      if (!entry) throw new HttpError('not_found', 'No such job.')
      if (entry.job.status === 'running') {
        if (entry.polls > 0) {
          entry.polls--
          entry.job = { ...entry.job, completed: Math.min(entry.job.total - 1, entry.job.completed + 1) }
        } else {
          entry.job = options.failJobs ? { ...entry.job, status: 'failed', message: 'The engine stopped.' } : { ...entry.job, status: 'done', completed: entry.job.total, result: entry.result }
        }
        emit({ type: 'job', job: entry.job })
      }
      return entry.job
    }
    if (req.method === 'DELETE' && jobMatch) {
      if (role !== 'write') throw new HttpError('forbidden', 'The read token cannot cancel jobs.')
      const entry = jobs.get(decodeURIComponent(jobMatch[1]))
      if (!entry) throw new HttpError('not_found', 'No such job.')
      if (entry.job.status === 'running') entry.job = { ...entry.job, status: 'cancelled' }
      emit({ type: 'job', job: entry.job })
      return entry.job
    }
    if (req.method === 'GET' && path === '/v1/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      res.write(': connected\n\n')
      streams.add(res)
      res.on('close', () => streams.delete(res))
      return undefined
    }
    throw new HttpError('not_found', `No route ${req.method} ${path}.`)
  }

  const server = createServer(async (req, res) => {
    const send = (code: number, value: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(JSON.stringify(value))
    }
    const fail = (error: HttpError) => send(STATUS[error.code], { error: { code: error.code, message: error.message } } satisfies ApiErrorBody)
    const path = (req.url ?? '/').split('?')[0]
    let role: 'read' | 'write' | null = null
    let body: unknown
    try {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      const text = Buffer.concat(chunks).toString('utf8')
      body = text ? JSON.parse(text) : undefined
    } catch {
      requests.push({ method: req.method ?? '', path, body: undefined, role })
      return fail(new HttpError('invalid', 'The body is not valid JSON.'))
    }
    const auth = req.headers.authorization ?? ''
    role = auth === `Bearer ${discovery.writeToken}` ? 'write' : auth === `Bearer ${discovery.readToken}` ? 'read' : null
    requests.push({ method: req.method ?? '', path, body, role })
    try {
      const port = (server.address() as AddressInfo).port
      if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host ?? '')) throw new HttpError('forbidden', 'Bad Host header.')
      if (req.headers.origin !== undefined) throw new HttpError('forbidden', 'Browser requests are not allowed.')
      if (!role) throw new HttpError('unauthorized', 'Missing or wrong token.')
      const result = await route(req, res, role, path, body)
      if (result !== undefined) send(200, result)
    } catch (error) {
      if (error instanceof HttpError) return fail(error)
      if (error instanceof StudioError) return fail(new HttpError(error.code, error.message))
      fail(new HttpError('internal', error instanceof Error ? error.message : String(error)))
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  discovery.port = (server.address() as AddressInfo).port
  const apiFile = join(dir, 'api.json')
  await writeFile(apiFile, JSON.stringify(discovery))

  return {
    port: discovery.port,
    dir,
    apiFile,
    discovery,
    state,
    requests,
    subscribers: () => streams.size,
    emit,
    close: async () => {
      for (const stream of streams) stream.end()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(dir, { recursive: true, force: true })
    },
  }
}

/** Writes an api.json for `server` with some fields replaced. */
export async function writeApiFile(server: FakeServer, name: string, patch: Partial<ApiDiscovery>): Promise<string> {
  const file = join(server.dir, name)
  await writeFile(file, JSON.stringify({ ...server.discovery, ...patch }))
  return file
}

/** A PID that belonged to a process which has already exited. */
export async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
  const pid = child.pid ?? 0
  await new Promise((resolve) => child.on('exit', resolve))
  return pid
}

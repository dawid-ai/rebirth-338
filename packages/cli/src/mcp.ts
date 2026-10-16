import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'
import type { CommandInfo, RuntimeAction } from '@reborn/studio-core/api'
import { listCommands } from '@reborn/studio-core/studio'
import type { ApiClient } from './client'
import { CliError, VERSION, errorMessage } from './errors'
import { compact } from './format'

// MCP server over stdio: newline-delimited JSON-RPC 2.0 on stdin and stdout.
// Only protocol messages go to stdout; logs go through `log` (stderr).

export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const

export const MCP_INSTRUCTIONS = [
  'RE:BORN is a music workstation; these tools read and edit the project open in it.',
  'Read before you edit: call project_summary, track_get, and pattern_get for IDs and current values.',
  'Edit tools create proposals the user reviews in RE:BORN unless the user turned on direct agent edits.',
  'Each edit result says whether it was applied or is pending review (status "proposed" with a proposalId); pass a short intent with every edit.',
  'Use mixer_trace to explain why something is or is not audible.',
  'Run render_mix or analysis_run before you make claims about how the mix sounds.',
].join(' ')

const ERROR = { parse: -32700, invalidRequest: -32600, methodNotFound: -32601, invalidParams: -32602, internal: -32603 } as const

type Json = Record<string, unknown>
type Id = string | number

export interface ToolResult {
  content: { type: 'text'; text: string }[]
  isError?: true
}

interface Tool {
  name: string
  description: string
  inputSchema: Json
  annotations: { readOnlyHint: boolean }
  call: (args: Json) => Promise<ToolResult>
}

export interface McpServerOptions {
  /** Connects to the app. Called per tool call, so app restarts are picked up. */
  connect: () => Promise<ApiClient>
  readOnly?: boolean
  log?: (text: string) => void
  pollIntervalMs?: number
  jobTimeoutMs?: number
}

const text = (value: unknown, isError = false): ToolResult => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : compact(value) }], ...(isError && { isError: true as const }) })

const failure = (error: unknown): ToolResult =>
  error instanceof CliError ? text({ error: error.code, message: error.message, ...(error.hint && { hint: error.hint }) }, true) : text({ error: 'internal', message: errorMessage(error) }, true)

const INTENT = { type: 'string', description: 'Why you propose this change, in one sentence. Shown to the user on the review card.' }

const toolName = (type: string) => type.replace(/\./g, '_')

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message)
  }
}

export class McpServer {
  private tools: Map<string, Tool> | null = null
  private loading: Promise<Map<string, Tool>> | null = null

  constructor(private readonly options: McpServerOptions) {}

  /** Handles one stdin line. Returns the line to write, or null. */
  async handleLine(line: string): Promise<string | null> {
    if (!line.trim()) return null
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch {
      return compact(errorResponse(null, ERROR.parse, 'Parse error: the message is not valid JSON.'))
    }
    if (Array.isArray(message)) {
      if (!message.length) return compact(errorResponse(null, ERROR.invalidRequest, 'Empty batch.'))
      const responses = (await Promise.all(message.map((item) => this.handleMessage(item)))).filter((r) => r !== null)
      return responses.length ? compact(responses) : null
    }
    const response = await this.handleMessage(message)
    return response ? compact(response) : null
  }

  async handleMessage(message: unknown): Promise<Json | null> {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return errorResponse(null, ERROR.invalidRequest, 'Invalid request.')
    const msg = message as Json
    const hasId = typeof msg.id === 'string' || typeof msg.id === 'number'
    const id = hasId ? (msg.id as Id) : null
    if (msg.jsonrpc !== '2.0') return errorResponse(id, ERROR.invalidRequest, 'Invalid request: jsonrpc must be "2.0".')
    if (typeof msg.method !== 'string') {
      // Responses to requests we never send; nothing to do.
      if ('result' in msg || 'error' in msg) return null
      return errorResponse(id, ERROR.invalidRequest, 'Invalid request: method is missing.')
    }
    const params = msg.params === undefined ? {} : msg.params
    if (!hasId) {
      // Notifications (initialized, cancelled, ...) need no answer.
      return null
    }
    try {
      if (!params || typeof params !== 'object' || Array.isArray(params)) throw new RpcError(ERROR.invalidParams, 'params must be an object.')
      return { jsonrpc: '2.0', id, result: await this.dispatch(msg.method, params as Json) }
    } catch (error) {
      if (error instanceof RpcError) return errorResponse(id, error.code, error.message)
      this.log(`${msg.method} failed: ${errorMessage(error)}`)
      return errorResponse(id, ERROR.internal, errorMessage(error))
    }
  }

  private async dispatch(method: string, params: Json): Promise<unknown> {
    switch (method) {
      case 'initialize': {
        const requested = params.protocolVersion
        const supported = SUPPORTED_PROTOCOL_VERSIONS.find((v) => v === requested) ?? SUPPORTED_PROTOCOL_VERSIONS[0]
        return { protocolVersion: supported, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'reborn', version: VERSION }, instructions: MCP_INSTRUCTIONS }
      }
      case 'ping':
        return {}
      case 'tools/list':
        return { tools: [...(await this.loadTools()).values()].map(({ call: _call, ...tool }) => tool) }
      case 'tools/call': {
        if (typeof params.name !== 'string') throw new RpcError(ERROR.invalidParams, 'tools/call needs a tool name.')
        const tool = (await this.loadTools()).get(params.name)
        if (!tool) throw new RpcError(ERROR.invalidParams, `Unknown tool: ${params.name}`)
        const args = params.arguments ?? {}
        if (!args || typeof args !== 'object' || Array.isArray(args)) throw new RpcError(ERROR.invalidParams, 'Tool arguments must be an object.')
        try {
          return await tool.call(args as Json)
        } catch (error) {
          return failure(error)
        }
      }
      default:
        throw new RpcError(ERROR.methodNotFound, `Method not found: ${method}`)
    }
  }

  /**
   * Builds the tool list from the app's `GET /v1/commands`. When the app is
   * unreachable, falls back to the bundled registry and retries next time.
   */
  loadTools(): Promise<Map<string, Tool>> {
    if (this.tools) return Promise.resolve(this.tools)
    this.loading ??= (async () => {
      let commands: CommandInfo[]
      let live = false
      try {
        commands = await (await this.options.connect()).commands()
        live = true
      } catch (error) {
        this.log(`Using the bundled command list; RE:BORN did not answer: ${errorMessage(error)}`)
        commands = listCommands()
      }
      const tools = this.buildTools(commands)
      if (live) this.tools = tools
      this.loading = null
      return tools
    })()
    return this.loading
  }

  private buildTools(commands: readonly CommandInfo[]): Map<string, Tool> {
    const tools = new Map<string, Tool>()
    const add = (tool: Tool) => tools.set(tool.name, tool)
    for (const info of commands) {
      if (this.options.readOnly && info.mutates) continue
      const schema = info.mutates ? withIntent(info.schema) : info.schema
      add({ name: toolName(info.type), description: info.summary, inputSchema: schema, annotations: { readOnlyHint: !info.mutates }, call: (args) => this.callCommand(info, args) })
    }
    const empty: Json = { type: 'object', properties: {}, additionalProperties: false }
    const runtime = (name: string, description: string, action: RuntimeAction, mutates: boolean) => {
      if (this.options.readOnly && mutates) return
      add({ name, description, inputSchema: empty, annotations: { readOnlyHint: !mutates }, call: () => this.callRuntime(action, {}) })
    }
    runtime('transport_play', 'Start playback in RE:BORN.', 'transport.play', true)
    runtime('transport_stop', 'Stop playback in RE:BORN.', 'transport.stop', true)
    runtime('history_undo', 'Undo the last applied edit in RE:BORN.', 'history.undo', true)
    if (!this.options.readOnly) {
      add({ name: 'render_mix', description: 'Render the full mix to audio and wait for the job. Returns the output path.', inputSchema: empty, annotations: { readOnlyHint: false }, call: () => this.callRuntime('render.mix', {}) })
      add({ name: 'render_stems', description: 'Render one stem per track and wait for the job. Returns the output paths.', inputSchema: empty, annotations: { readOnlyHint: false }, call: () => this.callRuntime('render.stems', {}) })
    }
    add({
      name: 'analysis_run',
      description: 'Analyze the rendered mix (loudness, balance, spectrum) over a bar range and wait for the result. Bars are 1-based; omit both for the whole song.',
      inputSchema: {
        type: 'object',
        properties: { from: { type: 'integer', description: 'First bar (1-based).', minimum: 1 }, to: { type: 'integer', description: 'Last bar (1-based).', minimum: 1 } },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
      call: (args) => {
        const params: Json = {}
        for (const key of ['from', 'to'] as const) {
          if (args[key] === undefined) continue
          if (!Number.isInteger(args[key]) || (args[key] as number) < 1) return Promise.resolve(text({ error: 'invalid', message: `${key} must be a whole bar number from 1.` }, true))
          params[key] = args[key]
        }
        return this.callRuntime('analysis.run', params)
      },
    })
    add({
      name: 'proposal_status',
      description: 'Check whether the user applied, partly applied, or rejected a proposal. Without proposalId, lists proposals.',
      inputSchema: { type: 'object', properties: { proposalId: { type: 'string', description: 'Proposal ID from an edit result.' } }, additionalProperties: false },
      annotations: { readOnlyHint: true },
      call: (args) => (typeof args.proposalId === 'string' && args.proposalId ? this.callRuntime('proposal.status', { proposalId: args.proposalId }) : this.callRuntime('proposal.list', {})),
    })
    return tools
  }

  private async callCommand(info: CommandInfo, args: Json): Promise<ToolResult> {
    const { intent, ...params } = args
    const client = await this.options.connect()
    const response = await client.execute({
      commands: [{ type: info.type, params }],
      origin: 'agent',
      ...(info.mutates && typeof intent === 'string' && intent.trim() && { intent: intent.trim() }),
    })
    const result = response.results[0] ?? null
    if (response.status === 'read') return text(result)
    if (response.status === 'proposed') {
      return text({
        status: 'proposed',
        proposalId: response.proposalId,
        revision: response.revision,
        note: 'Not applied yet. The user reviews this proposal in RE:BORN; check it with proposal_status before relying on the change.',
      })
    }
    return text({ status: 'applied', revision: response.revision, result })
  }

  private async callRuntime(action: RuntimeAction, params: Json): Promise<ToolResult> {
    const client = await this.options.connect()
    const response = await client.runtime({ action, params })
    if (!response.jobId) return text({ status: 'done', result: response.result ?? null })
    const { job, timedOut } = await client.waitForJob(response.jobId, { intervalMs: this.options.pollIntervalMs, timeoutMs: this.options.jobTimeoutMs ?? 300_000 })
    if (timedOut) return text({ status: 'running', jobId: job.id, completed: job.completed, total: job.total, note: 'Still running. Call this tool again later or ask the user to check RE:BORN.' })
    if (job.status !== 'done') return text({ error: job.status, jobId: job.id, message: job.message ?? `The ${job.kind} job ${job.status}.` }, true)
    return text({ status: 'done', jobId: job.id, result: job.result ?? null })
  }

  private log(message: string): void {
    this.options.log?.(`[reborn mcp] ${message}`)
  }
}

function withIntent(schema: Record<string, unknown>): Json {
  const properties = (schema.properties ?? {}) as Json
  return { ...schema, properties: { ...properties, intent: INTENT } }
}

function errorResponse(id: Id | null, code: number, message: string): Json {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

export interface RunMcpOptions extends McpServerOptions {
  input: Readable
  output: Writable
}

/** Serves MCP until `input` ends, then waits for in-flight requests. */
export async function runMcpServer(options: RunMcpOptions): Promise<void> {
  const server = new McpServer(options)
  void server.loadTools()
  const pending = new Set<Promise<void>>()
  const lines = createInterface({ input: options.input, crlfDelay: Infinity })
  for await (const line of lines) {
    const task = server
      .handleLine(line)
      .then((reply) => {
        if (reply !== null) options.output.write(`${reply}\n`)
      })
      .catch((error: unknown) => options.log?.(`[reborn mcp] ${errorMessage(error)}`))
      .finally(() => pending.delete(task))
    pending.add(task)
  }
  await Promise.all(pending)
}

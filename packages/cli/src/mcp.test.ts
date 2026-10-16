import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { connect } from './client'
import { type FakeServer, startFakeServer } from './fake-server'
import { MCP_INSTRUCTIONS, runMcpServer } from './mcp'

interface Reply {
  jsonrpc: '2.0'
  id: string | number | null
  result?: Record<string, unknown>
  error?: { code: number; message: string }
}

interface ToolInfo {
  name: string
  description: string
  inputSchema: { properties: Record<string, unknown>; required?: string[] }
}

interface ToolResult {
  content: { type: string; text: string }[]
  isError?: boolean
}

let server: FakeServer
afterEach(async () => {
  await server.close()
})

/** Runs the MCP server on in-memory streams and talks to it line by line. */
function harness(options: { readOnly?: boolean; apiFile?: string } = {}) {
  const input = new PassThrough()
  const output = new PassThrough()
  const lines: string[] = []
  const waiting = new Map<string | number | null, (reply: Reply) => void>()
  let buffer = ''
  const logs: string[] = []
  output.setEncoding('utf8')
  output.on('data', (chunk: string) => {
    buffer += chunk
    let newline: number
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      lines.push(line)
      const reply = JSON.parse(line) as Reply
      waiting.get(reply.id)?.(reply)
      waiting.delete(reply.id)
    }
  })
  const done = runMcpServer({
    connect: () => connect({ apiFile: options.apiFile ?? server.apiFile, readOnly: options.readOnly }),
    readOnly: options.readOnly,
    input,
    output,
    log: (text) => logs.push(text),
    pollIntervalMs: 5,
  })
  let nextId = 1
  const send = (raw: string, id: string | number | null) =>
    new Promise<Reply>((resolve) => {
      waiting.set(id, resolve)
      input.write(`${raw}\n`)
    })
  const request = (method: string, params?: unknown) => {
    const id = nextId++
    return send(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params !== undefined && { params }) }), id)
  }
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const reply = await request('tools/call', { name, arguments: args })
    if (reply.error) throw new Error(reply.error.message)
    const result = reply.result as unknown as ToolResult
    return { ...result, data: JSON.parse(result.content[0].text) as Record<string, unknown> }
  }
  const tools = async () => ((await request('tools/list')).result as { tools: ToolInfo[] }).tools
  return { input, lines, logs, send, request, call, tools, close: async () => (input.end(), await done) }
}

describe('MCP protocol', () => {
  beforeEach(async () => {
    server = await startFakeServer()
  })

  it('echoes a supported protocol version and describes the server', async () => {
    const mcp = harness()
    const reply = await mcp.request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } })
    expect(reply.result).toEqual({
      protocolVersion: '2025-03-26',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'reborn', version: '2.0.0-dev' },
      instructions: MCP_INSTRUCTIONS,
    })
    expect(MCP_INSTRUCTIONS).toMatch(/project_summary.*track_get.*pattern_get/)
    expect(MCP_INSTRUCTIONS).toMatch(/mixer_trace/)
    const old = await mcp.request('initialize', { protocolVersion: '2024-11-05' })
    expect(old.result?.protocolVersion).toBe('2024-11-05')
    const future = await mcp.request('initialize', { protocolVersion: '2099-01-01' })
    expect(future.result?.protocolVersion).toBe('2025-06-18')
    await mcp.close()
  })

  it('ignores notifications, answers ping, and keeps stdout to protocol lines', async () => {
    const mcp = harness()
    mcp.input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
    const pong = await mcp.request('ping')
    expect(pong).toEqual({ jsonrpc: '2.0', id: 1, result: {} })
    await mcp.close()
    expect(mcp.lines).toHaveLength(1)
    for (const line of mcp.lines) expect(JSON.parse(line)).toMatchObject({ jsonrpc: '2.0' })
  })

  it('returns -32700 with a null id for unparsable input', async () => {
    const mcp = harness()
    const reply = await mcp.send('{"jsonrpc":"2.0","id":5,', null)
    expect(reply).toMatchObject({ id: null, error: { code: -32700 } })
    await mcp.close()
  })

  it('returns -32601 for unknown methods and -32602 for unknown tools', async () => {
    const mcp = harness()
    expect((await mcp.request('resources/list')).error?.code).toBe(-32601)
    expect((await mcp.request('tools/call', { name: 'track_explode', arguments: {} })).error?.code).toBe(-32602)
    await mcp.close()
  })
})

describe('MCP tools', () => {
  beforeEach(async () => {
    server = await startFakeServer()
  })

  it('lists one tool per registry command plus runtime tools', async () => {
    const mcp = harness()
    const tools = await mcp.tools()
    const byName = new Map(tools.map((t) => [t.name, t]))
    expect(byName.get('project_summary')?.description).toMatch(/Describe the project/)
    expect(byName.get('drum_step_set')).toBeDefined()
    expect(byName.get('project_summary')?.inputSchema.properties).not.toHaveProperty('intent')
    expect(byName.get('parameter_set')?.inputSchema.properties).toHaveProperty('intent')
    expect(byName.get('parameter_set')?.inputSchema.required).toEqual(['trackId', 'param', 'value'])
    for (const name of ['transport_play', 'transport_stop', 'render_mix', 'render_stems', 'analysis_run', 'history_undo', 'proposal_status']) expect(byName.has(name)).toBe(true)
    expect(server.requests.filter((r) => r.path === '/v1/commands')).toHaveLength(1)
    await mcp.close()
  })

  it('lists only read tools in read-only mode and refuses edit tools', async () => {
    const mcp = harness({ readOnly: true })
    const names = (await mcp.tools()).map((t) => t.name)
    expect(names).toContain('project_summary')
    expect(names).toContain('mixer_trace')
    expect(names).toContain('analysis_run')
    expect(names).toContain('proposal_status')
    for (const name of ['parameter_set', 'track_add', 'transport_play', 'render_mix', 'history_undo']) expect(names).not.toContain(name)
    expect((await mcp.request('tools/call', { name: 'parameter_set', arguments: {} })).error?.code).toBe(-32602)
    const summary = await mcp.call('project_summary')
    expect(summary.data).toMatchObject({ name: 'Test Beat' })
    expect(server.requests.at(-1)?.role).toBe('read')
    await mcp.close()
  })

  it('reports edits as pending proposals when direct agent edits are off', async () => {
    const mcp = harness()
    const before = server.state.project.revision
    const result = await mcp.call('parameter_set', { trackId: 'Acid 1', param: 'device.cutoff', value: 0.8, intent: 'Open the filter for the chorus.' })
    expect(result.isError).toBeUndefined()
    expect(result.data).toMatchObject({ status: 'proposed', proposalId: expect.stringMatching(/^prop_/) })
    expect(result.data.note).toMatch(/Not applied yet/)
    expect(server.state.project.revision).toBe(before)
    expect(server.requests.at(-1)?.body).toEqual({ commands: [{ type: 'parameter.set', params: { trackId: 'Acid 1', param: 'device.cutoff', value: 0.8 } }], origin: 'agent', intent: 'Open the filter for the chorus.' })
    const status = await mcp.call('proposal_status', { proposalId: result.data.proposalId })
    expect(status.data).toMatchObject({ status: 'done', result: { status: 'pending', intent: 'Open the filter for the chorus.' } })
    await mcp.close()
  })

  it('reports edits as applied when direct agent edits are on', async () => {
    server.state.directAgentEdits = true
    const mcp = harness()
    const result = await mcp.call('track_add', { kind: 'drum', name: 'Perc' })
    expect(result.data).toMatchObject({ status: 'applied', revision: 1, result: { trackId: expect.any(String) } })
    expect(server.state.project.tracks.at(-1)?.name).toBe('Perc')
    await mcp.close()
  })

  it('turns app errors into isError results', async () => {
    const mcp = harness()
    const missing = await mcp.call('track_get', { trackId: 'nope' })
    expect(missing.isError).toBe(true)
    expect(missing.data).toEqual({ error: 'not_found', message: 'No track "nope".' })
    const invalid = await mcp.call('mixer_set', { trackId: '808', volume: 99 })
    expect(invalid).toMatchObject({ isError: true, data: { error: 'invalid' } })
    await mcp.close()
  })

  it('generates and separates through Ismail jobs, and hides them when read-only', async () => {
    const mcp = harness()
    const generated = await mcp.call('ismail_generate', { name: 'Stab', instrument: 'acid_bass', notes: '0 C2 0.5' })
    expect(generated.data).toMatchObject({ status: 'done', result: { assetId: 'ast_generated', name: 'Stab' } })
    const separated = await mcp.call('ismail_separate', { clipId: 'clp_1' })
    expect(separated.data).toMatchObject({ status: 'done', result: { stems: expect.arrayContaining([expect.objectContaining({ name: 'vocals' })]) } })
    expect((await mcp.call('ismail_presets')).data).toMatchObject({ status: 'done', result: { presets: [{ name: 'acid_bass' }] } })
    await mcp.close()
    const readOnly = harness({ readOnly: true })
    const names = (await readOnly.tools()).map((t) => t.name)
    expect(names).toContain('ismail_presets')
    expect(names).not.toContain('ismail_generate')
    expect(names).not.toContain('ismail_separate')
    await readOnly.close()
  })

  it('runs analysis as a job and returns its result', async () => {
    const mcp = harness()
    const result = await mcp.call('analysis_run', { from: 1, to: 8 })
    expect(result.data).toMatchObject({ status: 'done', result: { from: 1, to: 8, lufs: -9.24 } })
    expect(server.requests.filter((r) => r.path.startsWith('/v1/jobs/')).length).toBe(3)
    expect((await mcp.call('analysis_run', { from: 0 })).isError).toBe(true)
    await mcp.close()
  })

  it('controls the transport and undoes', async () => {
    server.state.directAgentEdits = true
    const mcp = harness()
    expect((await mcp.call('transport_play')).data).toMatchObject({ status: 'done', result: { playing: true } })
    await mcp.call('project_update', { tempo: 90 })
    expect(server.state.project.tempo).toBe(90)
    await mcp.call('history_undo')
    expect(server.state.project.tempo).not.toBe(90)
    await mcp.close()
  })
})

describe('MCP without the app', () => {
  it('lists bundled tools and returns isError for calls', async () => {
    server = await startFakeServer()
    const mcp = harness({ apiFile: `${server.dir}/missing.json` })
    expect((await mcp.tools()).map((t) => t.name)).toContain('pattern_write')
    const result = await mcp.call('project_summary')
    expect(result).toMatchObject({ isError: true, data: { error: 'not_running' } })
    await mcp.close()
    expect(mcp.logs.join('\n')).toMatch(/bundled command list/)
  })
})

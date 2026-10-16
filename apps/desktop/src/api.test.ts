import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentCompleteRequest, ApiDiscovery } from '@reborn/studio-core'
import { AgentService, anthropicComplete, openAiComplete, toOpenAiMessages } from './agent'
import { ApiServer, type RendererRpc } from './api-server'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'reborn-api-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

interface Reply {
  status: number
  body: unknown
}

function call(discovery: ApiDiscovery, method: string, path: string, options: { token?: string; body?: unknown; host?: string; origin?: string } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const data = options.body === undefined ? undefined : JSON.stringify(options.body)
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: discovery.port,
        method,
        path,
        headers: {
          host: options.host ?? `127.0.0.1:${discovery.port}`,
          ...(options.token !== '' && { authorization: `Bearer ${options.token ?? discovery.writeToken}` }),
          ...(options.origin && { origin: options.origin }),
          ...(data && { 'content-type': 'application/json' }),
        },
      },
      (res) => {
        let text = ''
        res.on('data', (chunk) => (text += chunk))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : null }))
      },
    )
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })
}

function server(rpc: RendererRpc, written: string[] = []) {
  return new ApiServer({
    directory: root,
    version: '2.0.0-test',
    rpc,
    writeFiles: async (files, target) => {
      const paths = files.map((f) => join(target ?? root, f.name))
      written.push(...paths)
      return paths
    },
    log: () => undefined,
  })
}

describe('ApiServer', () => {
  it('writes api.json, checks host, origin, and tokens, and removes the file on stop', async () => {
    const api = server({ request: async (route) => ({ status: 200, body: route === 'status' ? { project: null } : {} }) })
    const discovery = await api.start()
    expect(JSON.parse(await readFile(join(root, 'api.json'), 'utf8')).port).toBe(discovery.port)
    expect((await call(discovery, 'GET', '/v1/status')).body).toMatchObject({ app: 'RE:BORN', api: 1 })
    expect((await call(discovery, 'GET', '/v1/status', { token: '' })).status).toBe(401)
    expect((await call(discovery, 'GET', '/v1/status', { token: 'nope' })).status).toBe(401)
    expect((await call(discovery, 'GET', '/v1/status', { host: 'evil.example:80' })).status).toBe(403)
    expect((await call(discovery, 'GET', '/v1/status', { origin: 'https://evil.example' })).status).toBe(403)
    await api.stop()
    expect(existsSync(join(root, 'api.json'))).toBe(false)
  })

  it('lets the read token read but not edit, and forwards edits for the write token', async () => {
    const seen: unknown[] = []
    const api = server({ request: async (route, body) => (seen.push({ route, body }), { status: 200, body: { status: 'applied', revision: 2, results: [null], changed: true } }) })
    const discovery = await api.start()
    const edit = { commands: [{ type: 'project.update', params: { tempo: 120 } }] }
    expect((await call(discovery, 'POST', '/v1/execute', { token: discovery.readToken, body: edit })).status).toBe(403)
    expect((await call(discovery, 'POST', '/v1/execute', { token: discovery.readToken, body: { commands: [{ type: 'project.summary' }] } })).status).toBe(200)
    expect((await call(discovery, 'POST', '/v1/execute', { body: edit })).body).toMatchObject({ status: 'applied' })
    expect((await call(discovery, 'POST', '/v1/execute', { body: { commands: [{ type: 'nope' }] } })).status).toBe(400)
    expect((await call(discovery, 'GET', '/v1/commands')).body).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'pattern.write' })]))
    expect(seen).toHaveLength(2)
    await api.stop()
  })

  it('maps renderer errors to HTTP status codes', async () => {
    const api = server({ request: async () => ({ status: 409, body: { error: { code: 'conflict', message: 'Stale.' } } }) })
    const discovery = await api.start()
    const reply = await call(discovery, 'POST', '/v1/execute', { body: { commands: [{ type: 'project.update', params: { tempo: 99 } }], expectedRevision: 1 } })
    expect(reply).toMatchObject({ status: 409, body: { error: { code: 'conflict' } } })
    await api.stop()
  })

  it('runs renders as jobs and writes the returned files', async () => {
    const written: string[] = []
    const api = server({ request: async () => ({ status: 200, body: { result: { files: [{ name: 'mix.wav', data: new Uint8Array([1, 2]) }] } } }) }, written)
    const discovery = await api.start()
    const started = (await call(discovery, 'POST', '/v1/runtime', { body: { action: 'render.mix' } })).body as { jobId: string }
    let job: { status: string; result?: { path: string } } = { status: 'running' }
    for (let i = 0; i < 50 && job.status === 'running'; i += 1) {
      await new Promise((r) => setTimeout(r, 10))
      job = (await call(discovery, 'GET', `/v1/jobs/${started.jobId}`)).body as typeof job
    }
    expect(job).toMatchObject({ status: 'done', result: { path: join(root, 'mix.wav') } })
    expect((await call(discovery, 'POST', '/v1/runtime', { token: discovery.readToken, body: { action: 'render.mix' } })).status).toBe(403)
    await api.stop()
  })

  it('runs Ismail generation as a job and keeps it off the read token', async () => {
    const forwarded: unknown[] = []
    const api = server({
      request: async (route, body) => {
        forwarded.push(body)
        return { status: 200, body: { result: route === 'runtime' && (body as { action: string }).action === 'ismail.presets' ? { presets: [] } : { assetId: 'ast_1' } } }
      },
    })
    const discovery = await api.start()
    const started = (await call(discovery, 'POST', '/v1/runtime', { body: { action: 'ismail.generate', params: { name: 'Stab' } } })).body as { jobId: string }
    let job: { status: string; kind?: string; result?: unknown } = { status: 'running' }
    for (let i = 0; i < 50 && job.status === 'running'; i += 1) {
      await new Promise((r) => setTimeout(r, 10))
      job = (await call(discovery, 'GET', `/v1/jobs/${started.jobId}`)).body as typeof job
    }
    expect(job).toMatchObject({ status: 'done', kind: 'ismail', result: { assetId: 'ast_1' } })
    expect(forwarded[0]).toMatchObject({ action: 'ismail.generate', params: { name: 'Stab', jobId: started.jobId } })
    expect((await call(discovery, 'POST', '/v1/runtime', { token: discovery.readToken, body: { action: 'ismail.generate' } })).status).toBe(403)
    expect((await call(discovery, 'POST', '/v1/runtime', { token: discovery.readToken, body: { action: 'ismail.separate' } })).status).toBe(403)
    expect((await call(discovery, 'POST', '/v1/runtime', { token: discovery.readToken, body: { action: 'ismail.presets' } })).status).toBe(200)
    await api.stop()
  })

  it('merges app progress into jobs and cancels them through the app', async () => {
    const seen: { action: string; params?: Record<string, unknown> }[] = []
    let finish: (value: { status: number; body: unknown }) => void = () => undefined
    const api = server({
      request: (_route, body) => {
        const request = body as { action: string; params?: Record<string, unknown> }
        seen.push(request)
        if (request.action === 'job.cancel') return Promise.resolve({ status: 200, body: { result: { cancelled: true } } })
        return new Promise((resolve) => (finish = resolve))
      },
    })
    const discovery = await api.start()
    const { jobId } = (await call(discovery, 'POST', '/v1/runtime', { body: { action: 'render.mix' } })).body as { jobId: string }
    expect(seen[0].params?.jobId).toBe(jobId)
    api.emit({ type: 'job', job: { id: jobId, kind: 'render', status: 'done', completed: 3, total: 8 } })
    expect((await call(discovery, 'GET', `/v1/jobs/${jobId}`)).body).toMatchObject({ status: 'running', completed: 3, total: 8 })
    expect((await call(discovery, 'DELETE', `/v1/jobs/${jobId}`, { token: discovery.readToken })).status).toBe(403)
    expect((await call(discovery, 'DELETE', `/v1/jobs/${jobId}`)).body).toMatchObject({ status: 'cancelled' })
    expect(seen.at(-1)).toEqual({ action: 'job.cancel', params: { jobId } })
    finish({ status: 200, body: { result: { files: [] } } })
    await new Promise((r) => setTimeout(r, 20))
    expect((await call(discovery, 'GET', `/v1/jobs/${jobId}`)).body).toMatchObject({ status: 'cancelled' })
    await api.stop()
  })

  it('reports the window as unavailable when the renderer does not answer', async () => {
    const api = server({ request: () => Promise.reject(new Error('The RE:BORN window is not ready.')) })
    const discovery = await api.start()
    expect(await call(discovery, 'GET', '/v1/status')).toMatchObject({ status: 503 })
    await api.stop()
  })
})

const request: AgentCompleteRequest = {
  system: 'Be helpful.',
  tools: [{ name: 'project_summary', description: 'Read', input_schema: { type: 'object' } }],
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'Why echo?' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Checking.' }, { type: 'tool_use', id: 't1', name: 'project_summary', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '{"tempo":124}' }] },
  ],
}

function fakeFetch(handler: (url: string, init: RequestInit) => { status?: number; body: unknown }): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const { status = 200, body } = handler(String(url), init ?? {})
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
}

describe('agent providers', () => {
  it('converts tool turns to the OpenAI chat format', () => {
    expect(toOpenAiMessages(request)).toEqual([
      { role: 'system', content: 'Be helpful.' },
      { role: 'user', content: 'Why echo?' },
      { role: 'assistant', content: 'Checking.', tool_calls: [{ id: 't1', type: 'function', function: { name: 'project_summary', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 't1', content: '{"tempo":124}' },
    ])
  })

  it('calls the Claude API and maps tool use', async () => {
    let sent: Record<string, unknown> = {}
    const result = await anthropicComplete(
      fakeFetch((url, init) => {
        expect(url).toBe('https://api.anthropic.com/v1/messages')
        expect((init.headers as Record<string, string>)['x-api-key']).toBe('k')
        sent = JSON.parse(String(init.body))
        return { body: { content: [{ type: 'text', text: 'Looking' }, { type: 'tool_use', id: 'x', name: 'analysis_run', input: { from: 1 } }], stop_reason: 'tool_use' } }
      }),
      'k',
      'claude-sonnet-5-5',
      request,
    )
    expect(sent).toMatchObject({ model: 'claude-sonnet-5-5', system: 'Be helpful.' })
    expect(result).toEqual({ content: [{ type: 'text', text: 'Looking' }, { type: 'tool_use', id: 'x', name: 'analysis_run', input: { from: 1 } }], stopReason: 'tool_use' })
  })

  it('explains a rejected key and a missing key', async () => {
    await expect(anthropicComplete(fakeFetch(() => ({ status: 401, body: { error: { message: 'bad' } } })), 'k', 'm', request)).rejects.toThrow(/rejected the API key/)
    await expect(anthropicComplete(fakeFetch(() => ({ body: {} })), '', 'm', request)).rejects.toThrow(/Add your Anthropic API key/)
  })

  it('calls an OpenAI-compatible server and parses tool calls', async () => {
    const result = await openAiComplete(
      fakeFetch((url) => {
        expect(url).toBe('http://127.0.0.1:11434/v1/chat/completions')
        return { body: { choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'c', type: 'function', function: { name: 'mixer_trace', arguments: '{"returnId":"delay"}' } }] } }] } }
      }),
      'http://127.0.0.1:11434/v1/',
      '',
      'llama3.1',
      request,
    )
    expect(result).toEqual({ content: [{ type: 'tool_use', id: 'c', name: 'mixer_trace', input: { returnId: 'delay' } }], stopReason: 'tool_use' })
  })

  it('stores settings and an encrypted key, and refuses to store keys without encryption', async () => {
    const secrets = { isEncryptionAvailable: () => true, encryptString: (t: string) => Buffer.from(`enc:${t}`), decryptString: (b: Buffer) => b.toString().slice(4) }
    const service = new AgentService(root, secrets, fakeFetch(() => ({ body: { content: [], stop_reason: 'end_turn' } })))
    let settings = await service.update({ provider: 'anthropic', model: 'claude-sonnet-5-5', apiKey: 'secret' })
    expect(settings).toMatchObject({ provider: 'anthropic', hasKey: true })
    expect((await readFile(join(root, 'agent-key.bin'))).toString()).toBe('enc:secret')
    expect(await readFile(join(root, 'agent.json'), 'utf8')).not.toContain('secret')
    settings = await service.update({ apiKey: null })
    expect(settings.hasKey).toBe(false)
    const locked = new AgentService(root, { ...secrets, isEncryptionAvailable: () => false })
    await expect(locked.update({ apiKey: 'x' })).rejects.toThrow(/credential store/)
  })
})

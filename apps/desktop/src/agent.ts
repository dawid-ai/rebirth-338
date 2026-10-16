import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentCompleteRequest, AgentCompleteResponse, AgentContent, AgentSettings } from '@reborn/studio-core'
import { writeAtomic } from './project-dir'

// Provider adapters for the in-app agent. The renderer runs the tool loop;
// main only makes the model calls, so API keys never reach the page.

export interface SecretBox {
  isEncryptionAvailable(): boolean
  encryptString(text: string): Buffer
  decryptString(data: Buffer): string
}

type StoredSettings = Omit<AgentSettings, 'hasKey' | 'cliAvailable'>

const DEFAULTS: StoredSettings = {
  provider: 'claude-cli',
  model: '',
  baseUrl: 'http://127.0.0.1:11434/v1',
  directEdits: false,
  shareMeasurements: false,
}

export class AgentService {
  private readonly settingsFile: string
  private readonly keyFile: string
  private cliPath: string | null | undefined

  constructor(
    private readonly directory: string,
    private readonly secrets: SecretBox,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.settingsFile = join(directory, 'agent.json')
    this.keyFile = join(directory, 'agent-key.bin')
  }

  private async stored(): Promise<StoredSettings> {
    try {
      return { ...DEFAULTS, ...(JSON.parse(await readFile(this.settingsFile, 'utf8')) as Partial<StoredSettings>) }
    } catch {
      return DEFAULTS
    }
  }

  findCli(): string | null {
    if (this.cliPath !== undefined) return this.cliPath
    const override = process.env.REBORN_CLAUDE_PATH
    if (override) return (this.cliPath = existsSync(override) ? override : null)
    const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['claude'], { encoding: 'utf8' })
    const found = probe.status === 0 ? probe.stdout.split(/\r?\n/).map((l) => l.trim()).find(Boolean) : null
    this.cliPath = found ?? null
    return this.cliPath
  }

  async settings(): Promise<AgentSettings> {
    return { ...(await this.stored()), hasKey: existsSync(this.keyFile), cliAvailable: Boolean(this.findCli()) }
  }

  async update(patch: Partial<StoredSettings> & { apiKey?: string | null }): Promise<AgentSettings> {
    const { apiKey, ...rest } = patch
    const allowed: (keyof StoredSettings)[] = ['provider', 'model', 'baseUrl', 'directEdits', 'shareMeasurements']
    const clean = Object.fromEntries(Object.entries(rest).filter(([k]) => allowed.includes(k as keyof StoredSettings)))
    await writeAtomic(this.settingsFile, JSON.stringify({ ...(await this.stored()), ...clean }, null, 2))
    if (apiKey === null) await rm(this.keyFile, { force: true })
    else if (typeof apiKey === 'string' && apiKey.trim()) {
      if (!this.secrets.isEncryptionAvailable()) throw new Error('The OS credential store is unavailable, so the key cannot be stored safely.')
      await writeAtomic(this.keyFile, this.secrets.encryptString(apiKey.trim()))
    }
    return this.settings()
  }

  private async key(): Promise<string | null> {
    if (!existsSync(this.keyFile)) return null
    return this.secrets.decryptString(await readFile(this.keyFile))
  }

  async complete(request: AgentCompleteRequest): Promise<AgentCompleteResponse> {
    const settings = await this.stored()
    if (settings.provider === 'anthropic') return anthropicComplete(this.fetchImpl, (await this.key()) ?? '', settings.model || 'claude-sonnet-5-5', request)
    if (settings.provider === 'openai-compatible') return openAiComplete(this.fetchImpl, settings.baseUrl, (await this.key()) ?? '', settings.model, request)
    throw new Error('The Claude CLI provider runs through agentRunCli, not agentComplete.')
  }

  /** Runs `claude -p` with the RE:BORN MCP server attached. */
  async runCli(prompt: string, mcp: { command: string; args: string[]; env: Record<string, string> }, tempDir: string, timeoutMs = 300_000): Promise<{ text: string }> {
    const cli = this.findCli()
    if (!cli) throw new Error('The claude command was not found. Install Claude Code or choose another provider.')
    const configFile = join(tempDir, `reborn-mcp-${process.pid}.json`)
    await writeFile(configFile, JSON.stringify({ mcpServers: { reborn: mcp } }))
    try {
      const output = await new Promise<string>((resolve, reject) => {
        const child = spawn(cli, ['-p', prompt, '--output-format', 'json', '--mcp-config', configFile, '--allowedTools', 'mcp__reborn'], { shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(cli), windowsHide: true })
        let stdout = ''
        let stderr = ''
        const timer = setTimeout(() => {
          child.kill()
          reject(new Error('The Claude CLI did not finish within 5 minutes.'))
        }, timeoutMs)
        child.stdout.on('data', (chunk) => (stdout += chunk))
        child.stderr.on('data', (chunk) => (stderr += chunk))
        child.on('error', (error) => {
          clearTimeout(timer)
          reject(error)
        })
        child.on('close', (code) => {
          clearTimeout(timer)
          if (code === 0) resolve(stdout)
          else reject(new Error(`The Claude CLI exited with code ${code}: ${stderr.slice(0, 400)}`))
        })
      })
      try {
        const parsed = JSON.parse(output) as { result?: string; is_error?: boolean }
        if (parsed.is_error) throw new Error(parsed.result ?? 'The Claude CLI reported an error.')
        return { text: parsed.result ?? '' }
      } catch (error) {
        if (error instanceof SyntaxError) return { text: output.trim() }
        throw error
      }
    } finally {
      await rm(configFile, { force: true })
    }
  }
}

async function failed(response: Response, provider: string): Promise<Error> {
  let detail = ''
  try {
    const body = (await response.json()) as { error?: { message?: string } | string }
    detail = typeof body.error === 'string' ? body.error : (body.error?.message ?? '')
  } catch {
    // Non-JSON error bodies keep only the status.
  }
  if (response.status === 401 || response.status === 403) return new Error(`${provider} rejected the API key. Check it in the agent settings.`)
  return new Error(`${provider} returned ${response.status}${detail ? `: ${detail}` : ''}.`)
}

export async function anthropicComplete(fetchImpl: typeof fetch, apiKey: string, model: string, request: AgentCompleteRequest, baseUrl = 'https://api.anthropic.com'): Promise<AgentCompleteResponse> {
  if (!apiKey) throw new Error('Add your Anthropic API key in the agent settings.')
  const response = await fetchImpl(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: request.maxTokens ?? 2048, system: request.system, messages: request.messages, tools: request.tools }),
  })
  if (!response.ok) throw await failed(response, 'The Claude API')
  const body = (await response.json()) as { content: { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }[]; stop_reason: string }
  const content: AgentContent[] = []
  for (const block of body.content ?? []) {
    if (block.type === 'text' && block.text) content.push({ type: 'text', text: block.text })
    if (block.type === 'tool_use' && block.id && block.name) content.push({ type: 'tool_use', id: block.id, name: block.name, input: block.input ?? {} })
  }
  return { content, stopReason: body.stop_reason }
}

interface OpenAiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]
  tool_call_id?: string
}

/** Converts provider-neutral messages to the OpenAI chat format. */
export function toOpenAiMessages(request: AgentCompleteRequest): OpenAiMessage[] {
  const messages: OpenAiMessage[] = [{ role: 'system', content: request.system }]
  for (const message of request.messages) {
    if (message.role === 'assistant') {
      const text = message.content.filter((c) => c.type === 'text').map((c) => (c as { text: string }).text).join('\n')
      const calls = message.content.filter((c) => c.type === 'tool_use') as Extract<AgentContent, { type: 'tool_use' }>[]
      messages.push({ role: 'assistant', content: text || null, ...(calls.length && { tool_calls: calls.map((c) => ({ id: c.id, type: 'function' as const, function: { name: c.name, arguments: JSON.stringify(c.input) } })) }) })
      continue
    }
    const text = message.content.filter((c) => c.type === 'text').map((c) => (c as { text: string }).text).join('\n')
    for (const result of message.content.filter((c) => c.type === 'tool_result') as Extract<AgentContent, { type: 'tool_result' }>[]) {
      messages.push({ role: 'tool', tool_call_id: result.tool_use_id, content: result.is_error ? `Error: ${result.content}` : result.content })
    }
    if (text) messages.push({ role: 'user', content: text })
  }
  return messages
}

export async function openAiComplete(fetchImpl: typeof fetch, baseUrl: string, apiKey: string, model: string, request: AgentCompleteRequest): Promise<AgentCompleteResponse> {
  if (!model) throw new Error('Choose a model name for the local server, for example llama3.1.')
  const response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(apiKey && { authorization: `Bearer ${apiKey}` }) },
    body: JSON.stringify({
      model,
      max_tokens: request.maxTokens ?? 2048,
      messages: toOpenAiMessages(request),
      tools: request.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } })),
    }),
  })
  if (!response.ok) throw await failed(response, 'The model server')
  const body = (await response.json()) as { choices: { message: OpenAiMessage; finish_reason: string }[] }
  const choice = body.choices?.[0]
  if (!choice) throw new Error('The model server returned no answer.')
  const content: AgentContent[] = []
  if (choice.message.content) content.push({ type: 'text', text: choice.message.content })
  for (const call of choice.message.tool_calls ?? []) {
    let input: Record<string, unknown> = {}
    try {
      input = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>
    } catch {
      input = {}
    }
    content.push({ type: 'tool_use', id: call.id, name: call.function.name, input })
  }
  return { content, stopReason: choice.finish_reason === 'tool_calls' ? 'tool_use' : choice.finish_reason }
}

import { useSyncExternalStore } from 'react'
import { type AgentContent, type AgentMessage, type AgentSettings, type AgentToolSpec, studio } from '@reborn/studio-core'
import { latestAnalysis, runAnalysis, summarizeReport } from '../audio/analysis'
import { desktop } from '../platform/desktop'
import { addProposal } from '../state/proposals'
import { dispatch, getState } from '../state/store'

// The in-app agent. It reads the project with the registry's read commands,
// measures rendered audio before making claims, and changes the project only
// by proposing command batches the user reviews (unless direct edits are on).

export interface ChatLine {
  role: 'user' | 'agent' | 'tool'
  text: string
}

interface AgentState {
  lines: ChatLine[]
  busy: boolean
  settings: AgentSettings | null
}

let state: AgentState = { lines: [], busy: false, settings: null }
const listeners = new Set<() => void>()
const set = (patch: Partial<AgentState>) => {
  state = { ...state, ...patch }
  listeners.forEach((l) => l())
}
const say = (line: ChatLine) => set({ lines: [...state.lines.slice(-60), line] })

export function useAgent<T>(select: (s: AgentState) => T): T {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => {
        listeners.delete(l)
      }
    },
    () => select(state),
  )
}

export async function loadAgentSettings(): Promise<AgentSettings | null> {
  if (!desktop) return null
  const settings = await desktop.getAgentSettings()
  set({ settings })
  return settings
}

export async function updateAgentSettings(patch: Parameters<NonNullable<typeof desktop>['setAgentSettings']>[0]): Promise<void> {
  if (!desktop) return
  set({ settings: await desktop.setAgentSettings(patch) })
}

const isLocalProvider = (s: AgentSettings) => s.provider === 'openai-compatible' && /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/i.test(s.baseUrl)

const READ_TOOLS: Record<string, string> = {
  project_summary: 'project.summary',
  track_get: 'track.get',
  clip_list: 'clip.list',
  pattern_get: 'pattern.get',
  mixer_trace: 'mixer.trace',
}

function tools(): AgentToolSpec[] {
  const registry = new Map(studio.listCommands().map((c) => [c.type, c]))
  const read = Object.entries(READ_TOOLS).map(([name, type]) => ({ name, description: registry.get(type)!.summary, input_schema: registry.get(type)!.schema }))
  return [
    ...read,
    {
      name: 'analysis_run',
      description: 'Render the song (or a bar range) offline and measure loudness, true peak, crest, band energy shares, stereo correlation, and warnings per section. Use before making any claim about how the mix sounds.',
      input_schema: { type: 'object', properties: { from: { type: 'integer', description: 'First bar, 1-based.' }, to: { type: 'integer', description: 'Last bar, 1-based.' } }, additionalProperties: false },
    },
    {
      name: 'command_help',
      description: 'Get the parameter schema for one or more mutating commands before proposing them.',
      input_schema: { type: 'object', properties: { types: { type: 'array', items: { type: 'string' } } }, required: ['types'], additionalProperties: false },
    },
    {
      name: 'propose_changes',
      description: 'Propose edits for the user to review. Each change is a short summary, a detail line with the evidence, and the exact commands. Commands are validated before the proposal is shown; invalid ones come back as an error to fix.',
      input_schema: {
        type: 'object',
        properties: {
          intent: { type: 'string', description: 'One sentence: what the changes achieve.' },
          evidence: { type: 'array', items: { type: 'string' }, description: 'Measurements or user instructions that justify the changes.' },
          changes: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                summary: { type: 'string' },
                detail: { type: 'string', description: 'Before → after values and why.' },
                commands: { type: 'array', items: { type: 'object', properties: { type: { type: 'string' }, params: { type: 'object' } }, required: ['type'] } },
              },
              required: ['summary', 'commands'],
            },
          },
        },
        required: ['intent', 'changes'],
        additionalProperties: false,
      },
    },
  ]
}

function systemPrompt(): string {
  const { project } = getState()
  const mutating = studio
    .listCommands()
    .filter((c) => c.mutates)
    .map((c) => `- ${c.type}: ${c.summary}`)
    .join('\n')
  return [
    'You are the production assistant inside RE:BORN, a groovebox-style music workstation. You help the user finish beats: diagnose mixes, write patterns, arrange sections, and set up sounds.',
    'Rules:',
    '1. Read before you change anything (project_summary, track_get, pattern_get, clip_list, mixer_trace).',
    '2. Never claim how something sounds without measuring it first with analysis_run. Quote the numbers you rely on.',
    '3. Change the project only through propose_changes. Keep each change small, labeled, and reversible; the user can accept some and reject others.',
    '4. Respect artistic choices. Diagnose and explain; do not "fix" style unless asked.',
    '5. Bars in your answers are 1-based. Command parameters for start and at are 0-based bars.',
    `Project "${project.name}": ${project.tempo} BPM, ${project.length} bars, ${project.tracks.length} tracks (${project.tracks.map((t) => `${t.name} [${t.kind}]`).join(', ')}).`,
    'Mutating commands you can propose:',
    mutating,
  ].join('\n')
}

async function runTool(name: string, input: Record<string, unknown>, settings: AgentSettings): Promise<{ content: string; isError?: boolean }> {
  try {
    if (name in READ_TOOLS) {
      const result = studio.executeBatch(getState().project, [{ type: READ_TOOLS[name], params: input }]).results[0]
      return { content: JSON.stringify(result).slice(0, 20000) }
    }
    if (name === 'analysis_run') {
      const cloud = !isLocalProvider(settings)
      if (cloud && !settings.shareMeasurements) return { content: 'The user has not allowed sharing measurements with this provider. Ask them to turn on “Share measurements” in the agent settings, or reason from the project structure and mixer_trace only.', isError: true }
      const from = typeof input.from === 'number' ? input.from - 1 : undefined
      const to = typeof input.to === 'number' ? input.to : undefined
      say({ role: 'tool', text: `Rendering and measuring${from !== undefined ? ` bars ${from + 1}–${to ?? ''}` : ' the song'}…` })
      const report = await runAnalysis({ from, to })
      return { content: JSON.stringify(summarizeReport(report)) }
    }
    if (name === 'command_help') {
      const types = (input.types as string[]) ?? []
      return { content: JSON.stringify(studio.listCommands().filter((c) => types.includes(c.type))) }
    }
    if (name === 'propose_changes') {
      const changes = (input.changes as { summary: string; detail?: string; commands: studio.Command[] }[]) ?? []
      const commands = changes.flatMap((c) => c.commands)
      if (!commands.length) return { content: 'No commands were given.', isError: true }
      studio.executeBatch(getState().project, commands, { origin: 'agent' })
      if (settings.directEdits) {
        dispatch(commands, { origin: 'agent', label: `Agent: ${String(input.intent ?? 'edit')}` })
        return { content: `Applied ${changes.length} changes directly (the user enabled direct edits). They can undo them in one step.` }
      }
      const proposal = addProposal({
        id: studio.newId('prp'),
        source: 'agent',
        request: state.lines.filter((l) => l.role === 'user').at(-1)?.text ?? '',
        intent: String(input.intent ?? 'Proposed changes'),
        evidence: ((input.evidence as string[]) ?? []).map(String),
        changes: changes.map((c, i) => ({ id: `c${i + 1}`, summary: c.summary, detail: c.detail ?? '', commands: c.commands })),
      })
      return { content: `Proposal ${proposal.id} is waiting for the user's review with ${changes.length} changes. Tell the user what you proposed and why; do not repeat the commands.` }
    }
    return { content: `Unknown tool ${name}.`, isError: true }
  } catch (error) {
    return { content: error instanceof Error ? error.message : String(error), isError: true }
  }
}

export async function ask(prompt: string): Promise<void> {
  const text = prompt.trim()
  if (!text || state.busy) return
  say({ role: 'user', text })
  if (!desktop) {
    say({ role: 'agent', text: 'The agent runs in the desktop edition, which keeps API keys in your OS credential store. In the browser you can still use the analyzer and signal trace in Mix view.' })
    return
  }
  const settings = state.settings ?? (await loadAgentSettings())
  if (!settings) return
  set({ busy: true })
  try {
    if (settings.provider === 'claude-cli') {
      if (!settings.cliAvailable) throw new Error('The claude command was not found. Install Claude Code, or pick another provider.')
      const summary = JSON.stringify(studio.executeBatch(getState().project, [{ type: 'project.summary' }]).results[0])
      const result = await desktop.agentRunCli(`${systemPrompt()}\n\nCurrent project: ${summary}\n\nUser request: ${text}\n\nUse the reborn MCP tools. Mutating tools create proposals for the user to review.`)
      say({ role: 'agent', text: result.text || 'Done.' })
      return
    }
    const messages: AgentMessage[] = [...historyAsMessages(), { role: 'user', content: [{ type: 'text', text }] }]
    for (let round = 0; round < 10; round += 1) {
      const response = await desktop.agentComplete({ system: systemPrompt(), messages, tools: tools(), maxTokens: 2048 })
      messages.push({ role: 'assistant', content: response.content })
      const texts = response.content.filter((c): c is Extract<AgentContent, { type: 'text' }> => c.type === 'text').map((c) => c.text.trim()).filter(Boolean)
      if (texts.length) say({ role: 'agent', text: texts.join('\n\n') })
      const calls = response.content.filter((c): c is Extract<AgentContent, { type: 'tool_use' }> => c.type === 'tool_use')
      if (!calls.length) break
      const results: AgentContent[] = []
      for (const call of calls) {
        const outcome = await runTool(call.name, call.input, settings)
        if (call.name !== 'analysis_run') say({ role: 'tool', text: `${call.name.replace('_', ' ')}${outcome.isError ? ' failed' : ''}` })
        results.push({ type: 'tool_result', tool_use_id: call.id, content: outcome.content, is_error: outcome.isError })
      }
      messages.push({ role: 'user', content: results })
    }
  } catch (error) {
    say({ role: 'agent', text: `Something went wrong: ${error instanceof Error ? error.message : String(error)}` })
  } finally {
    set({ busy: false })
  }
}

function historyAsMessages(): AgentMessage[] {
  // Keep a short text-only memory of the conversation.
  // Providers need alternating turns that start with the user and end with
  // the assistant, because the new request is appended as a user turn.
  const turns = state.lines
    .slice(-9, -1)
    .filter((l) => l.role !== 'tool')
    .map((l) => ({ role: l.role === 'user' ? ('user' as const) : ('assistant' as const), content: [{ type: 'text' as const, text: l.text }] }))
    .filter((m, i, all) => i === 0 || m.role !== all[i - 1].role)
  while (turns.length && turns[0].role !== 'user') turns.shift()
  while (turns.length && turns[turns.length - 1].role !== 'assistant') turns.pop()
  return turns
}

export const analysisAvailable = () => Boolean(latestAnalysis())

import type { Readable, Writable } from 'node:stream'
import type { ExecuteResponse, JobState, RuntimeAction, RuntimeResponse } from '@reborn/studio-core/api'
import type { Command } from '@reborn/studio-core/studio'
import { type FlagSpec, type ParsedArgs, findCommand, parseArgs } from './args'
import { type ApiClient, type DiscoveryOptions, connect } from './client'
import { CliError, EXIT, VERSION, errorMessage, usageError } from './errors'
import { compact, extractPaths, formatCommands, formatEvent, formatJob, formatReport, formatStatus, pretty } from './format'
import { runMcpServer } from './mcp'
import { type JsonSchemaProperty, type ParamInfo, type TrackRef, coerceParam, parseBars, parseParamValue, requireTrackRef, resolveParam, slug, splitTarget } from './resolve'
import { resolve as resolvePath } from 'node:path'

export interface CliIO {
  stdout: (text: string) => void
  stderr: (text: string) => void
  env?: Record<string, string | undefined>
  platform?: NodeJS.Platform
  home?: string
  /** Streams for `reborn mcp`. Default to the process's stdin and stdout. */
  input?: Readable
  output?: Writable
  /** Stops `reborn watch` and job polling. */
  signal?: AbortSignal
  pollIntervalMs?: number
}

const GLOBAL_FLAGS: FlagSpec = { json: 'boolean', help: 'boolean', version: 'boolean', 'read-only': 'boolean', 'api-file': 'string' }
const EDIT_FLAGS: FlagSpec = { 'expect-revision': 'string', label: 'string' }
const JOB_FLAGS: FlagSpec = { wait: 'boolean', timeout: 'string' }

interface Context {
  args: ParsedArgs
  json: boolean
  io: CliIO
  client: () => Promise<ApiClient>
  out: (text: string) => void
}

interface CommandDef {
  usage: string
  summary: string
  details?: string
  flags?: FlagSpec
  /** Accept arbitrary `--name value` flags (command parameters). */
  params?: boolean
  run: (ctx: Context) => Promise<number | void>
}

const COMMANDS: Record<string, CommandDef> = {
  status: {
    usage: 'reborn status',
    summary: 'Show the open project, transport, and API status.',
    run: async (ctx) => {
      const status = await (await ctx.client()).status()
      ctx.out(ctx.json ? compact(status) : formatStatus(status))
    },
  },
  commands: {
    usage: 'reborn commands [--json]',
    summary: 'List the command registry. --json includes parameter schemas.',
    run: async (ctx) => {
      const commands = await (await ctx.client()).commands()
      ctx.out(ctx.json ? compact(commands) : formatCommands(commands))
    },
  },
  run: {
    usage: 'reborn run <command.type> [--param value ...] [--json-params \'{...}\'] [--expect-revision N] [--label text]',
    summary: 'Run any registry command as one undoable script edit.',
    details: [
      'Parameters follow the command type as --name value pairs, typed by the command schema.',
      'A boolean parameter given without a value means true. Objects and arrays take JSON.',
      '--json-params supplies parameters as one JSON object; --name flags override its keys.',
      '',
      'Examples:',
      '  reborn run project.summary',
      '  reborn run mixer.set --trackId 808 --volume -3 --mute',
      '  reborn run step.set --json-params \'{"patternId":"pat_1","index":0,"on":true}\'',
    ].join('\n'),
    flags: { ...EDIT_FLAGS, 'json-params': 'string' },
    params: true,
    run: runCommand,
  },
  pattern: {
    usage: 'reborn pattern write <track>[.<voice>] "<steps>"',
    summary: 'Write a track\'s pattern from text notation.',
    details: [
      'Drums take a voice and a step string: X accent, x hit, "." rest.',
      'Note tracks take space-separated notes: ! accent, ~ slide, "." rest.',
      'Tracks match by ID, name, or slug, so acid-1 finds "Acid 1".',
      '',
      'Examples:',
      '  reborn pattern write 808.kick "X...X...X...X..."',
      '  reborn pattern write "Acid 1" "C2 . D#2! C3~"',
    ].join('\n'),
    flags: EDIT_FLAGS,
    run: writePattern,
  },
  set: {
    usage: 'reborn set <track>.<param> <value> [--bar N]',
    summary: 'Set a parameter now, or write an automation point at a 1-based bar.',
    details: [
      'A bare parameter name means device.<name>; any unique suffix also works (kick.tune, volume).',
      'For 0..1 parameters, values above 1 and values with % are percentages.',
      '',
      'Examples:',
      '  reborn set "Acid 1".device.cutoff 0.62',
      '  reborn set acid-1.cutoff 62 --bar 9',
      '  reborn set 808.volume -3',
    ].join('\n'),
    flags: { ...EDIT_FLAGS, bar: 'string' },
    run: setParameter,
  },
  play: { usage: 'reborn play', summary: 'Start playback.', run: (ctx) => simpleRuntime(noArgs(ctx), 'transport.play', {}, 'Playing.') },
  stop: { usage: 'reborn stop', summary: 'Stop playback.', run: (ctx) => simpleRuntime(noArgs(ctx), 'transport.stop', {}, 'Stopped.') },
  seek: {
    usage: 'reborn seek <bar>',
    summary: 'Move the playhead to a 1-based bar.',
    run: (ctx) => {
      const bar = positiveInt(one(ctx, 'bar'), 'bar')
      return simpleRuntime(ctx, 'transport.seek', { bar }, `Moved to bar ${bar}.`)
    },
  },
  launch: { usage: 'reborn launch <scene>', summary: 'Launch a scene by name, ID, or 1-based number.', run: launchScene },
  undo: { usage: 'reborn undo', summary: 'Undo the last edit.', run: (ctx) => simpleRuntime(noArgs(ctx), 'history.undo', {}, 'Undone.') },
  redo: { usage: 'reborn redo', summary: 'Redo the last undone edit.', run: (ctx) => simpleRuntime(noArgs(ctx), 'history.redo', {}, 'Redone.') },
  save: { usage: 'reborn save', summary: 'Save the open project.', run: (ctx) => simpleRuntime(noArgs(ctx), 'project.save', {}, 'Saved.') },
  open: {
    usage: 'reborn open <path> [--discard-changes]',
    summary: 'Open a project folder or file in RE:BORN.',
    details: 'If the open project has unsaved changes, RE:BORN refuses unless you pass --discard-changes.',
    flags: { 'discard-changes': 'boolean' },
    run: async (ctx) => {
      const path = one(ctx, 'path')
      try {
        await simpleRuntime(ctx, 'project.open', { path: resolvePath(path), ...(ctx.args.flags['discard-changes'] === true && { discardChanges: true }) }, `Opened ${path}.`)
      } catch (error) {
        // A conflict here means unsaved work, not a stale revision.
        if (error instanceof CliError && error.code === 'conflict') throw new CliError(error.message, EXIT.generic, 'conflict', 'Run `reborn save` first, or add --discard-changes.')
        throw error
      }
    },
  },
  cancel: {
    usage: 'reborn cancel <job>',
    summary: 'Cancel a running render, analysis, generation, or separation job.',
    run: async (ctx) => {
      const id = one(ctx, 'job')
      const job = await (await ctx.client()).cancelJob(id)
      ctx.out(ctx.json ? compact(job) : job.status === 'cancelled' ? `Cancelled ${id}.` : `Job ${id} already ${job.status}.`)
    },
  },
  render: {
    usage: 'reborn render [--stems] [--out path] [--wait] [--timeout seconds]',
    summary: 'Render the mix (or stems) and print the output path(s).',
    details: 'Without --wait, prints the job ID and returns. Follow it with `reborn watch`.',
    flags: { ...JOB_FLAGS, stems: 'boolean', out: 'string' },
    run: render,
  },
  presets: {
    usage: 'reborn presets',
    summary: "List Ismail's instrument presets and voices for `reborn generate`.",
    run: presets,
  },
  generate: {
    usage: 'reborn generate <instrument> "<notes>" [--name N] [--track T] [--bar N] [--tail seconds] [--wait]',
    summary: 'Synthesize a sound with Ismail and place it in the project.',
    details: [
      '<instrument> is a preset (acid_bass), voice:<name> (voice:growl), or an Ismail instrument as JSON.',
      'Notes: start beat, pitch, length in beats, velocity; one per line or separated by ";". A comma makes a chord.',
      'With --track, a Sampler loads the sound and an Audio track gets a clip at --bar; otherwise it lands on a new audio track.',
      'Example: reborn generate acid_bass "0 C2 0.5 110; 0.5 C3 0.5" --name Stab --wait',
    ].join('\n'),
    flags: { ...JOB_FLAGS, name: 'string', track: 'string', bar: 'string', tail: 'string' },
    run: generate,
  },
  separate: {
    usage: 'reborn separate (--clip ID | --asset ID | --track T) [--bar N] [--wait]',
    summary: 'Split audio into drums, bass, other, and vocals on new audio tracks with Ismail.',
    details: 'A clip keeps its position, offset, gain, and fades on each stem. --track takes a Deck or a Sampler source. The original audio is unchanged.',
    flags: { ...JOB_FLAGS, clip: 'string', asset: 'string', track: 'string', bar: 'string' },
    run: separate,
  },
  analyze: {
    usage: 'reborn analyze [--bars FROM:TO] [--wait] [--timeout seconds]',
    summary: 'Analyze the mix over 1-based bars and print a compact report.',
    details: 'Example: reborn analyze --bars 1:16 --wait',
    flags: { ...JOB_FLAGS, bars: 'string' },
    run: analyze,
  },
  agent: {
    usage: 'reborn agent "<instruction>"',
    summary: 'Explains how agents connect. Agents use `reborn mcp`.',
    run: async (ctx) => {
      ctx.io.stderr(
        [
          'reborn agent does not run instructions itself. Agents edit RE:BORN through MCP:',
          '',
          '  claude mcp add reborn -- reborn mcp',
          '',
          'Then ask the agent, for example: "make the chorus drums hit harder".',
          'Agent edits arrive in RE:BORN as proposals you review, unless you turned on direct agent edits.',
        ].join('\n') + '\n',
      )
      return EXIT.usage
    },
  },
  watch: {
    usage: 'reborn watch [--count N]',
    summary: 'Stream project, transport, job, and proposal events until interrupted.',
    flags: { count: 'string' },
    run: watch,
  },
  mcp: {
    usage: 'reborn mcp [--read-only]',
    summary: 'Run the MCP server over stdio for agents.',
    details: '--read-only lists only read tools and uses the read token.',
    run: async (ctx) => {
      await runMcpServer({
        connect: () => connect(discovery(ctx)),
        readOnly: ctx.args.flags['read-only'] === true,
        input: ctx.io.input ?? process.stdin,
        output: ctx.io.output ?? process.stdout,
        log: (text) => ctx.io.stderr(`${text}\n`),
        pollIntervalMs: ctx.io.pollIntervalMs,
      })
    },
  },
}

const MAIN_HELP = () =>
  [
    `reborn ${VERSION}: control the running RE:BORN desktop app.`,
    '',
    'Usage: reborn <command> [options]',
    '',
    'Commands:',
    ...commandList(),
    '',
    'Global options:',
    '  --json             Print machine-readable JSON.',
    '  --read-only        Use the read token; edits fail.',
    '  --api-file <path>  Use this api.json instead of discovering it (also REBORN_API_FILE).',
    '  -h, --help         Show help for a command.',
    '',
    'Exit codes: 0 ok, 1 error, 2 usage, 3 RE:BORN not running, 4 stale revision, 5 not authorized.',
  ].join('\n')

function commandList(): string[] {
  const rows = Object.values(COMMANDS).map((def) => [def.usage.split(' [')[0].replace('reborn ', ''), def.summary])
  const width = Math.max(...rows.map(([usage]) => usage.length)) + 2
  return rows.map(([usage, summary]) => `  ${usage.padEnd(width)}${summary}`)
}

const commandHelp = (def: CommandDef) => [`Usage: ${def.usage}`, '', def.summary, ...(def.details ? ['', def.details] : [])].join('\n')

/** Runs the CLI and returns the process exit code. */
export async function runCli(argv: readonly string[], io: CliIO): Promise<number> {
  const json = argv.includes('--json')
  try {
    const found = findCommand(argv, GLOBAL_FLAGS)
    if (!found) {
      const globals = parseArgs(argv, GLOBAL_FLAGS)
      io.stdout(`${globals.flags.version ? VERSION : MAIN_HELP()}\n`)
      return EXIT.ok
    }
    if (found.name === 'help') {
      const topic = argv[found.index + 1]
      const def = topic && Object.hasOwn(COMMANDS, topic) ? COMMANDS[topic] : undefined
      if (topic && !def) throw usageError(`Unknown command "${topic}".`, 'Run `reborn --help` to list commands.')
      io.stdout(`${def ? commandHelp(def) : MAIN_HELP()}\n`)
      return EXIT.ok
    }
    const def = Object.hasOwn(COMMANDS, found.name) ? COMMANDS[found.name] : undefined
    if (!def) throw usageError(`Unknown command "${found.name}".`, 'Run `reborn --help` to list commands.')
    const rest = [...argv.slice(0, found.index), ...argv.slice(found.index + 1)]
    const args = parseArgs(rest, { ...GLOBAL_FLAGS, ...def.flags }, { allowUnknown: def.params })
    if (args.flags.help) {
      io.stdout(`${commandHelp(def)}\n`)
      return EXIT.ok
    }
    let client: ApiClient | undefined
    const ctx: Context = {
      args,
      json: args.flags.json === true,
      io,
      client: async () => (client ??= await connect(discovery({ args, io }))),
      out: (text) => io.stdout(`${text}\n`),
    }
    return (await def.run(ctx)) ?? EXIT.ok
  } catch (error) {
    const failure = error instanceof CliError ? error : new CliError(errorMessage(error))
    if (json) io.stderr(`${compact({ error: { code: failure.code, message: failure.message, ...(failure.hint && { hint: failure.hint }) } })}\n`)
    else io.stderr(`Error: ${failure.message}\n${failure.hint ? `${failure.hint}\n` : ''}`)
    return failure.exitCode
  }
}

function discovery(ctx: { args: ParsedArgs; io: CliIO }): DiscoveryOptions & { readOnly: boolean } {
  const apiFile = ctx.args.flags['api-file']
  return {
    apiFile: typeof apiFile === 'string' ? apiFile : undefined,
    env: ctx.io.env ?? process.env,
    platform: ctx.io.platform,
    home: ctx.io.home,
    readOnly: ctx.args.flags['read-only'] === true,
  }
}

// Helpers ---------------------------------------------------------------------

function one(ctx: Context, name: string): string {
  const [value, ...extra] = ctx.args.positionals
  if (value === undefined) throw usageError(`Missing <${name}>.`)
  if (extra.length) throw usageError(`Unexpected argument "${extra[0]}".`)
  return value
}

function noArgs(ctx: Context): Context {
  if (ctx.args.positionals.length) throw usageError(`Unexpected argument "${ctx.args.positionals[0]}".`)
  return ctx
}

function positiveInt(text: string, name: string): number {
  const value = Number(text)
  if (!Number.isInteger(value) || value < 1) throw usageError(`<${name}> must be a whole number from 1; got "${text}".`)
  return value
}

function stringFlag(ctx: Context, name: string): string | undefined {
  const value = ctx.args.flags[name]
  return typeof value === 'string' ? value : undefined
}

function editOptions(ctx: Context): { label?: string; expectedRevision?: number } {
  const label = stringFlag(ctx, 'label')
  const revision = stringFlag(ctx, 'expect-revision')
  if (revision !== undefined && !/^\d+$/.test(revision)) throw usageError(`--expect-revision takes a revision number; got "${revision}".`)
  return { ...(label !== undefined && { label }), ...(revision !== undefined && { expectedRevision: Number(revision) }) }
}

async function execute(ctx: Context, commands: Command[], options: { label?: string; expectedRevision?: number } = {}): Promise<ExecuteResponse> {
  return (await ctx.client()).execute({ commands, origin: 'script', ...options })
}

async function readSummary(ctx: Context): Promise<{ tracks: TrackRef[]; scenes: TrackRef[] }> {
  const response = await execute(ctx, [{ type: 'project.summary' }])
  const summary = (response.results[0] ?? {}) as { tracks?: TrackRef[]; scenes?: TrackRef[] }
  return { tracks: summary.tracks ?? [], scenes: summary.scenes ?? [] }
}

function reportEdit(ctx: Context, response: ExecuteResponse, applied: string): void {
  if (ctx.json) return ctx.out(compact(response))
  if (response.status === 'proposed') return ctx.out(`Proposed as ${response.proposalId ?? 'a pending change'}; review it in RE:BORN.`)
  ctx.out(`${applied} (revision ${response.revision}).`)
}

function timeoutMs(ctx: Context): number | undefined {
  const text = stringFlag(ctx, 'timeout')
  if (text === undefined) return undefined
  const seconds = Number(text)
  if (!Number.isFinite(seconds) || seconds <= 0) throw usageError(`--timeout takes seconds; got "${text}".`)
  return seconds * 1000
}

async function runtime(ctx: Context, action: RuntimeAction, params: Record<string, unknown>): Promise<RuntimeResponse> {
  return (await ctx.client()).runtime({ action, params })
}

async function simpleRuntime(ctx: Context, action: RuntimeAction, params: Record<string, unknown>, message: string): Promise<void> {
  const response = await runtime(ctx, action, params)
  if (ctx.json) return ctx.out(compact(response))
  const paths = extractPaths(response.result)
  ctx.out([message, ...paths].join('\n'))
}

/** Waits for a job when asked to, and returns its final state or null. */
async function settleJob(ctx: Context, response: RuntimeResponse, what: string): Promise<JobState | null> {
  if (!response.jobId) return null
  if (ctx.args.flags.wait !== true) {
    ctx.out(ctx.json ? compact(response) : `${what} started as job ${response.jobId}. Pass --wait to wait for it, or follow it with \`reborn watch\`.`)
    return null
  }
  const client = await ctx.client()
  let shown = -1
  const onProgress = (state: JobState) => {
    if (ctx.json || state.status !== 'running' || state.total <= 0) return
    const percent = Math.floor((state.completed / state.total) * 10) * 10
    if (percent > shown) {
      shown = percent
      ctx.io.stderr(`${what}: ${percent}%
`)
    }
  }
  const { job, timedOut } = await client.waitForJob(response.jobId, { intervalMs: ctx.io.pollIntervalMs, timeoutMs: timeoutMs(ctx), signal: ctx.io.signal, onProgress })
  // Interrupting a --wait cancels the job, so a render doesn't keep running unseen.
  if (ctx.io.signal?.aborted && job.status === 'running') {
    await client.cancelJob(job.id).catch(() => undefined)
    throw new CliError(`${what} cancelled.`, EXIT.generic)
  }
  if (timedOut) throw new CliError(`${what} is still running (${formatJob(job)}).`, EXIT.generic, 'unavailable', `Check it later with \`reborn watch\` or GET /v1/jobs/${job.id}.`)
  if (job.status !== 'done') throw new CliError(`${what} ${job.status}${job.message ? `: ${job.message}` : '.'}`, EXIT.generic, 'internal')
  return job
}

// Commands --------------------------------------------------------------------

async function runCommand(ctx: Context): Promise<void> {
  const [type, ...extra] = ctx.args.positionals
  if (!type) throw usageError('Missing <command.type>.', 'Run `reborn commands` to list them.')
  if (extra.length) throw usageError(`Unexpected argument "${extra[0]}". Pass parameters as --name value.`)
  const info = (await (await ctx.client()).commands()).find((c) => c.type === type)
  if (!info) throw usageError(`Unknown command "${type}".`, 'Run `reborn commands` to list them.')
  const properties = (info.schema.properties ?? {}) as Record<string, JsonSchemaProperty>
  let params: Record<string, unknown> = {}
  const jsonParams = stringFlag(ctx, 'json-params')
  if (jsonParams !== undefined) {
    let parsed: unknown
    try {
      parsed = JSON.parse(jsonParams)
    } catch {
      throw usageError('--json-params is not valid JSON.')
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw usageError('--json-params must be a JSON object.')
    params = { ...(parsed as Record<string, unknown>) }
  }
  for (const flag of ctx.args.extra) params[flag.name] = coerceParam(type, flag.name, flag.value, Object.hasOwn(properties, flag.name) ? properties[flag.name] : undefined)
  const response = await execute(ctx, [{ type, params }], editOptions(ctx))
  if (ctx.json) return ctx.out(compact(response))
  const result = response.results[0]
  if (response.status === 'read') return ctx.out(pretty(result))
  reportEdit(ctx, response, `Applied ${type}`)
  if (response.status === 'applied' && result !== null && result !== undefined) ctx.out(compact(result))
}

async function writePattern(ctx: Context): Promise<void> {
  const [sub, target, ...steps] = ctx.args.positionals
  if (sub !== 'write') throw usageError(sub ? `Unknown pattern command "${sub}".` : 'Missing pattern command.', 'Usage: reborn pattern write <track>[.<voice>] "<steps>"')
  if (!target || !steps.length) throw usageError('Usage: reborn pattern write <track>[.<voice>] "<steps>"')
  const { tracks } = await readSummary(ctx)
  const { track, rest: voice } = splitTarget(tracks, target, { restRequired: false })
  const command: Command = { type: 'pattern.write', params: { trackId: track.id, steps: steps.join(' '), ...(voice && { voice }) } }
  const response = await execute(ctx, [command], editOptions(ctx))
  const patternId = (response.results[0] as { patternId?: string } | null)?.patternId
  reportEdit(ctx, response, `Wrote ${track.name}${voice ? ` ${voice}` : ''}${patternId ? ` to pattern ${patternId}` : ''}`)
}

async function setParameter(ctx: Context): Promise<void> {
  const [target, valueText, ...extra] = ctx.args.positionals
  if (!target || valueText === undefined) throw usageError('Usage: reborn set <track>.<param> <value> [--bar N]')
  if (extra.length) throw usageError(`Unexpected argument "${extra[0]}".`)
  const barText = stringFlag(ctx, 'bar')
  const bar = barText === undefined ? undefined : positiveInt(barText, 'bar')
  const { tracks } = await readSummary(ctx)
  const { track, rest } = splitTarget(tracks, target, { restRequired: true })
  const detail = await execute(ctx, [{ type: 'track.get', params: { trackId: track.id } }])
  const params = ((detail.results[0] ?? {}) as { params?: ParamInfo[] }).params ?? []
  const param = resolveParam(params, track.name, rest ?? '')
  const value = parseParamValue(param, valueText)
  const command: Command =
    bar === undefined
      ? { type: 'parameter.set', params: { trackId: track.id, param: param.id, value } }
      : { type: 'automation.write', params: { trackId: track.id, param: param.id, points: [{ bar: bar - 1, value }] } }
  const response = await execute(ctx, [command], editOptions(ctx))
  reportEdit(ctx, response, bar === undefined ? `Set ${track.name} ${param.id} to ${value}` : `Wrote ${track.name} ${param.id} = ${value} at bar ${bar}`)
}

async function launchScene(ctx: Context): Promise<void> {
  const ref = one(ctx, 'scene')
  const { scenes } = await readSummary(ctx)
  const scene = /^\d+$/.test(ref) && !scenes.some((s) => s.name === ref) ? scenes[Number(ref) - 1] : (scenes.find((s) => s.id === ref) ?? scenes.find((s) => s.name.toLowerCase() === ref.toLowerCase()) ?? scenes.find((s) => slug(s.name) === slug(ref)))
  if (!scene) throw new CliError(`No scene "${ref}".`, EXIT.generic, 'not_found', scenes.length ? `Scenes: ${scenes.map((s, i) => `${i + 1}. ${s.name}`).join(', ')}.` : 'The project has no scenes.')
  const response = await runtime(ctx, 'scene.launch', { sceneId: scene.id })
  ctx.out(ctx.json ? compact(response) : `Launched ${scene.name}.`)
}

async function render(ctx: Context): Promise<void> {
  noArgs(ctx)
  const stems = ctx.args.flags.stems === true
  const out = stringFlag(ctx, 'out')
  const response = await runtime(ctx, stems ? 'render.stems' : 'render.mix', out ? { path: out } : {})
  const what = stems ? 'Stem render' : 'Mix render'
  if (!response.jobId) {
    if (ctx.json) return ctx.out(compact(response))
    return ctx.out(extractPaths(response.result).join('\n') || `${what} finished.`)
  }
  const job = await settleJob(ctx, response, what)
  if (!job) return
  if (ctx.json) return ctx.out(compact(job))
  ctx.out(extractPaths(job.result).join('\n') || `${what} finished.`)
}

async function analyze(ctx: Context): Promise<void> {
  noArgs(ctx)
  const bars = stringFlag(ctx, 'bars')
  const response = await runtime(ctx, 'analysis.run', bars ? parseBars(bars) : {})
  if (!response.jobId) return ctx.out(ctx.json ? compact(response) : formatReport(response.result))
  const job = await settleJob(ctx, response, 'Analysis')
  if (!job) return
  ctx.out(ctx.json ? compact(job) : formatReport(job.result))
}

async function presets(ctx: Context): Promise<void> {
  noArgs(ctx)
  const response = await runtime(ctx, 'ismail.presets', {})
  if (ctx.json) return ctx.out(compact(response.result))
  const listed = (response.result ?? {}) as { presets?: { name: string; type: string }[]; voices?: { name: string; family: string; summary: string }[] }
  ctx.out(
    [
      'Presets:',
      ...(listed.presets ?? []).map((p) => `  ${p.name.padEnd(20)} ${p.type}`),
      'Voices (use voice:<name>):',
      ...(listed.voices ?? []).map((v) => `  ${v.name.padEnd(20)} ${v.summary}`),
    ].join('\n'),
  )
}

function parseInstrument(text: string): string | Record<string, unknown> {
  if (text.startsWith('voice:')) return { type: 'code', voice: text.slice(6) }
  if (!text.trimStart().startsWith('{')) return text.startsWith('preset:') ? text.slice(7) : text
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
  } catch {
    // Reported below.
  }
  throw usageError('<instrument> JSON must be an object, for example {"type":"synth","oscs":[{"wave":"saw"}]}.')
}

function numberFlag(ctx: Context, name: string, min: number, max: number): number | undefined {
  const text = stringFlag(ctx, name)
  if (text === undefined) return undefined
  const value = Number(text)
  if (!Number.isFinite(value) || value < min || value > max) throw usageError(`--${name} must be a number from ${min} to ${max}; got "${text}".`)
  return value
}

async function generate(ctx: Context): Promise<void> {
  const [instrumentText, notes, ...extra] = ctx.args.positionals
  if (!instrumentText || !notes) throw usageError('Usage: reborn generate <instrument> "<notes>"', 'Run `reborn presets` to list instruments.')
  if (extra.length) throw usageError(`Unexpected argument "${extra[0]}". Quote the notes.`)
  const instrument = parseInstrument(instrumentText)
  const name = stringFlag(ctx, 'name') ?? (typeof instrument === 'string' ? instrument.replace(/_/g, ' ') : String(instrument.voice ?? 'sound'))
  const bar = stringFlag(ctx, 'bar')
  const tail = numberFlag(ctx, 'tail', 0, 30)
  const track = stringFlag(ctx, 'track')
  const params = { name, instrument, notes, ...(tail !== undefined && { tailSeconds: tail }), ...(track && { trackId: track }), ...(bar !== undefined && { bar: positiveInt(bar, 'bar') }) }
  const response = await runtime(ctx, 'ismail.generate', params)
  const job = await settleJob(ctx, response, 'Generation')
  if (!job) return
  if (ctx.json) return ctx.out(compact(job))
  const result = (job.result ?? {}) as { name?: string; summary?: string; trackId?: string | null; assetId?: string }
  ctx.out(`Generated ${result.name ?? name}${result.trackId ? ` on track ${result.trackId}` : ''} (asset ${result.assetId}).${result.summary ? `\n${result.summary}` : ''}`)
}

async function separate(ctx: Context): Promise<void> {
  noArgs(ctx)
  const clip = stringFlag(ctx, 'clip')
  const asset = stringFlag(ctx, 'asset')
  const track = stringFlag(ctx, 'track')
  if ([clip, asset, track].filter(Boolean).length !== 1) throw usageError('Pass exactly one of --clip, --asset, or --track.')
  const bar = stringFlag(ctx, 'bar')
  const params = { ...(clip && { clipId: clip }), ...(asset && { assetId: asset }), ...(track && { trackId: track }), ...(bar !== undefined && { bar: positiveInt(bar, 'bar') }) }
  const response = await runtime(ctx, 'ismail.separate', params)
  const job = await settleJob(ctx, response, 'Stem separation')
  if (!job) return
  if (ctx.json) return ctx.out(compact(job))
  const stems = ((job.result ?? {}) as { stems?: { name: string; trackId: string | null }[] }).stems ?? []
  ctx.out(['Separated into new audio tracks:', ...stems.map((stem) => `  ${stem.name.padEnd(8)} ${stem.trackId ?? ''}`)].join('\n'))
}

async function watch(ctx: Context): Promise<void> {
  noArgs(ctx)
  const countText = stringFlag(ctx, 'count')
  const limit = countText === undefined ? Infinity : positiveInt(countText, 'count')
  const client = await ctx.client()
  if (!ctx.json) ctx.io.stderr('Watching RE:BORN events. Press Ctrl+C to stop.\n')
  let seen = 0
  const stop = new AbortController()
  ctx.io.signal?.addEventListener('abort', () => stop.abort(), { once: true })
  for await (const event of client.events(stop.signal)) {
    ctx.out(ctx.json ? compact(event) : formatEvent(event))
    if (++seen >= limit) {
      stop.abort()
      break
    }
  }
}

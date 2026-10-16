import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DrumPattern, NotePattern } from '@reborn/studio-core/studio'
import { type CliIO, runCli } from './cli'
import { delay } from './client'
import { EXIT } from './errors'
import { type FakeServer, deadPid, startFakeServer, writeApiFile } from './fake-server'

let server: FakeServer
beforeEach(async () => {
  server = await startFakeServer()
})
afterEach(async () => {
  await server.close()
})

async function cli(argv: string[], io: Partial<CliIO> = {}) {
  let stdout = ''
  let stderr = ''
  const code = await runCli(argv, {
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
    env: { REBORN_API_FILE: server.apiFile },
    pollIntervalMs: 5,
    ...io,
  })
  return { code, stdout, stderr }
}

const track = (name: string) => server.state.project.tracks.find((t) => t.name === name)!
const patternOf = (name: string) => {
  const clip = server.state.project.clips.find((c) => c.trackId === track(name).id && c.patternId)!
  return server.state.project.patterns[clip.patternId!]
}
const lastBody = (path: string) => [...server.requests].reverse().find((r) => r.path === path)?.body

describe('discovery and auth', () => {
  it('prints status as text and as JSON', async () => {
    const text = await cli(['status'])
    expect(text.code).toBe(EXIT.ok)
    expect(text.stdout).toMatch(/Project: Test Beat, revision 0/)
    const json = await cli(['status', '--json'])
    expect(JSON.parse(json.stdout)).toMatchObject({ app: 'RE:BORN', api: 1, project: { name: 'Test Beat' } })
  })

  it('takes --api-file over the environment', async () => {
    const result = await cli(['--api-file', server.apiFile, 'status', '--json'], { env: { REBORN_API_FILE: 'Z:/missing/api.json' } })
    expect(result.code).toBe(EXIT.ok)
  })

  it('exits 3 when the PID in api.json is gone', async () => {
    const file = await writeApiFile(server, 'dead.json', { pid: await deadPid() })
    const result = await cli(['status'], { env: { REBORN_API_FILE: file } })
    expect(result.code).toBe(EXIT.notRunning)
    expect(result.stderr).toMatch(/RE:BORN is not running/)
  })

  it('exits 3 when nothing listens on the port', async () => {
    const file = await writeApiFile(server, 'closed.json', { port: 1 })
    expect((await cli(['status'], { env: { REBORN_API_FILE: file } })).code).toBe(EXIT.notRunning)
  })

  it('exits 5 for a rejected token, with a JSON error under --json', async () => {
    const file = await writeApiFile(server, 'stale.json', { writeToken: 'old' })
    const result = await cli(['status', '--json'], { env: { REBORN_API_FILE: file } })
    expect(result.code).toBe(EXIT.auth)
    expect(JSON.parse(result.stderr)).toMatchObject({ error: { code: 'unauthorized' } })
  })

  it('uses the read token with --read-only, so edits exit 5', async () => {
    expect((await cli(['status', '--read-only'])).code).toBe(EXIT.ok)
    expect(server.requests.at(-1)?.role).toBe('read')
    const edit = await cli(['--read-only', 'run', 'project.update', '--tempo', '100'])
    expect(edit.code).toBe(EXIT.auth)
    expect(edit.stderr).toMatch(/read token/)
    expect(server.state.project.tempo).not.toBe(100)
  })
})

describe('usage', () => {
  it('prints help and rejects unknown commands and options with exit 2', async () => {
    expect((await cli(['--help'])).stdout).toMatch(/Usage: reborn <command>/)
    expect((await cli(['help', 'set'])).stdout).toMatch(/reborn set acid-1.cutoff 62 --bar 9/)
    expect((await cli(['render', '--help'])).stdout).toMatch(/--stems/)
    expect((await cli(['dance'])).code).toBe(EXIT.usage)
    expect((await cli(['status', '--loud'])).code).toBe(EXIT.usage)
    expect((await cli(['seek', 'zero'])).code).toBe(EXIT.usage)
  })

  it('points `agent` at MCP and exits 2', async () => {
    const result = await cli(['agent', 'make the chorus drums hit harder'])
    expect(result.code).toBe(EXIT.usage)
    expect(result.stderr).toMatch(/reborn mcp/)
    expect(server.requests).toHaveLength(0)
  })
})

describe('commands and run', () => {
  it('lists commands as text and JSON', async () => {
    expect((await cli(['commands'])).stdout).toMatch(/parameter\.set\s+Set any track parameter/)
    const list = JSON.parse((await cli(['commands', '--json'])).stdout) as { type: string; schema: unknown }[]
    expect(list.find((c) => c.type === 'pattern.write')?.schema).toMatchObject({ type: 'object' })
  })

  it('runs a command with typed --param flags', async () => {
    const result = await cli(['run', 'mixer.set', '--trackId', '808', '--volume', '-3', '--mute'])
    expect(result.code).toBe(EXIT.ok)
    expect(result.stdout).toMatch(/Applied mixer.set \(revision 1\)/)
    expect(track('808').mixer).toMatchObject({ volume: -3, mute: true })
    expect(lastBody('/v1/execute')).toMatchObject({ origin: 'script', commands: [{ type: 'mixer.set', params: { trackId: '808', volume: -3, mute: true } }] })
  })

  it('merges --json-params with flags and passes --label', async () => {
    const result = await cli(['run', 'project.update', '--json-params', '{"tempo":100,"name":"A"}', '--name', 'B', '--label', 'Retitle', '--json'])
    expect(JSON.parse(result.stdout)).toMatchObject({ status: 'applied', revision: 1 })
    expect(server.state.project).toMatchObject({ tempo: 100, name: 'B' })
    expect(server.state.project.audit.at(-1)?.label).toBe('Retitle')
  })

  it('prints read results as JSON', async () => {
    const result = await cli(['run', 'project.summary'])
    expect(JSON.parse(result.stdout)).toMatchObject({ name: 'Test Beat', bars: expect.any(Number) })
  })

  it('exits 4 on a stale --expect-revision', async () => {
    const result = await cli(['run', 'project.update', '--tempo', '99', '--expect-revision', '7'])
    expect(result.code).toBe(EXIT.conflict)
    expect(result.stderr).toMatch(/revision 0, expected 7/)
  })

  it('rejects unknown commands and badly typed values before sending', async () => {
    expect((await cli(['run', 'track.explode'])).code).toBe(EXIT.usage)
    expect((await cli(['run', 'mixer.set', '--trackId', '808', '--volume', 'loud'])).code).toBe(EXIT.usage)
    expect(server.requests.filter((r) => r.path === '/v1/execute')).toHaveLength(0)
  })

  it('reports registry errors with exit 1', async () => {
    const result = await cli(['run', 'track.get', '--trackId', 'nope'])
    expect(result.code).toBe(EXIT.generic)
    expect(result.stderr).toMatch(/No track "nope"/)
  })
})

describe('pattern write', () => {
  it('writes a drum lane with <track>.<voice>', async () => {
    const result = await cli(['pattern', 'write', '808.kick', 'X...x...X...x...'])
    expect(result.code).toBe(EXIT.ok)
    expect(result.stdout).toMatch(/Wrote 808 kick/)
    const lane = (patternOf('808') as DrumPattern).lanes.kick
    expect(lane.map((h) => (h.on ? (h.accent ? 'X' : 'x') : '.')).join('')).toBe('X...x...X...x...')
  })

  it('writes notes to a track whose name has a space', async () => {
    expect((await cli(['pattern', 'write', 'Acid 1', 'C2 . D#2! C3~'])).code).toBe(EXIT.ok)
    const pattern = patternOf('Acid 1') as NotePattern
    expect(pattern.steps.map((s) => s.on)).toEqual([true, false, true, true])
    expect(pattern.steps[2]).toMatchObject({ accent: true })
    expect(pattern.steps[3]).toMatchObject({ slide: true })
  })

  it('joins unquoted note tokens and resolves slugs', async () => {
    expect((await cli(['pattern', 'write', 'acid-1', 'C2', 'D2'])).code).toBe(EXIT.ok)
    expect((patternOf('Acid 1') as NotePattern).length).toBe(2)
  })

  it('fails clearly for an unknown track', async () => {
    const result = await cli(['pattern', 'write', 'tuba.kick', 'X...'])
    expect(result.code).toBe(EXIT.generic)
    expect(result.stderr).toMatch(/No track "tuba"[\s\S]*Tracks: Acid 1/)
  })
})

describe('set', () => {
  it('resolves the shorthand and reads values above 1 as percentages', async () => {
    const result = await cli(['set', 'acid-1.cutoff', '62'])
    expect(result.code).toBe(EXIT.ok)
    expect(result.stdout).toMatch(/Set Acid 1 device.cutoff to 0.62/)
    expect(lastBody('/v1/execute')).toMatchObject({ commands: [{ type: 'parameter.set', params: { param: 'device.cutoff', value: 0.62 } }] })
    expect(track('Acid 1').device).toMatchObject({ cutoff: 0.62 })
  })

  it('writes automation at a 1-based bar with --bar', async () => {
    const result = await cli(['set', 'Acid 1.device.cutoff', '0.5', '--bar', '9'])
    expect(result.stdout).toMatch(/at bar 9/)
    const lane = server.state.project.automation.find((a) => a.trackId === track('Acid 1').id && a.param === 'device.cutoff')
    expect(lane?.points).toEqual([{ bar: 8, value: 0.5, curve: 'linear' }])
  })

  it('matches parameter suffixes and negative values', async () => {
    expect((await cli(['set', '808.volume', '-3'])).code).toBe(EXIT.ok)
    expect(track('808').mixer.volume).toBe(-3)
    expect((await cli(['set', '808.kick.tune', '25%'])).code).toBe(EXIT.ok)
    expect(track('808').device).toMatchObject({ voices: { kick: { tune: 0.25 } } })
  })

  it('rejects out-of-range values and unknown parameters', async () => {
    expect((await cli(['set', 'acid-1.cutoff', '250'])).code).toBe(EXIT.usage)
    const unknown = await cli(['set', 'acid-1.wobble', '1'])
    expect(unknown.code).toBe(EXIT.generic)
    expect(unknown.stderr).toMatch(/no parameter "wobble"/)
  })
})

describe('runtime', () => {
  it('controls the transport and launches scenes by name', async () => {
    expect((await cli(['play'])).stdout).toBe('Playing.\n')
    expect(server.state.playing).toBe(true)
    expect((await cli(['seek', '9'])).code).toBe(EXIT.ok)
    expect(server.state.bar).toBe(9)
    expect((await cli(['launch', 'groove'])).stdout).toBe('Launched Groove.\n')
    expect(lastBody('/v1/runtime')).toEqual({ action: 'scene.launch', params: { sceneId: server.state.project.scenes[1].id } })
  })

  it('undoes and saves', async () => {
    await cli(['run', 'project.update', '--tempo', '101'])
    expect((await cli(['undo'])).code).toBe(EXIT.ok)
    expect(server.state.project.tempo).not.toBe(101)
    expect((await cli(['save'])).stdout).toMatch(/Saved.\n.*Test Beat.reborn/)
  })

  it('cancels a job and reports finished ones', async () => {
    const started = await cli(['render'])
    const id = /job_\d+/.exec(started.stdout)![0]
    expect((await cli(['cancel', id])).stdout).toBe(`Cancelled ${id}.
`)
    expect(server.requests.at(-1)).toMatchObject({ method: 'DELETE', path: `/v1/jobs/${id}` })
    const done = JSON.parse((await cli(['render', '--wait', '--json'])).stdout) as { id: string }
    expect((await cli(['cancel', done.id])).stdout).toBe(`Job ${done.id} already done.
`)
  })

  it('reports render progress on stderr while waiting', async () => {
    const result = await cli(['render', '--wait'])
    expect(result.stderr).toMatch(/Mix render: \d+%/)
  })

  it('opens a project by absolute path and refuses to drop unsaved work', async () => {
    const opened = await cli(['open', 'Some Beat.reborn'])
    expect(opened.code).toBe(EXIT.ok)
    expect((lastBody('/v1/runtime') as { params: { path: string } }).params.path).toMatch(/Some Beat\.reborn$/)
    await cli(['run', 'project.update', '--tempo', '99'])
    expect((await cli(['open', 'Other.reborn'])).code).not.toBe(EXIT.ok)
    expect((await cli(['open', 'Other.reborn', '--discard-changes'])).code).toBe(EXIT.ok)
  })

  it('starts a render and returns without --wait', async () => {
    const result = await cli(['render'])
    expect(result.stdout).toMatch(/Mix render started as job job_\d+/)
    expect(server.requests.some((r) => r.path.startsWith('/v1/jobs/'))).toBe(false)
  })

  it('polls a render job with --wait and prints the output path', async () => {
    const result = await cli(['render', '--wait', '--out', 'C:/out/mix.wav'])
    expect(result.code).toBe(EXIT.ok)
    expect(result.stdout).toBe('C:/out/mix.wav\n')
    expect(lastBody('/v1/runtime')).toEqual({ action: 'render.mix', params: { path: 'C:/out/mix.wav' } })
    expect(server.requests.filter((r) => r.path.startsWith('/v1/jobs/')).length).toBe(3)
  })

  it('prints every stem path, or the job as JSON', async () => {
    const text = await cli(['render', '--stems', '--wait'])
    expect(text.stdout.trim().split('\n')).toHaveLength(server.state.project.tracks.length)
    const json = JSON.parse((await cli(['render', '--stems', '--wait', '--json'])).stdout)
    expect(json).toMatchObject({ status: 'done', result: { paths: expect.any(Array) } })
  })

  it('fails when the job fails', async () => {
    await server.close()
    server = await startFakeServer({ failJobs: true })
    const result = await cli(['render', '--wait'])
    expect(result.code).toBe(EXIT.generic)
    expect(result.stderr).toMatch(/Mix render failed: The engine stopped/)
  })

  it('analyzes a bar range and prints a compact report', async () => {
    const result = await cli(['analyze', '--bars', '1:16', '--wait'])
    expect(result.code).toBe(EXIT.ok)
    expect(lastBody('/v1/runtime')).toEqual({ action: 'analysis.run', params: { from: 1, to: 16 } })
    expect(result.stdout).toMatch(/^from: 1\nto: 16\nlufs: -9.24\npeak: -0.8\nnotes: Kick and Acid 1 overlap at 60 Hz\n$/)
    expect((await cli(['analyze', '--bars', '16:1'])).code).toBe(EXIT.usage)
  })
})

describe('watch', () => {
  it('streams events until --count is reached', async () => {
    const watching = cli(['watch', '--count', '2', '--json'])
    while (server.subscribers() === 0) await delay(5)
    await cli(['play'])
    await cli(['run', 'project.update', '--tempo', '111'])
    const result = await watching
    expect(result.code).toBe(EXIT.ok)
    const events = result.stdout.trim().split('\n').map((line) => JSON.parse(line) as { type: string })
    expect(events.map((e) => e.type)).toEqual(['transport', 'project'])
  })

  it('prints readable lines and stops on abort', async () => {
    const abort = new AbortController()
    const watching = cli(['watch'], { signal: abort.signal })
    while (server.subscribers() === 0) await delay(5)
    server.emit({ type: 'proposal', id: 'prop_9', status: 'applied' })
    await delay(50)
    abort.abort()
    const result = await watching
    expect(result.code).toBe(EXIT.ok)
    expect(result.stdout).toMatch(/proposal\s+prop_9 applied/)
  })
})

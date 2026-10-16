import { describe, expect, it } from 'vitest'
import { createDefaultProject } from '../model'
import { createDemoProject, demoCatalog } from '../demo/catalog'
import { type Command, COMMANDS, StudioError, execute, executeBatch, listCommands } from './index'
import {
  automationValueAt,
  clipById,
  createDefaultStudioProject,
  formatNoteNotation,
  importV1Project,
  laneFor,
  linkCount,
  migrateStudioProject,
  parseNoteNotation,
  resolveParam,
  trackById,
  traceReturn,
  traceTrack,
} from './index'

const run = (project: ReturnType<typeof createDefaultStudioProject>, type: string, params: Record<string, unknown> = {}) => execute(project, { type, params })

function fresh() {
  return createDefaultStudioProject('Test')
}

describe('default project', () => {
  it('has the six-track rack, a starter beat, and valid macros', () => {
    const project = fresh()
    expect(project.tracks.map((t) => t.kind)).toEqual(['acid', 'acid', 'wave', 'drum', 'drum', 'sampler'])
    expect(project.clips.length).toBeGreaterThan(0)
    for (const track of project.tracks) {
      expect(track.macros).toHaveLength(8)
      for (const macro of track.macros) expect(macro.targets.length).toBe(1)
    }
  })
})

describe('command registry', () => {
  it('rejects unknown commands, unknown params, and invalid values without changing the project', () => {
    const project = fresh()
    expect(() => run(project, 'nope')).toThrow(StudioError)
    expect(() => run(project, 'project.update', { bogus: 1 })).toThrow(/does not take bogus/)
    expect(() => run(project, 'project.update', { tempo: 9 })).toThrow(/at least 40/)
    expect(() => run(project, 'mixer.set', { trackId: 'Acid 1', mute: 'yes' })).toThrow(/true or false/)
  })

  it('applies batches atomically and bumps the revision once with an audit entry', () => {
    const project = fresh()
    const ok = executeBatch(project, [{ type: 'project.update', params: { tempo: 130 } }, { type: 'mixer.set', params: { trackId: 'Acid 1', volume: -3 } }], { origin: 'agent', label: 'Tighten' })
    expect(ok.project.revision).toBe(project.revision + 1)
    expect(ok.project.audit.at(-1)).toMatchObject({ origin: 'agent', label: 'Tighten', commands: ['project.update', 'mixer.set'] })
    expect(() => executeBatch(project, [{ type: 'project.update', params: { tempo: 130 } }, { type: 'mixer.set', params: { trackId: 'missing' } }])).toThrow(/No track/)
  })

  it('refuses stale revisions', () => {
    const project = fresh()
    expect(() => execute(project, { type: 'project.update', params: { tempo: 99 } }, { expectedRevision: 5 })).toThrow(/changed/)
  })

  it('does not bump the revision for reads', () => {
    const project = fresh()
    const result = run(project, 'project.summary')
    expect(result.changed).toBe(false)
    expect(result.project).toBe(project)
    expect((result.results[0] as { tracks: unknown[] }).tracks).toHaveLength(6)
  })

  it('publishes a JSON schema for every command', () => {
    const list = listCommands()
    expect(list.length).toBe(COMMANDS.size)
    for (const entry of list) expect(entry.schema).toMatchObject({ type: 'object', additionalProperties: false })
  })

  it('accepts track names in place of IDs', () => {
    const project = fresh()
    const next = run(project, 'mixer.set', { trackId: '808', solo: true }).project
    expect(next.tracks.find((t) => t.name === '808')?.mixer.solo).toBe(true)
  })
})

describe('tracks and mixer', () => {
  it('adds tracks with sends for every return and removes them with their clips', () => {
    let project = fresh()
    const added = run(project, 'track.add', { kind: 'audio', name: 'Vox' })
    project = added.project
    const id = (added.results[0] as { trackId: string }).trackId
    expect(Object.keys(trackById(project, id)!.mixer.sends).sort()).toEqual(['delay', 'reverb'])
    project = run(project, 'track.remove', { trackId: 'Acid 1' }).project
    expect(project.tracks.some((t) => t.name === 'Acid 1')).toBe(false)
    expect(project.clips.every((c) => trackById(project, c.trackId))).toBe(true)
  })

  it('routes into groups and refuses loops', () => {
    let project = fresh()
    const group = run(project, 'track.add', { kind: 'group', name: 'Drums' })
    project = group.project
    const groupId = (group.results[0] as { trackId: string }).trackId
    project = run(project, 'mixer.set', { trackId: '808', output: groupId }).project
    expect(traceTrack(project, trackById(project, project.tracks[3].id)!.id).path).toEqual(['808', 'Drums', 'Master'])
    project = run(project, 'mixer.set', { trackId: groupId, mute: true }).project
    expect(traceTrack(project, project.tracks[3].id)).toMatchObject({ audible: false, reason: 'Its group Drums is muted.' })
    expect(() => run(project, 'mixer.set', { trackId: '808', output: project.tracks[0].id })).toThrow(/group track/)
  })

  it('sets parameters within their spec and moves macros across their targets', () => {
    let project = fresh()
    project = run(project, 'parameter.set', { trackId: 'Acid 1', param: 'device.cutoff', value: 4 }).project
    expect(project.tracks[0].device).toMatchObject({ cutoff: 1 })
    project = run(project, 'parameter.set', { trackId: '808', param: 'voice.kick.tune', value: 0.2 }).project
    expect(project.tracks[3].device.kind === 'drum' && project.tracks[3].device.voices.kick.tune).toBe(0.2)
    expect(() => run(project, 'parameter.set', { trackId: 'Acid 1', param: 'device.nope', value: 1 })).toThrow(/no parameter/)
    project = run(project, 'macro.set', { trackId: 'Acid 1', index: 0, value: 0 }).project
    expect(project.tracks[0].device).toMatchObject({ cutoff: 0 })
  })

  it('traces a muted track whose pre-fader send still feeds a return', () => {
    let project = fresh()
    project = run(project, 'send.set', { trackId: 'Acid 2', returnId: 'delay', level: 0.4, tap: 'pre' }).project
    project = run(project, 'mixer.set', { trackId: 'Acid 2', mute: true }).project
    const trace = traceReturn(project, 'delay')
    expect(trace.sources.find((s) => s.name === 'Acid 2')).toMatchObject({ feeds: true, suspicious: true })
    project = run(project, 'master.set', { fxSafeBypass: true }).project
    expect(traceReturn(project, 'delay').audible).toBe(false)
  })
})

describe('patterns', () => {
  it('round-trips note notation', () => {
    const steps = parseNoteNotation('C2 . D#2! C3~ -')
    expect(formatNoteNotation(steps)).toBe('C2 . D#2! C3~ .')
    expect(() => parseNoteNotation('C2 H9')).toThrow(/not a note/)
  })

  it('writes drum lanes by track and voice alias, growing the pattern when needed', () => {
    let project = fresh()
    project = run(project, 'pattern.write', { trackId: '808', voice: 'bd', steps: 'X...x...X...x...x.x.' }).project
    const clip = project.clips.find((c) => c.trackId === project.tracks[3].id)!
    const pattern = project.patterns[clip.patternId!]
    expect(pattern.kind === 'drums' && pattern.length).toBe(20)
    expect(pattern.kind === 'drums' && pattern.lanes.kick.filter((h) => h.on).length).toBe(6)
  })

  it('creates a clip when writing to a track with no pattern', () => {
    let project = fresh()
    project = run(project, 'pattern.write', { trackId: 'Wave', steps: 'C4 . E4 G4' }).project
    const wave = project.tracks[2]
    expect(project.clips.some((c) => c.trackId === wave.id)).toBe(true)
  })

  it('edits single steps with locks and removes locks with null', () => {
    let project = fresh()
    const clip = project.clips.find((c) => c.trackId === project.tracks[0].id)!
    project = run(project, 'step.set', { patternId: clip.patternId, index: 1, on: true, note: 40, locks: { 'device.cutoff': 0.9 } }).project
    let pattern = project.patterns[clip.patternId!]
    expect(pattern.kind === 'notes' && pattern.steps[1]).toMatchObject({ on: true, note: 40, locks: { 'device.cutoff': 0.9 } })
    project = run(project, 'step.set', { patternId: clip.patternId, index: 1, locks: { 'device.cutoff': null } }).project
    pattern = project.patterns[clip.patternId!]
    expect(pattern.kind === 'notes' && pattern.steps[1].locks).toEqual({})
  })
})

describe('arrangement', () => {
  it('duplicates as linked repeats and makes one unique', () => {
    let project = fresh()
    const source = project.clips[0]
    const dup = run(project, 'clip.duplicate', { clipId: source.id })
    project = dup.project
    const copyId = (dup.results[0] as { clipId: string }).clipId
    expect(linkCount(project, source.patternId!)).toBe(2)
    project = run(project, 'clip.makeUnique', { clipId: copyId }).project
    expect(linkCount(project, source.patternId!)).toBe(1)
    expect(clipById(project, copyId)!.patternId).not.toBe(source.patternId)
  })

  it('inserts time between sections without appending to the end', () => {
    let project = fresh()
    const lengthBefore = project.length
    const groove = project.sections.find((s) => s.name === 'Groove')!
    project = run(project, 'time.insert', { at: groove.start, bars: 8, name: 'Break' }).project
    expect(project.length).toBe(lengthBefore + 8)
    expect(project.sections.map((s) => [s.name, s.start])).toEqual([['Intro', 0], ['Break', 4], ['Groove', 12]])
    expect(project.clips.find((c) => c.trackId === project.tracks[0].id)!.start).toBe(12)
  })

  it('splits clips that cross an insert and keeps their pattern offset', () => {
    let project = fresh()
    const drums = project.clips[0]
    project = run(project, 'time.insert', { at: 2, bars: 4 }).project
    const parts = project.clips.filter((c) => c.patternId === drums.patternId).sort((a, b) => a.start - b.start)
    expect(parts.map((c) => [c.start, c.length, c.offset])).toEqual([[0, 2, 0], [6, 6, 2]])
  })

  it('deletes time and trims overlaps', () => {
    let project = fresh()
    project = run(project, 'time.delete', { at: 2, bars: 2 }).project
    expect(project.clips[0]).toMatchObject({ start: 0, length: 6 })
    expect(project.sections.map((s) => [s.name, s.start, s.length])).toEqual([['Intro', 0, 2], ['Groove', 2, 4]])
  })

  it('records scene launches into clips', () => {
    let project = fresh()
    const groove = project.scenes[1]
    project = run(project, 'scene.record', { launches: [{ sceneId: groove.id, start: 8, length: 4 }] }).project
    expect(project.clips.filter((c) => c.start === 8)).toHaveLength(Object.keys(groove.slots).length)
  })
})

describe('automation', () => {
  it('interpolates linear points, holds step points, and lets locks win', () => {
    let project = fresh()
    project = run(project, 'automation.write', { trackId: 'Acid 1', param: 'device.cutoff', points: [{ bar: 0, value: 0.2 }, { bar: 4, value: 0.6 }, { bar: 6, value: 1, curve: 'hold' }, { bar: 8, value: 0 }] }).project
    const lane = laneFor(project, project.tracks[0].id, 'device.cutoff')
    expect(automationValueAt(lane, 2)).toBeCloseTo(0.4)
    expect(automationValueAt(lane, 7)).toBe(1)
    const track = project.tracks[0]
    expect(resolveParam(project, track, 'device.cutoff', 2, { 'device.cutoff': 0.05 })).toBe(0.05)
    project = run(project, 'automation.clear', { trackId: 'Acid 1', param: 'device.cutoff' }).project
    expect(resolveParam(project, project.tracks[0], 'device.cutoff', 2)).toBe(track.device.kind === 'acid' ? track.device.cutoff : 0)
  })

  it('shifts automation with inserted time', () => {
    let project = fresh()
    project = run(project, 'automation.write', { trackId: 'Acid 1', param: 'device.cutoff', points: [{ bar: 6, value: 1 }] }).project
    project = run(project, 'time.insert', { at: 4, bars: 4 }).project
    expect(laneFor(project, project.tracks[0].id, 'device.cutoff')!.points[0].bar).toBe(10)
  })
})

describe('v1 import', () => {
  it('maps the default v1 project onto tracks, patterns, merged clips, sections, and scenes', () => {
    const v1 = createDefaultProject()
    const { project, report } = importV1Project(v1)
    expect(project.tracks.map((t) => t.kind)).toEqual(['acid', 'acid', 'wave', 'drum', 'drum', 'sampler', 'deck', 'deck'])
    expect(project.length).toBe(v1.songChain.length)
    expect(project.sections.map((s) => s.name)).toEqual(v1.songScenes.map((s) => s.name))
    // Every song bar is covered by exactly one clip per Acid and drum track.
    for (const track of project.tracks.slice(0, 2).concat(project.tracks.slice(3, 5))) {
      const covered = project.clips.filter((c) => c.trackId === track.id).reduce((sum, c) => sum + c.length, 0)
      expect(covered).toBe(v1.songChain.length)
    }
    expect(project.assets['builtin:loop_breakbeat.ogg']?.origin.kind).toBe('builtin')
    expect(report.notes.join(' ')).toMatch(/Imported 8 tracks/)
  })

  it('preserves the notes of a song-chain pattern', () => {
    const v1 = createDefaultProject()
    const { project } = importV1Project(v1)
    const firstIndex = v1.songChain[0].bass[0]
    const clip = project.clips.find((c) => c.trackId === project.tracks[0].id && c.start === 0)!
    const pattern = project.patterns[clip.patternId!]
    const expected = v1.bass[0].patterns[firstIndex].map((s) => (s.active ? s.note + s.octave * 12 : null))
    expect(pattern.kind === 'notes' && pattern.steps.map((s) => (s.on ? s.note : null))).toEqual(expected)
  })

  it('converts bar and step automation into hold points', () => {
    let v1 = createDefaultProject()
    v1 = { ...v1, channelAutomation: { 'bass-0': { bars: { '2': { cutoff: 80 } }, steps: { '3:4': { cutoff: 10 } } } } }
    const { project } = importV1Project(v1)
    const lane = laneFor(project, project.tracks[0].id, 'device.cutoff')!
    expect(automationValueAt(lane, 1)).toBeCloseTo(v1.bass[0].cutoff / 100)
    expect(automationValueAt(lane, 2.5)).toBeCloseTo(0.8)
    expect(automationValueAt(lane, 3 + 4 / 16)).toBeCloseTo(0.1)
    expect(automationValueAt(lane, 3 + 5 / 16)).toBeCloseTo(v1.bass[0].cutoff / 100)
  })

  it('imports every bundled demo and turns the dubstep demo’s scripted mix into automation', () => {
    for (const demo of demoCatalog) {
      const { project } = importV1Project(createDemoProject(demo.id))
      expect(project.tracks.length).toBeGreaterThanOrEqual(8)
      expect(migrateStudioProject(JSON.parse(JSON.stringify(project)))).toMatchObject({ name: project.name })
    }
    expect(importV1Project(createDemoProject('abyssal')).project.automation).toHaveLength(0)
    const { project } = importV1Project({ ...createDemoProject('abyssal'), demoAutoMix: true })
    expect(project.automation.length).toBeGreaterThan(0)
  })

  it('leaves the v1 project untouched', () => {
    const v1 = createDefaultProject()
    const before = JSON.stringify(v1)
    importV1Project(v1)
    expect(JSON.stringify(v1)).toBe(before)
  })

  it('keeps v1 gain staging for the master and crossfaded buses', () => {
    const { project } = importV1Project(createDefaultProject())
    const volume = (kind: string) => project.tracks.find((t) => t.kind === kind)!.mixer.volume
    expect(project.master.volume).toBeCloseTo(20 * Math.log10(0.76), 1)
    expect(volume('acid')).toBeCloseTo(-3, 0)
    expect(volume('drum')).toBeCloseTo(-3, 0)
    expect(volume('deck')).toBeCloseTo(-3, 0)
    expect(volume('wave')).toBe(0)
    expect(volume('sampler')).toBe(0)
  })
})

describe('migration', () => {
  it('rejects foreign and newer files and fills missing optional fields', () => {
    expect(() => migrateStudioProject({})).toThrow(/not a RE:BORN v2/)
    expect(() => migrateStudioProject({ ...fresh(), version: 99 })).toThrow(/newer/)
    const { sections: _s, audit: _a, ...partial } = fresh()
    const migrated = migrateStudioProject(partial)
    expect(migrated.sections).toEqual([])
    expect(migrated.audit).toEqual([])
  })
})

describe('every command', () => {
  it('has a test-reachable happy path', () => {
    // Guard: listing every command keeps new commands from shipping untested.
    const covered: Command['type'][] = [
      'project.summary', 'track.get', 'clip.list', 'pattern.get', 'mixer.trace', 'project.update', 'master.set', 'return.set', 'track.add', 'track.remove', 'track.update', 'mixer.set', 'send.set',
      'parameter.set', 'device.update', 'drum.voice.set', 'macro.set', 'pad.set', 'deck.set', 'sample.slice', 'asset.add', 'pattern.create', 'pattern.write', 'pattern.update', 'step.set', 'drum.step.set',
      'pad.hit', 'pad.record', 'clip.create', 'clip.move', 'clip.resize', 'clip.duplicate', 'clip.delete', 'clip.makeUnique', 'clip.split', 'clip.set', 'time.insert', 'time.delete',
      'section.add', 'section.update', 'section.remove', 'scene.add', 'scene.set', 'scene.remove', 'scene.record', 'automation.write', 'automation.clear',
      'pattern.quantize', 'groove.apply', 'macro.map',
    ]
    expect([...COMMANDS.keys()].sort()).toEqual([...covered].sort())
  })

  it('runs the remaining commands', () => {
    let project = fresh()
    const step = (type: string, params: Record<string, unknown>) => {
      const out = run(project, type, params)
      project = out.project
      return out.results[0] as Record<string, string>
    }
    step('track.get', { trackId: 'Wave' })
    step('clip.list', { trackId: '808', from: 1, to: 4 })
    step('mixer.trace', {})
    step('return.set', { returnId: 'delay', feedback: 0.3, time: 0.5 })
    expect(() => step('return.set', { returnId: 'reverb', feedback: 0.3 })).toThrow(/no feedback/)
    step('track.update', { trackId: 'Wave', name: 'Pad', index: 0 })
    expect(project.tracks[0].name).toBe('Pad')
    step('device.update', { trackId: '909', kit: '808' })
    expect(() => step('device.update', { trackId: 'Acid 1', waveform: 'sine' })).toThrow(/sawtooth or square/)
    step('drum.voice.set', { trackId: '808', voice: 'ch', mute: true })
    step('asset.add', { asset: { id: 'a1', name: 'break.wav', mimeType: 'audio/wav', bytes: 10, duration: 2, channels: 2, sampleRate: 44100, origin: { kind: 'import', createdAt: '' } } })
    step('sample.slice', { trackId: 'Sampler', assetId: 'a1', slices: [0.25, 0.5, 0.75], assignPads: true })
    const sampler = project.tracks.find((t) => t.kind === 'sampler')!
    expect(sampler.device.kind === 'sampler' && sampler.device.pads.slice(0, 4).map((p) => [p.start, p.end])).toEqual([[0, 0.25], [0.25, 0.5], [0.5, 0.75], [0.75, 1]])
    step('pad.set', { trackId: 'Sampler', pad: 2, pitch: 5, choke: 1 })
    step('track.add', { kind: 'deck', name: 'Deck A' })
    step('deck.set', { trackId: 'Deck A', assetId: 'a1', pitch: 2, loop: false })
    expect(() => step('deck.set', { trackId: 'Pad', gain: 1 })).toThrow(/not a deck/)
    const created = step('pattern.create', { trackId: 'Sampler', length: 64 })
    step('pad.hit', { patternId: created.patternId, step: 3, pad: 1 })
    step('pad.record', { patternId: created.patternId, hits: [{ step: 0, pad: 0, velocity: 90 }, { step: 70, pad: 0 }] })
    const pads = project.patterns[created.patternId]
    expect(pads.kind === 'pads' && pads.hits).toHaveLength(1)
    step('pattern.update', { patternId: created.patternId, name: 'Take', length: 32, division: 16, swing: 0.1 })
    const beat = project.clips.find((c) => c.trackId === project.tracks.find((t) => t.name === '808')!.id)!
    step('drum.step.set', { patternId: beat.patternId!, voice: 'snare', index: 4, on: true, accent: true })
    step('pattern.get', { patternId: beat.patternId! })
    const clip = step('clip.create', { trackId: 'Sampler', start: 8, length: 4, patternId: created.patternId })
    step('clip.move', { clipId: clip.clipId, start: 10 })
    step('clip.resize', { clipId: clip.clipId, length: 2 })
    step('clip.set', { clipId: clip.clipId, gain: -3, mute: true })
    const split = step('clip.split', { clipId: clip.clipId, at: 11 })
    step('clip.delete', { clipId: split.clipId })
    const section = step('section.add', { start: 8, length: 4, name: 'Outro' })
    step('section.update', { sectionId: section.sectionId, name: 'End' })
    step('section.remove', { sectionId: section.sectionId })
    const scene = step('scene.add', { name: 'Empty' })
    step('scene.set', { sceneId: scene.sceneId, trackId: 'Sampler', patternId: created.patternId, name: 'Pads' })
    step('scene.remove', { sceneId: scene.sceneId })
    expect(project.revision).toBeGreaterThan(10)
  })
})

describe('groove and quantize', () => {
  it('applies a repeating groove to active and inactive steps and quantizes it back', () => {
    let project = fresh()
    const patternId = project.clips.find((c) => project.tracks.find((t) => t.id === c.trackId)?.kind === 'drum')!.patternId!
    project = run(project, 'groove.apply', { patternId, groove: [0, 0.3], amount: 0.5 }).project
    const lane = () => (project.patterns[patternId] as { lanes: Record<string, { micro: number }[]> }).lanes.kick
    expect(lane()[0].micro).toBe(0)
    expect(lane()[1].micro).toBeCloseTo(0.15)
    expect(lane()[3].micro).toBeCloseTo(0.15)
    project = run(project, 'pattern.quantize', { patternId, strength: 0.5 }).project
    expect(lane()[1].micro).toBeCloseTo(0.075)
    project = run(project, 'pattern.quantize', { patternId }).project
    expect(lane()[1].micro).toBe(0)
  })

  it('rejects an empty groove', () => {
    const project = fresh()
    const patternId = Object.keys(project.patterns)[0]
    expect(() => run(project, 'groove.apply', { patternId, groove: [] })).toThrow(/at least one/)
  })
})

describe('macro.map', () => {
  it('maps one macro to several parameters, inverted ranges included', () => {
    let project = fresh()
    project = run(project, 'macro.map', { trackId: 'Acid 1', index: 0, name: 'Squelch', targets: [{ param: 'device.cutoff', min: 0.2, max: 0.8 }, { param: 'device.resonance', min: 0.9, max: 0.3 }] }).project
    project = run(project, 'macro.set', { trackId: 'Acid 1', index: 0, value: 1 }).project
    const track = project.tracks.find((t) => t.name === 'Acid 1')!
    expect(track.macros[0].name).toBe('Squelch')
    expect(track.device.kind === 'acid' && track.device.cutoff).toBeCloseTo(0.8)
    expect(track.device.kind === 'acid' && track.device.resonance).toBeCloseTo(0.3)
  })

  it('rejects unknown parameters', () => {
    expect(() => run(fresh(), 'macro.map', { trackId: 'Acid 1', index: 0, targets: [{ param: 'device.nope' }] })).toThrow(/no parameter/)
  })
})

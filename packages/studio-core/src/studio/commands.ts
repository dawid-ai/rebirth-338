import {
  type AutomationPoint,
  type Clip,
  type MasterState,
  type NotePattern,
  type Origin,
  type PadHit,
  type PadState,
  type ReturnBus,
  type StudioProject,
  type Track,
  type TrackKind,
  DEVICE_NAMES,
  DRUM_VOICES,
  PAD_COUNT,
  TRACK_COLORS,
  clamp,
  clipEnd,
  createPatternFor,
  createTrack,
  findParamSpec,
  getParam,
  macrosFor,
  newId,
  paramSpecs,
  setParam,
} from './model'
import {
  StudioError,
  clearAutomation,
  createClip,
  deleteClip,
  deleteTime,
  duplicateClip,
  fitLength,
  formatDrumNotation,
  formatNoteNotation,
  insertTime,
  makeUnique,
  moveClip,
  parseDrumNotation,
  parseNoteNotation,
  requireClip,
  requirePattern,
  requireTrack,
  resizeClip,
  resizePattern,
  resolveDrumVoice,
  splitClip,
  traceReturn,
  traceTrack,
  updateClip,
  updatePattern,
  updateTrack,
  writeAutomation,
} from './ops'

// Typed command registry shared by the UI, keyboard shortcuts, CLI, local
// API, MCP, and agents. Each command validates its parameters, applies a pure
// change, and returns an optional result.

export type FieldType = 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array'

export interface FieldSpec {
  type: FieldType
  description: string
  required?: boolean
  min?: number
  max?: number
  enum?: readonly string[]
  items?: FieldSpec
}

export interface CommandSpec {
  type: string
  summary: string
  mutates: boolean
  params: Record<string, FieldSpec>
  run: (project: StudioProject, params: Record<string, unknown>) => { project: StudioProject; result?: unknown }
}

export interface Command {
  type: string
  params?: Record<string, unknown>
}

const s = (description: string, required = true, extra: Partial<FieldSpec> = {}): FieldSpec => ({ type: 'string', description, required, ...extra })
const n = (description: string, required = true, extra: Partial<FieldSpec> = {}): FieldSpec => ({ type: 'number', description, required, ...extra })
const i = (description: string, required = true, extra: Partial<FieldSpec> = {}): FieldSpec => ({ type: 'integer', description, required, ...extra })
const b = (description: string, required = false): FieldSpec => ({ type: 'boolean', description, required })
const o = (description: string, required = true): FieldSpec => ({ type: 'object', description, required })

type P = Record<string, unknown>
const str = (p: P, k: string) => p[k] as string
const num = (p: P, k: string) => p[k] as number
const opt = <T>(p: P, k: string) => p[k] as T | undefined

const TRACK_KINDS: readonly TrackKind[] = ['acid', 'wave', 'drum', 'sampler', 'audio', 'deck', 'group']

function addReturnSends(tracks: Track[], ret: ReturnBus): Track[] {
  return tracks.map((t) => ({ ...t, mixer: { ...t.mixer, sends: { ...t.mixer.sends, [ret.id]: t.mixer.sends[ret.id] ?? { level: 0, tap: 'post' } } } }))
}

function patternForTrack(project: StudioProject, trackId: string): { project: StudioProject; patternId: string } {
  const track = requireTrack(project, trackId)
  const fromClip = project.clips.find((c) => c.trackId === track.id && c.patternId)
  if (fromClip?.patternId) return { project, patternId: fromClip.patternId }
  const fromScene = project.scenes.map((sc) => sc.slots[track.id]).find(Boolean)
  if (fromScene) return { project, patternId: fromScene }
  const created = createClip(project, track.id, 0, 4)
  if (!created.clip.patternId) throw new StudioError('invalid', `${track.name} does not play patterns.`)
  return { project: created.project, patternId: created.clip.patternId }
}

const SPECS: CommandSpec[] = [
  // Reads ---------------------------------------------------------------------
  {
    type: 'project.summary',
    summary: 'Describe the project: tempo, length, tracks, sections, and scenes.',
    mutates: false,
    params: {},
    run: (project) => ({
      project,
      result: {
        name: project.name,
        revision: project.revision,
        tempo: project.tempo,
        swing: project.swing,
        bars: project.length,
        tracks: project.tracks.map((t) => ({ id: t.id, name: t.name, kind: t.kind, volume: t.mixer.volume, mute: t.mixer.mute, solo: t.mixer.solo, clips: project.clips.filter((c) => c.trackId === t.id).length })),
        sections: project.sections.map((sec) => ({ id: sec.id, name: sec.name, start: sec.start + 1, bars: sec.length })),
        scenes: project.scenes.map((sc) => ({ id: sc.id, name: sc.name })),
        returns: project.returns.map((r) => ({ id: r.id, name: r.name, level: r.level, mute: r.mute })),
      },
    }),
  },
  {
    type: 'track.get',
    summary: 'Read one track with its device, inserts, mixer, and parameter specs.',
    mutates: false,
    params: { trackId: s('Track ID or name.') },
    run: (project, p) => {
      const track = requireTrack(project, str(p, 'trackId'))
      return { project, result: { ...track, params: paramSpecs(track, project.returns).map((spec) => ({ ...spec, value: getParam(track, spec.id) })) } }
    },
  },
  {
    type: 'clip.list',
    summary: 'List arrangement clips, optionally for one track or bar range.',
    mutates: false,
    params: { trackId: s('Track ID or name.', false), from: n('First bar (1-based).', false), to: n('Last bar (1-based).', false) },
    run: (project, p) => {
      const track = opt<string>(p, 'trackId') ? requireTrack(project, str(p, 'trackId')) : null
      const from = (opt<number>(p, 'from') ?? 1) - 1
      const to = opt<number>(p, 'to') ?? Infinity
      const clips = project.clips.filter((c) => (!track || c.trackId === track.id) && clipEnd(c) > from && c.start < to)
      return { project, result: clips.map((c) => ({ ...c, startBar: c.start + 1, pattern: c.patternId ? project.patterns[c.patternId]?.name : null })) }
    },
  },
  {
    type: 'pattern.get',
    summary: 'Read a pattern, including text notation for notes or drum lanes.',
    mutates: false,
    params: { patternId: s('Pattern ID.') },
    run: (project, p) => {
      const pattern = requirePattern(project, str(p, 'patternId'))
      const notation = pattern.kind === 'notes' ? formatNoteNotation(pattern.steps) : pattern.kind === 'drums' ? Object.fromEntries(DRUM_VOICES.map((v) => [v, formatDrumNotation(pattern.lanes[v])])) : pattern.hits.map((h) => `${h.step}:${h.pad + 1}`).join(' ')
      return { project, result: { ...pattern, notation } }
    },
  },
  {
    type: 'mixer.trace',
    summary: 'Explain why a track is or is not audible, or every path into a return (for example, "why can I hear echo?").',
    mutates: false,
    params: { trackId: s('Track ID or name.', false), returnId: s('Return ID, for example "delay".', false) },
    run: (project, p) => {
      if (opt<string>(p, 'trackId')) return { project, result: traceTrack(project, requireTrack(project, str(p, 'trackId')).id) }
      const ids = opt<string>(p, 'returnId') ? [str(p, 'returnId')] : project.returns.map((r) => r.id)
      return { project, result: ids.map((id) => traceReturn(project, id)) }
    },
  },

  // Project -------------------------------------------------------------------
  {
    type: 'project.update',
    summary: 'Change the project name, tempo, or global swing.',
    mutates: true,
    params: { name: s('Project name.', false), tempo: n('Tempo in BPM.', false, { min: 40, max: 240 }), swing: n('Global swing 0..0.75.', false, { min: 0, max: 0.75 }) },
    run: (project, p) => ({ project: { ...project, ...(p.name !== undefined && { name: String(p.name).slice(0, 80) }), ...(p.tempo !== undefined && { tempo: num(p, 'tempo') }), ...(p.swing !== undefined && { swing: num(p, 'swing') }) } }),
  },
  {
    type: 'master.set',
    summary: 'Change master volume, ceiling, drive, compression, softening, or FX Safe Bypass.',
    mutates: true,
    params: {
      volume: n('Master volume in dB.', false, { min: -60, max: 6 }),
      ceiling: n('Output ceiling in dBFS.', false, { min: -6, max: 0 }),
      drive: n('0..1.', false, { min: 0, max: 1 }),
      compress: n('0..1.', false, { min: 0, max: 1 }),
      soften: n('0..1.', false, { min: 0, max: 1 }),
      fxSafeBypass: b('Silence returns without changing sends.'),
    },
    run: (project, p) => ({ project: { ...project, master: { ...project.master, ...(p as Partial<MasterState>) } } }),
  },
  {
    type: 'return.set',
    summary: 'Change a return bus: level, mute, and its delay or reverb settings.',
    mutates: true,
    params: {
      returnId: s('Return ID.'),
      level: n('Return level in dB.', false, { min: -60, max: 6 }),
      mute: b('Mute the return.'),
      time: n('Delay time in beats.', false, { min: 0.0625, max: 4 }),
      feedback: n('Delay feedback 0..0.95.', false, { min: 0, max: 0.95 }),
      decay: n('Reverb decay in seconds.', false, { min: 0.2, max: 12 }),
      tone: n('Tone 0..1.', false, { min: 0, max: 1 }),
    },
    run: (project, p) => {
      const id = str(p, 'returnId')
      const ret = project.returns.find((r) => r.id === id)
      if (!ret) throw new StudioError('not_found', `No return "${id}".`)
      const { returnId: _ignored, ...patch } = p
      const allowed = ret.kind === 'delay' ? ['level', 'mute', 'time', 'feedback', 'tone'] : ['level', 'mute', 'decay', 'tone']
      const extra = Object.keys(patch).filter((k) => !allowed.includes(k))
      if (extra.length) throw new StudioError('invalid', `${ret.name} has no ${extra.join(', ')} setting.`)
      return { project: { ...project, returns: project.returns.map((r) => (r.id === id ? ({ ...r, ...patch } as ReturnBus) : r)) } }
    },
  },

  // Tracks --------------------------------------------------------------------
  {
    type: 'track.add',
    summary: 'Add a track with a fresh device.',
    mutates: true,
    params: { kind: s('Device type.', true, { enum: TRACK_KINDS }), name: s('Track name.', false), index: i('Position in the track list.', false, { min: 0 }) },
    run: (project, p) => {
      const kind = str(p, 'kind') as TrackKind
      const count = project.tracks.filter((t) => t.kind === kind).length + 1
      const track = createTrack(kind, opt<string>(p, 'name') ?? `${DEVICE_NAMES[kind]} ${count}`, TRACK_COLORS[project.tracks.length % TRACK_COLORS.length], project.returns)
      track.macros = macrosFor(track)
      const tracks = [...project.tracks]
      tracks.splice(opt<number>(p, 'index') ?? tracks.length, 0, track)
      return { project: { ...project, tracks }, result: { trackId: track.id } }
    },
  },
  {
    type: 'track.remove',
    summary: 'Remove a track, its clips, and its automation.',
    mutates: true,
    params: { trackId: s('Track ID or name.') },
    run: (project, p) => {
      const track = requireTrack(project, str(p, 'trackId'))
      return {
        project: {
          ...project,
          tracks: project.tracks.filter((t) => t.id !== track.id).map((t) => (t.mixer.output === track.id ? { ...t, mixer: { ...t.mixer, output: 'master' } } : t)),
          clips: project.clips.filter((c) => c.trackId !== track.id),
          automation: project.automation.filter((a) => a.trackId !== track.id),
          scenes: project.scenes.map((sc) => {
            const slots = { ...sc.slots }
            delete slots[track.id]
            return { ...sc, slots }
          }),
        },
      }
    },
  },
  {
    type: 'track.update',
    summary: 'Rename, recolor, or move a track.',
    mutates: true,
    params: { trackId: s('Track ID or name.'), name: s('New name.', false), color: s('Hex color.', false), index: i('New position.', false, { min: 0 }) },
    run: (project, p) => {
      const track = requireTrack(project, str(p, 'trackId'))
      let next = updateTrack(project, track.id, (t) => ({ ...t, ...(p.name !== undefined && { name: String(p.name).slice(0, 40) }), ...(p.color !== undefined && { color: String(p.color) }) }))
      if (p.index !== undefined) {
        const tracks = next.tracks.filter((t) => t.id !== track.id)
        tracks.splice(clamp(num(p, 'index'), 0, tracks.length), 0, next.tracks.find((t) => t.id === track.id)!)
        next = { ...next, tracks }
      }
      return { project: next }
    },
  },
  {
    type: 'mixer.set',
    summary: 'Change a track’s volume (dB), pan (-1..1), mute, solo, or output (master or a group track).',
    mutates: true,
    params: {
      trackId: s('Track ID or name.'),
      volume: n('Volume in dB.', false, { min: -60, max: 6 }),
      pan: n('Pan -1..1.', false, { min: -1, max: 1 }),
      mute: b('Mute.'),
      solo: b('Solo.'),
      output: s('"master" or a group track ID.', false),
    },
    run: (project, p) => {
      const track = requireTrack(project, str(p, 'trackId'))
      if (p.output !== undefined && p.output !== 'master') {
        const group = requireTrack(project, str(p, 'output'))
        if (group.kind !== 'group' || group.id === track.id) throw new StudioError('invalid', 'Output must be "master" or a group track.')
        let cursor: string = group.mixer.output
        while (cursor !== 'master') {
          if (cursor === track.id) throw new StudioError('invalid', 'That routing would create a loop.')
          cursor = project.tracks.find((t) => t.id === cursor)?.mixer.output ?? 'master'
        }
        p = { ...p, output: group.id }
      }
      const { trackId: _ignored, ...patch } = p
      return { project: updateTrack(project, track.id, (t) => ({ ...t, mixer: { ...t.mixer, ...patch } })) }
    },
  },
  {
    type: 'send.set',
    summary: 'Change how much of a track feeds a return, and whether the send is pre- or post-fader.',
    mutates: true,
    params: { trackId: s('Track ID or name.'), returnId: s('Return ID.'), level: n('Send level 0..1.', false, { min: 0, max: 1 }), tap: s('Pre or post fader.', false, { enum: ['pre', 'post'] }) },
    run: (project, p) => {
      const track = requireTrack(project, str(p, 'trackId'))
      const id = str(p, 'returnId')
      if (!project.returns.some((r) => r.id === id)) throw new StudioError('not_found', `No return "${id}".`)
      return {
        project: updateTrack(project, track.id, (t) => {
          const current = t.mixer.sends[id] ?? { level: 0, tap: 'post' as const }
          return { ...t, mixer: { ...t.mixer, sends: { ...t.mixer.sends, [id]: { level: opt<number>(p, 'level') ?? current.level, tap: (opt<'pre' | 'post'>(p, 'tap') ?? current.tap) } } } }
        }),
      }
    },
  },
  {
    type: 'parameter.set',
    summary: 'Set any track parameter by ID (see track.get), for example device.cutoff, voice.kick.tune, insert.filter, or send.delay.',
    mutates: true,
    params: { trackId: s('Track ID or name.'), param: s('Parameter ID.'), value: n('Value in the parameter’s units.') },
    run: (project, p) => {
      const track = requireTrack(project, str(p, 'trackId'))
      const spec = findParamSpec(track, str(p, 'param'))
      if (!spec) throw new StudioError('invalid', `${track.name} has no parameter "${str(p, 'param')}".`)
      return { project: updateTrack(project, track.id, (t) => setParam(t, spec.id, num(p, 'value'))) }
    },
  },
  {
    type: 'device.update',
    summary: 'Change non-numeric device settings: waveform, oscillator source, drum kit, or Sixteen Levels mode.',
    mutates: true,
    params: {
      trackId: s('Track ID or name.'),
      waveform: s('Oscillator waveform.', false, { enum: ['sine', 'triangle', 'sawtooth', 'square'] }),
      source: s('Acid oscillator source.', false, { enum: ['classic', 'designer'] }),
      designerWaveform: s('Designer waveform for Acid Synth.', false, { enum: ['sine', 'triangle', 'sawtooth', 'square'] }),
      kit: s('Drum kit.', false, { enum: ['808', '909'] }),
      sixteenLevels: s('Sampler Sixteen Levels mode.', false, { enum: ['off', 'velocity', 'pitch', 'filter'] }),
    },
    run: (project, p) => {
      const track = requireTrack(project, str(p, 'trackId'))
      const { trackId: _ignored, ...patch } = p
      const allowed: Record<string, string[]> = { acid: ['waveform', 'source', 'designerWaveform'], wave: ['waveform'], drum: ['kit'], sampler: ['sixteenLevels'] }
      const bad = Object.keys(patch).filter((k) => !(allowed[track.kind] ?? []).includes(k))
      if (bad.length) throw new StudioError('invalid', `${track.name} has no ${bad.join(', ')} setting.`)
      if (track.kind === 'acid' && patch.waveform && !['sawtooth', 'square'].includes(String(patch.waveform))) throw new StudioError('invalid', 'Acid Synth waveforms are sawtooth or square.')
      return { project: updateTrack(project, track.id, (t) => ({ ...t, device: { ...t.device, ...patch } as Track['device'] })) }
    },
  },
  {
    type: 'drum.voice.set',
    summary: 'Mute or unmute one drum voice.',
    mutates: true,
    params: { trackId: s('Drum track.'), voice: s('Voice name or alias (kick, bd, ch…).'), mute: b('Mute the voice.', true) },
    run: (project, p) => {
      const track = requireTrack(project, str(p, 'trackId'))
      if (track.device.kind !== 'drum') throw new StudioError('invalid', `${track.name} is not a drum machine.`)
      const voice = resolveDrumVoice(str(p, 'voice'))
      return { project: updateTrack(project, track.id, (t) => (t.device.kind === 'drum' ? { ...t, device: { ...t.device, voices: { ...t.device.voices, [voice]: { ...t.device.voices[voice], mute: Boolean(p.mute) } } } } : t)) }
    },
  },
  {
    type: 'macro.set',
    summary: 'Turn one of a track’s eight macros (0..1); it moves every mapped parameter within its range.',
    mutates: true,
    params: { trackId: s('Track ID or name.'), index: i('Macro 0..7.', true, { min: 0, max: 7 }), value: n('0..1.', true, { min: 0, max: 1 }) },
    run: (project, p) => {
      const track = requireTrack(project, str(p, 'trackId'))
      const macro = track.macros[num(p, 'index')]
      if (!macro) throw new StudioError('not_found', `${track.name} has no macro ${num(p, 'index') + 1}.`)
      const value = num(p, 'value')
      let next = { ...track, macros: track.macros.map((m, idx) => (idx === num(p, 'index') ? { ...m, value } : m)) }
      for (const target of macro.targets) next = setParam(next, target.param, target.min + (target.max - target.min) * value)
      return { project: updateTrack(project, track.id, () => next) }
    },
  },
  {
    type: 'pad.set',
    summary: 'Change a sampler pad: region, pitch, gain, mode, reverse, choke group, envelope, or filter.',
    mutates: true,
    params: {
      trackId: s('Sampler track.'),
      pad: i('Pad 0..15.', true, { min: 0, max: PAD_COUNT - 1 }),
      name: s('Pad name.', false),
      assetId: s('Asset to play.', false),
      start: n('Region start 0..1.', false, { min: 0, max: 1 }),
      end: n('Region end 0..1.', false, { min: 0, max: 1 }),
      pitch: n('Semitones.', false, { min: -24, max: 24 }),
      gain: n('0..1.', false, { min: 0, max: 1 }),
      reverse: b('Play backwards.'),
      mode: s('Playback mode.', false, { enum: ['oneShot', 'loop'] }),
      attack: n('0..1.', false, { min: 0, max: 1 }),
      release: n('0..1.', false, { min: 0, max: 1 }),
      choke: i('Choke group 1..8, or 0 for none.', false, { min: 0, max: 8 }),
      filter: n('Low-pass 0..1.', false, { min: 0, max: 1 }),
    },
    run: (project, p) => {
      const track = requireTrack(project, str(p, 'trackId'))
      if (track.device.kind !== 'sampler') throw new StudioError('invalid', `${track.name} is not a sampler.`)
      if (p.assetId !== undefined && !project.assets[str(p, 'assetId')]) throw new StudioError('not_found', `No asset "${str(p, 'assetId')}".`)
      const { trackId: _t, pad: index, choke, ...patch } = p
      const update: Partial<PadState> = { ...(patch as Partial<PadState>), ...(choke !== undefined && { choke: Number(choke) || null }) }
      return {
        project: updateTrack(project, track.id, (t) =>
          t.device.kind === 'sampler' ? { ...t, device: { ...t.device, pads: t.device.pads.map((pad, idx) => (idx === index ? { ...pad, ...update } : pad)) } } : t,
        ),
      }
    },
  },
  {
    type: 'deck.set',
    summary: 'Load audio into a deck or change its gain, pitch, filter, loop, or cue point.',
    mutates: true,
    params: {
      trackId: s('Deck track.'),
      assetId: s('Asset to load.', false),
      gain: n('0..1.', false, { min: 0, max: 1 }),
      pitch: n('Semitones.', false, { min: -12, max: 12 }),
      filter: n('-1 high-pass .. 1 low-pass.', false, { min: -1, max: 1 }),
      loop: b('Loop playback.'),
      loopStart: n('Seconds.', false, { min: 0 }),
      loopEnd: n('Seconds; 0 loops the whole file.', false, { min: 0 }),
      cue: n('Cue point in seconds.', false, { min: 0 }),
    },
    run: (project, p) => {
      const track = requireTrack(project, str(p, 'trackId'))
      if (track.device.kind !== 'deck') throw new StudioError('invalid', `${track.name} is not a deck.`)
      if (p.assetId !== undefined && !project.assets[str(p, 'assetId')]) throw new StudioError('not_found', `No asset "${str(p, 'assetId')}".`)
      const { trackId: _t, ...patch } = p
      return { project: updateTrack(project, track.id, (t) => (t.device.kind === 'deck' ? { ...t, device: { ...t.device, ...patch } } : t)) }
    },
  },
  {
    type: 'sample.slice',
    summary: 'Set the sampler’s source asset and slice points (normalized 0..1 positions). Optionally assign slices to pads.',
    mutates: true,
    params: {
      trackId: s('Sampler track.'),
      assetId: s('Source asset.', false),
      slices: { type: 'array', description: 'Slice start positions 0..1.', required: true, items: { type: 'number', description: 'Position.' } },
      mode: s('How the slices were made.', false, { enum: ['transient', 'equal', 'beat', 'bar', 'manual'] }),
      bpm: n('Detected tempo.', false),
      bpmConfidence: n('0..1.', false, { min: 0, max: 1 }),
      bars: n('Length in bars.', false),
      assignPads: b('Map slice N to pad N.'),
    },
    run: (project, p) => {
      const track = requireTrack(project, str(p, 'trackId'))
      if (track.device.kind !== 'sampler') throw new StudioError('invalid', `${track.name} is not a sampler.`)
      const assetId = opt<string>(p, 'assetId') ?? track.device.source?.assetId
      if (!assetId || !project.assets[assetId]) throw new StudioError('not_found', 'The sampler has no source audio. Pass assetId.')
      const slices = [...new Set((p.slices as number[]).map((x) => clamp(Number(x), 0, 0.999)))].sort((a, z) => a - z)
      if (!slices.length || slices.length > 64) throw new StudioError('invalid', 'Give 1–64 slice positions.')
      if (slices[0] > 0) slices.unshift(0)
      const source = { assetId, slices, sliceMode: opt<'manual'>(p, 'mode') ?? 'manual', bpm: opt<number>(p, 'bpm') ?? track.device.source?.bpm ?? null, bpmConfidence: opt<number>(p, 'bpmConfidence') ?? 0, bars: opt<number>(p, 'bars') ?? track.device.source?.bars ?? null }
      const pads = p.assignPads
        ? track.device.pads.map((pad, idx) => (idx < slices.length ? { ...pad, name: `Slice ${idx + 1}`, assetId, start: slices[idx], end: slices[idx + 1] ?? 1 } : pad))
        : track.device.pads
      return { project: updateTrack(project, track.id, (t) => (t.device.kind === 'sampler' ? { ...t, device: { ...t.device, source, pads } } : t)) }
    },
  },
  {
    type: 'asset.add',
    summary: 'Register an audio asset that the host has stored. Hosts call this after decoding a file.',
    mutates: true,
    params: { asset: o('Asset record: id, name, mimeType, bytes, duration, channels, sampleRate, origin.') },
    run: (project, p) => {
      const asset = p.asset as StudioProject['assets'][string]
      if (!asset?.id || typeof asset.duration !== 'number') throw new StudioError('invalid', 'Assets need an id and a duration.')
      return { project: { ...project, assets: { ...project.assets, [asset.id]: asset } }, result: { assetId: asset.id } }
    },
  },

  // Patterns ------------------------------------------------------------------
  {
    type: 'pattern.create',
    summary: 'Create an empty pattern for a track (not placed in the arrangement).',
    mutates: true,
    params: { trackId: s('Track ID or name.'), name: s('Pattern name.', false), length: i('Steps 1..64.', false, { min: 1, max: 64 }) },
    run: (project, p) => {
      const track = requireTrack(project, str(p, 'trackId'))
      const pattern = createPatternFor(track, opt<string>(p, 'name') ?? `${track.name} pattern`, opt<number>(p, 'length') ?? 16)
      if (!pattern) throw new StudioError('invalid', `${track.name} does not play patterns.`)
      return { project: { ...project, patterns: { ...project.patterns, [pattern.id]: pattern } }, result: { patternId: pattern.id } }
    },
  },
  {
    type: 'pattern.write',
    summary:
      'Write a pattern from text. Notes: space-separated names like "C2 . D#2! C3~" (! accent, ~ slide, . rest). Drums: pass voice and a step string like "X...x...X...x..." (X accent). Give patternId, or trackId to use that track’s pattern.',
    mutates: true,
    params: { patternId: s('Pattern ID.', false), trackId: s('Track ID or name; uses its pattern.', false), voice: s('Drum voice for drum patterns.', false), steps: s('Notation.') },
    run: (project, p) => {
      let next = project
      let patternId = opt<string>(p, 'patternId')
      if (!patternId) {
        if (!opt<string>(p, 'trackId')) throw new StudioError('invalid', 'Give patternId or trackId.')
        const found = patternForTrack(project, str(p, 'trackId'))
        next = found.project
        patternId = found.patternId
      }
      const pattern = requirePattern(next, patternId)
      if (pattern.kind === 'notes') {
        const steps = parseNoteNotation(str(p, 'steps'), pattern.steps[0]?.note)
        return { project: updatePattern(next, patternId, (pt) => ({ ...(pt as NotePattern), length: steps.length, steps })), result: { patternId } }
      }
      if (pattern.kind === 'drums') {
        if (!opt<string>(p, 'voice')) throw new StudioError('invalid', 'Drum patterns need a voice, for example "kick".')
        const voice = resolveDrumVoice(str(p, 'voice'))
        const lane = parseDrumNotation(str(p, 'steps'))
        return {
          project: updatePattern(next, patternId, (pt) => {
            const sized = lane.length > pt.length ? resizePattern(pt, lane.length) : pt
            if (sized.kind !== 'drums') return sized
            return { ...sized, lanes: { ...sized.lanes, [voice]: Array.from({ length: sized.length }, (_, idx) => lane[idx] ?? { ...sized.lanes[voice][idx], on: false }) } }
          }),
          result: { patternId },
        }
      }
      throw new StudioError('invalid', 'Pad patterns are written with pad.hit.')
    },
  },
  {
    type: 'pattern.update',
    summary: 'Rename a pattern, change its length (1..64 steps), step division, or swing override.',
    mutates: true,
    params: { patternId: s('Pattern ID.'), name: s('Name.', false), length: i('Steps.', false, { min: 1, max: 64 }), division: i('Steps per bar: 4, 8, 16, 32, or 64.', false, { min: 4, max: 64 }), swing: n('Swing override, or -1 to inherit.', false, { min: -1, max: 0.75 }) },
    run: (project, p) => {
      const id = str(p, 'patternId')
      requirePattern(project, id)
      if (p.division !== undefined && ![4, 8, 16, 32, 64].includes(num(p, 'division'))) throw new StudioError('invalid', 'Division must be 4, 8, 16, 32, or 64 steps per bar.')
      return {
        project: updatePattern(project, id, (pt) => {
          let next = p.length !== undefined ? resizePattern(pt, num(p, 'length')) : pt
          if (p.name !== undefined) next = { ...next, name: String(p.name).slice(0, 40) }
          if (p.division !== undefined) next = { ...next, division: num(p, 'division') }
          if (p.swing !== undefined) next = { ...next, swing: num(p, 'swing') < 0 ? null : num(p, 'swing') }
          return next
        }),
      }
    },
  },
  {
    type: 'step.set',
    summary: 'Edit one step of a note pattern: on, note, velocity, accent, slide, probability, ratchet, micro, or parameter locks.',
    mutates: true,
    params: {
      patternId: s('Pattern ID.'),
      index: i('Step index (0-based).', true, { min: 0, max: 63 }),
      on: b('Step plays.'),
      note: i('MIDI note.', false, { min: 0, max: 127 }),
      velocity: i('1..127.', false, { min: 1, max: 127 }),
      accent: b('Accent.'),
      slide: b('Slide into the next step.'),
      probability: i('0..100%.', false, { min: 0, max: 100 }),
      ratchet: i('1..4 repeats.', false, { min: 1, max: 4 }),
      micro: n('Timing offset -0.5..0.5 steps.', false, { min: -0.5, max: 0.5 }),
      locks: o('Parameter locks {paramId: value}. Use null values to remove.', false),
    },
    run: (project, p) => {
      const id = str(p, 'patternId')
      const pattern = requirePattern(project, id)
      if (pattern.kind !== 'notes') throw new StudioError('invalid', 'step.set edits note patterns. Use drum.step.set or pad.hit for others.')
      const index = num(p, 'index')
      if (index >= pattern.length) throw new StudioError('invalid', `Step ${index + 1} is beyond the ${pattern.length}-step pattern.`)
      const { patternId: _p, index: _i, locks, ...patch } = p
      return {
        project: updatePattern(project, id, (pt) =>
          pt.kind !== 'notes' ? pt : { ...pt, steps: pt.steps.map((st, idx) => (idx === index ? { ...st, ...patch, locks: mergeLocks(st.locks, locks as Record<string, number | null> | undefined) } : st)) },
        ),
      }
    },
  },
  {
    type: 'drum.step.set',
    summary: 'Edit one drum hit: on, velocity, accent, probability, ratchet, micro, or locks.',
    mutates: true,
    params: {
      patternId: s('Pattern ID.'),
      voice: s('Drum voice.'),
      index: i('Step index.', true, { min: 0, max: 63 }),
      on: b('Hit plays.'),
      velocity: i('1..127.', false, { min: 1, max: 127 }),
      accent: b('Accent.'),
      probability: i('0..100%.', false, { min: 0, max: 100 }),
      ratchet: i('1..4.', false, { min: 1, max: 4 }),
      micro: n('-0.5..0.5 steps.', false, { min: -0.5, max: 0.5 }),
      locks: o('Parameter locks.', false),
    },
    run: (project, p) => {
      const id = str(p, 'patternId')
      const pattern = requirePattern(project, id)
      if (pattern.kind !== 'drums') throw new StudioError('invalid', 'drum.step.set edits drum patterns.')
      const voice = resolveDrumVoice(str(p, 'voice'))
      const index = num(p, 'index')
      if (index >= pattern.length) throw new StudioError('invalid', `Step ${index + 1} is beyond the ${pattern.length}-step pattern.`)
      const { patternId: _p, voice: _v, index: _i, locks, ...patch } = p
      return {
        project: updatePattern(project, id, (pt) =>
          pt.kind !== 'drums' ? pt : { ...pt, lanes: { ...pt.lanes, [voice]: pt.lanes[voice].map((h, idx) => (idx === index ? { ...h, ...patch, locks: mergeLocks(h.locks, locks as Record<string, number | null> | undefined) } : h)) } },
        ),
      }
    },
  },
  {
    type: 'pad.hit',
    summary: 'Add, change, or remove a pad hit in a pad pattern.',
    mutates: true,
    params: {
      patternId: s('Pattern ID.'),
      step: i('Step.', true, { min: 0, max: 63 }),
      pad: i('Pad 0..15.', true, { min: 0, max: 15 }),
      velocity: i('1..127; 0 removes the hit.', false, { min: 0, max: 127 }),
      probability: i('0..100%.', false, { min: 0, max: 100 }),
      ratchet: i('1..4.', false, { min: 1, max: 4 }),
      micro: n('-0.5..0.5 steps.', false, { min: -0.5, max: 0.5 }),
    },
    run: (project, p) => {
      const id = str(p, 'patternId')
      const pattern = requirePattern(project, id)
      if (pattern.kind !== 'pads') throw new StudioError('invalid', 'pad.hit edits pad patterns.')
      const step = num(p, 'step')
      const pad = num(p, 'pad')
      if (step >= pattern.length) throw new StudioError('invalid', `Step ${step + 1} is beyond the ${pattern.length}-step pattern.`)
      const velocity = opt<number>(p, 'velocity') ?? 100
      const hits = pattern.hits.filter((h) => !(h.step === step && h.pad === pad))
      if (velocity > 0) hits.push({ step, pad, velocity, probability: opt<number>(p, 'probability') ?? 100, ratchet: opt<number>(p, 'ratchet') ?? 1, micro: opt<number>(p, 'micro') ?? 0, locks: {} } satisfies PadHit)
      hits.sort((a, z) => a.step - z.step || a.pad - z.pad)
      return { project: updatePattern(project, id, (pt) => (pt.kind === 'pads' ? { ...pt, hits } : pt)) }
    },
  },
  {
    type: 'pad.record',
    summary: 'Replace a pad pattern’s hits with a recorded performance.',
    mutates: true,
    params: { patternId: s('Pattern ID.'), hits: { type: 'array', description: 'Hits {step, pad, velocity, micro}.', required: true, items: { type: 'object', description: 'Hit.' } }, length: i('Pattern length in steps.', false, { min: 1, max: 64 }) },
    run: (project, p) => {
      const id = str(p, 'patternId')
      const pattern = requirePattern(project, id)
      if (pattern.kind !== 'pads') throw new StudioError('invalid', 'pad.record writes pad patterns.')
      const length = opt<number>(p, 'length') ?? pattern.length
      const hits = (p.hits as PadHit[])
        .filter((h) => h.step >= 0 && h.step < length && h.pad >= 0 && h.pad < PAD_COUNT)
        .map((h) => ({ step: Math.round(h.step), pad: Math.round(h.pad), velocity: clamp(h.velocity ?? 100, 1, 127), probability: clamp(h.probability ?? 100, 0, 100), ratchet: clamp(Math.round(h.ratchet ?? 1), 1, 4), micro: clamp(h.micro ?? 0, -0.5, 0.5), locks: {} }))
      return { project: updatePattern(project, id, (pt) => (pt.kind === 'pads' ? { ...pt, length, hits } : pt)) }
    },
  },

  // Arrangement ---------------------------------------------------------------
  {
    type: 'clip.create',
    summary: 'Place a clip on a track. Without a patternId or assetId, a new empty pattern is created.',
    mutates: true,
    params: { trackId: s('Track ID or name.'), start: n('Start bar (0-based).', true, { min: 0 }), length: n('Length in bars.', true, { min: 0.0625 }), patternId: s('Existing pattern to link.', false), assetId: s('Audio asset for audio tracks.', false), name: s('Name for a new pattern.', false) },
    run: (project, p) => {
      const result = createClip(project, str(p, 'trackId'), num(p, 'start'), num(p, 'length'), { patternId: opt(p, 'patternId'), assetId: opt(p, 'assetId'), patternName: opt(p, 'name') })
      return { project: result.project, result: { clipId: result.clip.id, patternId: result.clip.patternId } }
    },
  },
  {
    type: 'clip.move',
    summary: 'Move a clip to a new start bar, and optionally to another track of the same type.',
    mutates: true,
    params: { clipId: s('Clip ID.'), start: n('Start bar (0-based).', true, { min: 0 }), trackId: s('Destination track.', false) },
    run: (project, p) => ({ project: moveClip(project, str(p, 'clipId'), num(p, 'start'), opt<string>(p, 'trackId') ? requireTrack(project, str(p, 'trackId')).id : undefined) }),
  },
  {
    type: 'clip.resize',
    summary: 'Change a clip’s length in bars. Patterns loop to fill it.',
    mutates: true,
    params: { clipId: s('Clip ID.'), length: n('Bars.', true, { min: 0.0625 }) },
    run: (project, p) => ({ project: resizeClip(project, str(p, 'clipId'), num(p, 'length')) }),
  },
  {
    type: 'clip.duplicate',
    summary: 'Duplicate a clip as a linked repeat (same pattern), right after it or at a given bar.',
    mutates: true,
    params: { clipId: s('Clip ID.'), start: n('Start bar for the copy.', false, { min: 0 }) },
    run: (project, p) => {
      const result = duplicateClip(project, str(p, 'clipId'), opt(p, 'start'))
      return { project: result.project, result: { clipId: result.clip.id } }
    },
  },
  {
    type: 'clip.delete',
    summary: 'Delete a clip. Its pattern is removed only if nothing else uses it.',
    mutates: true,
    params: { clipId: s('Clip ID.') },
    run: (project, p) => ({ project: deleteClip(project, str(p, 'clipId')) }),
  },
  {
    type: 'clip.makeUnique',
    summary: 'Give a linked clip its own copy of the pattern so edits affect only it.',
    mutates: true,
    params: { clipId: s('Clip ID.') },
    run: (project, p) => {
      const result = makeUnique(project, str(p, 'clipId'))
      return { project: result.project, result: { patternId: result.patternId } }
    },
  },
  {
    type: 'clip.split',
    summary: 'Split a clip at a bar position.',
    mutates: true,
    params: { clipId: s('Clip ID.'), at: n('Bar position inside the clip.') },
    run: (project, p) => {
      const result = splitClip(project, str(p, 'clipId'), num(p, 'at'))
      return { project: result.project, result: { clipId: result.right.id } }
    },
  },
  {
    type: 'clip.set',
    summary: 'Change a clip’s gain (dB), transpose (semitones), mute, offset, or fades.',
    mutates: true,
    params: {
      clipId: s('Clip ID.'),
      gain: n('dB.', false, { min: -60, max: 12 }),
      transpose: i('Semitones.', false, { min: -24, max: 24 }),
      mute: b('Mute this clip.'),
      offset: n('Bars into the source.', false, { min: 0 }),
      fadeIn: n('Bars.', false, { min: 0 }),
      fadeOut: n('Bars.', false, { min: 0 }),
    },
    run: (project, p) => {
      const clip = requireClip(project, str(p, 'clipId'))
      const { clipId: _c, ...patch } = p
      return { project: updateClip(project, clip.id, (c) => ({ ...c, ...(patch as Partial<Clip>) })) }
    },
  },
  {
    type: 'time.insert',
    summary: 'Insert empty bars. Later clips, sections, and automation move right; nothing is appended to the end.',
    mutates: true,
    params: { at: n('Bar position (0-based).', true, { min: 0 }), bars: n('Bars to insert.', true, { min: 0.25, max: 256 }), name: s('Name for the new section.', false) },
    run: (project, p) => {
      const result = insertTime(project, num(p, 'at'), num(p, 'bars'), opt(p, 'name'))
      return { project: result.project, result: { sectionId: result.sectionId } }
    },
  },
  {
    type: 'time.delete',
    summary: 'Remove a range of bars; later material moves left.',
    mutates: true,
    params: { at: n('Bar position (0-based).', true, { min: 0 }), bars: n('Bars to remove.', true, { min: 0.25 }) },
    run: (project, p) => ({ project: deleteTime(project, num(p, 'at'), num(p, 'bars')) }),
  },
  {
    type: 'section.add',
    summary: 'Add a named section marker.',
    mutates: true,
    params: { start: n('Start bar (0-based).', true, { min: 0 }), length: n('Bars.', true, { min: 0.25 }), name: s('Name.'), color: s('Hex color.', false) },
    run: (project, p) => {
      const section = { id: newId('sec'), name: str(p, 'name'), start: num(p, 'start'), length: num(p, 'length'), color: opt<string>(p, 'color') ?? '#6d7a6f' }
      return { project: fitLength({ ...project, sections: [...project.sections, section].sort((a, z) => a.start - z.start) }), result: { sectionId: section.id } }
    },
  },
  {
    type: 'section.update',
    summary: 'Rename, recolor, move, or resize a section marker.',
    mutates: true,
    params: { sectionId: s('Section ID.'), name: s('Name.', false), color: s('Color.', false), start: n('Start bar.', false, { min: 0 }), length: n('Bars.', false, { min: 0.25 }) },
    run: (project, p) => {
      const id = str(p, 'sectionId')
      if (!project.sections.some((sec) => sec.id === id)) throw new StudioError('not_found', `No section "${id}".`)
      const { sectionId: _s, ...patch } = p
      return { project: fitLength({ ...project, sections: project.sections.map((sec) => (sec.id === id ? { ...sec, ...patch } : sec)).sort((a, z) => a.start - z.start) }) }
    },
  },
  {
    type: 'section.remove',
    summary: 'Remove a section marker. Clips are not affected.',
    mutates: true,
    params: { sectionId: s('Section ID.') },
    run: (project, p) => ({ project: { ...project, sections: project.sections.filter((sec) => sec.id !== str(p, 'sectionId')) } }),
  },
  {
    type: 'scene.add',
    summary: 'Add a scene (a column in Build view).',
    mutates: true,
    params: { name: s('Scene name.', false), slots: o('{trackId: patternId}.', false) },
    run: (project, p) => {
      const scene = { id: newId('scn'), name: opt<string>(p, 'name') ?? `Scene ${project.scenes.length + 1}`, slots: (opt<Record<string, string | null>>(p, 'slots') ?? {}) }
      for (const [trackId, patternId] of Object.entries(scene.slots)) {
        requireTrack(project, trackId)
        if (patternId) requirePattern(project, patternId)
      }
      return { project: { ...project, scenes: [...project.scenes, scene] }, result: { sceneId: scene.id } }
    },
  },
  {
    type: 'scene.set',
    summary: 'Set which pattern a track plays in a scene, rename it, or clear the slot with patternId null.',
    mutates: true,
    params: { sceneId: s('Scene ID.'), trackId: s('Track ID.', false), patternId: s('Pattern ID or empty to clear.', false), name: s('Rename the scene.', false) },
    run: (project, p) => {
      const id = str(p, 'sceneId')
      if (!project.scenes.some((sc) => sc.id === id)) throw new StudioError('not_found', `No scene "${id}".`)
      const track = opt<string>(p, 'trackId') ? requireTrack(project, str(p, 'trackId')) : null
      const patternId = opt<string>(p, 'patternId') || null
      if (patternId) requirePattern(project, patternId)
      return {
        project: {
          ...project,
          scenes: project.scenes.map((sc) => (sc.id !== id ? sc : { ...sc, ...(p.name !== undefined && { name: String(p.name) }), slots: track ? { ...sc.slots, [track.id]: patternId } : sc.slots })),
        },
      }
    },
  },
  {
    type: 'scene.remove',
    summary: 'Remove a scene.',
    mutates: true,
    params: { sceneId: s('Scene ID.') },
    run: (project, p) => ({ project: { ...project, scenes: project.scenes.filter((sc) => sc.id !== str(p, 'sceneId')) } }),
  },
  {
    type: 'scene.record',
    summary: 'Write scene launches into the arrangement: each entry places that scene’s patterns at a bar.',
    mutates: true,
    params: { launches: { type: 'array', description: 'Entries {sceneId, start, length} in bars.', required: true, items: { type: 'object', description: 'Launch.' } } },
    run: (project, p) => {
      let next = project
      for (const launch of p.launches as { sceneId: string; start: number; length: number }[]) {
        const scene = next.scenes.find((sc) => sc.id === launch.sceneId)
        if (!scene) throw new StudioError('not_found', `No scene "${launch.sceneId}".`)
        for (const [trackId, patternId] of Object.entries(scene.slots)) {
          if (!patternId || !next.tracks.some((t) => t.id === trackId)) continue
          next = createClip(next, trackId, launch.start, launch.length, { patternId }).project
        }
      }
      return { project: next }
    },
  },
  {
    type: 'automation.write',
    summary: 'Write arrangement automation points for a parameter. Optionally replace a bar range first.',
    mutates: true,
    params: {
      trackId: s('Track ID or name.'),
      param: s('Parameter ID.'),
      points: { type: 'array', description: 'Points {bar, value, curve?: "linear"|"hold"}; bar is 0-based and may be fractional.', required: true, items: { type: 'object', description: 'Point.' } },
      from: n('Replace range start (bar).', false),
      to: n('Replace range end (bar).', false),
    },
    run: (project, p) => {
      const track = requireTrack(project, str(p, 'trackId'))
      const spec = findParamSpec(track, str(p, 'param'))
      if (!spec) throw new StudioError('invalid', `${track.name} has no parameter "${str(p, 'param')}".`)
      const points = (p.points as AutomationPoint[]).map((pt) => ({ bar: Number(pt.bar), value: clamp(Number(pt.value), spec.min, spec.max), curve: pt.curve === 'hold' ? ('hold' as const) : ('linear' as const) }))
      if (points.some((pt) => !Number.isFinite(pt.bar) || !Number.isFinite(pt.value))) throw new StudioError('invalid', 'Points need numeric bar and value.')
      const range = p.from !== undefined && p.to !== undefined ? ([num(p, 'from'), num(p, 'to')] as [number, number]) : undefined
      return { project: writeAutomation(project, track.id, spec.id, points, range) }
    },
  },
  {
    type: 'automation.clear',
    summary: 'Clear automation for a parameter, entirely or within a bar range.',
    mutates: true,
    params: { trackId: s('Track ID or name.'), param: s('Parameter ID.'), from: n('Range start.', false), to: n('Range end.', false) },
    run: (project, p) => {
      const track = requireTrack(project, str(p, 'trackId'))
      const range = p.from !== undefined && p.to !== undefined ? ([num(p, 'from'), num(p, 'to')] as [number, number]) : undefined
      return { project: clearAutomation(project, track.id, str(p, 'param'), range) }
    },
  },
]

function mergeLocks(current: Record<string, number>, patch: Record<string, number | null> | undefined): Record<string, number> {
  if (!patch) return current
  const next = { ...current }
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === undefined) delete next[key]
    else if (Number.isFinite(Number(value))) next[key] = Number(value)
  }
  return next
}

export const COMMANDS: ReadonlyMap<string, CommandSpec> = new Map(SPECS.map((spec) => [spec.type, spec]))

export function validateParams(spec: CommandSpec, params: Record<string, unknown> = {}): Record<string, unknown> {
  const unknown = Object.keys(params).filter((key) => !(key in spec.params))
  if (unknown.length) throw new StudioError('invalid', `${spec.type} does not take ${unknown.join(', ')}.`)
  for (const [key, field] of Object.entries(spec.params)) {
    const value = params[key]
    if (value === undefined || value === null) {
      if (field.required) throw new StudioError('invalid', `${spec.type} needs ${key}: ${field.description}`)
      continue
    }
    checkField(spec.type, key, field, value)
  }
  return params
}

function checkField(type: string, key: string, field: FieldSpec, value: unknown): void {
  const fail = (why: string) => {
    throw new StudioError('invalid', `${type}: ${key} ${why}.`)
  }
  switch (field.type) {
    case 'string':
      if (typeof value !== 'string') fail('must be text')
      if (field.enum && !field.enum.includes(value as string)) fail(`must be one of ${field.enum.join(', ')}`)
      break
    case 'number':
    case 'integer':
      if (typeof value !== 'number' || !Number.isFinite(value)) fail('must be a number')
      if (field.type === 'integer' && !Number.isInteger(value)) fail('must be a whole number')
      if (field.min !== undefined && (value as number) < field.min) fail(`must be at least ${field.min}`)
      if (field.max !== undefined && (value as number) > field.max) fail(`must be at most ${field.max}`)
      break
    case 'boolean':
      if (typeof value !== 'boolean') fail('must be true or false')
      break
    case 'object':
      if (typeof value !== 'object' || Array.isArray(value)) fail('must be an object')
      break
    case 'array':
      if (!Array.isArray(value)) fail('must be a list')
      if (field.items && field.items.type !== 'object') (value as unknown[]).forEach((item, idx) => checkField(type, `${key}[${idx}]`, field.items!, item))
      break
  }
}

export interface ExecuteResult {
  project: StudioProject
  results: unknown[]
  changed: boolean
}

export interface BatchOptions {
  origin?: Origin
  label?: string
  /** Rejects the batch when the project moved on since the caller read it. */
  expectedRevision?: number
  at?: string
}

/**
 * Runs commands as one atomic batch: if any command fails, none apply.
 * Mutating batches bump the revision once and append one audit entry.
 */
export function executeBatch(project: StudioProject, commands: Command[], options: BatchOptions = {}): ExecuteResult {
  if (options.expectedRevision !== undefined && options.expectedRevision !== project.revision) {
    throw new StudioError('conflict', `The project changed (revision ${project.revision}, expected ${options.expectedRevision}). Read it again and retry.`)
  }
  let next = project
  const results: unknown[] = []
  let mutated = false
  for (const command of commands) {
    const spec = COMMANDS.get(command.type)
    if (!spec) throw new StudioError('invalid', `Unknown command "${command.type}".`)
    const params = validateParams(spec, command.params ?? {})
    const outcome = spec.run(next, params)
    next = outcome.project
    results.push(outcome.result ?? null)
    mutated ||= spec.mutates
  }
  if (!mutated) return { project, results, changed: false }
  const revision = project.revision + 1
  const entry = {
    id: newId('aud'),
    at: options.at ?? new Date().toISOString(),
    origin: options.origin ?? 'manual',
    label: options.label ?? commands.map((c) => c.type).join(', '),
    commands: commands.map((c) => c.type),
    revision,
  }
  return { project: { ...next, revision, audit: [...next.audit.slice(-199), entry] }, results, changed: true }
}

export const execute = (project: StudioProject, command: Command, options: BatchOptions = {}) => executeBatch(project, [command], options)

/** JSON Schema for one command's parameters, for MCP and HTTP clients. */
export function commandJsonSchema(spec: CommandSpec): Record<string, unknown> {
  const toSchema = (field: FieldSpec): Record<string, unknown> => ({
    type: field.type,
    description: field.description,
    ...(field.enum && { enum: field.enum }),
    ...(field.min !== undefined && { minimum: field.min }),
    ...(field.max !== undefined && { maximum: field.max }),
    ...(field.items && { items: toSchema(field.items) }),
  })
  return {
    type: 'object',
    properties: Object.fromEntries(Object.entries(spec.params).map(([key, field]) => [key, toSchema(field)])),
    required: Object.entries(spec.params).filter(([, field]) => field.required).map(([key]) => key),
    additionalProperties: false,
  }
}

export function listCommands(): { type: string; summary: string; mutates: boolean; schema: Record<string, unknown> }[] {
  return SPECS.map((spec) => ({ type: spec.type, summary: spec.summary, mutates: spec.mutates, schema: commandJsonSchema(spec) }))
}

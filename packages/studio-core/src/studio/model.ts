// RE:BORN v2 project model. Every object has a stable ID; arrays are only
// used for ordered collections (tracks, clips, points). Values are stored in
// natural units (dB, semitones, seconds) or normalized 0..1 as each
// parameter's spec declares.

export const STUDIO_SCHEMA = 'reborn-studio'
export const STUDIO_VERSION = 1

export type TrackKind = 'acid' | 'wave' | 'drum' | 'sampler' | 'audio' | 'deck' | 'group'
export type Waveform = 'sine' | 'triangle' | 'sawtooth' | 'square'
export type Origin = 'manual' | 'script' | 'agent'

export const DRUM_VOICES = ['kick', 'snare', 'clap', 'closedHat', 'openHat', 'lowTom', 'midTom', 'highTom', 'rim', 'cowbell'] as const
export type DrumVoiceName = (typeof DRUM_VOICES)[number]
export const DRUM_VOICE_LABELS: Record<DrumVoiceName, string> = {
  kick: 'BD',
  snare: 'SD',
  clap: 'CP',
  closedHat: 'CH',
  openHat: 'OH',
  lowTom: 'LT',
  midTom: 'MT',
  highTom: 'HT',
  rim: 'RS',
  cowbell: 'CB',
}

export const PAD_COUNT = 16

export interface Send {
  level: number
  tap: 'pre' | 'post'
}

export interface MixerState {
  volume: number
  pan: number
  mute: boolean
  solo: boolean
  sends: Record<string, Send>
  /** 'master' or the ID of a group track. */
  output: string
}

export interface InsertState {
  eqLow: number
  eqMid: number
  eqHigh: number
  /** Bipolar DJ filter: negative is high-pass, positive is low-pass. */
  filter: number
  drive: number
}

export interface MacroTarget {
  param: string
  min: number
  max: number
}

export interface Macro {
  name: string
  value: number
  targets: MacroTarget[]
}

export interface AcidDevice {
  kind: 'acid'
  source: 'classic' | 'designer'
  waveform: 'sawtooth' | 'square'
  designerWaveform: Waveform
  spread: number
  tune: number
  cutoff: number
  resonance: number
  envMod: number
  decay: number
  accent: number
  drive: number
  level: number
}

export interface WaveDevice {
  kind: 'wave'
  waveform: Waveform
  spread: number
  tune: number
  cutoff: number
  resonance: number
  attack: number
  release: number
  drive: number
  level: number
}

export interface DrumVoiceState {
  level: number
  tone: number
  decay: number
  tune: number
  pan: number
  mute: boolean
}

export interface DrumDevice {
  kind: 'drum'
  kit: '808' | '909'
  level: number
  voices: Record<DrumVoiceName, DrumVoiceState>
}

export interface PadState {
  name: string
  assetId: string | null
  /** Normalized region of the asset, 0..1. */
  start: number
  end: number
  pitch: number
  gain: number
  reverse: boolean
  mode: 'oneShot' | 'loop'
  attack: number
  release: number
  /** Pads in the same choke group cut each other off. */
  choke: number | null
  filter: number
}

export interface SamplerSource {
  assetId: string
  slices: number[]
  sliceMode: 'transient' | 'equal' | 'beat' | 'bar' | 'manual'
  bpm: number | null
  bpmConfidence: number
  bars: number | null
}

export interface SamplerDevice {
  kind: 'sampler'
  level: number
  drive: number
  crush: number
  sixteenLevels: 'off' | 'velocity' | 'pitch' | 'filter'
  source: SamplerSource | null
  pads: PadState[]
}

export interface DeckDevice {
  kind: 'deck'
  assetId: string | null
  gain: number
  pitch: number
  filter: number
  loop: boolean
  loopStart: number
  loopEnd: number
  cue: number
}

export interface AudioDevice {
  kind: 'audio'
}

export interface GroupDevice {
  kind: 'group'
}

export type Device = AcidDevice | WaveDevice | DrumDevice | SamplerDevice | DeckDevice | AudioDevice | GroupDevice

export interface Track {
  id: string
  name: string
  color: string
  kind: TrackKind
  device: Device
  inserts: InsertState
  mixer: MixerState
  macros: Macro[]
}

export type ParamLocks = Record<string, number>

export interface NoteStep {
  on: boolean
  note: number
  velocity: number
  accent: boolean
  slide: boolean
  probability: number
  ratchet: number
  /** Microtiming in steps, -0.5..0.5. */
  micro: number
  locks: ParamLocks
}

export interface DrumHit {
  on: boolean
  velocity: number
  accent: boolean
  probability: number
  ratchet: number
  micro: number
  locks: ParamLocks
}

export interface PadHit {
  step: number
  pad: number
  velocity: number
  probability: number
  ratchet: number
  micro: number
  locks: ParamLocks
}

interface PatternBase {
  id: string
  name: string
  /** Steps in one cycle, 1..64. */
  length: number
  /** Steps per bar: 4, 8, 16, 32, or 64. */
  division: number
  /** Per-pattern swing (0..0.75). Null inherits the project swing. */
  swing: number | null
}

export interface NotePattern extends PatternBase {
  kind: 'notes'
  steps: NoteStep[]
}

export interface DrumPattern extends PatternBase {
  kind: 'drums'
  lanes: Record<DrumVoiceName, DrumHit[]>
}

export interface PadPattern extends PatternBase {
  kind: 'pads'
  hits: PadHit[]
}

export type Pattern = NotePattern | DrumPattern | PadPattern

export interface Clip {
  id: string
  trackId: string
  patternId: string | null
  assetId: string | null
  /** Bars from song start. */
  start: number
  length: number
  /** Bars into the pattern (or seconds-aligned bars into audio) where playback begins. */
  offset: number
  gain: number
  transpose: number
  mute: boolean
  /** Fades in bars, audio clips only. */
  fadeIn: number
  fadeOut: number
}

export interface Section {
  id: string
  name: string
  start: number
  length: number
  color: string
}

export interface Scene {
  id: string
  name: string
  /** Pattern each track plays when the scene launches; missing means stop. */
  slots: Record<string, string | null>
}

export type CurveShape = 'linear' | 'hold'

export interface AutomationPoint {
  bar: number
  value: number
  curve: CurveShape
}

export interface AutomationLane {
  id: string
  trackId: string
  param: string
  points: AutomationPoint[]
}

export interface DelayReturn {
  id: string
  kind: 'delay'
  name: string
  level: number
  mute: boolean
  /** Delay time in beats. */
  time: number
  feedback: number
  tone: number
}

export interface ReverbReturn {
  id: string
  kind: 'reverb'
  name: string
  level: number
  mute: boolean
  decay: number
  tone: number
}

export type ReturnBus = DelayReturn | ReverbReturn

export interface MasterState {
  volume: number
  /** True-peak-aware output ceiling in dBFS. */
  ceiling: number
  drive: number
  compress: number
  soften: number
  fxSafeBypass: boolean
}

export interface AssetOrigin {
  kind: 'import' | 'resample' | 'v1' | 'builtin' | 'generated'
  /** Original file name, builtin key, or generator. */
  source?: string
  /** Resampling provenance. */
  trackId?: string | null
  range?: [number, number]
  createdAt: string
}

export interface Asset {
  id: string
  name: string
  mimeType: string
  bytes: number
  duration: number
  channels: number
  sampleRate: number
  origin: AssetOrigin
}

export interface AuditEntry {
  id: string
  at: string
  origin: Origin
  label: string
  commands: string[]
  revision: number
}

export interface StudioProject {
  schema: typeof STUDIO_SCHEMA
  version: number
  id: string
  name: string
  tempo: number
  swing: number
  meter: { numerator: number; denominator: number }
  sampleRate: 44100 | 48000
  /** Bars in the arrangement. */
  length: number
  /** Increments on every accepted command batch. */
  revision: number
  createdAt: string
  tracks: Track[]
  returns: ReturnBus[]
  master: MasterState
  patterns: Record<string, Pattern>
  clips: Clip[]
  sections: Section[]
  scenes: Scene[]
  automation: AutomationLane[]
  assets: Record<string, Asset>
  audit: AuditEntry[]
}

// ---------------------------------------------------------------------------
// Factories

export const newId = (prefix: string) => `${prefix}_${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`}`

export const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

export const TRACK_COLORS = ['#a3bd4c', '#c58f43', '#5ea3a0', '#bd6a4d', '#ad965e', '#9283b8', '#6f8fbf', '#b5708f', '#7da36b', '#c2a74a']

export const emptyNoteStep = (note = 36): NoteStep => ({ on: false, note, velocity: 100, accent: false, slide: false, probability: 100, ratchet: 1, micro: 0, locks: {} })
export const emptyDrumHit = (): DrumHit => ({ on: false, velocity: 100, accent: false, probability: 100, ratchet: 1, micro: 0, locks: {} })

export function defaultInserts(): InsertState {
  return { eqLow: 0, eqMid: 0, eqHigh: 0, filter: 0, drive: 0 }
}

export function defaultMixer(returns: ReturnBus[], volume = -6): MixerState {
  return { volume, pan: 0, mute: false, solo: false, output: 'master', sends: Object.fromEntries(returns.map((r) => [r.id, { level: 0, tap: 'post' as const }])) }
}

export function defaultDrumVoices(kit: '808' | '909'): Record<DrumVoiceName, DrumVoiceState> {
  return Object.fromEntries(
    DRUM_VOICES.map((name, index) => [
      name,
      {
        level: name === 'kick' ? 0.92 : index < 2 ? 0.86 : 0.64,
        tone: kit === '808' ? 0.45 : 0.62,
        decay: name.includes('Hat') ? 0.32 : 0.55,
        tune: 0.5,
        pan: index % 2 ? 0.12 : -0.12,
        mute: false,
      },
    ]),
  ) as Record<DrumVoiceName, DrumVoiceState>
}

export function defaultPad(index: number): PadState {
  return { name: `Pad ${index + 1}`, assetId: null, start: 0, end: 1, pitch: 0, gain: 0.8, reverse: false, mode: 'oneShot', attack: 0, release: 0.2, choke: null, filter: 1 }
}

export function defaultDevice(kind: TrackKind): Device {
  switch (kind) {
    case 'acid':
      return { kind, source: 'classic', waveform: 'sawtooth', designerWaveform: 'sawtooth', spread: 0, tune: 0, cutoff: 0.35, resonance: 0.6, envMod: 0.6, decay: 0.45, accent: 0.7, drive: 0.25, level: 0.75 }
    case 'wave':
      return { kind, waveform: 'triangle', spread: 0.3, tune: 0, cutoff: 0.65, resonance: 0.25, attack: 0.15, release: 0.5, drive: 0.1, level: 0.6 }
    case 'drum':
      return { kind, kit: '808', level: 0.85, voices: defaultDrumVoices('808') }
    case 'sampler':
      return { kind, level: 0.8, drive: 0.05, crush: 0, sixteenLevels: 'off', source: null, pads: Array.from({ length: PAD_COUNT }, (_, i) => defaultPad(i)) }
    case 'deck':
      return { kind, assetId: null, gain: 0.85, pitch: 0, filter: 0, loop: true, loopStart: 0, loopEnd: 0, cue: 0 }
    case 'audio':
      return { kind }
    case 'group':
      return { kind }
  }
}

export const MACRO_TEMPLATES: Record<TrackKind, [string, string][]> = {
  acid: [['Cutoff', 'device.cutoff'], ['Reso', 'device.resonance'], ['Env mod', 'device.envMod'], ['Decay', 'device.decay'], ['Accent', 'device.accent'], ['Drive', 'device.drive'], ['Delay', 'send.delay'], ['Filter', 'insert.filter']],
  wave: [['Cutoff', 'device.cutoff'], ['Reso', 'device.resonance'], ['Attack', 'device.attack'], ['Release', 'device.release'], ['Spread', 'device.spread'], ['Drive', 'device.drive'], ['Delay', 'send.delay'], ['Reverb', 'send.reverb']],
  drum: [['Kick tune', 'voice.kick.tune'], ['Kick decay', 'voice.kick.decay'], ['Snare tone', 'voice.snare.tone'], ['Hat decay', 'voice.closedHat.decay'], ['Open hat', 'voice.openHat.decay'], ['Level', 'device.level'], ['Delay', 'send.delay'], ['Reverb', 'send.reverb']],
  sampler: [['Level', 'device.level'], ['Drive', 'device.drive'], ['Crush', 'device.crush'], ['Filter', 'insert.filter'], ['Low', 'insert.eqLow'], ['High', 'insert.eqHigh'], ['Delay', 'send.delay'], ['Reverb', 'send.reverb']],
  deck: [['Gain', 'device.gain'], ['Filter', 'device.filter'], ['Pitch', 'device.pitch'], ['Low', 'insert.eqLow'], ['Mid', 'insert.eqMid'], ['High', 'insert.eqHigh'], ['Delay', 'send.delay'], ['Reverb', 'send.reverb']],
  audio: [['Volume', 'mixer.volume'], ['Pan', 'mixer.pan'], ['Filter', 'insert.filter'], ['Drive', 'insert.drive'], ['Low', 'insert.eqLow'], ['High', 'insert.eqHigh'], ['Delay', 'send.delay'], ['Reverb', 'send.reverb']],
  group: [['Volume', 'mixer.volume'], ['Pan', 'mixer.pan'], ['Filter', 'insert.filter'], ['Drive', 'insert.drive'], ['Low', 'insert.eqLow'], ['High', 'insert.eqHigh'], ['Delay', 'send.delay'], ['Reverb', 'send.reverb']],
}

export const DEVICE_NAMES: Record<TrackKind, string> = {
  acid: 'Acid Synth',
  wave: 'Wave Synth',
  drum: 'Drum Machine',
  sampler: 'Sampler',
  audio: 'Audio Track',
  deck: 'Deck',
  group: 'Group Bus',
}

export function createTrack(kind: TrackKind, name: string, color: string, returns: ReturnBus[], options: { volume?: number; id?: string } = {}): Track {
  return {
    id: options.id ?? newId('trk'),
    name,
    color,
    kind,
    device: defaultDevice(kind),
    inserts: defaultInserts(),
    mixer: defaultMixer(returns, options.volume ?? -6),
    macros: [],
  }
}

export function defaultReturns(): ReturnBus[] {
  return [
    { id: 'delay', kind: 'delay', name: 'Tape Delay', level: -6, mute: false, time: 0.75, feedback: 0.42, tone: 0.6 },
    { id: 'reverb', kind: 'reverb', name: 'Plate', level: -8, mute: false, decay: 2.2, tone: 0.6 },
  ]
}

export function defaultMaster(): MasterState {
  return { volume: 0, ceiling: -0.3, drive: 0.1, compress: 0.35, soften: 0.5, fxSafeBypass: false }
}

export function createNotePattern(name: string, length = 16, root = 36): NotePattern {
  return { id: newId('pat'), name, kind: 'notes', length, division: 16, swing: null, steps: Array.from({ length }, () => emptyNoteStep(root)) }
}

export function createDrumPattern(name: string, length = 16): DrumPattern {
  return {
    id: newId('pat'),
    name,
    kind: 'drums',
    length,
    division: 16,
    swing: null,
    lanes: Object.fromEntries(DRUM_VOICES.map((v) => [v, Array.from({ length }, emptyDrumHit)])) as Record<DrumVoiceName, DrumHit[]>,
  }
}

export function createPadPattern(name: string, length = 16): PadPattern {
  return { id: newId('pat'), name, kind: 'pads', length, division: 16, swing: null, hits: [] }
}

export function patternKindFor(kind: TrackKind): Pattern['kind'] | null {
  return kind === 'acid' || kind === 'wave' ? 'notes' : kind === 'drum' ? 'drums' : kind === 'sampler' ? 'pads' : null
}

export function createPatternFor(track: Track, name: string, length = 16): Pattern | null {
  const kind = patternKindFor(track.kind)
  if (kind === 'notes') return createNotePattern(name, length, track.kind === 'wave' ? 48 : 36)
  if (kind === 'drums') return createDrumPattern(name, length)
  if (kind === 'pads') return createPadPattern(name, length)
  return null
}

export function emptyStudioProject(name = 'Untitled'): StudioProject {
  return {
    schema: STUDIO_SCHEMA,
    version: STUDIO_VERSION,
    id: newId('prj'),
    name,
    tempo: 124,
    swing: 0.08,
    meter: { numerator: 4, denominator: 4 },
    sampleRate: 44100,
    length: 8,
    revision: 0,
    createdAt: new Date().toISOString(),
    tracks: [],
    returns: defaultReturns(),
    master: defaultMaster(),
    patterns: {},
    clips: [],
    sections: [],
    scenes: [],
    automation: [],
    assets: {},
    audit: [],
  }
}

const hits = (length: number, on: number[], accents: number[] = []): DrumHit[] =>
  Array.from({ length }, (_, i) => ({ ...emptyDrumHit(), on: on.includes(i) || accents.includes(i), accent: accents.includes(i) }))

/**
 * The default rack: two Acid Synths, a Wave Synth, 808, 909, and a Sampler,
 * with a starter beat so pressing Play makes sound immediately.
 */
export function createDefaultStudioProject(name = 'New Beat'): StudioProject {
  const project = emptyStudioProject(name)
  const { returns } = project
  const acid1 = createTrack('acid', 'Acid 1', TRACK_COLORS[0], returns, { volume: -5 })
  const acid2 = createTrack('acid', 'Acid 2', TRACK_COLORS[1], returns, { volume: -8 })
  ;(acid2.device as AcidDevice).waveform = 'square'
  ;(acid2.device as AcidDevice).cutoff = 0.5
  acid2.mixer.sends.delay = { level: 0.22, tap: 'post' }
  const wave = createTrack('wave', 'Wave', TRACK_COLORS[2], returns, { volume: -10 })
  wave.mixer.sends.reverb = { level: 0.3, tap: 'post' }
  const d808 = createTrack('drum', '808', TRACK_COLORS[3], returns, { volume: -4 })
  const d909 = createTrack('drum', '909', TRACK_COLORS[4], returns, { volume: -8 })
  ;(d909.device as DrumDevice).kit = '909'
  ;(d909.device as DrumDevice).voices = defaultDrumVoices('909')
  d909.mixer.sends.reverb = { level: 0.12, tap: 'post' }
  const sampler = createTrack('sampler', 'Sampler', TRACK_COLORS[5], returns, { volume: -6 })
  project.tracks = [acid1, acid2, wave, d808, d909, sampler]
  for (const track of project.tracks) track.macros = macrosFor(track)

  const bass = createNotePattern('Acid line', 16, 36)
  const notes: (number | null)[] = [0, null, 12, 0, 3, null, 15, 0, null, 7, 0, 10, null, 12, 3, 0]
  bass.steps = notes.map((offset, i) => (offset === null ? emptyNoteStep(36) : { ...emptyNoteStep(36 + offset), on: true, accent: [2, 6, 13].includes(i), slide: [3, 9, 14].includes(i) }))
  const beat = createDrumPattern('Main beat')
  beat.lanes.kick = hits(16, [0, 4, 8, 12], [0])
  beat.lanes.clap = hits(16, [4, 12])
  beat.lanes.closedHat = hits(16, [2, 6, 10, 14])
  const hats = createDrumPattern('Ride hats')
  hats.lanes.closedHat = hits(16, [0, 2, 4, 6, 8, 10, 12, 14], [2, 10])
  hats.lanes.openHat = hits(16, [6, 14])
  for (const pattern of [bass, beat, hats]) project.patterns[pattern.id] = pattern

  const clip = (trackId: string, patternId: string, start: number, length: number): Clip => ({ id: newId('clp'), trackId, patternId, assetId: null, start, length, offset: 0, gain: 0, transpose: 0, mute: false, fadeIn: 0, fadeOut: 0 })
  project.clips = [clip(d808.id, beat.id, 0, 8), clip(acid1.id, bass.id, 4, 4), clip(d909.id, hats.id, 4, 4)]
  project.sections = [
    { id: newId('sec'), name: 'Intro', start: 0, length: 4, color: '#5d6e60' },
    { id: newId('sec'), name: 'Groove', start: 4, length: 4, color: '#86574a' },
  ]
  project.scenes = [
    { id: newId('scn'), name: 'Beat', slots: { [d808.id]: beat.id } },
    { id: newId('scn'), name: 'Groove', slots: { [d808.id]: beat.id, [acid1.id]: bass.id, [d909.id]: hats.id } },
  ]
  return project
}

export function macrosFor(track: Track): Macro[] {
  return MACRO_TEMPLATES[track.kind].map(([name, param]) => {
    const spec = findParamSpec(track, param)
    const value = spec ? normalize(spec, getParam(track, param) ?? spec.default) : 0.5
    return { name, value, targets: spec ? [{ param, min: spec.min, max: spec.max }] : [] }
  })
}

// ---------------------------------------------------------------------------
// Parameters

export interface ParamSpec {
  id: string
  label: string
  min: number
  max: number
  default: number
  unit: '' | '%' | 'dB' | 'st' | 'pan' | 's' | 'beats' | 'bipolar'
  /** Discrete values snap to whole numbers. */
  step?: number
}

const pct = (id: string, label: string, def = 0.5): ParamSpec => ({ id, label, min: 0, max: 1, default: def, unit: '%' })

const MIXER_SPECS: ParamSpec[] = [
  { id: 'mixer.volume', label: 'Volume', min: -60, max: 6, default: -6, unit: 'dB' },
  { id: 'mixer.pan', label: 'Pan', min: -1, max: 1, default: 0, unit: 'pan' },
  { id: 'insert.eqLow', label: 'Low', min: -12, max: 12, default: 0, unit: 'dB' },
  { id: 'insert.eqMid', label: 'Mid', min: -12, max: 12, default: 0, unit: 'dB' },
  { id: 'insert.eqHigh', label: 'High', min: -12, max: 12, default: 0, unit: 'dB' },
  { id: 'insert.filter', label: 'Filter', min: -1, max: 1, default: 0, unit: 'bipolar' },
  pct('insert.drive', 'Drive', 0),
]

const DEVICE_SPECS: Record<TrackKind, ParamSpec[]> = {
  acid: [
    { id: 'device.tune', label: 'Tune', min: -12, max: 12, default: 0, unit: 'st', step: 1 },
    pct('device.cutoff', 'Cutoff', 0.35),
    pct('device.resonance', 'Resonance', 0.6),
    pct('device.envMod', 'Env mod', 0.6),
    pct('device.decay', 'Decay', 0.45),
    pct('device.accent', 'Accent', 0.7),
    pct('device.drive', 'Drive', 0.25),
    pct('device.spread', 'Spread', 0),
    pct('device.level', 'Level', 0.75),
  ],
  wave: [
    { id: 'device.tune', label: 'Tune', min: -12, max: 12, default: 0, unit: 'st', step: 1 },
    pct('device.cutoff', 'Cutoff', 0.65),
    pct('device.resonance', 'Resonance', 0.25),
    pct('device.attack', 'Attack', 0.15),
    pct('device.release', 'Release', 0.5),
    pct('device.spread', 'Spread', 0.3),
    pct('device.drive', 'Drive', 0.1),
    pct('device.level', 'Level', 0.6),
  ],
  drum: [
    pct('device.level', 'Level', 0.85),
    ...DRUM_VOICES.flatMap((v) => [
      pct(`voice.${v}.level`, `${DRUM_VOICE_LABELS[v]} level`, 0.7),
      pct(`voice.${v}.tone`, `${DRUM_VOICE_LABELS[v]} tone`, 0.5),
      pct(`voice.${v}.decay`, `${DRUM_VOICE_LABELS[v]} decay`, 0.5),
      pct(`voice.${v}.tune`, `${DRUM_VOICE_LABELS[v]} tune`, 0.5),
      { id: `voice.${v}.pan`, label: `${DRUM_VOICE_LABELS[v]} pan`, min: -1, max: 1, default: 0, unit: 'pan' as const },
    ]),
  ],
  sampler: [
    pct('device.level', 'Level', 0.8),
    pct('device.drive', 'Drive', 0.05),
    pct('device.crush', 'Crush', 0),
    ...Array.from({ length: PAD_COUNT }, (_, i) => [
      { id: `pad.${i}.pitch`, label: `Pad ${i + 1} pitch`, min: -24, max: 24, default: 0, unit: 'st' as const, step: 1 },
      pct(`pad.${i}.gain`, `Pad ${i + 1} gain`, 0.8),
      pct(`pad.${i}.attack`, `Pad ${i + 1} attack`, 0),
      pct(`pad.${i}.release`, `Pad ${i + 1} release`, 0.2),
      pct(`pad.${i}.filter`, `Pad ${i + 1} filter`, 1),
    ]).flat(),
  ],
  deck: [
    pct('device.gain', 'Gain', 0.85),
    { id: 'device.pitch', label: 'Pitch', min: -12, max: 12, default: 0, unit: 'st' },
    { id: 'device.filter', label: 'Filter', min: -1, max: 1, default: 0, unit: 'bipolar' },
  ],
  audio: [],
  group: [],
}

export function paramSpecs(track: Track, returns: ReturnBus[] = []): ParamSpec[] {
  const sends = (returns.length ? returns.map((r) => r.id) : Object.keys(track.mixer.sends)).map((id) => pct(`send.${id}`, `${returns.find((r) => r.id === id)?.name ?? id} send`, 0))
  return [...DEVICE_SPECS[track.kind], ...MIXER_SPECS, ...sends]
}

export function findParamSpec(track: Track, param: string): ParamSpec | undefined {
  if (param.startsWith('send.')) return pct(param, `${param.slice(5)} send`, 0)
  return paramSpecs(track).find((spec) => spec.id === param)
}

export const normalize = (spec: ParamSpec, value: number) => (spec.max === spec.min ? 0 : (value - spec.min) / (spec.max - spec.min))
export const denormalize = (spec: ParamSpec, value: number) => {
  const raw = spec.min + clamp(value, 0, 1) * (spec.max - spec.min)
  return spec.step ? Math.round(raw / spec.step) * spec.step : raw
}

export function getParam(track: Track, param: string): number | undefined {
  const [scope, a, b] = param.split('.')
  const device = track.device as unknown as Record<string, unknown>
  if (scope === 'device') return typeof device[a] === 'number' ? (device[a] as number) : undefined
  if (scope === 'voice' && track.device.kind === 'drum') return track.device.voices[a as DrumVoiceName]?.[b as keyof DrumVoiceState] as number | undefined
  if (scope === 'pad' && track.device.kind === 'sampler') {
    const value = track.device.pads[Number(a)]?.[b as keyof PadState]
    return typeof value === 'number' ? value : undefined
  }
  if (scope === 'mixer') return a === 'volume' ? track.mixer.volume : a === 'pan' ? track.mixer.pan : undefined
  if (scope === 'insert') return track.inserts[a as keyof InsertState]
  if (scope === 'send') return track.mixer.sends[a]?.level ?? 0
  return undefined
}

/** Returns a copy of `track` with `param` set; unknown parameters are ignored. */
export function setParam(track: Track, param: string, value: number): Track {
  const spec = findParamSpec(track, param)
  if (!spec || !Number.isFinite(value)) return track
  const v = clamp(spec.step ? Math.round(value / spec.step) * spec.step : value, spec.min, spec.max)
  const [scope, a, b] = param.split('.')
  if (scope === 'device') return { ...track, device: { ...track.device, [a]: v } as Device }
  if (scope === 'voice' && track.device.kind === 'drum') {
    const voices = { ...track.device.voices, [a]: { ...track.device.voices[a as DrumVoiceName], [b]: v } }
    return { ...track, device: { ...track.device, voices } }
  }
  if (scope === 'pad' && track.device.kind === 'sampler') {
    const pads = track.device.pads.map((pad, i) => (i === Number(a) ? { ...pad, [b]: v } : pad))
    return { ...track, device: { ...track.device, pads } }
  }
  if (scope === 'mixer') return { ...track, mixer: { ...track.mixer, [a]: v } }
  if (scope === 'insert') return { ...track, inserts: { ...track.inserts, [a]: v } }
  if (scope === 'send') return { ...track, mixer: { ...track.mixer, sends: { ...track.mixer.sends, [a]: { ...(track.mixer.sends[a] ?? { tap: 'post' }), level: v } } } }
  return track
}

export function formatParam(spec: ParamSpec, value: number): string {
  switch (spec.unit) {
    case '%':
      return `${Math.round(value * 100)}%`
    case 'dB':
      return value <= -60 ? '−∞ dB' : `${value > 0 ? '+' : ''}${value.toFixed(1)} dB`
    case 'st':
      return `${value > 0 ? '+' : ''}${Number.isInteger(value) ? value : value.toFixed(1)} st`
    case 'pan':
      return Math.abs(value) < 0.005 ? 'C' : value < 0 ? `L${Math.round(-value * 100)}` : `R${Math.round(value * 100)}`
    case 'bipolar':
      return Math.abs(value) < 0.005 ? 'Off' : value < 0 ? `HP ${Math.round(-value * 100)}` : `LP ${Math.round(value * 100)}`
    case 's':
      return `${value.toFixed(2)} s`
    case 'beats':
      return `${value} beats`
    default:
      return value.toFixed(2)
  }
}

// ---------------------------------------------------------------------------
// Queries

export const clipEnd = (clip: Clip) => clip.start + clip.length
export const trackById = (project: StudioProject, id: string) => project.tracks.find((t) => t.id === id)
export const clipById = (project: StudioProject, id: string) => project.clips.find((c) => c.id === id)
export const linkCount = (project: StudioProject, patternId: string) => project.clips.filter((c) => c.patternId === patternId).length

export function isTrackAudible(project: StudioProject, track: Track): boolean {
  if (track.mixer.mute) return false
  const soloed = project.tracks.filter((t) => t.mixer.solo)
  if (!soloed.length) return true
  if (track.mixer.solo) return true
  // A group carrying a soloed track stays audible, and so does a track
  // routed into a soloed group.
  if (track.kind === 'group' && soloed.some((t) => t.mixer.output === track.id)) return true
  const parent = project.tracks.find((t) => t.id === track.mixer.output)
  return Boolean(parent?.mixer.solo)
}

export function noteName(midi: number): string {
  const names = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B']
  return `${names[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`
}

export function parseNoteName(text: string): number | null {
  const match = /^([A-Ga-g])([#♯b♭]?)(-?\d)$/.exec(text.trim())
  if (!match) return null
  const base = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 }[match[1].toLowerCase() as 'c']
  const accidental = match[2] === '#' || match[2] === '♯' ? 1 : match[2] === 'b' || match[2] === '♭' ? -1 : 0
  return (Number(match[3]) + 1) * 12 + base + accidental
}

export const barSeconds = (project: Pick<StudioProject, 'tempo' | 'meter'>) => (60 / project.tempo) * project.meter.numerator * (4 / project.meter.denominator)

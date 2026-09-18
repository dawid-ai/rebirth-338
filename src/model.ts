export type BassStep = {
  note: number
  active: boolean
  accent: boolean
  slide: boolean
  octave: -1 | 0 | 1
}

export type BassVoice = {
  name: string
  oscSource: 'classic' | 'designer'
  waveform: 'sawtooth' | 'square'
  designerWaveform: DesignerWaveform
  designerSpread: number
  cutoff: number
  resonance: number
  envMod: number
  decay: number
  accent: number
  drive: number
  delay: number
  reverb: number
  level: number
  pan: number
  tune: number
  muted: boolean
  solo: boolean
  eqLow: number
  eqMid: number
  eqHigh: number
  bank: number
  pattern: number
  steps: BassStep[]
  patterns: BassStep[][]
}

export type DesignerWaveform = 'sine' | 'triangle' | 'sawtooth' | 'square'

export type WaveDesignerState = {
  name: string
  waveform: DesignerWaveform
  cutoff: number
  resonance: number
  attack: number
  release: number
  spread: number
  drive: number
  tune: number
  level: number
  pan: number
  delay: number
  reverb: number
  muted: boolean
  solo: boolean
  eqLow: number
  eqMid: number
  eqHigh: number
  steps: BassStep[]
}

/** Copies the Wave Designer's tone into a 303 while preserving its sequence and mixer channel. */
export function transferWaveToBass(voice: BassVoice, designer: WaveDesignerState): BassVoice {
  return {
    ...voice,
    name: designer.name.slice(0, 18),
    oscSource: 'designer',
    designerWaveform: designer.waveform,
    designerSpread: designer.spread,
    cutoff: designer.cutoff,
    resonance: designer.resonance,
    decay: designer.release,
    drive: designer.drive,
    tune: designer.tune,
    delay: designer.delay,
    reverb: designer.reverb,
  }
}

export const drumNames = ['kick', 'snare', 'clap', 'closedHat', 'openHat', 'lowTom', 'midTom', 'highTom', 'rim', 'cowbell'] as const
export type DrumName = typeof drumNames[number]

export type DrumVoice = {
  level: number
  tone: number
  decay: number
  tune: number
  pan: number
  delay: number
  reverb: number
  muted: boolean
  solo: boolean
}

export type DrumStep = 0 | 1 | 2

export type RhythmMachineState = {
  kit: '808' | '909'
  bank: number
  pattern: number
  selectedDrum: DrumName
  drums: Record<DrumName, DrumVoice>
  steps: Record<DrumName, DrumStep[]>
  patterns: Array<Record<DrumName, DrumStep[]>>
  level: number
  pan: number
  delay: number
  reverb: number
  muted: boolean
  solo: boolean
  eqLow: number
  eqMid: number
  eqHigh: number
}

export type BeatRepeatDivision = 1 | 2 | 4 | 8

export type PerformanceState = {
  /** Tempo-synchronised master loop/beat repeat. */
  beatRepeat: boolean
  /** Subdivisions per quarter note: 1=quarter, 2=eighth, 4=sixteenth, 8=thirty-second. */
  beatRepeatDivision: BeatRepeatDivision
  beatRepeatMix: number
  beatRepeatDecay: number
}

export const fxPadNames = ['impact', 'riser', 'laser', 'dubSiren', 'subDrop', 'noiseHit', 'vinylStop', 'tapeStab', 'airHorn', 'vocalChop', 'scratch', 'bellHit'] as const
export type FxPadName = typeof fxPadNames[number]

export type SongCue = { bass: [number, number]; drums: [number, number] }
export type SongScene = { name: string; start: number }

export type DeckState = {
  name: string
  /** Binary audio is stored in IndexedDB; this is its stable lookup key. */
  assetId: string | null
  gain: number
  /** Semitones. Web Audio changes pitch and speed together. */
  pitch: number
  rate: number
  /** Bipolar DJ filter: negative=high-pass, positive=low-pass. */
  filter: number
  cuePoint: number
  loop: boolean
  loopStart: number
  loopEnd: number
  muted: boolean
  solo: boolean
  pan: number
  delay: number
  reverb: number
  eqLow: number
  eqMid: number
  eqHigh: number
}

export type SamplerMode = 'oneShot' | 'loop'

export type SamplerSlot = {
  name: string
  assetId: string | null
  gain: number
  pitch: number
  reverse: boolean
  mode: SamplerMode
  /** Normalized 0–1 trim markers. */
  trimStart: number
  trimEnd: number
  filter: number
  attack: number
  release: number
  chokeGroup: number
  normalize: boolean
  sourceBpm: number
  warp: boolean
  steps: DrumStep[]
  stepVelocities: number[]
  stepNudges: number[]
  stepProbabilities: number[]
  stepRatchets: number[]
}

export type SamplerState = {
  slots: SamplerSlot[]
  activeBank: number
  selectedSlot: number
  sixteenLevels: 'off' | 'velocity' | 'pitch'
  noteRepeat: 0 | 2 | 4 | 8
  level: number
  pan: number
  delay: number
  reverb: number
  muted: boolean
  solo: boolean
  eqLow: number
  eqMid: number
  eqHigh: number
  drive: number
  bitDepth: number
  sampleRate: number
  texture: number
}

export type ProjectState = {
  version: 1
  /** One-time migration marker for bundled, removable starter audio. */
  starterPackVersion: 1
  name: string
  tempo: number
  swing: number
  master: number
  compressor: number
  masterDrive: number
  /** Gentle anti-harshness stage after the master tone filter. */
  smoothOutput: boolean
  /** How strongly the master softening stage tames upper mids and highs. */
  softenAmount: number
  /** Instantly bypasses the shared echo and reverb returns. */
  effectsEnabled: boolean
  /** Optional demo-only sound automation; off keeps manual mix edits stable. */
  demoAutoMix: boolean
  filterCutoff: number
  filterResonance: number
  delayTime: number
  delayFeedback: number
  delayMix: number
  reverbMix: number
  reverbTone: number
  /** -100 is fully deck A (303s), +100 fully deck B (rhythm machines). */
  crossfader: number
  mode: 'pattern' | 'song'
  bass: [BassVoice, BassVoice]
  rhythms: [RhythmMachineState, RhythmMachineState]
  waveDesigner: WaveDesignerState
  /** Dynamic arrangement. New projects contain 32 bars; legacy projects retain their saved length. */
  songChain: SongCue[]
  /** Named, zero-based scene markers. Scenes may have any length and always include bar one. */
  songScenes: SongScene[]
  performance: PerformanceState
  decks: [DeckState, DeckState]
  sampler: SamplerState
}

const bassSteps = (root: number, variant = 0): BassStep[] => {
  const movement = variant ? [0, 12, 3, 0, 7, 10, 3, 0, 12, 7, 3, 10, 0, 3, 7, 10] : [0, 0, 12, 3, 0, 7, 10, 3, 0, 12, 7, 3, 10, 7, 3, 0]
  return movement.map((offset, index) => ({
    note: root + offset,
    active: variant ? ![1, 6, 11, 14].includes(index) : ![3, 6, 11, 15].includes(index),
    accent: index % (variant ? 5 : 4) === 0,
    slide: variant ? [4, 9, 13].includes(index) : [1, 8, 12].includes(index),
    octave: 0,
  }))
}

const drumPattern = (hits: number[], accents: number[] = []): DrumStep[] =>
  Array.from({ length: 16 }, (_, index) => accents.includes(index) ? 2 : hits.includes(index) ? 1 : 0) as DrumStep[]

const rotate = <T,>(items: T[], amount: number) => items.map((_, index) => items[(index - amount + items.length) % items.length])

type BassEvent = [step: number, note: number, accent?: boolean, slide?: boolean]
const curatedBassPattern = (events: BassEvent[], root: number): BassStep[] => {
  const steps: BassStep[] = Array.from({ length: 16 }, () => ({ note: root, active: false, accent: false, slide: false, octave: 0 }))
  events.forEach(([step, note, accent = false, slide = false]) => { steps[step - 1] = { note, active: true, accent, slide, octave: 0 } })
  return steps
}

const dubBassOne = [
  [[1,36,true,true],[2,36],[7,36,true],[9,34],[11,36,false,true],[12,38],[15,31]],
  [[1,36,true],[4,36],[6,39,false,true],[7,41],[10,36,true],[13,34],[15,31]],
  [[1,36,true],[3,36],[5,31],[7,34,false,true],[8,36],[11,39],[14,41,false,true],[15,43]],
  [[1,36,true,true],[2,36],[5,36],[9,36,true],[13,36],[15,38,false,true],[16,39]],
] as BassEvent[][]
const dubBassTwo = [
  [[3,48,true],[4,48,false,true],[5,43],[7,48,true],[11,46,false,true],[12,48],[15,51]],
  [[2,48,true],[6,51],[8,53,false,true],[9,55,true],[12,48],[14,46,false,true],[15,48]],
  [[3,43],[5,46,true,true],[6,48],[8,51],[10,53,true,true],[11,55],[14,48],[16,46]],
  [[2,48],[4,43],[9,48,true],[11,51,false,true],[12,53,false,true],[13,55,true],[14,58],[15,55],[16,48,true]],
] as BassEvent[][]

const makeBassPatterns = (root: number, variant: number) => Array.from({ length: 32 }, (_, index) => {
  const curated = (variant ? dubBassTwo : dubBassOne)[index]
  if (curated) return curatedBassPattern(curated, root)
  return rotate(bassSteps(root + (index % 3 === 2 ? 2 : 0), (variant + index) % 2), index % 8).map((step, cursor) => ({
    ...step,
    accent: cursor % (3 + (index % 3)) === 0,
    slide: step.active && (cursor + index) % 7 === 1,
  }))
})

const makeDrumRows = (variant = 0): Record<DrumName, DrumStep[]> => ({
  kick: drumPattern(variant % 3 === 0 ? [0, 4, 8, 10, 12] : variant % 3 === 1 ? [0, 3, 7, 10, 12] : [0, 6, 8, 11, 14], [0, 8]),
  snare: drumPattern([4, 12], [12]),
  clap: drumPattern(variant % 2 ? [4, 11, 12] : [4, 12]),
  closedHat: drumPattern(variant % 2 ? [0, 2, 4, 6, 8, 9, 10, 12, 14] : [0, 2, 4, 6, 8, 10, 12, 14], [2, 6, 10, 14]),
  openHat: drumPattern(variant % 4 === 3 ? [3, 7, 11, 15] : [7, 15]),
  lowTom: drumPattern(variant % 3 === 2 ? [9, 10] : [10]),
  midTom: drumPattern(variant % 4 === 1 ? [7, 11] : [11]),
  highTom: drumPattern([15]),
  rim: drumPattern(variant % 2 ? [2, 6, 10, 14] : [3, 11]),
  cowbell: drumPattern(variant % 3 ? [6, 14] : [2, 6, 10, 14]),
})

type HitMap = Partial<Record<DrumName, { hits: number[]; accents?: number[] }>>
const curatedDrums = (map: HitMap): Record<DrumName, DrumStep[]> => Object.fromEntries(drumNames.map((name) => {
  const data = map[name]
  return [name, drumPattern(data?.hits.map((step) => step - 1) ?? [], data?.accents?.map((step) => step - 1) ?? [])]
})) as Record<DrumName, DrumStep[]>

const dub808 = [
  curatedDrums({ kick:{hits:[1,11],accents:[1,11]}, snare:{hits:[9]}, closedHat:{hits:[3,5,7,11,13,15]}, openHat:{hits:[8,16]}, rim:{hits:[5,13]} }),
  curatedDrums({ kick:{hits:[1,6,11,14],accents:[1]}, snare:{hits:[9]}, clap:{hits:[9]}, closedHat:{hits:[2,3,5,7,10,11,13,15]}, openHat:{hits:[8,16],accents:[16]}, lowTom:{hits:[16]}, rim:{hits:[5,13]} }),
  curatedDrums({ kick:{hits:[1],accents:[1]}, snare:{hits:[9]}, closedHat:{hits:[5,13]}, openHat:{hits:[16]}, lowTom:{hits:[11]}, midTom:{hits:[12]}, highTom:{hits:[13],accents:[13]}, rim:{hits:[3,7,15]}, cowbell:{hits:[6,14]} }),
  curatedDrums({ kick:{hits:[1,7,11],accents:[1]}, snare:{hits:[9,13]}, clap:{hits:[9]}, closedHat:{hits:[3,5,7,11]}, openHat:{hits:[8]}, lowTom:{hits:[12]}, midTom:{hits:[14]}, highTom:{hits:[15],accents:[15]}, rim:{hits:[16],accents:[16]} }),
]
const dub909 = [
  curatedDrums({ kick:{hits:[1,7,11],accents:[1]}, snare:{hits:[9],accents:[9]}, clap:{hits:[9]}, closedHat:{hits:[2,4,6,10,12,14],accents:[6,12]}, openHat:{hits:[8,16]}, rim:{hits:[5,13]} }),
  curatedDrums({ kick:{hits:[1,6,11,14],accents:[1]}, snare:{hits:[9],accents:[9]}, clap:{hits:[9,12],accents:[9]}, closedHat:{hits:[2,4,6,8,10,12,14,16],accents:[10]}, openHat:{hits:[7,15]}, lowTom:{hits:[16]}, rim:{hits:[4,13]}, cowbell:{hits:[16]} }),
  curatedDrums({ snare:{hits:[9],accents:[9]}, clap:{hits:[9]}, closedHat:{hits:[4,8,12,16]}, openHat:{hits:[15]}, rim:{hits:[3,7,11,15]}, cowbell:{hits:[6,14]} }),
  curatedDrums({ kick:{hits:[1,7,11,15],accents:[1,15]}, snare:{hits:[9,12,14,15,16],accents:[9,14,16]}, clap:{hits:[9]}, closedHat:{hits:[2,4,6,8,10,12,14]}, openHat:{hits:[16]}, lowTom:{hits:[11]}, midTom:{hits:[13]}, highTom:{hits:[15],accents:[15]}, rim:{hits:[5]} }),
]

const makeSongChain = (length = 32): SongCue[] => Array.from({ length }, (_, index) => {
  const section = Math.floor(index / 8)
  const phrase = index % 8
  return {
    bass: [
      (section * 2 + (phrase < 4 ? phrase % 2 : phrase)) % 32,
      (section * 2 + phrase + (section % 2 ? 3 : 1)) % 32,
    ],
    drums: [
      (section * 3 + (phrase === 7 ? 7 : phrase % 4)) % 32,
      (section * 3 + phrase + (phrase === 7 ? 5 : 0)) % 32,
    ],
  }
})

const starterSceneNames = ['INTRO', 'BUILD', 'DROP A', 'BREAK', 'DROP B', 'OUTRO']

export function createSongScenes(length: number): SongScene[] {
  return Array.from({ length: Math.max(1, Math.ceil(length / 8)) }, (_, index) => ({
    name: starterSceneNames[index] ?? `SCENE ${String(index + 1).padStart(2, '0')}`,
    start: index * 8,
  }))
}

export function normalizeSongScenes(scenes: readonly SongScene[] | undefined, length: number): SongScene[] {
  const lastBar = Math.max(0, length - 1)
  const candidates = scenes?.length ? scenes : createSongScenes(length)
  const byStart = new Map<number, SongScene>()
  candidates.forEach((scene, index) => {
    const start = Math.min(lastBar, Math.max(0, Math.floor(Number(scene.start) || 0)))
    const name = String(scene.name || `SCENE ${String(index + 1).padStart(2, '0')}`).trim().slice(0, 18).toUpperCase()
    if (!byStart.has(start)) byStart.set(start, { name, start })
  })
  if (!byStart.has(0)) byStart.set(0, { name: 'INTRO', start: 0 })
  return [...byStart.values()].sort((a, b) => a.start - b.start)
}

const makeSamplerSlot = (index: number): SamplerSlot => ({
  name: `SAMPLE ${String(index + 1).padStart(2, '0')}`,
  assetId: null,
  gain: 82,
  pitch: 0,
  reverse: false,
  mode: 'oneShot',
  trimStart: 0,
  trimEnd: 1,
  filter: 100,
  attack: 0,
  release: 8,
  chokeGroup: 0,
  normalize: false,
  sourceBpm: 90,
  warp: false,
  steps: Array.from({ length: 16 }, () => 0 as DrumStep),
  stepVelocities: Array.from({ length: 16 }, () => 100),
  stepNudges: Array.from({ length: 16 }, () => 0),
  stepProbabilities: Array.from({ length: 16 }, () => 100),
  stepRatchets: Array.from({ length: 16 }, () => 1),
})

const starterSamples = [
  ['808 KICK', 'bd_808.ogg', 90],
  ['DUB SNARE', 'sn_dub.ogg', 90],
  ['ZAN HAT', 'hat_zan.ogg', 90],
  ['SNAP', 'perc_snap.ogg', 90],
  ['VINYL SCRATCH', 'vinyl_scratch.ogg', 90],
  ['BACKSPIN', 'vinyl_backspin.ogg', 90],
  ['BASS HIT C', 'bass_hit_c.ogg', 90],
  ['AMEN BREAK', 'loop_amen.ogg', 136],
] as const

const makeStarterSamplerSlots = (): SamplerSlot[] => Array.from({ length: 32 }, (_, index) => {
  const slot = makeSamplerSlot(index)
  const starter = starterSamples[index]
  if (!starter) return slot
  return {
    ...slot,
    name: starter[0],
    assetId: `builtin:${starter[1]}`,
    sourceBpm: starter[2],
    mode: index === 7 ? 'loop' : 'oneShot',
  }
})

export const createDefaultProject = (): ProjectState => {
  const bassOnePatterns = makeBassPatterns(36, 0)
  const bassTwoPatterns = makeBassPatterns(43, 1)
  const drum808Patterns = Array.from({ length: 32 }, (_, index) => dub808[index] ?? makeDrumRows(index))
  const drum909Patterns = Array.from({ length: 32 }, (_, index) => dub909[index] ?? makeDrumRows(index + 5))
  const drumVoices = (offset = 0) => Object.fromEntries(drumNames.map((name, index) => [name, {
    level: index < 2 ? 88 : 66,
    tone: 52 + offset,
    decay: name.includes('Hat') ? 36 : 55,
    tune: 50 + offset,
    pan: index % 2 ? 12 : -12,
    delay: name.includes('Hat') || name === 'clap' ? 14 : 4,
    reverb: name === 'clap' || name === 'snare' ? 28 : 8,
    muted: false,
    solo: false,
  }])) as Record<DrumName, DrumVoice>
  const voices808 = drumVoices(-3)
  Object.assign(voices808.kick, { level: 94, tone: 28, decay: 70, tune: 43 })
  Object.assign(voices808.snare, { level: 42, tone: 48, decay: 42 })
  Object.assign(voices808.closedHat, { level: 48, decay: 28 })
  Object.assign(voices808.openHat, { level: 48, decay: 46 })
  const voices909 = drumVoices(4)
  Object.assign(voices909.kick, { level: 82, tone: 68, decay: 38, tune: 57 })
  Object.assign(voices909.snare, { level: 90, tone: 72, decay: 42, tune: 54 })
  Object.assign(voices909.clap, { level: 72, reverb: 38 })
  Object.assign(voices909.closedHat, { level: 55, decay: 25 })
  Object.assign(voices909.openHat, { level: 49, decay: 48 })
  const waveSteps = curatedBassPattern([
    [1, 48, true], [4, 55], [7, 51], [9, 60, true], [12, 58], [15, 55],
  ], 48)
  return ({
  version: 1,
  starterPackVersion: 1,
  name: 'DUB PRESSURE DEMO',
  tempo: 140,
  swing: 10,
  master: 0.76,
  compressor: 38,
  masterDrive: 12,
  smoothOutput: true,
  softenAmount: 70,
  effectsEnabled: true,
  demoAutoMix: false,
  filterCutoff: 94,
  filterResonance: 11,
  delayTime: 40,
  delayFeedback: 36,
  delayMix: 0,
  reverbMix: 0,
  reverbTone: 58,
  mode: 'song',
  bass: [
    { name: 'SUB PRESSURE', oscSource: 'classic', waveform: 'square', designerWaveform: 'triangle', designerSpread: 0, cutoff: 13, resonance: 18, envMod: 20, decay: 72, accent: 68, drive: 8, delay: 0, reverb: 3, level: 84, pan: 0, tune: 0, muted: false, solo: false, eqLow: 62, eqMid: 42, eqHigh: 38, bank: 0, pattern: 0, steps: bassOnePatterns[0], patterns: bassOnePatterns },
    { name: 'MID GROWL', oscSource: 'classic', waveform: 'sawtooth', designerWaveform: 'sawtooth', designerSpread: 0, cutoff: 39, resonance: 74, envMod: 82, decay: 43, accent: 88, drive: 58, delay: 24, reverb: 15, level: 62, pan: 7, tune: 0, muted: false, solo: false, eqLow: 44, eqMid: 62, eqHigh: 57, bank: 0, pattern: 0, steps: bassTwoPatterns[0], patterns: bassTwoPatterns },
  ],
  rhythms: [
    { kit: '808', bank: 0, pattern: 0, selectedDrum: 'kick', drums: voices808, steps: drum808Patterns[0], patterns: drum808Patterns, level: 86, pan: -4, delay: 4, reverb: 7, muted: false, solo: false, eqLow: 63, eqMid: 44, eqHigh: 46 },
    { kit: '909', bank: 0, pattern: 0, selectedDrum: 'snare', drums: voices909, steps: drum909Patterns[0], patterns: drum909Patterns, level: 79, pan: 4, delay: 10, reverb: 16, muted: false, solo: false, eqLow: 52, eqMid: 58, eqHigh: 61 },
  ],
  waveDesigner: { name: 'GLASS CURRENT', waveform: 'triangle', cutoff: 67, resonance: 24, attack: 18, release: 54, spread: 32, drive: 12, tune: 0, level: 54, pan: 0, delay: 28, reverb: 34, muted: false, solo: false, eqLow: 40, eqMid: 54, eqHigh: 62, steps: waveSteps },
  songChain: makeSongChain(32),
  songScenes: createSongScenes(32),
  performance: { beatRepeat: false, beatRepeatDivision: 4, beatRepeatMix: 68, beatRepeatDecay: 72 },
  crossfader: 0,
  decks: [
    { name: 'BREAKBEAT STARTER', assetId: 'builtin:loop_breakbeat.ogg', gain: 86, pitch: 0, rate: 1, filter: 0, cuePoint: 0, loop: true, loopStart: 0, loopEnd: 0, muted: false, solo: false, pan: -8, delay: 0, reverb: 0, eqLow: 50, eqMid: 50, eqHigh: 50 },
    { name: 'COMPUS STARTER', assetId: 'builtin:loop_compus.ogg', gain: 86, pitch: 0, rate: 1, filter: 0, cuePoint: 0, loop: true, loopStart: 0, loopEnd: 0, muted: false, solo: false, pan: 8, delay: 0, reverb: 0, eqLow: 50, eqMid: 50, eqHigh: 50 },
  ],
  sampler: { slots: makeStarterSamplerSlots(), activeBank: 0, selectedSlot: 0, sixteenLevels: 'off', noteRepeat: 0, level: 82, pan: 0, delay: 12, reverb: 10, muted: false, solo: false, eqLow: 50, eqMid: 50, eqHigh: 50, drive: 8, bitDepth: 100, sampleRate: 100, texture: 0 },
})
}

export function hydrateProject(candidate: Partial<ProjectState> | null | undefined): ProjectState {
  const fallback = createDefaultProject()
  if (!candidate || candidate.version !== 1) return fallback
  const needsStarterPack = candidate.starterPackVersion !== 1
  const bass = fallback.bass.map((voice, index) => ({ ...voice, ...(candidate.bass?.[index] ?? {}), patterns: candidate.bass?.[index]?.patterns ?? voice.patterns })) as [BassVoice, BassVoice]
  const songChain = candidate.songChain?.length ? candidate.songChain.slice(0, 128) : fallback.songChain
  return {
    ...fallback,
    ...candidate,
    ...(candidate.demoAutoMix === undefined && candidate.name?.includes('48 BAR DEMO')
      ? { delayMix: 0, reverbMix: 0, masterDrive: 12, softenAmount: 70 }
      : {}),
    bass,
    rhythms: fallback.rhythms.map((rhythm, index) => ({
      ...rhythm,
      ...(candidate.rhythms?.[index] ?? {}),
      drums: Object.fromEntries(drumNames.map((name) => [name, {
        ...rhythm.drums[name],
        ...(candidate.rhythms?.[index]?.drums?.[name] ?? {}),
      }])) as Record<DrumName, DrumVoice>,
      steps: { ...rhythm.steps, ...(candidate.rhythms?.[index]?.steps ?? {}) },
      patterns: candidate.rhythms?.[index]?.patterns ?? rhythm.patterns,
    })) as [RhythmMachineState, RhythmMachineState],
    waveDesigner: { ...fallback.waveDesigner, ...(candidate.waveDesigner ?? {}), steps: candidate.waveDesigner?.steps ?? fallback.waveDesigner.steps },
    songChain,
    songScenes: normalizeSongScenes(candidate.songScenes, songChain.length),
    performance: { ...fallback.performance, ...(candidate.performance ?? {}) },
    decks: fallback.decks.map((deck, index) => {
      const saved = candidate.decks?.[index]
      const merged = { ...deck, ...(saved ?? {}) }
      return needsStarterPack && !saved?.assetId ? { ...merged, name: deck.name, assetId: deck.assetId, loop: deck.loop } : merged
    }) as [DeckState, DeckState],
    sampler: {
      ...fallback.sampler,
      ...(candidate.sampler ?? {}),
      activeBank: Math.max(0, Math.min(3, Math.floor(candidate.sampler?.activeBank ?? fallback.sampler.activeBank))),
      selectedSlot: Math.max(0, Math.min(31, Math.floor(candidate.sampler?.selectedSlot ?? fallback.sampler.selectedSlot))),
      slots: Array.from({ length: Math.max(32, candidate.sampler?.slots?.length ?? 0) }, (_, index) => {
        const empty = makeSamplerSlot(index)
        const saved = candidate.sampler?.slots?.[index]
        const starter = fallback.sampler.slots[index]
        const audio = needsStarterPack && !saved?.assetId && starter?.assetId ? { name: starter.name, assetId: starter.assetId, sourceBpm: starter.sourceBpm, mode: starter.mode } : {}
        return {
          ...empty,
          ...(saved ?? {}),
          ...audio,
          steps: saved?.steps ?? empty.steps,
          stepVelocities: saved?.stepVelocities ?? empty.stepVelocities,
          stepNudges: saved?.stepNudges ?? empty.stepNudges,
          stepProbabilities: saved?.stepProbabilities ?? empty.stepProbabilities,
          stepRatchets: saved?.stepRatchets ?? empty.stepRatchets,
        }
      }),
    },
  }
}

const blankBassSteps = (root: number): BassStep[] => Array.from({ length: 16 }, () => ({ note: root, active: false, accent: false, slide: false, octave: 0 }))

/** Clears every event and modifier in the currently selected 16-step 303 pattern. */
export function wipeBassPattern(voice: BassVoice, root = 36): BassVoice {
  const steps = blankBassSteps(root)
  const slot = voice.bank * 8 + voice.pattern
  return { ...voice, steps, patterns: voice.patterns.map((pattern, index) => index === slot ? steps : pattern) }
}

/** Restores 303 sound/mixer controls without touching the user's patterns. */
export function restoreBassDefaults(voice: BassVoice, index: 0 | 1): BassVoice {
  const defaults = createDefaultProject().bass[index]
  return { ...defaults, bank: voice.bank, pattern: voice.pattern, steps: voice.steps, patterns: voice.patterns }
}

/** Clears all ten drum lanes in the currently selected 16-step pattern. */
export function wipeRhythmPattern(machine: RhythmMachineState): RhythmMachineState {
  const steps = Object.fromEntries(drumNames.map((name) => [name, Array.from({ length: 16 }, () => 0 as DrumStep)])) as Record<DrumName, DrumStep[]>
  const slot = machine.bank * 8 + machine.pattern
  return { ...machine, steps, patterns: machine.patterns.map((pattern, index) => index === slot ? steps : pattern) }
}

/** Restores drum synthesis, voice, and mixer controls without touching patterns. */
export function restoreRhythmDefaults(machine: RhythmMachineState, index: 0 | 1): RhythmMachineState {
  const defaults = createDefaultProject().rhythms[index]
  return { ...defaults, bank: machine.bank, pattern: machine.pattern, selectedDrum: machine.selectedDrum, steps: machine.steps, patterns: machine.patterns }
}

/** Clears every note and modifier in the Wave Designer's 16-step lane. */
export function wipeWavePattern(voice: WaveDesignerState): WaveDesignerState {
  return { ...voice, steps: blankBassSteps(48) }
}

/** Restores Wave Designer sound/mixer controls without touching its sequence. */
export function restoreWaveDefaults(voice: WaveDesignerState): WaveDesignerState {
  return { ...createDefaultProject().waveDesigner, steps: voice.steps }
}

/** Clears the selected sampler trigger lane and all of its per-step modulation. */
export function wipeSamplerPattern(sampler: SamplerState): SamplerState {
  const slot = sampler.selectedSlot
  return {
    ...sampler,
    slots: sampler.slots.map((sample, index) => index === slot ? {
      ...sample,
      steps: Array.from({ length: 16 }, () => 0 as DrumStep),
      stepVelocities: Array.from({ length: 16 }, () => 100),
      stepNudges: Array.from({ length: 16 }, () => 0),
      stepProbabilities: Array.from({ length: 16 }, () => 100),
      stepRatchets: Array.from({ length: 16 }, () => 1),
    } : sample),
  }
}

/** Restores sampler color/mixer and selected-pad processing while preserving audio and patterns. */
export function restoreSamplerDefaults(sampler: SamplerState): SamplerState {
  const defaults = createDefaultProject().sampler
  const selected = sampler.selectedSlot
  const slots = sampler.slots.map((slot, index) => {
    if (index !== selected) return slot
    const pad = defaults.slots[index]
    return {
      ...pad,
      name: slot.name,
      assetId: slot.assetId,
      steps: slot.steps,
      stepVelocities: slot.stepVelocities,
      stepNudges: slot.stepNudges,
      stepProbabilities: slot.stepProbabilities,
      stepRatchets: slot.stepRatchets,
    }
  })
  return { ...defaults, activeBank: sampler.activeBank, selectedSlot: selected, slots }
}

/** Restores deck controls while keeping its loaded audio reference. */
export function restoreDeckDefaults(deck: DeckState, index: 0 | 1): DeckState {
  return { ...createDefaultProject().decks[index], name: deck.name, assetId: deck.assetId }
}

export function resizeSongChain(project: ProjectState, length: number): ProjectState {
  const size = Math.round(Math.min(128, Math.max(1, length)))
  const generated = makeSongChain(size)
  const songChain = Array.from({ length: size }, (_, index) => project.songChain[index] ?? generated[index])
  return {
    ...project,
    songChain,
    songScenes: normalizeSongScenes(project.songScenes, songChain.length),
  }
}

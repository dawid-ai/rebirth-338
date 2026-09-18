import {
  drumNames,
  type BassStep,
  type BassVoice,
  type DrumName,
  type DrumStep,
  type FxPadName,
  type ProjectState,
  type RhythmMachineState,
} from '../model'

type BassEvent = readonly [step: number, note: number, accent?: boolean, slide?: boolean]
type HitMap = Partial<Record<DrumName, { hits: number[]; accents?: number[] }>>

export type DubstepAutomationFrame = {
  /** One-based bar number. Values hold until the next frame. */
  bar: number
  section: 'INTRO' | 'BUILD' | 'DROP A' | 'BREAKDOWN' | 'DROP B' | 'OUTRO'
  global?: Partial<Pick<ProjectState,
    'filterCutoff' | 'filterResonance' | 'masterDrive' | 'compressor' |
    'delayTime' | 'delayFeedback' | 'delayMix' | 'reverbMix' | 'crossfader'>>
  bass?: readonly [Partial<BassVoice>, Partial<BassVoice>]
  rhythms?: readonly [Partial<RhythmMachineState>, Partial<RhythmMachineState>]
  /** Arrangement marker for a future automatic performance-pad lane. */
  fxPad?: FxPadName
}

const bassPattern = (events: readonly BassEvent[], restingNote = 36): BassStep[] => {
  const steps: BassStep[] = Array.from({ length: 16 }, () => ({
    note: restingNote,
    active: false,
    accent: false,
    slide: false,
    octave: 0,
  }))
  events.forEach(([step, note, accent = false, slide = false]) => {
    steps[step - 1] = { note, active: true, accent, slide, octave: 0 }
  })
  return steps
}

const drumPattern = (hits: number[] = [], accents: number[] = []): DrumStep[] =>
  Array.from({ length: 16 }, (_, index) => {
    const step = index + 1
    return accents.includes(step) ? 2 : hits.includes(step) ? 1 : 0
  }) as DrumStep[]

const drumRows = (map: HitMap): Record<DrumName, DrumStep[]> => Object.fromEntries(
  drumNames.map((name) => {
    const voice = map[name]
    return [name, drumPattern(voice?.hits, voice?.accents)]
  }),
) as Record<DrumName, DrumStep[]>

/**
 * Twelve deliberately composed sub patterns in C minor. Slot zero is a true rest,
 * which is essential for an arrangement with contrast rather than a perpetual loop.
 */
const SUB_PATTERNS: BassStep[][] = [
  bassPattern([]),
  bassPattern([[1, 36, true, true], [2, 36], [9, 31]]),
  bassPattern([[1, 36, true, true], [2, 36], [7, 34], [9, 36], [13, 31], [15, 34]]),
  bassPattern([[1, 36, true, true], [2, 36], [7, 36, true], [9, 34], [11, 36, false, true], [12, 38], [15, 31]]),
  bassPattern([[1, 36, true], [4, 36], [6, 39, false, true], [7, 41], [10, 36, true], [13, 34], [15, 31]]),
  bassPattern([[1, 36, true], [3, 36], [5, 31], [7, 34, false, true], [8, 36], [11, 39], [14, 41, false, true], [15, 43]]),
  bassPattern([[1, 36, true, true], [2, 36], [9, 36], [13, 34]]),
  bassPattern([[1, 39, true, true], [2, 39], [9, 32], [13, 34, false, true], [14, 36]]),
  bassPattern([[1, 29, true, true], [2, 29], [6, 31], [8, 34, false, true], [9, 36], [12, 29], [15, 31]]),
  bassPattern([[1, 31, true], [4, 34], [6, 36, false, true], [7, 39], [10, 31, true], [13, 29], [15, 36]]),
  bassPattern([[1, 29, true], [3, 29], [5, 36], [7, 39, false, true], [8, 41], [10, 43, true, true], [11, 41], [13, 39], [15, 36, false, true], [16, 29]]),
  bassPattern([[1, 36, true, true], [2, 36], [9, 31], [13, 36]]),
]

/** Mid-bass call/response material. It stays above the sub to reduce masking. */
const MID_PATTERNS: BassStep[][] = [
  bassPattern([], 48),
  bassPattern([[3, 48, true], [11, 55], [15, 51]], 48),
  bassPattern([[3, 48], [7, 51], [11, 55], [15, 58]], 48),
  bassPattern([[2, 48], [4, 51], [6, 53], [8, 55], [10, 58], [12, 60], [14, 63], [16, 67, true]], 48),
  bassPattern([[3, 48, true], [4, 48, false, true], [5, 43], [7, 48, true], [11, 46, false, true], [12, 48], [15, 51]], 48),
  bassPattern([[2, 48, true], [6, 51], [8, 53, false, true], [9, 55, true], [12, 48], [14, 46, false, true], [15, 48]], 48),
  bassPattern([[3, 43], [5, 46, true, true], [6, 48], [8, 51], [10, 53, true, true], [11, 55], [14, 48], [16, 46]], 48),
  bassPattern([[1, 60], [5, 55], [9, 58, true, true], [10, 60], [13, 51]], 48),
  bassPattern([[2, 53, true], [4, 48], [7, 53, false, true], [8, 55], [11, 48, true], [14, 51], [16, 53]], 48),
  bassPattern([[2, 55, true], [5, 58], [7, 60, false, true], [8, 63], [10, 55], [13, 53, true], [15, 48]], 48),
  bassPattern([[2, 53], [4, 55], [6, 58, true, true], [7, 60], [9, 63], [11, 60, false, true], [12, 58], [13, 55], [14, 53], [15, 51], [16, 48, true]], 48),
  bassPattern([[3, 48, true], [11, 43], [15, 48]], 48),
]

const DRUM_808_PATTERNS: Record<DrumName, DrumStep[]>[] = [
  drumRows({}),
  drumRows({ closedHat: { hits: [3, 7, 11, 15] }, rim: { hits: [5, 13] } }),
  drumRows({ kick: { hits: [1], accents: [1] }, closedHat: { hits: [3, 7, 11, 15] }, openHat: { hits: [16] }, rim: { hits: [5, 13] } }),
  drumRows({ kick: { hits: [1, 11], accents: [1] }, snare: { hits: [9] }, closedHat: { hits: [3, 5, 7, 11, 13, 15] }, openHat: { hits: [8, 16] }, rim: { hits: [5, 13] } }),
  drumRows({ kick: { hits: [1, 6, 11, 14], accents: [1] }, snare: { hits: [9] }, clap: { hits: [9] }, closedHat: { hits: [2, 3, 5, 7, 10, 11, 13, 15] }, openHat: { hits: [8, 16], accents: [16] }, lowTom: { hits: [16] } }),
  drumRows({ kick: { hits: [1, 7, 11], accents: [1, 11] }, snare: { hits: [9] }, closedHat: { hits: [3, 5, 7, 11, 13, 15] }, openHat: { hits: [8, 16] }, rim: { hits: [5, 13] } }),
  drumRows({ kick: { hits: [1, 6, 11, 14], accents: [1] }, snare: { hits: [9] }, clap: { hits: [9] }, closedHat: { hits: [2, 3, 5, 7, 10, 11, 13, 15] }, openHat: { hits: [8, 16] }, lowTom: { hits: [12] }, rim: { hits: [5] } }),
  drumRows({ kick: { hits: [1, 7, 11], accents: [1] }, snare: { hits: [9, 13] }, clap: { hits: [9] }, closedHat: { hits: [3, 5, 7, 11] }, lowTom: { hits: [12] }, midTom: { hits: [14] }, highTom: { hits: [15], accents: [15] }, rim: { hits: [16], accents: [16] } }),
  drumRows({ kick: { hits: [1], accents: [1] }, snare: { hits: [9] }, closedHat: { hits: [5, 13] }, openHat: { hits: [16] }, lowTom: { hits: [11] }, midTom: { hits: [12] }, highTom: { hits: [13], accents: [13] }, rim: { hits: [3, 7, 15] } }),
  drumRows({ kick: { hits: [1, 8, 11, 15], accents: [1, 11] }, snare: { hits: [9] }, closedHat: { hits: [3, 5, 7, 11, 13, 15] }, openHat: { hits: [6, 16] }, rim: { hits: [5, 13] } }),
  drumRows({ kick: { hits: [1, 6, 10, 12, 15], accents: [1, 12] }, snare: { hits: [9] }, clap: { hits: [9] }, closedHat: { hits: [2, 3, 5, 7, 10, 11, 13, 14, 15] }, openHat: { hits: [8, 16] }, lowTom: { hits: [12] }, midTom: { hits: [14] } }),
  drumRows({ kick: { hits: [1, 11], accents: [1] }, snare: { hits: [9] }, closedHat: { hits: [3, 7, 11, 15] }, openHat: { hits: [16] }, rim: { hits: [5, 13] } }),
]

const DRUM_909_PATTERNS: Record<DrumName, DrumStep[]>[] = [
  drumRows({}),
  drumRows({ closedHat: { hits: [4, 8, 12, 16] }, openHat: { hits: [15] }, rim: { hits: [3, 7, 11, 15] } }),
  drumRows({ kick: { hits: [1], accents: [1] }, snare: { hits: [9], accents: [9] }, closedHat: { hits: [4, 8, 12, 16] }, rim: { hits: [5, 13] } }),
  drumRows({ kick: { hits: [1, 7, 11], accents: [1] }, snare: { hits: [9], accents: [9] }, clap: { hits: [9] }, closedHat: { hits: [2, 4, 6, 10, 12, 14], accents: [6, 12] }, openHat: { hits: [8, 16] }, rim: { hits: [5, 13] } }),
  drumRows({ kick: { hits: [1, 6, 11, 14], accents: [1] }, snare: { hits: [9, 13], accents: [9] }, clap: { hits: [9, 12], accents: [9] }, closedHat: { hits: [2, 4, 6, 8, 10, 12, 14, 16], accents: [10, 14] }, openHat: { hits: [7, 15] }, lowTom: { hits: [16] } }),
  drumRows({ kick: { hits: [1, 7, 11], accents: [1] }, snare: { hits: [9], accents: [9] }, clap: { hits: [9] }, closedHat: { hits: [2, 4, 6, 10, 12, 14], accents: [6, 12] }, openHat: { hits: [8, 16] }, rim: { hits: [5, 13] } }),
  drumRows({ kick: { hits: [1, 6, 11, 14], accents: [1, 11] }, snare: { hits: [9], accents: [9] }, clap: { hits: [9, 12] }, closedHat: { hits: [2, 4, 6, 8, 10, 12, 14, 16], accents: [4, 10, 14] }, openHat: { hits: [7, 15] }, rim: { hits: [4, 13] } }),
  drumRows({ kick: { hits: [1, 7, 11, 15], accents: [1, 15] }, snare: { hits: [9, 12, 14, 15, 16], accents: [9, 14, 16] }, clap: { hits: [9] }, closedHat: { hits: [2, 4, 6, 8, 10, 12, 14] }, lowTom: { hits: [11] }, midTom: { hits: [13] }, highTom: { hits: [15], accents: [15] } }),
  drumRows({ snare: { hits: [9], accents: [9] }, clap: { hits: [9] }, closedHat: { hits: [4, 8, 12, 16] }, openHat: { hits: [15] }, rim: { hits: [3, 7, 11, 15] }, cowbell: { hits: [6, 14] } }),
  drumRows({ kick: { hits: [1, 5, 8, 11, 15], accents: [1, 11] }, snare: { hits: [9], accents: [9] }, clap: { hits: [9] }, closedHat: { hits: [2, 4, 6, 10, 12, 14], accents: [6, 14] }, openHat: { hits: [8, 16] }, rim: { hits: [5, 13] } }),
  drumRows({ kick: { hits: [1, 6, 10, 12, 15], accents: [1, 12] }, snare: { hits: [9, 14], accents: [9, 14] }, clap: { hits: [9] }, closedHat: { hits: [2, 4, 6, 8, 10, 12, 14, 16], accents: [4, 10, 16] }, openHat: { hits: [7, 15] }, lowTom: { hits: [12] }, midTom: { hits: [14] }, highTom: { hits: [16], accents: [16] } }),
  drumRows({ kick: { hits: [1, 11], accents: [1] }, snare: { hits: [9], accents: [9] }, closedHat: { hits: [4, 8, 12, 16] }, openHat: { hits: [15] }, rim: { hits: [5, 13] } }),
]

const cue = (bassA: number, bassB: number, drum808: number, drum909: number) => ({
  bass: [bassA, bassB] as [number, number],
  drums: [drum808, drum909] as [number, number],
})

/** 48 bars: intro, build, first drop, breakdown/rebuild, second drop, outro. */
export const DUBSTEP_SONG_CHAIN: ProjectState['songChain'] = [
  // 1-8 INTRO — delayed signal appears first; rhythm and sub enter by degrees.
  cue(0, 1, 0, 1), cue(0, 1, 0, 1), cue(0, 1, 0, 2), cue(1, 1, 1, 2),
  cue(1, 2, 1, 2), cue(1, 2, 2, 2), cue(2, 2, 2, 3), cue(2, 3, 4, 4),
  // 9-16 BUILD — increasingly dense hats, snare movement and rising mid pattern.
  cue(2, 2, 3, 3), cue(2, 2, 3, 3), cue(2, 3, 3, 4), cue(2, 3, 4, 4),
  cue(2, 3, 4, 4), cue(2, 3, 4, 4), cue(2, 3, 4, 4), cue(0, 3, 7, 7),
  // 17-24 DROP A — four-bar call/response, then a more aggressive answer.
  cue(3, 4, 5, 5), cue(3, 5, 5, 6), cue(4, 4, 6, 5), cue(4, 5, 7, 7),
  cue(3, 6, 5, 5), cue(5, 4, 6, 6), cue(4, 5, 5, 6), cue(5, 6, 7, 7),
  // 25-32 BREAKDOWN + SECOND BUILD — harmonic lift, then an empty pre-drop bar.
  cue(6, 7, 0, 8), cue(6, 7, 0, 8), cue(7, 7, 1, 8), cue(7, 1, 1, 2),
  cue(6, 2, 2, 3), cue(7, 2, 3, 3), cue(7, 3, 4, 4), cue(0, 3, 7, 7),
  // 33-40 DROP B — F/G-root movement, denser drums, maximal final turnaround.
  cue(8, 8, 9, 9), cue(8, 9, 9, 10), cue(9, 8, 10, 9), cue(9, 9, 7, 7),
  cue(8, 10, 9, 9), cue(10, 8, 10, 10), cue(9, 9, 9, 10), cue(10, 10, 7, 7),
  // 41-48 OUTRO — remove fill density, then sub, then leave the delayed signal.
  cue(3, 4, 5, 5), cue(3, 11, 5, 11), cue(11, 11, 11, 11), cue(11, 1, 11, 11),
  cue(1, 1, 1, 1), cue(1, 1, 0, 1), cue(0, 1, 0, 1), cue(0, 0, 0, 0),
]

export const DUBSTEP_AUTOMATION_FRAMES: readonly DubstepAutomationFrame[] = [
  { bar: 1, section: 'INTRO', global: { filterCutoff: 31, filterResonance: 20, masterDrive: 8, compressor: 24, delayFeedback: 48, delayMix: 42, reverbMix: 35, crossfader: -24 }, bass: [{ level: 72 }, { cutoff: 24, drive: 28, delay: 40, reverb: 34, level: 48 }], rhythms: [{ level: 42 }, { level: 50 }], fxPad: 'noiseHit' },
  { bar: 4, section: 'INTRO', global: { filterCutoff: 44, crossfader: -12 }, rhythms: [{ level: 55 }, { level: 59 }] },
  { bar: 7, section: 'INTRO', global: { filterCutoff: 58, compressor: 30 }, bass: [{ level: 78 }, { cutoff: 32, level: 54 }], rhythms: [{ level: 69 }, { level: 67 }] },
  { bar: 8, section: 'INTRO', global: { delayFeedback: 56, delayMix: 48 }, fxPad: 'riser' },
  { bar: 9, section: 'BUILD', global: { filterCutoff: 63, filterResonance: 17, masterDrive: 14, delayFeedback: 40, delayMix: 31, reverbMix: 27, crossfader: 0 }, bass: [{ level: 80 }, { cutoff: 36, drive: 44, level: 57 }], rhythms: [{ level: 75 }, { level: 72 }] },
  { bar: 12, section: 'BUILD', global: { filterCutoff: 72 }, bass: [{}, { cutoff: 43, resonance: 70 }] },
  { bar: 13, section: 'BUILD', global: { filterCutoff: 78, masterDrive: 17 } },
  { bar: 14, section: 'BUILD', global: { filterCutoff: 85, filterResonance: 13 } },
  { bar: 15, section: 'BUILD', global: { filterCutoff: 93, delayFeedback: 52 }, fxPad: 'riser' },
  { bar: 16, section: 'BUILD', global: { filterCutoff: 42, filterResonance: 30, delayFeedback: 61, delayMix: 46 }, bass: [{ level: 0 }, { cutoff: 68, drive: 61 }], rhythms: [{ level: 72 }, { level: 76 }], fxPad: 'subDrop' },
  { bar: 17, section: 'DROP A', global: { filterCutoff: 96, filterResonance: 10, masterDrive: 24, compressor: 42, delayFeedback: 34, delayMix: 24, reverbMix: 17, crossfader: 0 }, bass: [{ cutoff: 12, resonance: 14, drive: 7, delay: 0, reverb: 2, level: 87 }, { cutoff: 42, resonance: 76, drive: 62, delay: 18, reverb: 9, level: 64 }], rhythms: [{ level: 86 }, { level: 81 }], fxPad: 'impact' },
  { bar: 20, section: 'DROP A', global: { delayFeedback: 47, delayMix: 34 }, bass: [{}, { cutoff: 51, delay: 31 }], fxPad: 'laser' },
  { bar: 21, section: 'DROP A', global: { delayFeedback: 33, delayMix: 22 }, bass: [{}, { cutoff: 38, delay: 16 }] },
  { bar: 24, section: 'DROP A', global: { filterCutoff: 88, delayFeedback: 57, delayMix: 41 }, fxPad: 'noiseHit' },
  { bar: 25, section: 'BREAKDOWN', global: { filterCutoff: 29, filterResonance: 25, masterDrive: 9, compressor: 26, delayFeedback: 52, delayMix: 43, reverbMix: 39, crossfader: -20 }, bass: [{ cutoff: 18, level: 72 }, { cutoff: 27, drive: 31, delay: 39, reverb: 31, level: 47 }], rhythms: [{ level: 48 }, { level: 55 }], fxPad: 'dubSiren' },
  { bar: 29, section: 'BREAKDOWN', global: { filterCutoff: 52, crossfader: -8 }, bass: [{ level: 77 }, { cutoff: 35, level: 53 }], rhythms: [{ level: 65 }, { level: 65 }] },
  { bar: 30, section: 'BREAKDOWN', global: { filterCutoff: 66, masterDrive: 14 } },
  { bar: 31, section: 'BREAKDOWN', global: { filterCutoff: 83, delayFeedback: 55 }, fxPad: 'riser' },
  { bar: 32, section: 'BREAKDOWN', global: { filterCutoff: 38, filterResonance: 32, delayFeedback: 64, delayMix: 48 }, bass: [{ level: 0 }, { cutoff: 72, drive: 68 }], rhythms: [{ level: 75 }, { level: 78 }], fxPad: 'subDrop' },
  { bar: 33, section: 'DROP B', global: { filterCutoff: 100, filterResonance: 9, masterDrive: 28, compressor: 46, delayFeedback: 32, delayMix: 22, reverbMix: 15, crossfader: 0 }, bass: [{ cutoff: 11, resonance: 12, drive: 9, delay: 0, reverb: 1, level: 89 }, { cutoff: 47, resonance: 79, drive: 68, delay: 16, reverb: 7, level: 66 }], rhythms: [{ level: 88 }, { level: 83 }], fxPad: 'impact' },
  { bar: 36, section: 'DROP B', global: { delayFeedback: 50, delayMix: 35 }, bass: [{}, { cutoff: 58, delay: 30 }], fxPad: 'laser' },
  { bar: 37, section: 'DROP B', global: { delayFeedback: 31, delayMix: 20 }, bass: [{}, { cutoff: 43, delay: 14 }] },
  { bar: 40, section: 'DROP B', global: { masterDrive: 31, delayFeedback: 58, delayMix: 40 }, fxPad: 'noiseHit' },
  { bar: 41, section: 'OUTRO', global: { filterCutoff: 81, masterDrive: 20, compressor: 37, delayFeedback: 42, delayMix: 30, reverbMix: 24 }, bass: [{ level: 82 }, { cutoff: 39, drive: 52, level: 60 }], rhythms: [{ level: 82 }, { level: 77 }] },
  { bar: 44, section: 'OUTRO', global: { filterCutoff: 62, crossfader: -12 }, rhythms: [{ level: 69 }, { level: 66 }] },
  { bar: 46, section: 'OUTRO', global: { filterCutoff: 43, delayFeedback: 52, delayMix: 41, reverbMix: 32, crossfader: -25 }, bass: [{ level: 70 }, { cutoff: 29, delay: 35, reverb: 27, level: 48 }], rhythms: [{ level: 50 }, { level: 54 }] },
  { bar: 48, section: 'OUTRO', global: { filterCutoff: 27, masterDrive: 8, compressor: 22, delayFeedback: 58, delayMix: 46, reverbMix: 38, crossfader: -40 }, bass: [{ level: 0 }, { level: 0 }], rhythms: [{ level: 0 }, { level: 0 }], fxPad: 'subDrop' },
]

const installPatterns = <T,>(existing: T[], curated: T[]): T[] =>
  existing.map((pattern, index) => curated[index] ?? pattern)

/** Build the authored demo on top of a hydrated project without relying on model defaults. */
export function createDubstepDemoProject(base: ProjectState): ProjectState {
  const songChain = DUBSTEP_SONG_CHAIN.map((item) => ({
    bass: [...item.bass] as [number, number],
    drums: [...item.drums] as [number, number],
  }))
  const bass = base.bass.map((voice, index) => {
    const curated = index === 0 ? SUB_PATTERNS : MID_PATTERNS
    const patterns = installPatterns(voice.patterns, curated)
    return {
      ...voice,
      name: index === 0 ? 'VOID SUB' : 'FORMANT REESE',
      waveform: index === 0 ? 'square' as const : 'sawtooth' as const,
      cutoff: index === 0 ? 12 : 42,
      resonance: index === 0 ? 14 : 55,
      envMod: index === 0 ? 18 : 84,
      decay: index === 0 ? 76 : 46,
      accent: index === 0 ? 68 : 88,
      drive: index === 0 ? 7 : 35,
      delay: index === 0 ? 0 : 18,
      reverb: index === 0 ? 2 : 9,
      level: index === 0 ? 87 : 64,
      pan: index === 0 ? 0 : 6,
      eqLow: index === 0 ? 65 : 38,
      eqMid: index === 0 ? 38 : 55,
      eqHigh: index === 0 ? 28 : 48,
      bank: 0,
      pattern: songChain[0].bass[index],
      patterns,
      steps: patterns[songChain[0].bass[index]],
    }
  }) as [BassVoice, BassVoice]
  const rhythms = base.rhythms.map((machine, index) => {
    const curated = index === 0 ? DRUM_808_PATTERNS : DRUM_909_PATTERNS
    const patterns = installPatterns(machine.patterns, curated)
    return {
      ...machine,
      level: index === 0 ? 86 : 81,
      pan: index === 0 ? -3 : 3,
      delay: index === 0 ? 3 : 8,
      reverb: index === 0 ? 5 : 13,
      eqLow: index === 0 ? 64 : 51,
      eqMid: index === 0 ? 42 : 59,
      eqHigh: index === 0 ? 43 : 63,
      bank: 0,
      pattern: songChain[0].drums[index],
      patterns,
      steps: patterns[songChain[0].drums[index]],
    }
  }) as [RhythmMachineState, RhythmMachineState]
  return {
    ...base,
    name: 'ABYSSAL SIGNAL — 48 BAR DEMO',
    tempo: 140,
    swing: 9,
    master: 0.73,
    compressor: 42,
    masterDrive: 12,
    filterCutoff: 96,
    filterResonance: 10,
    delayTime: 40,
    delayFeedback: 34,
    delayMix: 0,
    reverbMix: 0,
    demoAutoMix: false,
    reverbTone: 54,
    crossfader: 0,
    mode: 'song',
    bass,
    rhythms,
    songChain,
    songScenes: [
      { name: 'INTRO', start: 0 },
      { name: 'BUILD', start: 8 },
      { name: 'DROP A', start: 16 },
      { name: 'BREAKDOWN', start: 24 },
      { name: 'DROP B', start: 32 },
      { name: 'OUTRO', start: 40 },
    ],
  }
}

/**
 * Applies the latest held automation frame. The engine can call this before its
 * pattern substitution at each bar; until then the frames remain useful score data.
 */
export function applyDubstepBarAutomation(project: ProjectState, zeroBasedBar: number): ProjectState {
  if (!project.demoAutoMix) return project
  const bar = zeroBasedBar + 1
  return DUBSTEP_AUTOMATION_FRAMES
    .filter((frame) => frame.bar <= bar)
    .reduce<ProjectState>((state, frame) => ({
      ...state,
      ...(frame.global ?? {}),
      ...(frame.global?.delayMix !== undefined ? { delayMix: Math.round(frame.global.delayMix * 0.4) } : {}),
      ...(frame.global?.reverbMix !== undefined ? { reverbMix: Math.round(frame.global.reverbMix * 0.4) } : {}),
      ...(frame.global?.masterDrive !== undefined ? { masterDrive: Math.round(frame.global.masterDrive * 0.65) } : {}),
      bass: state.bass.map((voice, index) => {
        const changes = frame.bass?.[index] ?? {}
        return { ...voice, ...changes, ...(index === 1 && changes.drive !== undefined ? { drive: Math.min(45, changes.drive) } : {}), ...(index === 1 && changes.resonance !== undefined ? { resonance: Math.min(65, changes.resonance) } : {}) }
      }) as [BassVoice, BassVoice],
      rhythms: state.rhythms.map((machine, index) => ({ ...machine, ...(frame.rhythms?.[index] ?? {}) })) as [RhythmMachineState, RhythmMachineState],
    }), project)
}

export function dubstepSectionForBar(zeroBasedBar: number): DubstepAutomationFrame['section'] {
  const bar = zeroBasedBar + 1
  if (bar <= 8) return 'INTRO'
  if (bar <= 16) return 'BUILD'
  if (bar <= 24) return 'DROP A'
  if (bar <= 32) return 'BREAKDOWN'
  if (bar <= 40) return 'DROP B'
  return 'OUTRO'
}

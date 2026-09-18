import { drumNames, type BassStep, type DrumName, type DrumStep, type ProjectState, type SongCue } from '../model'

type BassEvent = readonly [step: number, note: number, accent?: boolean, slide?: boolean]
type Hits = Partial<Record<DrumName, { notes: number[]; accents?: number[] }>>

const bassPattern = (events: readonly BassEvent[], root = 36): BassStep[] => {
  const steps: BassStep[] = Array.from({ length: 16 }, () => ({ active: false, note: root, accent: false, slide: false, octave: 0 as const }))
  events.forEach(([step, note, accent = false, slide = false]) => { steps[step - 1] = { active: true, note, accent, slide, octave: 0 } })
  return steps
}

const drumPattern = (hits: Hits): Record<DrumName, DrumStep[]> => Object.fromEntries(drumNames.map((name) => {
  const notes = hits[name]?.notes ?? []
  const accents = hits[name]?.accents ?? []
  return [name, Array.from({ length: 16 }, (_, index) => accents.includes(index + 1) ? 2 : notes.includes(index + 1) ? 1 : 0)]
})) as Record<DrumName, DrumStep[]>

const install = <T,>(original: T[], authored: T[]): T[] => original.map((pattern, index) => authored[index] ?? pattern)
const cue = (bassA: number, bassB: number, drumA: number, drumB: number): SongCue => ({ bass: [bassA, bassB], drums: [drumA, drumB] })
const all = [1, 3, 5, 7, 9, 11, 13, 15]

/** Original breakbeat study, informed by the late-90s big-beat vocabulary. */
export function createMatrixBreakProject(base: ProjectState): ProjectState {
  const bassA = [
    bassPattern([]),
    bassPattern([[1, 40, true], [4, 40], [7, 43], [9, 40, true], [12, 38], [15, 35]]),
    bassPattern([[1, 40, true], [3, 47], [6, 43], [8, 38], [9, 40, true], [11, 43], [14, 38], [16, 35]]),
    bassPattern([[1, 40], [9, 38]]),
  ]
  const bassB = [
    bassPattern([], 52),
    bassPattern([[3, 52], [7, 55], [11, 52, true], [15, 59]], 52),
    bassPattern([[2, 52], [6, 55, true], [8, 59], [10, 55], [14, 52], [16, 50]], 52),
    bassPattern([[7, 55], [15, 59]], 52),
  ]
  const drumsA = [
    drumPattern({ kick: { notes: [1, 9] }, closedHat: { notes: [3, 7, 11, 15] } }),
    drumPattern({ kick: { notes: [1, 4, 7, 9, 12, 15], accents: [1, 9] }, snare: { notes: [5, 13], accents: [5, 13] }, closedHat: { notes: all }, openHat: { notes: [8, 16] }, rim: { notes: [16] } }),
    drumPattern({ kick: { notes: [1, 3, 7, 9, 10, 15], accents: [1, 9] }, snare: { notes: [5, 12, 13, 16], accents: [5, 13] }, closedHat: { notes: all }, openHat: { notes: [8] }, clap: { notes: [13] } }),
    drumPattern({ kick: { notes: [1] }, snare: { notes: [13] }, closedHat: { notes: [7, 15] } }),
  ]
  const drumsB = [
    drumPattern({}),
    drumPattern({ closedHat: { notes: [2, 6, 10, 14] }, clap: { notes: [5, 13] }, rim: { notes: [4, 12] } }),
    drumPattern({ closedHat: { notes: all }, openHat: { notes: [4, 12] }, clap: { notes: [5, 13] }, lowTom: { notes: [15] }, midTom: { notes: [16] } }),
    drumPattern({ rim: { notes: [4, 12] }, closedHat: { notes: [3, 11] } }),
  ]
  const songChain = Array.from({ length: 32 }, (_, bar) => {
    if (bar < 4) return cue(0, 0, 0, 0)
    if (bar < 12) return cue(1, bar % 4 === 3 ? 3 : 1, bar % 4 === 3 ? 2 : 1, 1)
    if (bar < 16) return cue(3, 0, 3, 3)
    if (bar < 24) return cue(2, bar % 4 === 3 ? 2 : 1, bar % 4 === 3 ? 2 : 1, 2)
    if (bar < 28) return cue(3, 3, 0, 3)
    return cue(2, 2, 2, 2)
  })
  return {
    ...base,
    name: 'MATRIX BREAK — BIG BEAT TRIBUTE',
    tempo: 112, swing: 24, master: 0.73, compressor: 31, masterDrive: 13,
    filterCutoff: 88, filterResonance: 8, delayTime: 24, delayFeedback: 17,
    delayMix: 4, reverbMix: 3, reverbTone: 46, softenAmount: 68,
    effectsEnabled: true, demoAutoMix: false, crossfader: 0, mode: 'song',
    bass: [
      { ...base.bass[0], name: 'CINEMATIC LOW END', waveform: 'square', cutoff: 24, resonance: 24, envMod: 37, decay: 43, drive: 13, delay: 2, reverb: 2, level: 80, eqLow: 58, eqMid: 48, eqHigh: 43, patterns: install(base.bass[0].patterns, bassA), steps: bassA[0], bank: 0, pattern: 0 },
      { ...base.bass[1], name: 'CHOPPED STABS', waveform: 'sawtooth', cutoff: 55, resonance: 33, envMod: 44, decay: 25, drive: 21, delay: 9, reverb: 4, level: 51, eqLow: 36, eqMid: 57, eqHigh: 48, patterns: install(base.bass[1].patterns, bassB), steps: bassB[0], bank: 0, pattern: 0 },
    ],
    rhythms: [
      { ...base.rhythms[0], level: 84, delay: 0, reverb: 2, eqLow: 62, eqMid: 52, eqHigh: 48, patterns: install(base.rhythms[0].patterns, drumsA), steps: drumsA[0], bank: 0, pattern: 0 },
      { ...base.rhythms[1], level: 62, delay: 0, reverb: 4, eqLow: 45, eqMid: 55, eqHigh: 54, patterns: install(base.rhythms[1].patterns, drumsB), steps: drumsB[0], bank: 0, pattern: 0 },
    ],
    waveDesigner: { ...base.waveDesigner, name: 'NEON HAZE', waveform: 'triangle', attack: 35, release: 50, cutoff: 42, resonance: 12, drive: 4, level: 34, delay: 5, reverb: 7, steps: bassPattern([[1, 64], [9, 59]], 59) },
    songChain,
    songScenes: [{ name: 'COLD OPEN', start: 0 }, { name: 'BREAK IN', start: 4 }, { name: 'HOLD', start: 12 }, { name: 'CHASE', start: 16 }, { name: 'AIRLOCK', start: 24 }, { name: 'FINAL CUT', start: 28 }],
  }
}

/** Original four-on-the-floor acid study, not a transcription or recording. */
export function createBloodRaveProject(base: ProjectState): ProjectState {
  const bassA = [
    bassPattern([]),
    bassPattern([[1, 36, true, true], [2, 36], [5, 39], [7, 41, false, true], [8, 43], [9, 36, true], [12, 34], [15, 31]]),
    bassPattern([[1, 36, true], [3, 39], [4, 43, false, true], [5, 46], [7, 43], [9, 36, true], [11, 39], [12, 41, false, true], [13, 43], [15, 34], [16, 31]]),
    bassPattern([[1, 36], [9, 36], [13, 31]]),
  ]
  const bassB = [
    bassPattern([], 48),
    bassPattern([[3, 48], [7, 51], [11, 55], [15, 51]], 48),
    bassPattern([[2, 48], [4, 51], [6, 55], [8, 58], [10, 55], [12, 51], [14, 48], [16, 46]], 48),
    bassPattern([[7, 48], [15, 55]], 48),
  ]
  const drumsA = [
    drumPattern({ kick: { notes: [1, 5, 9, 13], accents: [1, 9] }, closedHat: { notes: [3, 7, 11, 15] } }),
    drumPattern({ kick: { notes: [1, 5, 9, 13], accents: [1, 9] }, snare: { notes: [5, 13] }, closedHat: { notes: all }, openHat: { notes: [7, 15] } }),
    drumPattern({ kick: { notes: [1, 5, 9, 13], accents: [1, 9] }, snare: { notes: [5, 13], accents: [13] }, closedHat: { notes: [2, 4, 6, 8, 10, 12, 14, 16] }, openHat: { notes: [7, 15] }, clap: { notes: [13] } }),
    drumPattern({ kick: { notes: [1, 9] }, closedHat: { notes: [3, 11] } }),
  ]
  const drumsB = [
    drumPattern({}),
    drumPattern({ clap: { notes: [5, 13] }, closedHat: { notes: [2, 6, 10, 14] }, rim: { notes: [16] } }),
    drumPattern({ clap: { notes: [5, 13] }, closedHat: { notes: all }, openHat: { notes: [4, 12] }, lowTom: { notes: [15] }, highTom: { notes: [16] } }),
    drumPattern({ rim: { notes: [4, 12] }, closedHat: { notes: [7, 15] } }),
  ]
  const songChain = Array.from({ length: 40 }, (_, bar) => {
    if (bar < 8) return cue(bar < 4 ? 0 : 3, 0, 0, 0)
    if (bar < 16) return cue(1, bar % 4 === 3 ? 3 : 0, 1, 1)
    if (bar < 28) return cue(bar % 4 === 3 ? 2 : 1, bar % 4 === 3 ? 2 : 1, 2, 2)
    if (bar < 32) return cue(3, 0, 3, 3)
    if (bar < 36) return cue(2, 2, 2, 2)
    return cue(1, 3, 1, 1)
  })
  return {
    ...base,
    name: 'BLOOD RAVE — ACID TECHNO TRIBUTE',
    tempo: 132, swing: 6, master: 0.71, compressor: 44, masterDrive: 17,
    filterCutoff: 87, filterResonance: 10, delayTime: 20, delayFeedback: 18,
    delayMix: 4, reverbMix: 2, reverbTone: 44, softenAmount: 72,
    effectsEnabled: true, demoAutoMix: false, crossfader: 0, mode: 'song',
    bass: [
      { ...base.bass[0], name: 'NIGHT RUNNER', waveform: 'sawtooth', cutoff: 38, resonance: 47, envMod: 62, decay: 34, accent: 75, drive: 26, delay: 4, reverb: 1, level: 78, eqLow: 54, eqMid: 55, eqHigh: 47, patterns: install(base.bass[0].patterns, bassA), steps: bassA[0], bank: 0, pattern: 0 },
      { ...base.bass[1], name: 'SHADOW PULSE', waveform: 'square', cutoff: 19, resonance: 24, envMod: 27, decay: 42, drive: 9, delay: 0, reverb: 0, level: 50, eqLow: 59, eqMid: 46, eqHigh: 35, patterns: install(base.bass[1].patterns, bassB), steps: bassB[0], bank: 0, pattern: 0 },
    ],
    rhythms: [
      { ...base.rhythms[0], level: 74, delay: 0, reverb: 2, eqLow: 63, eqMid: 48, eqHigh: 44, patterns: install(base.rhythms[0].patterns, drumsA), steps: drumsA[0], bank: 0, pattern: 0 },
      { ...base.rhythms[1], level: 76, delay: 0, reverb: 3, eqLow: 58, eqMid: 54, eqHigh: 52, patterns: install(base.rhythms[1].patterns, drumsB), steps: drumsB[0], bank: 0, pattern: 0 },
    ],
    waveDesigner: { ...base.waveDesigner, name: 'DARK AIR', waveform: 'sine', level: 0, delay: 0, reverb: 0, steps: bassPattern([], 60) },
    songChain,
    songScenes: [{ name: 'DOORS OPEN', start: 0 }, { name: 'PULSE', start: 8 }, { name: 'BLOOD FLOOR', start: 16 }, { name: 'BLACKOUT', start: 28 }, { name: 'FINAL RUSH', start: 32 }, { name: 'EXIT', start: 36 }],
  }
}

import { type Clip, type NoteStep, type Pattern, type Project, type Track, emptyStep } from './model'

const notes = (root: number, offsets: (number | null)[], accents: number[] = [], slides: number[] = []): NoteStep[] =>
  offsets.map((offset, i) =>
    offset === null
      ? emptyStep(root)
      : { ...emptyStep(root + offset), on: true, accent: accents.includes(i), slide: slides.includes(i) },
  )

const lane = (voice: string, steps: number[], accents: number[] = []) => ({
  voice,
  hits: Array.from({ length: 16 }, (_, i) => (accents.includes(i) ? 2 : steps.includes(i) ? 1 : 0)),
})

const track = (id: string, name: string, kind: Track['kind'], device: string, color: string, patch: Partial<Track> = {}): Track => ({
  id,
  name,
  kind,
  device,
  color,
  volume: -6,
  pan: 0,
  mute: false,
  solo: false,
  sends: { delay: { level: 0, tap: 'post' }, reverb: { level: 0, tap: 'post' } },
  macros: [0.42, 0.55, 0.6, 0.38, 0.5, 0.3, 0.5, 0.2],
  ...patch,
})

const patterns: Pattern[] = [
  {
    id: 'pat-acid-a',
    name: 'Squelch A',
    kind: 'notes',
    length: 16,
    steps: notes(36, [0, null, 12, 0, 3, null, 15, 0, null, 7, 0, 10, null, 12, 3, 0], [2, 6, 13], [3, 9, 14]),
  },
  {
    id: 'pat-acid-b',
    name: 'Answer riff',
    kind: 'notes',
    length: 16,
    steps: notes(48, [0, null, null, 3, null, 7, null, null, 10, null, 12, null, 7, null, 3, null], [5, 10], [3, 12]),
  },
  {
    id: 'pat-wave-pad',
    name: 'Night pad',
    kind: 'notes',
    length: 16,
    steps: notes(53, [0, null, null, null, null, null, null, null, 3, null, null, null, null, null, null, null]),
  },
  {
    id: 'pat-808-intro',
    name: 'Intro beat',
    kind: 'drums',
    length: 16,
    lanes: [lane('BD', [0, 10]), lane('SD', []), lane('CH', [2, 6, 10, 14]), lane('OH', []), lane('CP', [12]), lane('LT', []), lane('HT', []), lane('RS', [7])],
  },
  {
    id: 'pat-808-main',
    name: 'Main beat',
    kind: 'drums',
    length: 16,
    lanes: [lane('BD', [0, 7, 10], [0]), lane('SD', [4, 12], [12]), lane('CH', [0, 2, 4, 6, 8, 10, 12, 14]), lane('OH', [14]), lane('CP', [12]), lane('LT', []), lane('HT', [15]), lane('RS', [3, 11])],
  },
  {
    id: 'pat-909-hats',
    name: 'Ride hats',
    kind: 'drums',
    length: 16,
    lanes: [lane('BD', []), lane('SD', []), lane('CH', [1, 3, 5, 7, 9, 11, 13, 15], [3, 11]), lane('OH', [6, 14]), lane('CP', []), lane('LT', []), lane('HT', []), lane('RS', [])],
  },
]

const clip = (id: string, trackId: string, patternId: string, start: number, length: number): Clip => ({
  id,
  trackId,
  patternId,
  start,
  length,
  offset: 0,
})

export function demoProject(): Project {
  return {
    name: 'Night Shift',
    tempo: 124,
    swing: 0.08,
    length: 40,
    tracks: [
      track('acid-1', 'Acid 1', 'acid', 'Acid Synth', '#a3bd4c', { volume: -4, sends: { delay: { level: 0.12, tap: 'post' }, reverb: { level: 0, tap: 'post' } } }),
      track('acid-2', 'Acid 2', 'acid', 'Acid Synth', '#c58f43', { mute: true, sends: { delay: { level: 0.38, tap: 'pre' }, reverb: { level: 0.06, tap: 'post' } } }),
      track('wave', 'Wave', 'wave', 'Wave Synth', '#5ea3a0', { volume: -8, sends: { delay: { level: 0, tap: 'post' }, reverb: { level: 0.34, tap: 'post' } } }),
      track('808', '808', 'drum', 'Drum Machine · 808', '#bd6a4d', { volume: -3 }),
      track('909', '909', 'drum', 'Drum Machine · 909', '#ad965e', { volume: -6, sends: { delay: { level: 0, tap: 'post' }, reverb: { level: 0.1, tap: 'post' } } }),
      track('sampler', 'Sampler', 'sampler', 'Sampler', '#9283b8', { volume: -5, sends: { delay: { level: 0, tap: 'post' }, reverb: { level: 0.2, tap: 'post' } } }),
    ],
    returns: {
      delay: { id: 'delay', name: 'Tape Delay', level: -6, mute: false, feedback: 0.62, beats: 0.75 },
      reverb: { id: 'reverb', name: 'Plate', level: -9, mute: false, decay: 2.4 },
    },
    patterns: Object.fromEntries(patterns.map((pattern) => [pattern.id, pattern])),
    clips: [
      clip('c-a1-1', 'acid-1', 'pat-acid-a', 8, 4),
      clip('c-a1-2', 'acid-1', 'pat-acid-a', 12, 4),
      clip('c-a1-3', 'acid-1', 'pat-acid-a', 16, 4),
      clip('c-a1-4', 'acid-1', 'pat-acid-a', 20, 4),
      clip('c-a1-5', 'acid-1', 'pat-acid-a', 24, 4),
      clip('c-a1-6', 'acid-1', 'pat-acid-a', 28, 4),
      clip('c-a2-1', 'acid-2', 'pat-acid-b', 16, 8),
      clip('c-a2-2', 'acid-2', 'pat-acid-b', 24, 8),
      clip('c-w-1', 'wave', 'pat-wave-pad', 0, 8),
      clip('c-w-2', 'wave', 'pat-wave-pad', 16, 16),
      clip('c-w-3', 'wave', 'pat-wave-pad', 32, 8),
      clip('c-808-1', '808', 'pat-808-intro', 0, 8),
      clip('c-808-2', '808', 'pat-808-main', 8, 8),
      clip('c-808-3', '808', 'pat-808-main', 16, 8),
      clip('c-808-4', '808', 'pat-808-main', 24, 8),
      clip('c-808-5', '808', 'pat-808-intro', 32, 8),
      clip('c-909-1', '909', 'pat-909-hats', 16, 16),
    ],
    sections: [
      { id: 'sec-intro', name: 'Intro', start: 0, length: 8, color: '#5d6e60' },
      { id: 'sec-build', name: 'Build', start: 8, length: 8, color: '#77704d' },
      { id: 'sec-drop', name: 'Drop', start: 16, length: 16, color: '#86574a' },
      { id: 'sec-outro', name: 'Outro', start: 32, length: 8, color: '#51616f' },
    ],
    sample: null,
    fxSafeBypass: false,
  }
}

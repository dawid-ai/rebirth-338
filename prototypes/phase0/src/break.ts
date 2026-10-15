import { type Sample, type SliceMode, uid } from './model'

// Synthetic two-bar breaks stand in for real audio in the Phase 0
// prototype. Each break is a deterministic list of hits on a 32-step grid.

export interface LibrarySample {
  file: string
  bpm: number
  seed: number
  feel: string
}

export const LIBRARY: LibrarySample[] = [
  { file: 'dusty_break_93.wav', bpm: 93.4, seed: 3, feel: 'Loose, ghost snares' },
  { file: 'ride_break_101.wav', bpm: 101, seed: 7, feel: 'Bright ride, busy kick' },
  { file: 'shuffle_break_88.wav', bpm: 88.2, seed: 11, feel: 'Shuffled hats' },
]

type HitKind = 'kick' | 'snare' | 'ghost' | 'hat'
interface Hit {
  step: number
  kind: HitKind
  amp: number
}

const STEPS = 32

function random(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function breakHits(seed: number): Hit[] {
  const rand = random(seed)
  const hits: Hit[] = []
  for (const step of [0, 10, 16, 23, 26]) hits.push({ step, kind: 'kick', amp: 0.86 + rand() * 0.14 })
  for (const step of [4, 12, 20, 28]) hits.push({ step, kind: 'snare', amp: 0.78 + rand() * 0.18 })
  for (const step of [7, 15, 19, 31]) if (rand() > 0.3) hits.push({ step, kind: 'ghost', amp: 0.28 + rand() * 0.14 })
  for (let step = 0; step < STEPS; step += 2) hits.push({ step, kind: 'hat', amp: 0.18 + rand() * 0.12 })
  return hits.sort((a, b) => a.step - b.step)
}

const DECAY: Record<HitKind, number> = { kick: 0.014, snare: 0.011, ghost: 0.005, hat: 0.0028 }

// Returns `points` peak values in 0..1 across the break.
export function breakPeaks(seed: number, points: number): number[] {
  const hits = breakHits(seed)
  const rand = random(seed * 31 + 1)
  const peaks: number[] = []
  for (let i = 0; i < points; i += 1) {
    const x = i / points
    let value = 0.015 + rand() * 0.02
    for (const hit of hits) {
      const dx = x - hit.step / STEPS
      if (dx < 0 || dx > DECAY[hit.kind] * 6) continue
      value += hit.amp * Math.exp(-dx / DECAY[hit.kind]) * (0.35 + rand() * 0.65)
    }
    peaks.push(Math.min(1, value))
  }
  return peaks
}

export function transientPositions(seed: number) {
  const hits = breakHits(seed).filter((hit) => hit.kind !== 'hat' || hit.amp > 0.27)
  return [...new Set(hits.map((hit) => hit.step))].map((step) => step / STEPS)
}

export function slicePositions(seed: number, mode: SliceMode, count = 16): number[] {
  if (mode === 'transient') return transientPositions(seed)
  const divisions = mode === 'equal' ? count : mode === 'beat' ? 8 : 2
  return Array.from({ length: divisions }, (_, i) => i / divisions)
}

export function distributeToPads(slices: number[]): (number | null)[] {
  return Array.from({ length: 16 }, (_, pad) => (pad < slices.length ? pad : null))
}

export function importSample(item: LibrarySample): Sample {
  const slices = slicePositions(item.seed, 'transient')
  return {
    id: uid('smp'),
    name: item.file,
    seed: item.seed,
    bars: 2,
    bpm: item.bpm,
    bpmConfidence: 0.86 + (item.seed % 5) * 0.025,
    key: item.seed % 2 ? null : 'F minor',
    keyConfidence: item.seed % 2 ? 0 : 0.41,
    mode: 'transient',
    slices,
    pads: distributeToPads(slices),
  }
}

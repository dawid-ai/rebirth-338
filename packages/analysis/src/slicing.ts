import { detectOnsetEvents, type OnsetOptions } from './onsets'

// Positions closer than this (normalized) are treated as duplicates.
const POSITION_EPSILON = 1e-9
// Zero-crossing search radius used when snapping transient slices.
const SNAP_SEARCH_SECONDS = 0.002

/** Sorts, de-duplicates, and bounds normalized slice starts to [0, 1), always starting at 0. */
export function normalizeSlicePositions(positions: readonly number[]): number[] {
  const sorted = positions.filter((position) => Number.isFinite(position) && position > 0 && position < 1).sort((a, b) => a - b)
  const result = [0]
  for (const position of sorted) {
    if (position - result[result.length - 1] > POSITION_EPSILON) result.push(position)
  }
  return result
}

/**
 * Nearest sample to `positionSamples`, within `searchSamples`, where the waveform crosses
 * zero. Returns the side of the crossing closer to zero, or the input when none is found.
 */
export function snapToZeroCrossing(mono: Float32Array, positionSamples: number, searchSamples: number): number {
  const length = mono.length
  if (length === 0) return 0
  const origin = Math.min(length - 1, Math.max(0, Math.round(positionSamples)))
  const radius = Math.max(0, Math.round(searchSamples))
  const crossingAt = (i: number): number | null => {
    if (i < 1 || i >= length) return null
    const a = mono[i - 1]
    const b = mono[i]
    if (b === 0) return i
    if (a === 0 || (a < 0) === (b < 0)) return null
    return Math.abs(a) < Math.abs(b) ? i - 1 : i
  }
  for (let distance = 0; distance <= radius; distance += 1) {
    const before = crossingAt(origin - distance)
    if (before !== null) return before
    const after = crossingAt(origin + distance + 1)
    if (after !== null) return after
  }
  return origin
}

export interface TransientSliceOptions extends OnsetOptions {
  /** Upper bound on the number of slices, including the one at 0. Defaults to 16. */
  maxSlices?: number
  /** Snap each slice to a nearby zero crossing to avoid clicks. Defaults to true. */
  snap?: boolean
}

/** Normalized slice starts at detected transients, keeping the strongest when there are too many. */
export function sliceByTransients(mono: Float32Array, sampleRate: number, options: TransientSliceOptions = {}): number[] {
  if (mono.length === 0) return [0]
  const maxSlices = Math.max(1, Math.floor(options.maxSlices ?? 16))
  const snap = options.snap ?? true
  const search = Math.round(SNAP_SEARCH_SECONDS * sampleRate)
  const events = detectOnsetEvents(mono, sampleRate, options)
    .map((event) => {
      const sample = Math.round(event.time * sampleRate)
      return { sample: snap ? snapToZeroCrossing(mono, sample, search) : sample, strength: event.strength }
    })
    .filter((event) => event.sample > 0)
    .sort((a, b) => b.strength - a.strength || a.sample - b.sample)
    .slice(0, maxSlices - 1)
  return normalizeSlicePositions(events.map((event) => event.sample / mono.length))
}

/** `count` equal slices. */
export function sliceEqual(count: number): number[] {
  const slices = Math.max(1, Math.floor(count))
  return normalizeSlicePositions(Array.from({ length: slices }, (_, index) => index / slices))
}

/** Slices every `beatsPerSlice` beats, optionally shifted by `offsetSeconds`. */
export function sliceByBeats(bpm: number, durationSeconds: number, beatsPerSlice = 1, offsetSeconds = 0): number[] {
  if (!(bpm > 0) || !(durationSeconds > 0) || !(beatsPerSlice > 0)) return [0]
  const sliceSeconds = (60 / bpm) * beatsPerSlice
  const first = offsetSeconds - Math.floor(offsetSeconds / sliceSeconds) * sliceSeconds
  const positions: number[] = []
  for (let index = 0; first + index * sliceSeconds < durationSeconds; index += 1) {
    positions.push((first + index * sliceSeconds) / durationSeconds)
  }
  return normalizeSlicePositions(positions)
}

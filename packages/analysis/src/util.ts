/** Planar channel data, one `Float32Array` per channel. Channels may differ in length. */
export type Channels = readonly Float32Array[]

/** Lowest decibel value any analysis returns, so results stay finite and JSON-safe. */
export const DB_FLOOR = -144

export function amplitudeToDb(amplitude: number): number {
  if (!(amplitude > 0)) return DB_FLOOR
  return Math.max(DB_FLOOR, 20 * Math.log10(amplitude))
}

export function powerToDb(power: number): number {
  if (!(power > 0)) return DB_FLOOR
  return Math.max(DB_FLOOR, 10 * Math.log10(power))
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** Length of the longest channel in samples. */
export function channelLength(channels: Channels): number {
  let length = 0
  for (const channel of channels) length = Math.max(length, channel.length)
  return length
}

/** Averages all channels into one; a single channel is returned as is. */
export function mixToMono(channels: Channels): Float32Array {
  if (channels.length === 1) return channels[0]
  const length = channelLength(channels)
  const mono = new Float32Array(length)
  if (channels.length === 0) return mono
  const gain = 1 / channels.length
  for (const channel of channels) {
    for (let i = 0; i < channel.length; i += 1) mono[i] += channel[i] * gain
  }
  return mono
}

/** Returns zero-copy views of every channel between two sample indices. */
export function sliceChannels(channels: Channels, start: number, end: number): Float32Array[] {
  return channels.map((channel) => channel.subarray(clamp(start, 0, channel.length), clamp(end, 0, channel.length)))
}

export function nextPowerOfTwo(value: number): number {
  let size = 1
  while (size < value) size *= 2
  return size
}

/** Deterministic 32-bit PRNG (mulberry32) returning values in [0, 1). */
export function createRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Reads `values` at a fractional index with linear interpolation; out-of-range reads return zero. */
export function interpolate(values: ArrayLike<number>, position: number): number {
  if (position < 0 || position > values.length - 1) return 0
  const index = Math.floor(position)
  const fraction = position - index
  if (fraction === 0 || index + 1 >= values.length) return values[index]
  return values[index] + (values[index + 1] - values[index]) * fraction
}

export function median(values: ArrayLike<number>): number {
  if (values.length === 0) return 0
  const sorted = Float64Array.from(values).sort()
  const middle = sorted.length >> 1
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

/** Frame start offsets covering `length` samples, capped at `maxFrames` evenly spaced frames. */
export function frameStarts(length: number, size: number, maxFrames: number): number[] {
  if (length <= size) return [0]
  const available = Math.floor((length - size) / size) + 1
  const count = Math.min(available, maxFrames)
  if (count === 1) return [0]
  const span = length - size
  const starts: number[] = []
  for (let i = 0; i < count; i += 1) starts.push(Math.round((i * span) / (count - 1)))
  return starts
}

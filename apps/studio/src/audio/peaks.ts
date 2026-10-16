// Waveform overviews for drawing. Peaks are computed once per buffer at a
// fixed resolution and resampled for each view.

const RESOLUTION = 4096
const cache = new WeakMap<AudioBuffer, { min: Float32Array; max: Float32Array }>()

function base(buffer: AudioBuffer) {
  let entry = cache.get(buffer)
  if (entry) return entry
  const buckets = Math.min(RESOLUTION, buffer.length)
  const min = new Float32Array(buckets).fill(1)
  const max = new Float32Array(buckets).fill(-1)
  const size = buffer.length / buckets
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const data = buffer.getChannelData(channel)
    for (let b = 0; b < buckets; b += 1) {
      const start = Math.floor(b * size)
      const end = Math.min(data.length, Math.floor((b + 1) * size))
      let lo = min[b]
      let hi = max[b]
      for (let i = start; i < end; i += 1) {
        const v = data[i]
        if (v < lo) lo = v
        if (v > hi) hi = v
      }
      min[b] = lo
      max[b] = hi
    }
  }
  entry = { min, max }
  cache.set(buffer, entry)
  return entry
}

/** Min/max pairs for `count` columns across the normalized range [from, to]. */
export function peaks(buffer: AudioBuffer, count: number, from = 0, to = 1): { min: number; max: number }[] {
  const { min, max } = base(buffer)
  const total = min.length
  const out: { min: number; max: number }[] = []
  for (let i = 0; i < count; i += 1) {
    const a = Math.floor((from + ((to - from) * i) / count) * total)
    const b = Math.max(a + 1, Math.floor((from + ((to - from) * (i + 1)) / count) * total))
    let lo = 1
    let hi = -1
    for (let j = Math.max(0, a); j < Math.min(total, b); j += 1) {
      if (min[j] < lo) lo = min[j]
      if (max[j] > hi) hi = max[j]
    }
    out.push(hi < lo ? { min: 0, max: 0 } : { min: lo, max: hi })
  }
  return out
}

/** Mono mixdown, for analysis. */
export function mono(buffer: AudioBuffer): Float32Array {
  const out = new Float32Array(buffer.length)
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const data = buffer.getChannelData(channel)
    for (let i = 0; i < data.length; i += 1) out[i] += data[i] / buffer.numberOfChannels
  }
  return out
}

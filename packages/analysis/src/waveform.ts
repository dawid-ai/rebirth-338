import { channelLength, type Channels } from './util'

export interface PeakBucket {
  min: number
  max: number
}

/** Min and max across all channels for `buckets` equal spans of the signal, for waveform drawing. */
export function peaksForDisplay(channels: Channels, buckets: number): PeakBucket[] {
  const count = Math.max(0, Math.floor(buckets))
  const length = channelLength(channels)
  const result: PeakBucket[] = []
  if (length === 0) {
    for (let i = 0; i < count; i += 1) result.push({ min: 0, max: 0 })
    return result
  }
  for (let bucket = 0; bucket < count; bucket += 1) {
    const start = Math.floor((bucket * length) / count)
    // A bucket narrower than one sample still shows the sample it falls on.
    const end = Math.max(start + 1, Math.floor(((bucket + 1) * length) / count))
    let min = Infinity
    let max = -Infinity
    for (const channel of channels) {
      const channelEnd = Math.min(end, channel.length)
      for (let i = start; i < channelEnd; i += 1) {
        const value = channel[i]
        if (value < min) min = value
        if (value > max) max = value
      }
    }
    result.push(min <= max ? { min, max } : { min: 0, max: 0 })
  }
  return result
}

/** Linear RMS of consecutive `windowSeconds` windows; the last window may be partial. */
export function rmsEnvelope(mono: Float32Array, sampleRate: number, windowSeconds: number): Float32Array {
  const window = Math.max(1, Math.round(windowSeconds * sampleRate))
  const envelope = new Float32Array(Math.ceil(mono.length / window))
  for (let index = 0; index < envelope.length; index += 1) {
    const start = index * window
    const end = Math.min(mono.length, start + window)
    let sum = 0
    for (let i = start; i < end; i += 1) sum += mono[i] * mono[i]
    envelope[index] = Math.sqrt(sum / (end - start))
  }
  return envelope
}

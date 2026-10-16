import { channelLength, powerToDb, type Channels } from './util'

export interface TailOptions {
  /** Level relative to the reference at which the tail counts as gone, in dB. */
  thresholdDb?: number
  /** RMS envelope window in seconds. */
  windowSeconds?: number
}

export interface TailEstimate {
  /** Seconds after `fromSeconds` until the envelope last sits at or above the threshold. */
  tailSeconds: number
  /** RMS level of the window centered on `fromSeconds`, in dBFS. */
  referenceDb: number
  /** True when the signal ends before the tail decays below the threshold. */
  truncated: boolean
}

/**
 * Measures how long a delay or reverb tail rings after `fromSeconds`. The tail ends at the
 * last envelope window within `thresholdDb` of the reference, so gaps between echo
 * repeats do not cut the measurement short.
 */
export function estimateTail(channels: Channels, sampleRate: number, fromSeconds: number, options: TailOptions = {}): TailEstimate {
  const thresholdDb = options.thresholdDb ?? -60
  const window = Math.max(1, Math.round((options.windowSeconds ?? 0.01) * sampleRate))
  const length = channelLength(channels)
  const from = Math.round(fromSeconds * sampleRate)
  const windowPower = (center: number): number => {
    const start = Math.max(0, center - (window >> 1))
    const end = Math.min(length, start + window)
    if (end <= start) return 0
    let sum = 0
    for (const channel of channels) {
      const channelEnd = Math.min(end, channel.length)
      for (let i = start; i < channelEnd; i += 1) sum += channel[i] * channel[i]
    }
    return sum / ((end - start) * Math.max(1, channels.length))
  }
  const reference = windowPower(from)
  if (reference === 0 || from >= length) return { tailSeconds: 0, referenceDb: powerToDb(reference), truncated: false }
  const limit = reference * 10 ** (thresholdDb / 10)
  let lastAbove = 0
  let index = 0
  for (let center = from; center < length; center += window, index += 1) {
    if (windowPower(center) >= limit) lastAbove = index
  }
  const truncated = lastAbove === index - 1 && index > 1
  return { tailSeconds: (lastAbove * window) / sampleRate, referenceDb: powerToDb(reference), truncated }
}

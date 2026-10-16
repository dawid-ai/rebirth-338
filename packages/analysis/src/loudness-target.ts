import { integratedLoudness, truePeak } from './levels'
import { type Channels } from './util'

export interface LoudnessMatch {
  /** Gain applied, in dB. */
  gainDb: number
  /** Integrated loudness after the gain. */
  lufs: number
  truePeakDb: number
  /** True when the ceiling stopped the gain short of the target. */
  limitedByCeiling: boolean
}

/**
 * Applies one static gain so the signal reaches `targetLufs`, without letting
 * true peaks pass `ceilingDbtp`. It never compresses or limits: if the target
 * needs more gain than the ceiling allows, it stops at the ceiling and says so.
 */
export function matchLoudness(channels: Channels, sampleRate: number, targetLufs: number, ceilingDbtp: number): { channels: Float32Array[]; result: LoudnessMatch } {
  const measured = integratedLoudness(channels, sampleRate)
  const peakDb = truePeak(channels, sampleRate)
  if (!Number.isFinite(measured) || measured < -70) {
    return { channels: channels.map((c) => new Float32Array(c)), result: { gainDb: 0, lufs: measured, truePeakDb: peakDb, limitedByCeiling: false } }
  }
  const wanted = targetLufs - measured
  const headroom = ceilingDbtp - peakDb
  const gainDb = Math.min(wanted, headroom)
  const gain = 10 ** (gainDb / 20)
  const out = channels.map((c) => {
    const copy = new Float32Array(c.length)
    for (let i = 0; i < c.length; i += 1) copy[i] = c[i] * gain
    return copy
  })
  return { channels: out, result: { gainDb, lufs: measured + gainDb, truePeakDb: peakDb + gainDb, limitedByCeiling: wanted > headroom + 1e-6 } }
}

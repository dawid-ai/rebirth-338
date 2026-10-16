import { SpectrumAnalyzer } from './fft'
import { clamp, frameStarts, nextPowerOfTwo } from './util'

export const PITCH_CLASSES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'] as const
export type PitchClass = (typeof PITCH_CLASSES)[number]
export type KeyName = `${PitchClass} ${'major' | 'minor'}`

export interface KeyEstimate {
  /** Detected key, or null when the evidence is too weak. */
  key: KeyName | null
  /** 0..1 */
  confidence: number
}

// Krumhansl-Kessler probe-tone profiles, starting on the tonic.
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]
/** Estimates below this confidence return `key: null`. */
export const KEY_MIN_CONFIDENCE = 0.35
// Ties with the runner-up halve the confidence; a lead of half this scale keeps the full correlation.
const KEY_MARGIN_SCALE = 0.2
const CHROMA_MIN_HZ = 80
const CHROMA_MAX_HZ = 5000
const CHROMA_FRAME_SECONDS = 0.18
const MAX_CHROMA_FRAMES = 128

/** Average 12-bin pitch-class profile (C first), normalized so the bins sum to 1. */
export function chromagram(mono: Float32Array, sampleRate: number): Float64Array {
  const chroma = new Float64Array(12)
  if (mono.length === 0) return chroma
  const analyzer = new SpectrumAnalyzer(nextPowerOfTwo(Math.round(CHROMA_FRAME_SECONDS * sampleRate)))
  const spectrum = new Float64Array(analyzer.binCount)
  const pitchClassOfBin = new Int8Array(analyzer.binCount).fill(-1)
  for (let k = 1; k < analyzer.binCount; k += 1) {
    const frequency = analyzer.binFrequency(k, sampleRate)
    if (frequency < CHROMA_MIN_HZ || frequency > CHROMA_MAX_HZ) continue
    const midi = Math.round(12 * Math.log2(frequency / 440) + 69)
    pitchClassOfBin[k] = ((midi % 12) + 12) % 12
  }
  for (const start of frameStarts(mono.length, analyzer.size, MAX_CHROMA_FRAMES)) {
    analyzer.magnitudes(mono, start, spectrum)
    for (let k = 1; k < analyzer.binCount; k += 1) {
      const pitchClass = pitchClassOfBin[k]
      if (pitchClass >= 0) chroma[pitchClass] += spectrum[k]
    }
  }
  const total = chroma.reduce((sum, value) => sum + value, 0)
  if (total > 0) for (let i = 0; i < 12; i += 1) chroma[i] /= total
  return chroma
}

function correlation(chroma: Float64Array, profile: readonly number[], tonic: number): number {
  let chromaMean = 0
  let profileMean = 0
  for (let i = 0; i < 12; i += 1) {
    chromaMean += chroma[i] / 12
    profileMean += profile[i] / 12
  }
  let covariance = 0
  let chromaVariance = 0
  let profileVariance = 0
  for (let i = 0; i < 12; i += 1) {
    const c = chroma[(i + tonic) % 12] - chromaMean
    const p = profile[i] - profileMean
    covariance += c * p
    chromaVariance += c * c
    profileVariance += p * p
  }
  if (chromaVariance === 0 || profileVariance === 0) return 0
  return covariance / Math.sqrt(chromaVariance * profileVariance)
}

/** Key via a chromagram correlated against the 24 rotated Krumhansl-Kessler profiles. */
export function estimateKey(mono: Float32Array, sampleRate: number): KeyEstimate {
  const chroma = chromagram(mono, sampleRate)
  const candidates: { key: KeyName; score: number }[] = []
  PITCH_CLASSES.forEach((pitchClass, tonic) => {
    candidates.push({ key: `${pitchClass} major`, score: correlation(chroma, MAJOR_PROFILE, tonic) })
    candidates.push({ key: `${pitchClass} minor`, score: correlation(chroma, MINOR_PROFILE, tonic) })
  })
  candidates.sort((a, b) => b.score - a.score)
  const [best, runnerUp] = candidates
  const confidence = clamp(best.score, 0, 1) * clamp(0.5 + (best.score - runnerUp.score) / KEY_MARGIN_SCALE, 0, 1)
  return { key: confidence >= KEY_MIN_CONFIDENCE ? best.key : null, confidence: Number(confidence.toFixed(3)) }
}

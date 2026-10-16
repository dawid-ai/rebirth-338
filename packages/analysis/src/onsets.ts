import { SpectrumAnalyzer } from './fft'
import { clamp, interpolate, median, nextPowerOfTwo } from './util'

/** Default spacing of onset-envelope frames, about 1024 samples at 44.1 kHz. */
export const ONSET_HOP_SECONDS = 0.0232
// Log compression applied to magnitudes before differencing, so quiet attacks still register.
const FLUX_COMPRESSION = 1000
// Adaptive threshold: local mean of the normalized envelope plus a sensitivity-dependent offset.
const THRESHOLD_MEAN_RADIUS_SECONDS = 0.1
const THRESHOLD_OFFSET_MIN = 0.02
const THRESHOLD_OFFSET_RANGE = 0.3
const PEAK_RADIUS_SECONDS = 0.03
// Energy windows used to place an onset at the attack within its envelope frame.
const REFINE_WINDOW_SECONDS = 0.005
const REFINE_ATTACK_FRACTION = 0.1

export interface OnsetEnvelope {
  /** Half-wave rectified spectral flux per frame. */
  values: Float32Array
  /** Seconds between frames; frame `j` is centered on `j * hopSeconds`. */
  hopSeconds: number
  hopSamples: number
}

export interface OnsetEnvelopeOptions {
  hopSeconds?: number
}

// Inputs whose halved rate still reaches this value are decimated by two (pairwise averaging)
// before the flux is computed. Content above the halved Nyquist adds little to onset detection,
// and decimating halves the cost.
const FLUX_MIN_DECIMATED_RATE = 16000

function decimateByTwo(mono: Float32Array): Float32Array {
  const result = new Float32Array(Math.ceil(mono.length / 2))
  for (let i = 0; i < result.length; i += 1) {
    const next = 2 * i + 1 < mono.length ? mono[2 * i + 1] : mono[2 * i]
    result[i] = (mono[2 * i] + next) * 0.5
  }
  return result
}

/** Spectral-flux onset strength with log-compressed magnitudes and Hann frames twice the hop. */
export function onsetEnvelope(mono: Float32Array, sampleRate: number, options: OnsetEnvelopeOptions = {}): OnsetEnvelope {
  const hopSeconds = options.hopSeconds ?? ONSET_HOP_SECONDS
  const decimate = sampleRate / 2 >= FLUX_MIN_DECIMATED_RATE
  const source = decimate ? decimateByTwo(mono) : mono
  const sourceHop = Math.max(1, Math.round((hopSeconds * sampleRate) / (decimate ? 2 : 1)))
  const hop = decimate ? sourceHop * 2 : sourceHop
  const analyzer = new SpectrumAnalyzer(Math.max(32, nextPowerOfTwo(sourceHop * 2)))
  const half = analyzer.size / 2
  const frames = mono.length > 0 ? Math.floor((mono.length - 1) / hop) + 1 : 0
  const values = new Float32Array(frames)
  let previous = new Float64Array(analyzer.binCount)
  let current = new Float64Array(analyzer.binCount)
  for (let j = 0; j < frames; j += 1) {
    analyzer.magnitudes(source, j * sourceHop - half, current)
    let flux = 0
    for (let k = 0; k < current.length; k += 1) {
      const compressed = Math.log1p(FLUX_COMPRESSION * current[k])
      current[k] = compressed
      const rise = compressed - previous[k]
      if (rise > 0) flux += rise
    }
    values[j] = flux
    const swap = previous
    previous = current
    current = swap
  }
  return { values, hopSeconds: hop / sampleRate, hopSamples: hop }
}

export interface OnsetOptions {
  /** 0..1; higher values report quieter onsets. Defaults to 0.5. */
  sensitivity?: number
  /** Minimum spacing between reported onsets in seconds. Defaults to 0.05. */
  minGapSeconds?: number
}

export interface OnsetEvent {
  /** Attack position in seconds. */
  time: number
  /** Envelope peak relative to the strongest onset, 0..1. */
  strength: number
}

/** Onsets with their relative strength, sorted by time. */
export function detectOnsetEvents(mono: Float32Array, sampleRate: number, options: OnsetOptions = {}): OnsetEvent[] {
  return pickOnsets(mono, sampleRate, onsetEnvelope(mono, sampleRate), options)
}

/** Onset times in seconds via adaptive-threshold peak picking on the spectral-flux envelope. */
export function detectOnsets(mono: Float32Array, sampleRate: number, options: OnsetOptions = {}): number[] {
  return detectOnsetEvents(mono, sampleRate, options).map((event) => event.time)
}

function pickOnsets(mono: Float32Array, sampleRate: number, envelope: OnsetEnvelope, options: OnsetOptions): OnsetEvent[] {
  const { values, hopSeconds, hopSamples } = envelope
  let max = 0
  for (const value of values) max = Math.max(max, value)
  if (max <= 0) return []
  const sensitivity = clamp(options.sensitivity ?? 0.5, 0, 1)
  const minGapSeconds = Math.max(0, options.minGapSeconds ?? 0.05)
  const offset = THRESHOLD_OFFSET_MIN + (1 - sensitivity) * THRESHOLD_OFFSET_RANGE
  const meanRadius = Math.max(1, Math.round(THRESHOLD_MEAN_RADIUS_SECONDS / hopSeconds))
  const peakRadius = Math.max(1, Math.round(PEAK_RADIUS_SECONDS / hopSeconds))
  const prefix = new Float64Array(values.length + 1)
  for (let j = 0; j < values.length; j += 1) prefix[j + 1] = prefix[j] + values[j] / max
  const candidates: { frame: number; strength: number }[] = []
  for (let j = 0; j < values.length; j += 1) {
    const strength = values[j] / max
    if (strength < offset) continue
    let isPeak = true
    for (let i = Math.max(0, j - peakRadius); i <= Math.min(values.length - 1, j + peakRadius); i += 1) {
      if (values[i] > values[j] || (i < j && values[i] === values[j])) {
        isPeak = false
        break
      }
    }
    if (!isPeak) continue
    const lo = Math.max(0, j - meanRadius)
    const hi = Math.min(values.length - 1, j + meanRadius)
    const localMean = (prefix[hi + 1] - prefix[lo]) / (hi - lo + 1)
    if (strength < localMean + offset) continue
    // An attack can split its flux across two frames, so strength sums the neighbors too.
    const total = (j > 0 ? values[j - 1] : 0) + values[j] + (j + 1 < values.length ? values[j + 1] : 0)
    candidates.push({ frame: j, strength: total })
  }
  const strongest = candidates.reduce((best, candidate) => Math.max(best, candidate.strength), 0)
  const events = candidates
    .map((candidate) => ({
      time: refineOnset(mono, candidate.frame * hopSamples, hopSamples, sampleRate) / sampleRate,
      strength: strongest > 0 ? candidate.strength / strongest : 0,
    }))
    .sort((a, b) => a.time - b.time)
  const kept: OnsetEvent[] = []
  for (const event of events) {
    const last = kept[kept.length - 1]
    if (last && event.time - last.time < minGapSeconds) {
      if (event.strength > last.strength) kept[kept.length - 1] = event
      continue
    }
    kept.push(event)
  }
  return kept
}

/**
 * Moves an onset found at frame resolution to its attack: first the point of largest
 * short-term energy rise near `center`, then the first sample that clears the
 * pre-attack level by a fraction of the attack peak.
 */
export function refineOnset(mono: Float32Array, center: number, hopSamples: number, sampleRate: number): number {
  const length = mono.length
  if (length === 0) return 0
  const window = Math.max(1, Math.round(REFINE_WINDOW_SECONDS * sampleRate))
  const radius = hopSamples
  const lo = clamp(center - radius, 0, length - 1)
  const hi = clamp(center + radius, 0, length - 1)
  const base = Math.max(0, lo - window)
  const top = Math.min(length, hi + window)
  const prefix = new Float64Array(top - base + 1)
  for (let i = base; i < top; i += 1) prefix[i - base + 1] = prefix[i - base] + mono[i] * mono[i]
  const energy = (from: number, to: number) => prefix[clamp(to, base, top) - base] - prefix[clamp(from, base, top) - base]
  let best = -Infinity
  let position = clamp(center, 0, length - 1)
  for (let p = lo; p <= hi; p += 1) {
    const rise = energy(p, p + window) - energy(p - window, p)
    if (rise > best) {
      best = rise
      position = p
    }
  }
  let attackPeak = 0
  for (let i = position; i < Math.min(length, position + 2 * window); i += 1) attackPeak = Math.max(attackPeak, Math.abs(mono[i]))
  let background = 0
  for (let i = Math.max(0, position - window); i < position; i += 1) background = Math.max(background, Math.abs(mono[i]))
  if (attackPeak <= background) return position
  const threshold = background + REFINE_ATTACK_FRACTION * (attackPeak - background)
  for (let i = position; i < Math.min(length, position + window); i += 1) {
    if (Math.abs(mono[i]) > threshold) return i
  }
  return position
}

// Detrends the envelope with a moving average and half-wave rectifies it, keeping only
// onsets that stand out from their surroundings.
function emphasizePeaks(envelope: OnsetEnvelope): Float64Array {
  const { values, hopSeconds } = envelope
  const radius = Math.max(1, Math.round(1 / hopSeconds))
  const prefix = new Float64Array(values.length + 1)
  for (let j = 0; j < values.length; j += 1) prefix[j + 1] = prefix[j] + values[j]
  const result = new Float64Array(values.length)
  for (let j = 0; j < values.length; j += 1) {
    const lo = Math.max(0, j - radius)
    const hi = Math.min(values.length - 1, j + radius)
    const mean = (prefix[hi + 1] - prefix[lo]) / (hi - lo + 1)
    result[j] = Math.max(0, values[j] - mean)
  }
  return result
}

// Number of lag multiples whose autocorrelation supports each tempo candidate.
const TEMPO_MULTIPLES = 4
const TEMPO_GRID_BPM = 0.1
// When double the best tempo keeps this fraction of its score, the faster tempo wins.
// A pure pulse at the slower tempo scores about 0.5 at double speed, so 0.8 separates the cases.
const OCTAVE_PREFERENCE = 0.8

export interface TempoOptions {
  min?: number
  max?: number
}

export interface TempoEstimate {
  /** Tempo in BPM, or 0 when no periodicity is found. */
  bpm: number
  /** 0..1; how far the winning periodicity stands above the median candidate. */
  confidence: number
}

function autocorrelation(signal: Float64Array, maxLag: number): Float64Array {
  const result = new Float64Array(maxLag + 1)
  const length = signal.length
  for (let lag = 0; lag <= maxLag; lag += 1) {
    let sum = 0
    for (let i = 0; i + lag < length; i += 1) sum += signal[i] * signal[i + lag]
    result[lag] = sum / (length - lag)
  }
  const zero = result[0]
  if (zero > 0) for (let lag = 0; lag <= maxLag; lag += 1) result[lag] /= zero
  return result
}

/** Tempo from the autocorrelation of the onset envelope, with octave-error handling. */
export function estimateTempo(mono: Float32Array, sampleRate: number, options: TempoOptions = {}): TempoEstimate {
  const envelope = onsetEnvelope(mono, sampleRate)
  return tempoFromEnvelope(emphasizePeaks(envelope), envelope.hopSeconds, options)
}

function tempoFromEnvelope(envelope: Float64Array, hopSeconds: number, options: TempoOptions): TempoEstimate {
  const minBpm = Math.max(1, options.min ?? 70)
  const maxBpm = Math.max(minBpm, options.max ?? 180)
  const lagOf = (bpm: number) => 60 / (bpm * hopSeconds)
  const maxLag = Math.min(envelope.length - 2, Math.ceil(lagOf(minBpm) * TEMPO_MULTIPLES) + 2)
  if (maxLag < lagOf(maxBpm) + 1) return { bpm: 0, confidence: 0 }
  const ac = autocorrelation(envelope, maxLag)
  if (ac[0] === 0) return { bpm: 0, confidence: 0 }
  const score = (bpm: number): number => {
    const lag = lagOf(bpm)
    let sum = 0
    let count = 0
    for (let k = 1; k <= TEMPO_MULTIPLES; k += 1) {
      if (k * lag > maxLag) break
      sum += interpolate(ac, k * lag)
      count += 1
    }
    return count > 0 ? sum / count : 0
  }
  const steps = Math.round((maxBpm - minBpm) / TEMPO_GRID_BPM)
  const scores = new Float64Array(steps + 1)
  let bestIndex = 0
  for (let i = 0; i <= steps; i += 1) {
    scores[i] = score(minBpm + i * TEMPO_GRID_BPM)
    if (scores[i] > scores[bestIndex]) bestIndex = i
  }
  let bpm = minBpm + bestIndex * TEMPO_GRID_BPM
  let bestScore = scores[bestIndex]
  if (bpm * 2 <= maxBpm) {
    // Search a small neighborhood of the doubled tempo, since grid points rarely align exactly.
    let doubled = bpm * 2
    let doubledScore = -Infinity
    for (let candidate = bpm * 2 * 0.98; candidate <= Math.min(maxBpm, bpm * 2 * 1.02); candidate += TEMPO_GRID_BPM) {
      const value = score(candidate)
      if (value > doubledScore) {
        doubledScore = value
        doubled = candidate
      }
    }
    if (doubledScore >= OCTAVE_PREFERENCE * bestScore) {
      bpm = doubled
      bestScore = doubledScore
    }
  }
  const confidence = clamp(bestScore - median(scores), 0, 1)
  return { bpm: refineTempo(ac, lagOf(bpm), maxLag, hopSeconds), confidence }
}

// Refines the period from the centroid of each autocorrelation peak at the lag multiples.
// Later multiples pin the period more precisely, so they get proportionally more weight.
function refineTempo(ac: Float64Array, lag: number, maxLag: number, hopSeconds: number): number {
  let weighted = 0
  let weights = 0
  for (let k = 1; k <= TEMPO_MULTIPLES; k += 1) {
    const expected = k * lag
    if (expected + 2 > maxLag) break
    let mass = 0
    let moment = 0
    for (let l = Math.max(0, Math.round(expected) - 2); l <= Math.round(expected) + 2; l += 1) {
      const value = Math.max(0, ac[l])
      mass += value
      moment += value * l
    }
    if (mass <= 0) continue
    weighted += k * (moment / mass)
    weights += k * k
  }
  const period = weights > 0 ? weighted / weights : lag
  return Number((60 / (period * hopSeconds)).toFixed(2))
}

export interface DownbeatOptions {
  /** Known tempo; estimated when omitted. */
  bpm?: number
  beatsPerBar?: number
}

/**
 * Best-effort downbeat: the offset in seconds, within the first bar, of the phase whose
 * bar-periodic onsets are strongest. The result snaps to a detected attack when one is near.
 */
export function estimateDownbeat(mono: Float32Array, sampleRate: number, options: DownbeatOptions = {}): number {
  const envelope = onsetEnvelope(mono, sampleRate)
  const emphasized = emphasizePeaks(envelope)
  const bpm = options.bpm ?? tempoFromEnvelope(emphasized, envelope.hopSeconds, {}).bpm
  if (!(bpm > 0)) return 0
  const bar = ((options.beatsPerBar ?? 4) * 60) / (bpm * envelope.hopSeconds)
  let bestPhase = 0
  let bestSum = -Infinity
  for (let phase = 0; phase < bar; phase += 0.25) {
    let sum = 0
    for (let position = phase; position < emphasized.length; position += bar) sum += interpolate(emphasized, position)
    if (sum > bestSum) {
      bestSum = sum
      bestPhase = phase
    }
  }
  const offset = bestPhase * envelope.hopSeconds
  const onsets = pickOnsets(mono, sampleRate, envelope, {})
  let nearest = offset
  let nearestDistance = envelope.hopSeconds
  for (const onset of onsets) {
    const distance = Math.abs(onset.time - offset)
    if (distance <= nearestDistance) {
      nearest = onset.time
      nearestDistance = distance
    }
  }
  return nearest
}

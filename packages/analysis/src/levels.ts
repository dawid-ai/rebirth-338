import { amplitudeToDb, channelLength, DB_FLOOR, powerToDb, type Channels } from './util'

/** Largest absolute sample value across all channels, linear. */
export function samplePeak(channels: Channels): number {
  let max = 0
  for (const channel of channels) {
    for (let i = 0; i < channel.length; i += 1) {
      const value = Math.abs(channel[i])
      if (value > max) max = value
    }
  }
  return max
}

/** Mean square of every sample of every channel, linear. */
export function meanSquare(channels: Channels): number {
  let sum = 0
  let count = 0
  for (const channel of channels) {
    for (let i = 0; i < channel.length; i += 1) sum += channel[i] * channel[i]
    count += channel.length
  }
  return count > 0 ? sum / count : 0
}

/** Sample peak in dBFS. */
export function peak(channels: Channels): number {
  return amplitudeToDb(samplePeak(channels))
}

/** RMS level of all channels pooled, in dBFS. A full-scale sine reads -3.01 dBFS. */
export function rms(channels: Channels): number {
  return powerToDb(meanSquare(channels))
}

/** Peak-to-RMS ratio in dB; silence reads 0. A sine reads 3.01 dB. */
export function crestFactor(channels: Channels): number {
  const peakValue = samplePeak(channels)
  const power = meanSquare(channels)
  if (peakValue === 0 || power === 0) return 0
  return 20 * Math.log10(peakValue) - 10 * Math.log10(power)
}

// Each interpolation phase uses 2 * TRUE_PEAK_HALF_TAPS taps of a Blackman-windowed sinc.
const TRUE_PEAK_HALF_TAPS = 16
// Samples are screened in blocks before any interpolation runs.
const TRUE_PEAK_BLOCK = 16
// Blocks whose samples all sit more than 6 dB below the running maximum are skipped. Real
// program material does not overshoot that far between samples.
const TRUE_PEAK_SEARCH_MARGIN = 0.5
// A sinusoid overshoots its nearest sample by at most 0.25 times its second difference there, so
// an interval whose end samples plus this bound cannot beat the running maximum is skipped. The
// factor includes headroom for mixtures, where the bound is a close estimate rather than exact.
const OVERSHOOT_PER_CURVATURE = 0.3

const truePeakKernelCache = new Map<number, Float64Array[]>()

function truePeakKernels(oversampling: number): Float64Array[] {
  const cached = truePeakKernelCache.get(oversampling)
  if (cached) return cached
  const taps = TRUE_PEAK_HALF_TAPS * 2
  const kernels: Float64Array[] = []
  for (let phase = 1; phase < oversampling; phase += 1) {
    const fraction = phase / oversampling
    const kernel = new Float64Array(taps)
    let sum = 0
    for (let m = 0; m < taps; m += 1) {
      // Tap m multiplies x[n + k] with k = m - HALF + 1 to estimate x(n + fraction).
      const t = fraction - (m - TRUE_PEAK_HALF_TAPS + 1)
      const sinc = Math.sin(Math.PI * t) / (Math.PI * t)
      const u = t / TRUE_PEAK_HALF_TAPS
      const window = 0.42 + 0.5 * Math.cos(Math.PI * u) + 0.08 * Math.cos(2 * Math.PI * u)
      kernel[m] = sinc * window
      sum += kernel[m]
    }
    for (let m = 0; m < taps; m += 1) kernel[m] /= sum
    kernels.push(kernel)
  }
  truePeakKernelCache.set(oversampling, kernels)
  return kernels
}

// Largest |x| per block. Math.abs keeps the loop free of sign branches, which mispredict on noise.
function blockMaxima(x: Float32Array): Float32Array {
  const maxima = new Float32Array(Math.ceil(x.length / TRUE_PEAK_BLOCK))
  for (let block = 0; block < maxima.length; block += 1) {
    const start = block * TRUE_PEAK_BLOCK
    const end = Math.min(x.length, start + TRUE_PEAK_BLOCK)
    let max = 0
    for (let i = start; i < end; i += 1) {
      const magnitude = Math.abs(x[i])
      if (magnitude > max) max = magnitude
    }
    maxima[block] = max
  }
  return maxima
}

// |x[i]| plus the overshoot bound from its second difference.
function sampleBound(x: Float32Array, i: number): number {
  if (i < 0 || i >= x.length) return 0
  const previous = i > 0 ? x[i - 1] : 0
  const next = i + 1 < x.length ? x[i + 1] : 0
  return Math.abs(x[i]) + OVERSHOOT_PER_CURVATURE * Math.abs(previous - 2 * x[i] + next)
}

// Runs the oversampling filter on every interval that can beat `best` and returns the new maximum.
function interpolatePeaks(x: Float32Array, maxima: Float32Array, kernels: readonly Float64Array[], start: number): number {
  const taps = TRUE_PEAK_HALF_TAPS * 2
  const length = x.length
  let best = start
  for (let block = 0; block < maxima.length; block += 1) {
    // The last interval of a block ends on the first sample of the next block.
    const reach = block + 1 < maxima.length ? Math.max(maxima[block], maxima[block + 1]) : maxima[block]
    if (reach < best * TRUE_PEAK_SEARCH_MARGIN) continue
    const end = Math.min(length - 1, (block + 1) * TRUE_PEAK_BLOCK)
    let boundHere = sampleBound(x, block * TRUE_PEAK_BLOCK)
    for (let n = block * TRUE_PEAK_BLOCK; n < end; n += 1) {
      const boundNext = sampleBound(x, n + 1)
      const candidate = boundHere > best || boundNext > best
      boundHere = boundNext
      if (!candidate) continue
      const first = n - TRUE_PEAK_HALF_TAPS + 1
      const inside = first >= 0 && first + taps <= length
      for (let phase = 0; phase < kernels.length; phase += 1) {
        const kernel = kernels[phase]
        let sum = 0
        if (inside) {
          for (let m = 0; m < taps; m += 1) sum += x[first + m] * kernel[m]
        } else {
          for (let m = 0; m < taps; m += 1) {
            const index = first + m
            if (index >= 0 && index < length) sum += x[index] * kernel[m]
          }
        }
        const value = Math.abs(sum)
        if (value > best) best = value
      }
    }
  }
  return best
}

/**
 * Linear true-peak estimate using windowed-sinc oversampling (4x below 88.2 kHz, 2x above).
 * Intervals are screened first, so only the few that can raise the maximum run the full filter.
 */
export function truePeakLinear(channels: Channels, sampleRate: number): number {
  const kernels = truePeakKernels(sampleRate >= 88200 ? 2 : 4)
  const maxima = channels.map(blockMaxima)
  let best = 0
  for (const channelMaxima of maxima) for (let i = 0; i < channelMaxima.length; i += 1) best = Math.max(best, channelMaxima[i])
  for (let index = 0; index < channels.length; index += 1) {
    best = interpolatePeaks(channels[index], maxima[index], kernels, best)
  }
  return best
}

/** True peak in dBTP. */
export function truePeak(channels: Channels, sampleRate: number): number {
  return amplitudeToDb(truePeakLinear(channels, sampleRate))
}

export interface Biquad {
  b0: number
  b1: number
  b2: number
  a1: number
  a2: number
}

/**
 * BS.1770 K-weighting stages (high shelf, then high pass) for any sample rate.
 * The analog prototypes match the standard's published 48 kHz coefficients.
 */
export function kWeightingFilters(sampleRate: number): [Biquad, Biquad] {
  let k = Math.tan((Math.PI * 1681.974450955533) / sampleRate)
  let q = 0.7071752369554196
  const vh = 10 ** (3.999843853973347 / 20)
  const vb = vh ** 0.4996667741545416
  let a0 = 1 + k / q + k * k
  const shelf = {
    b0: (vh + (vb * k) / q + k * k) / a0,
    b1: (2 * (k * k - vh)) / a0,
    b2: (vh - (vb * k) / q + k * k) / a0,
    a1: (2 * (k * k - 1)) / a0,
    a2: (1 - k / q + k * k) / a0,
  }
  k = Math.tan((Math.PI * 38.13547087602444) / sampleRate)
  q = 0.5003270373238773
  a0 = 1 + k / q + k * k
  const highPass = {
    b0: 1,
    b1: -2,
    b2: 1,
    a1: (2 * (k * k - 1)) / a0,
    a2: (1 - k / q + k * k) / a0,
  }
  return [shelf, highPass]
}

const LOUDNESS_OFFSET = -0.691
const LOUDNESS_HOP_SECONDS = 0.1
const BLOCK_HOPS = 4
const SHORT_TERM_HOPS = 30
/** Absolute gate in LUFS (BS.1770-4). */
export const ABSOLUTE_GATE_LUFS = -70
/** Relative gate in LU below the absolute-gated loudness (BS.1770-4). */
export const RELATIVE_GATE_LU = -10

// BS.1770 channel weights for the L, R, C, LFE, Ls, Rs layout; other layouts weight every channel 1.
function channelWeight(index: number, count: number): number {
  if (count !== 6) return 1
  return [1, 1, 1, 0, 1.41, 1.41][index]
}

// Filters one channel, adds its weighted mean square per complete hop into `hops`, and returns
// its total sum of squares.
function kWeightChannel(x: Float32Array, shelf: Biquad, highPass: Biquad, hop: number, hops: Float64Array, weight: number): number {
  const { b0, b1, b2, a1, a2 } = shelf
  const { b0: c0, b1: c1, b2: c2, a1: d1, a2: d2 } = highPass
  let s1 = 0
  let s2 = 0
  let h1 = 0
  let h2 = 0
  let total = 0
  for (let start = 0; start < x.length; start += hop) {
    const end = Math.min(x.length, start + hop)
    let sum = 0
    for (let i = start; i < end; i += 1) {
      // Transposed direct form II keeps the state in four doubles.
      const input = x[i]
      const shelved = b0 * input + s1
      s1 = b1 * input - a1 * shelved + s2
      s2 = b2 * input - a2 * shelved
      const weighted = c0 * shelved + h1
      h1 = c1 * shelved - d1 * weighted + h2
      h2 = c2 * shelved - d2 * weighted
      sum += weighted * weighted
    }
    total += sum
    const hopIndex = start / hop
    if (hopIndex < hops.length) hops[hopIndex] += (weight * sum) / hop
  }
  return total
}

interface WeightedPowers {
  /** Weighted mean square of every complete 100 ms hop. */
  hops: Float64Array
  /** Weighted mean square of the whole signal, including a trailing partial hop. */
  total: number
}

function kWeightedPowers(channels: Channels, sampleRate: number): WeightedPowers {
  const hop = Math.max(1, Math.round(sampleRate * LOUDNESS_HOP_SECONDS))
  const length = channelLength(channels)
  const hops = new Float64Array(Math.floor(length / hop))
  const [shelf, highPass] = kWeightingFilters(sampleRate)
  let total = 0
  for (let index = 0; index < channels.length; index += 1) {
    const weight = channelWeight(index, channels.length)
    if (weight > 0 && length > 0) total += (weight * kWeightChannel(channels[index], shelf, highPass, hop, hops, weight)) / length
  }
  return { hops, total }
}

function powerToLufs(power: number): number {
  if (!(power > 0)) return DB_FLOOR
  return Math.max(DB_FLOOR, LOUDNESS_OFFSET + 10 * Math.log10(power))
}

/**
 * Gated integrated loudness in LUFS per ITU-R BS.1770-4: 400 ms blocks with 75 % overlap,
 * a -70 LUFS absolute gate, and a -10 LU relative gate. Signals shorter than one block
 * are measured as a single block. Returns `DB_FLOOR` when every block falls below the
 * absolute gate.
 */
export function integratedLoudness(channels: Channels, sampleRate: number): number {
  const { hops, total } = kWeightedPowers(channels, sampleRate)
  if (hops.length < BLOCK_HOPS) {
    const loudness = powerToLufs(total)
    return loudness > ABSOLUTE_GATE_LUFS ? loudness : DB_FLOOR
  }
  const blockCount = hops.length - BLOCK_HOPS + 1
  const blocks = new Float64Array(blockCount)
  let running = 0
  for (let i = 0; i < hops.length; i += 1) {
    running += hops[i]
    if (i >= BLOCK_HOPS) running -= hops[i - BLOCK_HOPS]
    if (i >= BLOCK_HOPS - 1) blocks[i - BLOCK_HOPS + 1] = Math.max(0, running) / BLOCK_HOPS
  }
  const absolutePower = 10 ** ((ABSOLUTE_GATE_LUFS - LOUDNESS_OFFSET) / 10)
  let sum = 0
  let count = 0
  for (const power of blocks) {
    if (power > absolutePower) {
      sum += power
      count += 1
    }
  }
  if (count === 0) return DB_FLOOR
  const relativePower = (sum / count) * 10 ** (RELATIVE_GATE_LU / 10)
  sum = 0
  count = 0
  for (const power of blocks) {
    if (power > absolutePower && power > relativePower) {
      sum += power
      count += 1
    }
  }
  return powerToLufs(sum / count)
}

export interface LoudnessPoint {
  /** End of the measurement window in seconds. */
  time: number
  lufs: number
}

function slidingLoudness(channels: Channels, sampleRate: number, windowHops: number): LoudnessPoint[] {
  const { hops, total } = kWeightedPowers(channels, sampleRate)
  const hopSeconds = Math.max(1, Math.round(sampleRate * LOUDNESS_HOP_SECONDS)) / sampleRate
  if (hops.length < windowHops) {
    return [{ time: channelLength(channels) / sampleRate, lufs: powerToLufs(total) }]
  }
  const points: LoudnessPoint[] = []
  let running = 0
  for (let i = 0; i < hops.length; i += 1) {
    running += hops[i]
    if (i >= windowHops) running -= hops[i - windowHops]
    if (i >= windowHops - 1) points.push({ time: (i + 1) * hopSeconds, lufs: powerToLufs(Math.max(0, running) / windowHops) })
  }
  return points
}

/** Ungated 3 s short-term loudness, one point every 100 ms. */
export function shortTermLoudness(channels: Channels, sampleRate: number): LoudnessPoint[] {
  return slidingLoudness(channels, sampleRate, SHORT_TERM_HOPS)
}

/** Ungated 400 ms momentary loudness, one point every 100 ms. */
export function momentaryLoudness(channels: Channels, sampleRate: number): LoudnessPoint[] {
  return slidingLoudness(channels, sampleRate, BLOCK_HOPS)
}

/** Mean value of each channel, linear. */
export function dcOffset(channels: Channels): number[] {
  return channels.map((channel) => {
    let sum = 0
    for (let i = 0; i < channel.length; i += 1) sum += channel[i]
    return channel.length > 0 ? sum / channel.length : 0
  })
}

/** Phase-meter correlation from -1 (inverted) to 1 (mono); silence reads 0. */
export function stereoCorrelation(left: Float32Array, right: Float32Array): number {
  const length = Math.min(left.length, right.length)
  let lr = 0
  let ll = 0
  let rr = 0
  for (let i = 0; i < length; i += 1) {
    lr += left[i] * right[i]
    ll += left[i] * left[i]
    rr += right[i] * right[i]
  }
  if (ll === 0 || rr === 0) return 0
  return Math.max(-1, Math.min(1, lr / Math.sqrt(ll * rr)))
}

/** Left level minus right level in dB; positive values lean left. */
export function stereoBalance(left: Float32Array, right: Float32Array): number {
  return powerToDb(meanSquare([left])) - powerToDb(meanSquare([right]))
}

export interface LevelSummary {
  peakDb: number
  rmsDb: number
  crestDb: number
  /** Per-channel mean, linear. */
  dcOffset: number[]
  /** Correlation of the first two channels; a single channel reads 1. */
  correlation: number
  /** Level of the first channel minus the second in dB; a single channel reads 0. */
  balanceDb: number
}

/** Sample-domain level statistics gathered in as few passes as possible. */
export function levelSummary(channels: Channels): LevelSummary {
  let peakValue = 0
  let squareTotal = 0
  let count = 0
  const dc: number[] = []
  const channelPowers: number[] = []
  for (const x of channels) {
    let sum = 0
    let squares = 0
    for (let i = 0; i < x.length; i += 1) {
      const value = x[i]
      sum += value
      squares += value * value
      const magnitude = Math.abs(value)
      if (magnitude > peakValue) peakValue = magnitude
    }
    dc.push(x.length > 0 ? sum / x.length : 0)
    channelPowers.push(x.length > 0 ? squares / x.length : 0)
    squareTotal += squares
    count += x.length
  }
  const power = count > 0 ? squareTotal / count : 0
  const stereo = channels.length >= 2
  return {
    peakDb: amplitudeToDb(peakValue),
    rmsDb: powerToDb(power),
    crestDb: peakValue > 0 && power > 0 ? 20 * Math.log10(peakValue) - 10 * Math.log10(power) : 0,
    dcOffset: dc,
    correlation: stereo ? stereoCorrelation(channels[0], channels[1]) : 1,
    balanceDb: stereo ? powerToDb(channelPowers[0]) - powerToDb(channelPowers[1]) : 0,
  }
}

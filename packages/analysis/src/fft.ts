interface FftTables {
  reverse: Uint32Array
  cos: Float64Array
  sin: Float64Array
}

const tableCache = new Map<number, FftTables>()

export function isPowerOfTwo(value: number): boolean {
  return Number.isInteger(value) && value > 0 && (value & (value - 1)) === 0
}

function tablesFor(size: number): FftTables {
  const cached = tableCache.get(size)
  if (cached) return cached
  const bits = Math.log2(size)
  const reverse = new Uint32Array(size)
  for (let i = 0; i < size; i += 1) {
    let reversed = 0
    for (let bit = 0; bit < bits; bit += 1) reversed |= ((i >> bit) & 1) << (bits - 1 - bit)
    reverse[i] = reversed
  }
  const half = size >> 1
  const cos = new Float64Array(half)
  const sin = new Float64Array(half)
  for (let k = 0; k < half; k += 1) {
    cos[k] = Math.cos((2 * Math.PI * k) / size)
    sin[k] = Math.sin((2 * Math.PI * k) / size)
  }
  const tables = { reverse, cos, sin }
  tableCache.set(size, tables)
  return tables
}

/** In-place iterative radix-2 complex FFT. The inverse transform is scaled by 1/N. */
export function fft(re: Float64Array, im: Float64Array, inverse = false): void {
  const size = re.length
  if (im.length !== size) throw new Error('fft: real and imaginary parts must have the same length')
  if (!isPowerOfTwo(size)) throw new Error(`fft: size ${size} is not a power of two`)
  const { reverse, cos, sin } = tablesFor(size)
  for (let i = 0; i < size; i += 1) {
    const j = reverse[i]
    if (j > i) {
      const tr = re[i]
      re[i] = re[j]
      re[j] = tr
      const ti = im[i]
      im[i] = im[j]
      im[j] = ti
    }
  }
  const sign = inverse ? 1 : -1
  let firstBlock = 2
  if (size >= 4) {
    // The first two stages have trivial twiddles (1 and -+i), so they run as one radix-4 pass.
    for (let i = 0; i < size; i += 4) {
      const r0 = re[i] + re[i + 1]
      const i0 = im[i] + im[i + 1]
      const r1 = re[i] - re[i + 1]
      const i1 = im[i] - im[i + 1]
      const r2 = re[i + 2] + re[i + 3]
      const i2 = im[i + 2] + im[i + 3]
      // (x2 - x3) times -i for the forward transform, +i for the inverse.
      const r3 = sign * -(im[i + 2] - im[i + 3])
      const i3 = sign * (re[i + 2] - re[i + 3])
      re[i] = r0 + r2
      im[i] = i0 + i2
      re[i + 2] = r0 - r2
      im[i + 2] = i0 - i2
      re[i + 1] = r1 + r3
      im[i + 1] = i1 + i3
      re[i + 3] = r1 - r3
      im[i + 3] = i1 - i3
    }
    firstBlock = 8
  }
  for (let block = firstBlock; block <= size; block <<= 1) {
    const half = block >> 1
    const stride = size / block
    for (let start = 0; start < size; start += block) {
      for (let k = 0; k < half; k += 1) {
        const wr = cos[k * stride]
        const wi = sign * sin[k * stride]
        const a = start + k
        const b = a + half
        const tr = re[b] * wr - im[b] * wi
        const ti = re[b] * wi + im[b] * wr
        re[b] = re[a] - tr
        im[b] = im[a] - ti
        re[a] += tr
        im[a] += ti
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < size; i += 1) {
      re[i] /= size
      im[i] /= size
    }
  }
}

/** Periodic Hann window, which sums to exactly N/2. */
export function hannWindow(size: number): Float64Array {
  const window = new Float64Array(size)
  for (let i = 0; i < size; i += 1) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size)
  return window
}

/**
 * Reusable Hann-windowed real-signal analyzer. It packs even and odd samples into one
 * half-size complex FFT and owns its scratch buffers, so per-frame calls do not allocate.
 */
export class SpectrumAnalyzer {
  readonly size: number
  /** Number of one-sided bins, from DC to Nyquist inclusive. */
  readonly binCount: number
  readonly window: Float64Array
  private readonly re: Float64Array
  private readonly im: Float64Array
  private readonly cos: Float64Array
  private readonly sin: Float64Array
  private readonly amplitudeScale: number
  private readonly powerScale: number

  constructor(size: number) {
    if (!isPowerOfTwo(size) || size < 4) throw new Error(`SpectrumAnalyzer: size ${size} is not a power of two of at least 4`)
    const half = size / 2
    this.size = size
    this.binCount = half + 1
    this.window = hannWindow(size)
    this.re = new Float64Array(half)
    this.im = new Float64Array(half)
    this.cos = new Float64Array(half + 1)
    this.sin = new Float64Array(half + 1)
    for (let k = 0; k <= half; k += 1) {
      this.cos[k] = Math.cos((2 * Math.PI * k) / size)
      this.sin[k] = Math.sin((2 * Math.PI * k) / size)
    }
    let sum = 0
    let squareSum = 0
    for (let i = 0; i < size; i += 1) {
      sum += this.window[i]
      squareSum += this.window[i] * this.window[i]
    }
    // A sine of amplitude A peaks at A in the magnitude spectrum.
    this.amplitudeScale = 2 / sum
    // One-sided bin powers sum to the mean square of a stationary signal.
    this.powerScale = 2 / (size * squareSum)
  }

  /** Hann-weighted magnitudes of `size` samples from `start`; samples outside the signal read as zero. */
  magnitudes(signal: ArrayLike<number>, start: number, out: Float64Array): Float64Array {
    this.squaredMagnitudes(signal, start, out)
    const scale = this.amplitudeScale
    for (let k = 0; k < this.binCount; k += 1) out[k] = Math.sqrt(out[k]) * scale
    return out
  }

  /** One-sided power per bin, scaled so the bins of a stationary signal sum to its mean square. */
  power(signal: ArrayLike<number>, start: number, out: Float64Array): Float64Array {
    this.squaredMagnitudes(signal, start, out)
    const scale = this.powerScale
    for (let k = 0; k < this.binCount; k += 1) out[k] *= scale
    return out
  }

  /** Center frequency of bin `k` in hertz. */
  binFrequency(k: number, sampleRate: number): number {
    return (k * sampleRate) / this.size
  }

  private squaredMagnitudes(signal: ArrayLike<number>, start: number, out: Float64Array): void {
    const { re, im, window, size, cos, sin } = this
    const half = size / 2
    const length = signal.length
    if (start >= 0 && start + size <= length) {
      for (let n = 0; n < half; n += 1) {
        re[n] = signal[start + 2 * n] * window[2 * n]
        im[n] = signal[start + 2 * n + 1] * window[2 * n + 1]
      }
    } else {
      for (let n = 0; n < half; n += 1) {
        const even = start + 2 * n
        const odd = even + 1
        re[n] = even >= 0 && even < length ? signal[even] * window[2 * n] : 0
        im[n] = odd >= 0 && odd < length ? signal[odd] * window[2 * n + 1] : 0
      }
    }
    fft(re, im)
    // Split the packed spectrum into the even- and odd-sample spectra, then combine them
    // with the size-N twiddle to get bins 0..N/2 of the real input.
    for (let k = 0; k <= half; k += 1) {
      const a = k === half ? 0 : k
      const b = k === 0 ? 0 : half - k
      const ar = re[a]
      const ai = im[a]
      const br = re[b]
      const bi = -im[b]
      const evenRe = (ar + br) / 2
      const evenIm = (ai + bi) / 2
      const oddRe = (ai - bi) / 2
      const oddIm = (br - ar) / 2
      const c = cos[k]
      const s = sin[k]
      const xr = evenRe + c * oddRe + s * oddIm
      const xi = evenIm + c * oddIm - s * oddRe
      out[k] = xr * xr + xi * xi
    }
  }
}

/** Hann-windowed magnitude spectrum of one frame whose length is a power of two. */
export function magnitudeSpectrum(frame: ArrayLike<number>): Float64Array {
  const analyzer = new SpectrumAnalyzer(frame.length)
  return analyzer.magnitudes(frame, 0, new Float64Array(analyzer.binCount))
}

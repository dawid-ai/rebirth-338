// Shared DSP tables. Noise and impulse responses come from a seeded PRNG so
// live playback and offline render use identical buffers.

export const clamp = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, value))
export const dbToGain = (db: number) => (db <= -60 ? 0 : 10 ** (db / 20))
export const midiToHz = (note: number) => 440 * 2 ** ((clamp(note, 12, 115) - 69) / 12)

export function seeded(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function makeNoise(context: BaseAudioContext, seconds: number, seed = 338): AudioBuffer {
  const buffer = context.createBuffer(1, Math.ceil(context.sampleRate * seconds), context.sampleRate)
  const data = buffer.getChannelData(0)
  const random = seeded(seed)
  let last = 0
  for (let i = 0; i < data.length; i += 1) {
    last = last * 0.15 + (random() * 2 - 1) * 0.85
    data[i] = last
  }
  return buffer
}

/** Six inharmonic square partials, baked once instead of six oscillators per hat. */
export function makeMetallic(context: BaseAudioContext, seconds: number): AudioBuffer {
  const buffer = context.createBuffer(1, Math.ceil(context.sampleRate * seconds), context.sampleRate)
  const data = buffer.getChannelData(0)
  const frequencies = [355, 475.7, 536.1, 646.1, 766.8, 933.7]
  const phases = frequencies.map(() => 0)
  for (let sample = 0; sample < data.length; sample += 1) {
    let value = 0
    for (let p = 0; p < frequencies.length; p += 1) {
      phases[p] = (phases[p] + frequencies[p] / context.sampleRate) % 1
      value += phases[p] < 0.5 ? 1 : -1
    }
    data[sample] = value / frequencies.length
  }
  return buffer
}

export function makeImpulse(context: BaseAudioContext, seconds: number, decay: number, seed = 808): AudioBuffer {
  const length = Math.max(1, Math.ceil(context.sampleRate * seconds))
  const impulse = context.createBuffer(2, length, context.sampleRate)
  for (let channel = 0; channel < 2; channel += 1) {
    const data = impulse.getChannelData(channel)
    const random = seeded(seed + channel * 7919)
    let damped = 0
    for (let i = 0; i < length; i += 1) {
      const progress = i / length
      const damping = 0.42 + progress * 0.5
      damped = damped * damping + (random() * 2 - 1) * (1 - damping)
      const diffusion = Math.min(1, i / Math.max(1, context.sampleRate * 0.012))
      data[i] = damped * diffusion * (1 - progress) ** decay * 0.86
    }
  }
  return impulse
}

/** Low-level signals stay linear; larger amounts progressively round peaks. */
export function saturationCurve(amount: number, size = 1024): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(size)
  const mix = clamp(amount)
  const drive = 1 + mix * 7
  for (let i = 0; i < size; i += 1) {
    const x = (i * 2) / (size - 1) - 1
    curve[i] = x * (1 - mix) + (Math.tanh(x * drive) / Math.tanh(drive)) * mix
  }
  return curve
}

/** Soft-knee clipper that keeps output below `ceiling` (linear gain). */
export function limiterCurve(ceiling: number, size = 2048): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(size)
  const threshold = ceiling * 0.86
  const normalization = 1 - Math.exp(-4)
  for (let i = 0; i < size; i += 1) {
    const input = (i * 2) / (size - 1) - 1
    const magnitude = Math.abs(input)
    if (magnitude <= threshold) {
      curve[i] = input
      continue
    }
    const knee = Math.min(1, (magnitude - threshold) / Math.max(1e-6, 1 - threshold))
    curve[i] = Math.sign(input) * (threshold + ((ceiling - threshold) * (1 - Math.exp(-4 * knee))) / normalization)
  }
  return curve
}

export function bitCrushCurve(bits: number, size = 2048): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(size)
  const levels = 2 ** clamp(Math.round(bits), 2, 16)
  for (let i = 0; i < size; i += 1) {
    const input = (i / (size - 1)) * 2 - 1
    curve[i] = Math.round(input * levels) / levels
  }
  return curve
}

export function reverseBuffer(context: BaseAudioContext, source: AudioBuffer): AudioBuffer {
  const output = context.createBuffer(source.numberOfChannels, source.length, source.sampleRate)
  for (let channel = 0; channel < source.numberOfChannels; channel += 1) {
    const input = source.getChannelData(channel)
    const target = output.getChannelData(channel)
    for (let i = 0; i < input.length; i += 1) target[i] = input[input.length - 1 - i]
  }
  return output
}

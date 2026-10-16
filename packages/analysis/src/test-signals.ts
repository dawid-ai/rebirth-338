import { createRandom } from './util'

// Synthetic signal generators shared by the colocated tests.

export function sine(frequency: number, amplitude: number, seconds: number, sampleRate: number, phase = 0): Float32Array {
  const signal = new Float32Array(Math.round(seconds * sampleRate))
  for (let i = 0; i < signal.length; i += 1) signal[i] = amplitude * Math.sin((2 * Math.PI * frequency * i) / sampleRate + phase)
  return signal
}

export function noise(seconds: number, sampleRate: number, amplitude = 0.5, seed = 7): Float32Array {
  const random = createRandom(seed)
  const signal = new Float32Array(Math.round(seconds * sampleRate))
  for (let i = 0; i < signal.length; i += 1) signal[i] = amplitude * (random() * 2 - 1)
  return signal
}

/** Cascaded one-pole low-pass filters, applied in place. */
export function lowPass(signal: Float32Array, cutoff: number, sampleRate: number, stages = 4): Float32Array {
  const coefficient = Math.exp((-2 * Math.PI * cutoff) / sampleRate)
  for (let stage = 0; stage < stages; stage += 1) {
    let state = 0
    for (let i = 0; i < signal.length; i += 1) {
      state = (1 - coefficient) * signal[i] + coefficient * state
      signal[i] = state
    }
  }
  return signal
}

/** First-difference high-pass, applied `stages` times in place. */
export function highPass(signal: Float32Array, stages = 3): Float32Array {
  for (let stage = 0; stage < stages; stage += 1) {
    let previous = 0
    for (let i = 0; i < signal.length; i += 1) {
      const current = signal[i]
      signal[i] = current - previous
      previous = current
    }
  }
  return signal
}

export function scaleToPeak(signal: Float32Array, target: number): Float32Array {
  let max = 0
  for (const value of signal) max = Math.max(max, Math.abs(value))
  if (max > 0) for (let i = 0; i < signal.length; i += 1) signal[i] *= target / max
  return signal
}

/** Writes a 3 ms decaying noise click at each time in `times`. */
export function clicks(times: readonly number[], seconds: number, sampleRate: number, amplitudes?: readonly number[]): Float32Array {
  const signal = new Float32Array(Math.round(seconds * sampleRate))
  const random = createRandom(3)
  const length = Math.round(0.003 * sampleRate)
  times.forEach((time, index) => {
    const start = Math.round(time * sampleRate)
    const amplitude = amplitudes?.[index] ?? 0.8
    for (let i = 0; i < length && start + i < signal.length; i += 1) {
      signal[start + i] += amplitude * Math.exp(-i / (length / 4)) * (random() * 2 - 1)
    }
  })
  return signal
}

export function beatTimes(bpm: number, seconds: number, offset = 0): number[] {
  const times: number[] = []
  for (let index = 0; offset + (index * 60) / bpm < seconds; index += 1) times.push(offset + (index * 60) / bpm)
  return times
}

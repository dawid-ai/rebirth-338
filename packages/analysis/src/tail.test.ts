import { describe, expect, it } from 'vitest'
import { estimateTail } from './tail'

const SAMPLE_RATE = 44100

function decayingTone(seconds: number, decayStart: number, timeConstant: number): Float32Array {
  const signal = new Float32Array(Math.round(seconds * SAMPLE_RATE))
  for (let i = 0; i < signal.length; i += 1) {
    const time = i / SAMPLE_RATE
    const envelope = time < decayStart ? 1 : Math.exp(-(time - decayStart) / timeConstant)
    signal[i] = 0.8 * envelope * Math.sin(2 * Math.PI * 1000 * time)
  }
  return signal
}

describe('tail estimation', () => {
  it('measures the -60 dB decay time of an exponential tail', () => {
    // An exponential envelope loses 60 dB after timeConstant * ln(1000) seconds.
    const timeConstant = 0.1
    const result = estimateTail([decayingTone(2, 0.5, timeConstant)], SAMPLE_RATE, 0.5)
    expect(Math.abs(result.tailSeconds - timeConstant * Math.log(1000))).toBeLessThan(0.02)
    expect(result.referenceDb).toBeCloseTo(-4.95, 0)
    expect(result.truncated).toBe(false)
  })

  it('bridges silent gaps between echo repeats', () => {
    const signal = new Float32Array(SAMPLE_RATE * 2)
    for (const [start, gain] of [[0, 0.8], [0.3, 0.4], [0.6, 0.2]]) {
      for (let i = 0; i < 0.05 * SAMPLE_RATE; i += 1) {
        signal[Math.round(start * SAMPLE_RATE) + i] = gain * Math.sin((2 * Math.PI * 800 * i) / SAMPLE_RATE)
      }
    }
    const result = estimateTail([signal, signal], SAMPLE_RATE, 0.02)
    expect(result.tailSeconds).toBeGreaterThan(0.6)
    expect(result.tailSeconds).toBeLessThan(0.65)
  })

  it('reports truncation when the signal ends mid-tail and zero for silence', () => {
    expect(estimateTail([decayingTone(1, 0.5, 1)], SAMPLE_RATE, 0.5).truncated).toBe(true)
    expect(estimateTail([new Float32Array(SAMPLE_RATE)], SAMPLE_RATE, 0.2).tailSeconds).toBe(0)
  })
})

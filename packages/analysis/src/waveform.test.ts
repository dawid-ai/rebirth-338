import { describe, expect, it } from 'vitest'
import { peaksForDisplay, rmsEnvelope } from './waveform'

describe('waveform peaks', () => {
  it('returns min and max per bucket across channels', () => {
    const left = Float32Array.from([0, 0.5, -0.25, 0.1, 0.9, -0.9, 0, 0])
    const right = Float32Array.from([0, 0, -0.75, 0, 0, 0, 0.2, 0.3])
    expect(peaksForDisplay([left, right], 4)).toEqual([
      { min: 0, max: 0.5 },
      { min: -0.75, max: Math.fround(0.1) },
      { min: Math.fround(-0.9), max: Math.fround(0.9) },
      { min: 0, max: Math.fround(0.3) },
    ])
  })

  it('repeats samples when there are more buckets than samples', () => {
    const peaks = peaksForDisplay([Float32Array.from([1, -1])], 4)
    expect(peaks.map((bucket) => bucket.max)).toEqual([1, 1, -1, -1])
  })

  it('returns flat buckets for an empty signal', () => {
    expect(peaksForDisplay([new Float32Array(0)], 2)).toEqual([{ min: 0, max: 0 }, { min: 0, max: 0 }])
  })
})

describe('RMS envelope', () => {
  it('measures consecutive windows, including a partial last window', () => {
    const signal = new Float32Array(25)
    signal.fill(0.5, 0, 10)
    signal.fill(-0.25, 10, 25)
    const envelope = rmsEnvelope(signal, 1000, 0.01)
    expect(envelope.length).toBe(3)
    expect(envelope[0]).toBeCloseTo(0.5, 6)
    expect(envelope[1]).toBeCloseTo(0.25, 6)
    expect(envelope[2]).toBeCloseTo(0.25, 6)
  })
})

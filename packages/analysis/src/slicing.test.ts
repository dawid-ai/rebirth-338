import { describe, expect, it } from 'vitest'
import { normalizeSlicePositions, sliceByBeats, sliceByTransients, sliceEqual, snapToZeroCrossing } from './slicing'
import { clicks, sine } from './test-signals'

const SAMPLE_RATE = 44100

describe('slice positions', () => {
  it('always starts at 0 and stays sorted, unique, and below 1', () => {
    expect(normalizeSlicePositions([0.5, 0.25, 0.5, 1, 1.2, -0.1, Number.NaN, 0])).toEqual([0, 0.25, 0.5])
  })

  it('slices equally', () => {
    expect(sliceEqual(4)).toEqual([0, 0.25, 0.5, 0.75])
    expect(sliceEqual(0)).toEqual([0])
  })

  it('slices by beats with an optional offset', () => {
    // Two seconds at 120 BPM is four beats; two beats per slice gives two slices.
    expect(sliceByBeats(120, 2, 2)).toEqual([0, 0.5])
    expect(sliceByBeats(120, 2, 1)).toEqual([0, 0.25, 0.5, 0.75])
    expect(sliceByBeats(120, 2, 1, 0.25)).toEqual([0, 0.125, 0.375, 0.625, 0.875])
    expect(sliceByBeats(0, 2, 1)).toEqual([0])
  })
})

describe('transient slicing', () => {
  it('slices at each click, snapped near the attack', () => {
    const times = [0.25, 0.5, 0.75, 1.25]
    const slices = sliceByTransients(clicks(times, 1.5, SAMPLE_RATE), SAMPLE_RATE)
    expect(slices.length).toBe(times.length + 1)
    expect(slices[0]).toBe(0)
    times.forEach((time, index) => expect(Math.abs(slices[index + 1] * 1.5 - time)).toBeLessThan(0.01))
  })

  it('keeps only the strongest transients when capped', () => {
    const times = [0.2, 0.4, 0.6, 0.8, 1]
    const amplitudes = [0.2, 0.9, 0.2, 0.9, 0.2]
    const slices = sliceByTransients(clicks(times, 1.2, SAMPLE_RATE, amplitudes), SAMPLE_RATE, { maxSlices: 3 })
    expect(slices.length).toBe(3)
    expect(Math.abs(slices[1] * 1.2 - 0.4)).toBeLessThan(0.01)
    expect(Math.abs(slices[2] * 1.2 - 0.8)).toBeLessThan(0.01)
  })
})

describe('zero-crossing snap', () => {
  it('moves to the nearest sign change within the search radius', () => {
    // A 100 Hz sine at 44.1 kHz crosses zero every 220.5 samples.
    const signal = sine(100, 0.5, 0.1, SAMPLE_RATE, 0.01)
    const snapped = snapToZeroCrossing(signal, 215, 20)
    expect(Math.abs(signal[snapped])).toBeLessThan(0.01)
    expect(Math.abs(snapped - 220)).toBeLessThanOrEqual(1)
  })

  it('keeps the position when no crossing is in range', () => {
    const signal = new Float32Array(100).fill(0.3)
    expect(snapToZeroCrossing(signal, 50, 10)).toBe(50)
  })
})

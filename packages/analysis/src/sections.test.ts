import { describe, expect, it } from 'vitest'
import { analyzeRanges, type WarningCode } from './sections'
import { sine } from './test-signals'

const SAMPLE_RATE = 44100

function codes(channels: Float32Array[]): WarningCode[] {
  const [result] = analyzeRanges(channels, SAMPLE_RATE, [{ id: 'all', start: 0, end: 2 }])
  return result.warnings.map((warning) => warning.code).sort()
}

describe('range analysis', () => {
  it('measures each range independently', () => {
    const signal = new Float32Array(SAMPLE_RATE * 4)
    signal.set(sine(1000, 0.1, 2, SAMPLE_RATE))
    signal.set(sine(1000, 0.5, 2, SAMPLE_RATE), SAMPLE_RATE * 2)
    const [quiet, loud] = analyzeRanges([signal, signal], SAMPLE_RATE, [
      { id: 'verse', start: 0, end: 2 },
      { id: 'drop', start: 2, end: 10 },
    ])
    expect(quiet.id).toBe('verse')
    expect(quiet.peakDb).toBeCloseTo(-20, 1)
    expect(quiet.rmsDb).toBeCloseTo(-23.01, 1)
    expect(quiet.crestDb).toBeCloseTo(3.01, 1)
    expect(quiet.loudnessLufs).toBeCloseTo(-20, 1)
    expect(quiet.correlation).toBeCloseTo(1, 6)
    expect(quiet.balanceDb).toBeCloseTo(0, 6)
    expect(loud.peakDb).toBeCloseTo(-6.02, 1)
    expect(loud.loudnessLufs - quiet.loudnessLufs).toBeCloseTo(13.98, 1)
    expect(loud.bands.mid.share).toBeGreaterThan(0.99)
    expect(quiet.warnings).toEqual([])
    expect(loud.warnings).toEqual([])
  })

  it('flags clipping above -0.1 dBTP', () => {
    expect(codes([sine(1000, 1, 2, SAMPLE_RATE)])).toContain('clipping')
    expect(codes([sine(1000, 0.95, 2, SAMPLE_RATE)])).not.toContain('clipping')
  })

  it('flags inverted stereo as a phase problem', () => {
    const left = sine(1000, 0.5, 2, SAMPLE_RATE)
    expect(codes([left, left.map((value) => -value)])).toEqual(['phase'])
  })

  it('flags DC offset above 0.01', () => {
    const signal = sine(1000, 0.3, 2, SAMPLE_RATE).map((value) => value + 0.05)
    expect(codes([signal])).toContain('dc_offset')
  })

  it('flags sub buildup, harshness, and low-mid mud from band shares', () => {
    expect(codes([sine(40, 0.5, 2, SAMPLE_RATE)])).toEqual(['sub_buildup'])
    expect(codes([sine(3500, 0.5, 2, SAMPLE_RATE)])).toEqual(['harshness'])
    expect(codes([sine(350, 0.5, 2, SAMPLE_RATE)])).toEqual(['low_mid_mud'])
    expect(codes([sine(40, 0.3, 2, SAMPLE_RATE).map((value, i) => value + 0.3 * Math.sin((2 * Math.PI * 100 * i) / SAMPLE_RATE))])).toEqual([])
  })

  it('skips spectral warnings for near-silent ranges and clamps past the end', () => {
    const [result] = analyzeRanges([sine(40, 0.0001, 1, SAMPLE_RATE)], SAMPLE_RATE, [{ id: 'tail', start: 0.5, end: 5 }])
    expect(result.warnings).toEqual([])
    expect(result.rmsDb).toBeLessThan(-60)
  })
})

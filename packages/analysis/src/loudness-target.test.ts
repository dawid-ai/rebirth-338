import { describe, expect, it } from 'vitest'
import { integratedLoudness, truePeak } from './levels'
import { matchLoudness } from './loudness-target'
import { sine } from './test-signals'

const RATE = 48000

describe('matchLoudness', () => {
  it('reaches the target with one static gain', () => {
    const tone = sine(1000, 0.05, 5, RATE)
    const { channels, result } = matchLoudness([tone, tone], RATE, -16, -1)
    expect(result.limitedByCeiling).toBe(false)
    expect(integratedLoudness(channels, RATE)).toBeCloseTo(-16, 1)
    expect(result.lufs).toBeCloseTo(-16, 1)
  })

  it('stops at the true-peak ceiling instead of limiting', () => {
    const tone = sine(1000, 0.5, 5, RATE)
    const { channels, result } = matchLoudness([tone, tone], RATE, 0, -1)
    expect(result.limitedByCeiling).toBe(true)
    expect(truePeak(channels, RATE)).toBeCloseTo(-1, 1)
    expect(result.lufs).toBeLessThan(0)
  })

  it('leaves silence alone', () => {
    const silent = new Float32Array(RATE)
    expect(matchLoudness([silent], RATE, -14, -1).result.gainDb).toBe(0)
  })
})

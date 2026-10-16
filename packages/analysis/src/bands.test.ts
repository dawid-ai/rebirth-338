import { describe, expect, it } from 'vitest'
import { BAND_NAMES, bandEnergies } from './bands'
import { highPass, lowPass, noise, sine } from './test-signals'
import { DB_FLOOR } from './util'

describe('band energies', () => {
  it('places a sine in its band at its RMS level', () => {
    const bands = bandEnergies([sine(1000, 0.5, 2, 44100)], 44100)
    expect(bands.mid.share).toBeGreaterThan(0.999)
    expect(bands.mid.db).toBeCloseTo(-9.03, 1)
    expect(bands.sub.db).toBeLessThan(-80)
  })

  it('lands low-passed noise in the sub and bass bands', () => {
    const signal = lowPass(noise(3, 44100), 90, 44100)
    const bands = bandEnergies([signal], 44100)
    expect(bands.sub.share + bands.bass.share).toBeGreaterThan(0.9)
    expect(bands.air.share).toBeLessThan(0.001)
  })

  it('lands high-passed noise in the harsh and air bands', () => {
    const signal = highPass(noise(3, 44100))
    const bands = bandEnergies([signal], 44100)
    expect(bands.harsh.share + bands.air.share).toBeGreaterThan(0.9)
    expect(bands.sub.share + bands.bass.share).toBeLessThan(0.001)
  })

  it('shares sum to 1 and silence reads the floor with zero shares', () => {
    const bands = bandEnergies([noise(1, 48000), noise(1, 48000, 0.3, 11)], 48000)
    expect(BAND_NAMES.reduce((sum, name) => sum + bands[name].share, 0)).toBeCloseTo(1, 9)
    const silent = bandEnergies([new Float32Array(1000)], 48000)
    for (const name of BAND_NAMES) {
      expect(silent[name].db).toBe(DB_FLOOR)
      expect(silent[name].share).toBe(0)
    }
  })

  it('handles signals shorter than one analysis frame', () => {
    const bands = bandEnergies([sine(3000, 0.5, 0.01, 48000)], 48000)
    expect(bands.harsh.share).toBeGreaterThan(0.95)
  })
})

describe('band coverage on long signals', () => {
  it('gives the same shares when the hits shift slightly', () => {
    const rate = 44100
    const render = (offset: number) => {
      const data = new Float32Array(rate * 120)
      // A 50 Hz kick every half second with a short 150 Hz attack.
      for (let hit = offset; hit < data.length - rate; hit += rate / 2) {
        for (let i = 0; i < 8000; i += 1) {
          const env = Math.exp(-i / 2500)
          const frequency = i < 1500 ? 150 : 50
          data[hit + i] += Math.sin((2 * Math.PI * frequency * i) / rate) * env
        }
      }
      return bandEnergies([data], rate)
    }
    const a = render(0)
    const b = render(733)
    expect(Math.abs(a.sub.share - b.sub.share)).toBeLessThan(0.02)
    expect(Math.abs(a.bass.share - b.bass.share)).toBeLessThan(0.02)
  })
})

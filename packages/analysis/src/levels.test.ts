import { describe, expect, it } from 'vitest'
import {
  crestFactor,
  dcOffset,
  integratedLoudness,
  kWeightingFilters,
  momentaryLoudness,
  peak,
  rms,
  shortTermLoudness,
  stereoBalance,
  stereoCorrelation,
  truePeak,
} from './levels'
import { noise, sine } from './test-signals'
import { DB_FLOOR } from './util'

const dbfs = (db: number) => 10 ** (db / 20)

function concat(parts: Float32Array[]): Float32Array {
  const result = new Float32Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.length
  }
  return result
}

function fade(signal: Float32Array, samples: number): Float32Array {
  for (let i = 0; i < samples; i += 1) {
    const gain = 0.5 - 0.5 * Math.cos((Math.PI * i) / samples)
    signal[i] *= gain
    signal[signal.length - 1 - i] *= gain
  }
  return signal
}

describe('sample levels', () => {
  it('reads peak, RMS, and crest of a sine', () => {
    const signal = sine(997, 0.5, 1, 48000)
    expect(peak([signal])).toBeCloseTo(-6.0206, 3)
    expect(rms([signal])).toBeCloseTo(-9.0309, 3)
    expect(crestFactor([signal])).toBeCloseTo(3.0103, 3)
  })

  it('reports silence at the floor with a neutral crest', () => {
    const silence = new Float32Array(1000)
    expect(peak([silence])).toBe(DB_FLOOR)
    expect(rms([silence])).toBe(DB_FLOOR)
    expect(crestFactor([silence])).toBe(0)
  })

  it('measures DC per channel', () => {
    const offset = new Float32Array(48000).fill(0.02)
    const centered = sine(100, 0.5, 1, 48000)
    const [dcLeft, dcRight] = dcOffset([offset, centered])
    expect(dcLeft).toBeCloseTo(0.02, 6)
    expect(Math.abs(dcRight)).toBeLessThan(1e-6)
  })
})

describe('true peak', () => {
  it('finds the inter-sample peak of a quarter-rate sine', () => {
    // Samples land 45 degrees off the crest, so the sample peak reads -3.01 dBFS. Fades keep
    // the abrupt start and end from ringing above the sine itself.
    const signal = fade(sine(12000, 1, 0.5, 48000, Math.PI / 4), 480)
    expect(peak([signal])).toBeCloseTo(-3.01, 2)
    expect(truePeak([signal], 48000)).toBeGreaterThan(-0.1)
    expect(truePeak([signal], 48000)).toBeLessThan(0.1)
  })

  it('never reads below the sample peak', () => {
    const signal = noise(0.2, 44100, 0.7)
    expect(truePeak([signal], 44100)).toBeGreaterThanOrEqual(peak([signal]))
  })
})

describe('loudness', () => {
  it('matches the 48 kHz K-weighting coefficients published in BS.1770-4', () => {
    const [shelf, highPass] = kWeightingFilters(48000)
    expect(shelf.b0).toBeCloseTo(1.53512485958697, 10)
    expect(shelf.b1).toBeCloseTo(-2.69169618940638, 10)
    expect(shelf.b2).toBeCloseTo(1.19839281085285, 10)
    expect(shelf.a1).toBeCloseTo(-1.69065929318241, 10)
    expect(shelf.a2).toBeCloseTo(0.73248077421585, 10)
    expect(highPass.a1).toBeCloseTo(-1.99004745483398, 10)
    expect(highPass.a2).toBeCloseTo(0.99007225036621, 10)
  })

  // BS.1770 defines a 0 dBFS 1 kHz sine in one front channel as -3.01 LKFS, so a single
  // (mono) channel at -20 dBFS reads -23.01 LUFS. Feeding the same sine to both stereo
  // channels sums their power and reads 3.01 LU louder.
  it('reads a -20 dBFS 1 kHz mono sine as -23.01 LUFS at 48 and 44.1 kHz', () => {
    for (const sampleRate of [48000, 44100]) {
      const signal = sine(1000, dbfs(-20), 5, sampleRate)
      expect(Math.abs(integratedLoudness([signal], sampleRate) + 23.01)).toBeLessThan(0.05)
      expect(Math.abs(integratedLoudness([signal, signal], sampleRate) + 20)).toBeLessThan(0.05)
    }
  })

  it('reads EBU Tech 3341 case 1 (stereo -23 dBFS sine) as -23.0 LUFS', () => {
    const signal = sine(1000, dbfs(-23), 5, 48000)
    expect(Math.abs(integratedLoudness([signal, signal], 48000) + 23)).toBeLessThan(0.05)
  })

  it('gates quiet passages like EBU Tech 3341 case 4', () => {
    const sampleRate = 48000
    const part = (db: number, seconds: number) => sine(1000, dbfs(db), seconds, sampleRate)
    const signal = concat([part(-72, 10), part(-36, 10), part(-23, 60), part(-36, 10), part(-72, 10)])
    expect(Math.abs(integratedLoudness([signal, signal], sampleRate) + 23)).toBeLessThan(0.1)
  })

  it('returns the floor when everything sits under the absolute gate', () => {
    expect(integratedLoudness([sine(1000, dbfs(-80), 2, 48000)], 48000)).toBe(DB_FLOOR)
  })

  it('measures a signal shorter than one block as a single block', () => {
    expect(Math.abs(integratedLoudness([sine(1000, dbfs(-20), 0.2, 48000)], 48000) + 23.01)).toBeLessThan(0.2)
  })

  it('tracks level changes in the short-term and momentary series', () => {
    const sampleRate = 48000
    const signal = concat([sine(1000, dbfs(-30), 4, sampleRate), sine(1000, dbfs(-20), 4, sampleRate)])
    const shortTerm = shortTermLoudness([signal], sampleRate)
    expect(shortTerm.length).toBe(80 - 30 + 1)
    expect(shortTerm[0].time).toBeCloseTo(3, 6)
    expect(shortTerm[0].lufs).toBeCloseTo(-33.01, 1)
    expect(shortTerm[shortTerm.length - 1].lufs).toBeCloseTo(-23.01, 1)
    expect(momentaryLoudness([signal], sampleRate).length).toBe(80 - 4 + 1)
  })
})

describe('stereo image', () => {
  const left = sine(440, 0.5, 0.5, 48000)

  it('reads identical channels as +1 and inverted channels as -1', () => {
    const inverted = left.map((value) => -value)
    expect(stereoCorrelation(left, left)).toBeCloseTo(1, 6)
    expect(stereoCorrelation(left, inverted)).toBeCloseTo(-1, 6)
  })

  it('reads quadrature channels near 0 and silence as 0', () => {
    const quadrature = sine(440, 0.5, 0.5, 48000, Math.PI / 2)
    expect(Math.abs(stereoCorrelation(left, quadrature))).toBeLessThan(0.01)
    expect(stereoCorrelation(left, new Float32Array(left.length))).toBe(0)
  })

  it('reports balance as left minus right in dB', () => {
    const quieter = left.map((value) => value / 2)
    expect(stereoBalance(left, quieter)).toBeCloseTo(6.02, 2)
    expect(stereoBalance(quieter, left)).toBeCloseTo(-6.02, 2)
  })
})

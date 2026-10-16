import { describe, expect, it } from 'vitest'
import { fft, magnitudeSpectrum, SpectrumAnalyzer } from './fft'
import { sine } from './test-signals'

describe('fft', () => {
  it('matches a direct DFT and inverts back to the input', () => {
    const size = 16
    const re = new Float64Array(size)
    const im = new Float64Array(size)
    for (let i = 0; i < size; i += 1) {
      re[i] = Math.sin(i * 0.7) + (i % 3)
      im[i] = Math.cos(i * 0.3)
    }
    const inputRe = Float64Array.from(re)
    const inputIm = Float64Array.from(im)
    fft(re, im)
    for (let k = 0; k < size; k += 1) {
      let sumRe = 0
      let sumIm = 0
      for (let n = 0; n < size; n += 1) {
        const angle = (-2 * Math.PI * k * n) / size
        sumRe += inputRe[n] * Math.cos(angle) - inputIm[n] * Math.sin(angle)
        sumIm += inputRe[n] * Math.sin(angle) + inputIm[n] * Math.cos(angle)
      }
      expect(re[k]).toBeCloseTo(sumRe, 9)
      expect(im[k]).toBeCloseTo(sumIm, 9)
    }
    fft(re, im, true)
    for (let i = 0; i < size; i += 1) {
      expect(re[i]).toBeCloseTo(inputRe[i], 12)
      expect(im[i]).toBeCloseTo(inputIm[i], 12)
    }
  })

  it('rejects sizes that are not powers of two', () => {
    expect(() => fft(new Float64Array(12), new Float64Array(12))).toThrow()
  })
})

describe('magnitude spectrum', () => {
  it('reads a bin-centered sine at its amplitude', () => {
    const size = 1024
    const sampleRate = 1024 * 8
    const frame = sine(64 * 8, 0.5, size / sampleRate, sampleRate)
    const magnitudes = magnitudeSpectrum(frame)
    expect(magnitudes.length).toBe(size / 2 + 1)
    expect(magnitudes[64]).toBeCloseTo(0.5, 6)
    expect(magnitudes[63]).toBeCloseTo(0.25, 6)
    expect(magnitudes[100]).toBeLessThan(1e-6)
  })

  it('scales bin powers to the mean square of the signal', () => {
    const analyzer = new SpectrumAnalyzer(2048)
    const frame = sine(1000.3, 0.6, 1, 48000)
    const power = analyzer.power(frame, 1000, new Float64Array(analyzer.binCount))
    const total = power.reduce((sum, value) => sum + value, 0)
    expect(total).toBeCloseTo(0.18, 3)
  })
})

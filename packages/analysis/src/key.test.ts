import { describe, expect, it } from 'vitest'
import { chromagram, estimateKey, KEY_MIN_CONFIDENCE } from './key'
import { noise } from './test-signals'

const SAMPLE_RATE = 44100
const midiToHz = (note: number) => 440 * 2 ** ((note - 69) / 12)

/** Sustained chord of harmonic tones (fundamental plus three decaying partials). */
function chord(notes: readonly number[], seconds = 2): Float32Array {
  const signal = new Float32Array(Math.round(seconds * SAMPLE_RATE))
  for (const note of notes) {
    const frequency = midiToHz(note)
    for (let harmonic = 1; harmonic <= 4; harmonic += 1) {
      const step = (2 * Math.PI * frequency * harmonic) / SAMPLE_RATE
      for (let i = 0; i < signal.length; i += 1) signal[i] += (0.2 / harmonic) * Math.sin(step * i)
    }
  }
  return signal
}

describe('key estimation', () => {
  it('builds a chromagram that peaks on the chord tones', () => {
    const chroma = chromagram(chord([60, 64, 67]), SAMPLE_RATE)
    const ranked = Array.from(chroma.keys()).sort((a, b) => chroma[b] - chroma[a])
    expect(ranked.slice(0, 3).sort((a, b) => a - b)).toEqual([0, 4, 7])
    expect(chroma.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 9)
  })

  it('reads a C major triad as C major', () => {
    const estimate = estimateKey(chord([60, 64, 67]), SAMPLE_RATE)
    expect(estimate.key).toBe('C major')
    expect(estimate.confidence).toBeGreaterThanOrEqual(KEY_MIN_CONFIDENCE)
  })

  it('reads an A minor triad as A minor', () => {
    const estimate = estimateKey(chord([57, 60, 64]), SAMPLE_RATE)
    expect(estimate.key).toBe('A minor')
    expect(estimate.confidence).toBeGreaterThanOrEqual(KEY_MIN_CONFIDENCE)
  })

  it('returns null for noise and silence', () => {
    expect(estimateKey(noise(2, SAMPLE_RATE), SAMPLE_RATE).key).toBeNull()
    expect(estimateKey(new Float32Array(SAMPLE_RATE), SAMPLE_RATE)).toEqual({ key: null, confidence: 0 })
  })
})

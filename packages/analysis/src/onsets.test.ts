import { describe, expect, it } from 'vitest'
import { detectOnsets, estimateDownbeat, estimateTempo, onsetEnvelope } from './onsets'
import { beatTimes, clicks, noise, sine } from './test-signals'

const SAMPLE_RATE = 44100

describe('onset envelope', () => {
  it('uses ~23 ms hops and peaks at a click', () => {
    const envelope = onsetEnvelope(clicks([0.5], 1, SAMPLE_RATE), SAMPLE_RATE)
    expect(envelope.hopSeconds).toBeCloseTo(0.0232, 3)
    let peakFrame = 0
    envelope.values.forEach((value, frame) => {
      if (value > envelope.values[peakFrame]) peakFrame = frame
    })
    expect(Math.abs(peakFrame * envelope.hopSeconds - 0.5)).toBeLessThanOrEqual(envelope.hopSeconds)
  })

  it('stays flat for a steady tone after its start', () => {
    const envelope = onsetEnvelope(sine(440, 0.5, 1, SAMPLE_RATE), SAMPLE_RATE)
    const settled = envelope.values.slice(3, -3)
    expect(Math.max(...settled)).toBeLessThan(envelope.values[0] * 0.05)
  })
})

describe('onset detection', () => {
  it('finds every click of an irregular train within 10 ms', () => {
    const times = [0.1, 0.37, 0.52, 0.9, 1.31, 1.4, 1.95, 2.6]
    const onsets = detectOnsets(clicks(times, 3, SAMPLE_RATE), SAMPLE_RATE)
    expect(onsets.length).toBe(times.length)
    onsets.forEach((onset, index) => expect(Math.abs(onset - times[index])).toBeLessThan(0.01))
  })

  it('finds quiet clicks only at high sensitivity', () => {
    const times = [0.2, 0.6, 1, 1.4]
    const signal = clicks(times, 2, SAMPLE_RATE, [0.8, 0.8, 0.05, 0.8])
    const background = noise(2, SAMPLE_RATE, 0.002)
    for (let i = 0; i < signal.length; i += 1) signal[i] += background[i]
    expect(detectOnsets(signal, SAMPLE_RATE, { sensitivity: 0 }).length).toBe(3)
    expect(detectOnsets(signal, SAMPLE_RATE, { sensitivity: 1 }).length).toBe(4)
  })

  it('respects the minimum gap and returns nothing for silence', () => {
    const onsets = detectOnsets(clicks([0.5, 0.53, 1], 1.5, SAMPLE_RATE), SAMPLE_RATE, { minGapSeconds: 0.1 })
    expect(onsets.length).toBe(2)
    expect(detectOnsets(new Float32Array(SAMPLE_RATE), SAMPLE_RATE)).toEqual([])
  })
})

describe('tempo estimation', () => {
  for (const bpm of [90, 120, 174]) {
    it(`estimates ${bpm} BPM from a click train within 1 BPM`, () => {
      const signal = clicks(beatTimes(bpm, 12, 0.11), 12, SAMPLE_RATE)
      const tempo = estimateTempo(signal, SAMPLE_RATE, { min: 70, max: 180 })
      expect(Math.abs(tempo.bpm - bpm)).toBeLessThanOrEqual(1)
      expect(tempo.confidence).toBeGreaterThan(0.5)
    })
  }

  it('reports low confidence for noise', () => {
    expect(estimateTempo(noise(8, SAMPLE_RATE), SAMPLE_RATE).confidence).toBeLessThan(0.3)
  })

  it('finds the accented downbeat of a 4/4 click train', () => {
    const times = beatTimes(120, 12, 0.3)
    const amplitudes = times.map((_, index) => (index % 4 === 2 ? 0.9 : 0.25))
    const downbeat = estimateDownbeat(clicks(times, 12, SAMPLE_RATE, amplitudes), SAMPLE_RATE, { bpm: 120 })
    expect(Math.abs(downbeat - 1.3)).toBeLessThan(0.01)
  })
})

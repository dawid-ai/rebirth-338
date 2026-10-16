import { describe, expect, it } from 'vitest'
import { decodeWav, decodeWavHeader, encodeWav } from './dither'
import { sine } from './test-signals'

const SAMPLE_RATE = 44100

function maxError(a: Float32Array, b: Float32Array): number {
  let max = 0
  for (let i = 0; i < a.length; i += 1) max = Math.max(max, Math.abs(a[i] - b[i]))
  return max
}

describe('WAV encoding', () => {
  const left = sine(440, 0.8, 0.1, SAMPLE_RATE)
  const right = sine(660, 0.5, 0.1, SAMPLE_RATE)

  for (const bitDepth of [16, 24] as const) {
    it(`round-trips ${bitDepth}-bit PCM within half an LSB`, () => {
      const buffer = encodeWav([left, right], SAMPLE_RATE, bitDepth)
      const header = decodeWavHeader(buffer)
      expect(header).toEqual({
        channels: 2,
        sampleRate: SAMPLE_RATE,
        bitDepth,
        format: 1,
        frames: left.length,
        dataOffset: 44,
        dataBytes: left.length * 2 * (bitDepth / 8),
      })
      expect(buffer.byteLength).toBe(44 + header.dataBytes)
      const decoded = decodeWav(buffer)
      const lsb = 1 / 2 ** (bitDepth - 1)
      expect(maxError(decoded.channels[0], left)).toBeLessThanOrEqual(lsb / 2 + 1e-7)
      expect(maxError(decoded.channels[1], right)).toBeLessThanOrEqual(lsb / 2 + 1e-7)
    })
  }

  it('clips out-of-range samples to full scale', () => {
    const decoded = decodeWav(encodeWav([Float32Array.from([2, -2, Number.NaN])], SAMPLE_RATE, 16))
    expect(Array.from(decoded.channels[0])).toEqual([32767 / 32768, -1, 0])
  })

  it('dithers 16-bit output deterministically for a given seed', () => {
    const quiet = sine(440, 0.001, 0.05, SAMPLE_RATE)
    const first = new Uint8Array(encodeWav([quiet], SAMPLE_RATE, 16, { dither: true, seed: 42 }))
    const second = new Uint8Array(encodeWav([quiet], SAMPLE_RATE, 16, { dither: true, seed: 42 }))
    const otherSeed = new Uint8Array(encodeWav([quiet], SAMPLE_RATE, 16, { dither: true, seed: 43 }))
    const undithered = new Uint8Array(encodeWav([quiet], SAMPLE_RATE, 16))
    expect(first).toEqual(second)
    expect(first).not.toEqual(otherSeed)
    expect(first).not.toEqual(undithered)
    // TPDF dither stays within one LSB of the undithered value.
    const ditheredSamples = decodeWav(first.buffer).channels[0]
    expect(maxError(ditheredSamples, quiet)).toBeLessThanOrEqual(1.5 / 32768 + 1e-7)
  })

  it('skips unknown chunks when reading the header', () => {
    const plain = new Uint8Array(encodeWav([Float32Array.from([0.5, -0.5])], 8000, 16))
    const withList = new Uint8Array(plain.length + 10)
    withList.set(plain.subarray(0, 36))
    withList.set([0x4c, 0x49, 0x53, 0x54, 2, 0, 0, 0, 0xaa, 0xbb], 36)
    withList.set(plain.subarray(36), 46)
    const header = decodeWavHeader(withList.buffer)
    expect(header.dataOffset).toBe(54)
    expect(Array.from(decodeWav(withList.buffer).channels[0])).toEqual([0.5, -0.5])
  })
})

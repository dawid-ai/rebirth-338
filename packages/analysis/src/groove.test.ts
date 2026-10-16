import { describe, expect, it } from 'vitest'
import { extractGroove } from './groove'

describe('extractGroove', () => {
  it('finds a late second sixteenth (swing) and leaves straight steps at zero', () => {
    const bpm = 90
    const step = 60 / bpm / 4
    const onsets: number[] = []
    for (let bar = 0; bar < 4; bar += 1) {
      for (let s = 0; s < 16; s += 1) onsets.push((bar * 16 + s + (s % 2 ? 0.3 : 0)) * step)
    }
    const groove = extractGroove(onsets, bpm)
    expect(groove[0]).toBe(0)
    expect(groove[1]).toBeCloseTo(0.3, 2)
    expect(groove[2]).toBe(0)
  })

  it('ignores onsets halfway between steps', () => {
    expect(extractGroove([0.5 * (60 / 120 / 4)], 120).every((v) => v === 0)).toBe(true)
  })
})

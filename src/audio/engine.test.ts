import { describe, expect, it } from 'vitest'
import { createDefaultProject } from '../model'
import { applyOutputCeiling, beatRepeatSeconds, crossfaderGains, deckPlaybackRate, isMixerChannelAudible, makeBitCrushCurve, makeSaturationCurve, samplePlaybackRegion, swungStepDuration, tempoDelaySeconds } from './engine'

describe('sequencer timing', () => {
  it('keeps a swung pair the same total length', () => {
    const project = createDefaultProject()
    project.tempo = 120
    project.swing = 30
    const straightPair = (60 / 120 / 4) * 2
    expect(swungStepDuration(project, 0) + swungStepDuration(project, 1)).toBeCloseTo(straightPair, 10)
  })

  it('clamps tempo and swing to safe musical ranges', () => {
    expect(swungStepDuration({ tempo: 0, swing: 999 }, 0)).toBeCloseTo((60 / 40 / 4) * 1.75)
    expect(swungStepDuration({ tempo: 999, swing: -5 }, 1)).toBeCloseTo(60 / 240 / 4)
  })
})

describe('mixer routing', () => {
  it('uses an equal-power A/B crossfade curve', () => {
    expect(crossfaderGains(-100)).toEqual([1, 0])
    expect(crossfaderGains(0)[0]).toBeCloseTo(Math.SQRT1_2, 8)
    expect(crossfaderGains(0)[1]).toBeCloseTo(Math.SQRT1_2, 8)
    expect(crossfaderGains(100)[0]).toBeCloseTo(0, 8)
    expect(crossfaderGains(100)[1]).toBeCloseTo(1, 8)
  })

  it('applies mute and global solo policy to drum channels', () => {
    const project = createDefaultProject()
    const kick = { kind: 'drum', machineIndex: 0, name: 'kick' } as const
    const snare = { kind: 'drum', machineIndex: 0, name: 'snare' } as const
    expect(isMixerChannelAudible(project, kick)).toBe(true)
    project.rhythms[0].drums.kick.muted = true
    expect(isMixerChannelAudible(project, kick)).toBe(false)
    project.rhythms[0].drums.kick.muted = false
    project.rhythms[0].drums.snare.solo = true
    expect(isMixerChannelAudible(project, kick)).toBe(false)
    expect(isMixerChannelAudible(project, snare)).toBe(true)
    expect(isMixerChannelAudible(project, { kind: 'bass', index: 0 })).toBe(false)
  })

  it('mutes a whole rhythm machine and solos either mixer deck', () => {
    const project = createDefaultProject()
    project.rhythms[0].muted = true
    expect(isMixerChannelAudible(project, { kind: 'drum', machineIndex: 0, name: 'kick' })).toBe(false)
    project.rhythms[0].muted = false
    project.bass[1].solo = true
    expect(isMixerChannelAudible(project, { kind: 'bass', index: 1 })).toBe(true)
    expect(isMixerChannelAudible(project, { kind: 'bass', index: 0 })).toBe(false)
  })

  it('routes the Wave Designer as an independent fifth mixer channel', () => {
    const project = createDefaultProject()
    expect(isMixerChannelAudible(project, { kind: 'wave' })).toBe(true)
    project.waveDesigner.solo = true
    expect(isMixerChannelAudible(project, { kind: 'wave' })).toBe(true)
    expect(isMixerChannelAudible(project, { kind: 'bass', index: 0 })).toBe(false)
    project.waveDesigner.muted = true
    expect(isMixerChannelAudible(project, { kind: 'wave' })).toBe(false)
  })

  it('includes sampler and media decks in the global solo policy', () => {
    const project = createDefaultProject()
    expect(isMixerChannelAudible(project, { kind: 'sampler' })).toBe(true)
    expect(isMixerChannelAudible(project, { kind: 'deck', index: 0 })).toBe(true)
    project.sampler.solo = true
    expect(isMixerChannelAudible(project, { kind: 'sampler' })).toBe(true)
    expect(isMixerChannelAudible(project, { kind: 'deck', index: 0 })).toBe(false)
    project.sampler.solo = false
    project.decks[0].solo = true
    expect(isMixerChannelAudible(project, { kind: 'deck', index: 0 })).toBe(true)
    expect(isMixerChannelAudible(project, { kind: 'deck', index: 1 })).toBe(false)
  })
})

describe('performance effects', () => {
  it('derives beat-repeat duration from tempo and division', () => {
    const project = createDefaultProject()
    project.tempo = 120
    project.performance.beatRepeatDivision = 4
    expect(beatRepeatSeconds(project)).toBe(0.125)
    project.performance.beatRepeatDivision = 8
    expect(beatRepeatSeconds(project)).toBe(0.0625)
  })

  it('quantizes echo time to tempo-synchronised musical divisions', () => {
    expect(tempoDelaySeconds(120, 0)).toBe(0.0625)
    expect(tempoDelaySeconds(120, 100)).toBe(0.5)
    expect(tempoDelaySeconds(60, 100)).toBe(1)
  })

  it('maps deck pitch and rate predictably', () => {
    expect(deckPlaybackRate({ rate: 1, pitch: 12 })).toBeCloseTo(2)
    expect(deckPlaybackRate({ rate: 0.5, pitch: -12 })).toBeCloseTo(0.25)
    expect(deckPlaybackRate({ rate: 99, pitch: 99 })).toBe(16)
  })

  it('normalizes sampler trim and pitch into a playable region', () => {
    expect(samplePlaybackRegion({ trimStart: 0.25, trimEnd: 0.75, pitch: 12 }, 8)).toEqual({ start: 2, end: 6, rate: 2 })
    const clamped = samplePlaybackRegion({ trimStart: -2, trimEnd: 4, pitch: -99 }, 4)
    expect(clamped.start).toBe(0)
    expect(clamped.end).toBe(4)
    expect(clamped.rate).toBe(0.25)
  })

  it('trims overlapped export tails below the requested PCM ceiling', () => {
    const channels = [new Float32Array([0, 0.5, 1.4]), new Float32Array([-1.2, 0, 0.3])]
    const gain = applyOutputCeiling(channels, -0.3)
    expect(gain).toBeLessThan(1)
    expect(Math.max(...channels.flatMap((channel) => [...channel].map(Math.abs)))).toBeLessThanOrEqual(10 ** (-0.3 / 20) + 1e-6)
  })

  it('keeps the drive stage transparent at zero and bounded at full drive', () => {
    const dry = makeSaturationCurve(101, 0)
    const driven = makeSaturationCurve(101, 1)
    expect(dry[50]).toBeCloseTo(0, 6)
    expect(dry[75]).toBeCloseTo(0.5, 6)
    expect(driven[75]).toBeGreaterThan(dry[75])
    expect(Math.max(...driven.map(Math.abs))).toBeLessThanOrEqual(1)
  })

  it('creates progressively finer lo-fi quantization curves', () => {
    const fourBit = makeBitCrushCurve(257, 4)
    const sixteenBit = makeBitCrushCurve(257, 16)
    expect(new Set(fourBit).size).toBeLessThan(new Set(sixteenBit).size)
    expect(Math.max(...fourBit.map(Math.abs))).toBeLessThanOrEqual(1)
  })
})

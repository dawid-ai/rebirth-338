import { describe, expect, it } from 'vitest'
import { createDefaultProject, drumNames } from '../model'
import {
  DUBSTEP_AUTOMATION_FRAMES,
  DUBSTEP_SONG_CHAIN,
  applyDubstepBarAutomation,
  createDubstepDemoProject,
  dubstepSectionForBar,
} from './dubstepDemo'

describe('48-bar dubstep demo', () => {
  it('contains a complete six-section arrangement rather than a short loop', () => {
    expect(DUBSTEP_SONG_CHAIN).toHaveLength(48)
    expect(dubstepSectionForBar(0)).toBe('INTRO')
    expect(dubstepSectionForBar(8)).toBe('BUILD')
    expect(dubstepSectionForBar(16)).toBe('DROP A')
    expect(dubstepSectionForBar(24)).toBe('BREAKDOWN')
    expect(dubstepSectionForBar(32)).toBe('DROP B')
    expect(dubstepSectionForBar(40)).toBe('OUTRO')
  })

  it('installs playable sixteen-step patterns and valid song slots', () => {
    const demo = createDubstepDemoProject(createDefaultProject())
    expect(demo.name).toContain('48 BAR')
    expect(demo.songChain).toHaveLength(48)
    expect(demo.songScenes.map((scene) => [scene.name, scene.start])).toEqual([
      ['INTRO', 0], ['BUILD', 8], ['DROP A', 16], ['BREAKDOWN', 24], ['DROP B', 32], ['OUTRO', 40],
    ])
    expect(demo.waveDesigner.steps).toHaveLength(16)
    demo.bass.forEach((voice) => voice.patterns.forEach((pattern) => expect(pattern).toHaveLength(16)))
    demo.rhythms.forEach((machine) => machine.patterns.forEach((pattern) => {
      drumNames.forEach((name) => expect(pattern[name]).toHaveLength(16))
    }))
    demo.songChain.forEach((bar) => {
      bar.bass.forEach((slot, index) => expect(slot).toBeLessThan(demo.bass[index].patterns.length))
      bar.drums.forEach((slot, index) => expect(slot).toBeLessThan(demo.rhythms[index].patterns.length))
    })
  })

  it('has automation landmarks at all major transitions', () => {
    expect(DUBSTEP_AUTOMATION_FRAMES.map((frame) => frame.bar)).toEqual(expect.arrayContaining([1, 9, 17, 25, 33, 41, 48]))
    const demo = createDubstepDemoProject(createDefaultProject())
    expect(demo.delayMix).toBe(0)
    expect(demo.reverbMix).toBe(0)
    expect(demo.demoAutoMix).toBe(false)
    expect(applyDubstepBarAutomation({ ...demo, delayMix: 7, reverbMix: 3 }, 11)).toMatchObject({ delayMix: 7, reverbMix: 3 })
    const automated = applyDubstepBarAutomation({ ...demo, demoAutoMix: true }, 11)
    expect(automated.filterCutoff).toBe(72)
    expect(automated.crossfader).toBe(0)
    expect(automated.bass[1].drive).toBe(44)
  })
})

import { describe, expect, it } from 'vitest'
import { drumNames } from '../model'
import { createDemoProject, demoCatalog } from './catalog'

describe('demo song catalog', () => {
  it('offers three complete and distinct arrangements', () => {
    expect(demoCatalog).toHaveLength(3)
    const songs = demoCatalog.map(({ id }) => createDemoProject(id))
    expect(songs.map((song) => song.songChain.length)).toEqual([48, 32, 40])
    expect(new Set(songs.map((song) => song.tempo)).size).toBe(3)
    for (const song of songs) {
      expect(song.mode).toBe('song')
      expect(song.songScenes[0].start).toBe(0)
      expect(song.performance.beatRepeat).toBe(false)
      song.songChain.forEach((bar) => {
        bar.bass.forEach((slot, index) => expect(slot).toBeLessThan(song.bass[index].patterns.length))
        bar.drums.forEach((slot, index) => expect(slot).toBeLessThan(song.rhythms[index].patterns.length))
      })
      song.rhythms.forEach((machine) => machine.patterns.forEach((pattern) => {
        drumNames.forEach((name) => expect(pattern[name]).toHaveLength(16))
      }))
    }
  })

  it('rebuilds every original control value after a demo is edited', () => {
    const song = createDemoProject('matrix')
    const original = createDemoProject('matrix')
    song.masterDrive = 99
    song.bass[0].cutoff = 99
    song.rhythms[0].drums.kick.level = 0
    song.sampler.drive = 99
    song.decks[0].filter = -99
    song.songChain[4].bass[0] = 22
    expect(createDemoProject('matrix')).toEqual(original)
  })
})

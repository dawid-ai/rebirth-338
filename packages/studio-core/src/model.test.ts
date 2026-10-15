import { describe, expect, it } from 'vitest'
import { createDefaultProject, hydrateProject, normalizeSongScenes, resizeSongChain, restoreBassDefaults, restoreDeckDefaults, restoreRhythmDefaults, restoreSamplerDefaults, restoreWaveDefaults, transferWaveToBass, wipeBassPattern, wipeRhythmPattern, wipeSamplerPattern, wipeWavePattern } from './model'

describe('project hydration', () => {
  it('dries out legacy demo autosaves without changing newer mixes', () => {
    const oldDemo = { ...createDefaultProject(), name: 'ABYSSAL SIGNAL — 48 BAR DEMO', delayMix: 48, reverbMix: 39, masterDrive: 31, demoAutoMix: undefined }
    expect(hydrateProject(oldDemo).delayMix).toBe(0)
    expect(hydrateProject(oldDemo).reverbMix).toBe(0)
    expect(hydrateProject({ ...oldDemo, demoAutoMix: false, delayMix: 18 }).delayMix).toBe(18)
  })
  it('adds modern mixer defaults to legacy project data', () => {
    const legacy = createDefaultProject()
    const candidate = structuredClone(legacy) as unknown as Record<string, unknown>
    delete candidate.performance
    delete candidate.crossfader
    delete candidate.delayMix
    delete candidate.reverbMix
    const legacyBass = candidate.bass as Array<Record<string, unknown>>
    delete legacyBass[0].oscSource
    delete legacyBass[0].designerWaveform
    delete legacyBass[0].designerSpread
    const hydrated = hydrateProject(candidate as never)
    expect(hydrated.performance.beatRepeat).toBe(false)
    expect(hydrated.crossfader).toBe(0)
    expect(hydrated.delayMix).toBeTypeOf('number')
    expect(hydrated.rhythms[0].drums.kick.solo).toBe(false)
    expect(hydrated.bass[0].eqLow).toBeTypeOf('number')
    expect(hydrated.bass[0].oscSource).toBe('classic')
    expect(hydrated.bass[0].designerWaveform).toBeTypeOf('string')
  })

  it('loads a Wave Designer tone into a 303 without replacing its sequence or mixer level', () => {
    const project = createDefaultProject()
    const originalSteps = project.bass[0].steps
    const originalLevel = project.bass[0].level
    project.waveDesigner.waveform = 'sine'
    project.waveDesigner.spread = 74
    project.waveDesigner.cutoff = 81
    const transferred = transferWaveToBass(project.bass[0], project.waveDesigner)
    expect(transferred.oscSource).toBe('designer')
    expect(transferred.designerWaveform).toBe('sine')
    expect(transferred.designerSpread).toBe(74)
    expect(transferred.cutoff).toBe(81)
    expect(transferred.steps).toBe(originalSteps)
    expect(transferred.level).toBe(originalLevel)
  })

  it('creates a 32-bar arrangement and resizes it without losing existing cues', () => {
    const project = createDefaultProject()
    expect(project.songChain).toHaveLength(32)
    const first = project.songChain[0]
    const expanded = resizeSongChain(project, 48)
    expect(expanded.songChain).toHaveLength(48)
    expect(expanded.songChain[0]).toEqual(first)
    expect(resizeSongChain(expanded, 12).songChain).toHaveLength(12)
  })

  it('hydrates legacy eight-bar projects while adding decks and four sampler banks', () => {
    const project = createDefaultProject()
    const legacy = { ...project, songChain: project.songChain.slice(0, 8), decks: undefined, sampler: undefined }
    const hydrated = hydrateProject(legacy as never)
    expect(hydrated.songChain).toHaveLength(8)
    expect(hydrated.decks).toHaveLength(2)
    expect(hydrated.sampler.slots).toHaveLength(32)
    expect(hydrated.sampler.slots[0].stepProbabilities).toHaveLength(16)
    expect(hydrated.sampler.sixteenLevels).toBe('off')
    expect(hydrated.waveDesigner.steps).toHaveLength(16)
    expect(hydrated.songScenes[0]).toEqual({ name: 'INTRO', start: 0 })
  })

  it('adds removable starter audio once when hydrating pre-pack projects', () => {
    const legacy = createDefaultProject()
    delete (legacy as Partial<typeof legacy>).starterPackVersion
    legacy.decks.forEach((deck) => { deck.assetId = null })
    legacy.sampler.slots.forEach((slot) => { slot.assetId = null })
    const hydrated = hydrateProject(legacy)
    expect(hydrated.decks.every((deck) => deck.assetId?.startsWith('builtin:'))).toBe(true)
    expect(hydrated.sampler.slots.filter((slot) => slot.assetId?.startsWith('builtin:'))).toHaveLength(8)

    hydrated.sampler.slots[0].assetId = null
    expect(hydrateProject(hydrated).sampler.slots[0].assetId).toBeNull()
  })

  it('normalizes editable scene markers without imposing fixed section lengths', () => {
    expect(normalizeSongScenes([
      { name: 'drop', start: 12 },
      { name: 'intro', start: 0 },
      { name: 'duplicate', start: 12 },
      { name: 'late', start: 999 },
    ], 24)).toEqual([
      { name: 'INTRO', start: 0 },
      { name: 'DROP', start: 12 },
      { name: 'LATE', start: 23 },
    ])
  })
})

describe('factory dubstep song', () => {
  it('ships an arranged 140 BPM half-time demo with real pattern variation', () => {
    const project = createDefaultProject()
    expect(project.name).toBe('DUB PRESSURE DEMO')
    expect(project.tempo).toBe(140)
    expect(project.mode).toBe('song')
    expect(new Set(project.songChain.map((cue) => cue.bass.join(':'))).size).toBeGreaterThan(4)
    expect(new Set(project.songChain.map((cue) => cue.drums.join(':'))).size).toBeGreaterThan(4)
    expect(project.rhythms[1].patterns[0].snare[8]).toBe(2)
    expect(project.rhythms[0].patterns[0].kick[0]).toBe(2)
    expect(project.bass[0].patterns[0].some((step) => step.slide)).toBe(true)
    expect(project.decks.every((deck) => deck.assetId?.startsWith('builtin:'))).toBe(true)
    expect(project.sampler.slots.filter((slot) => slot.assetId)).toHaveLength(8)
  })
})

describe('machine recovery controls', () => {
  it('wipes complete current patterns, including hidden modifiers', () => {
    const project = createDefaultProject()
    const bass = wipeBassPattern(project.bass[0])
    expect(bass.steps.every((step) => !step.active && !step.accent && !step.slide && step.octave === 0)).toBe(true)
    expect(bass.patterns[0]).toEqual(bass.steps)

    const rhythm = wipeRhythmPattern(project.rhythms[0])
    expect(Object.values(rhythm.steps).flat().every((step) => step === 0)).toBe(true)

    const wave = wipeWavePattern(project.waveDesigner)
    expect(wave.steps.every((step) => !step.active && !step.accent && !step.slide)).toBe(true)

    project.sampler.slots[0].steps[0] = 2
    project.sampler.slots[0].stepRatchets[0] = 4
    const sampler = wipeSamplerPattern(project.sampler)
    expect(sampler.slots[0].steps.every((step) => step === 0)).toBe(true)
    expect(sampler.slots[0].stepRatchets.every((value) => value === 1)).toBe(true)
    expect(sampler.slots[0].stepProbabilities.every((value) => value === 100)).toBe(true)
  })

  it('restores factory controls without destroying patterns or loaded audio', () => {
    const project = createDefaultProject()
    const bassPatterns = project.bass[0].patterns
    project.bass[0].cutoff = 99
    expect(restoreBassDefaults(project.bass[0], 0).patterns).toBe(bassPatterns)
    expect(restoreBassDefaults(project.bass[0], 0).cutoff).not.toBe(99)

    const rhythmPatterns = project.rhythms[0].patterns
    project.rhythms[0].drums.kick.tune = 1
    expect(restoreRhythmDefaults(project.rhythms[0], 0).patterns).toBe(rhythmPatterns)
    expect(restoreRhythmDefaults(project.rhythms[0], 0).drums.kick.tune).not.toBe(1)

    const waveSteps = project.waveDesigner.steps
    expect(restoreWaveDefaults({ ...project.waveDesigner, drive: 99 }).steps).toBe(waveSteps)
    const sampleAsset = project.sampler.slots[0].assetId
    expect(restoreSamplerDefaults({ ...project.sampler, drive: 99 }).slots[0].assetId).toBe(sampleAsset)
    const deck = restoreDeckDefaults({ ...project.decks[0], gain: 0 }, 0)
    expect(deck.assetId).toBe(project.decks[0].assetId)
    expect(deck.gain).toBeGreaterThan(0)
    expect(project.smoothOutput).toBe(true)
  })
})

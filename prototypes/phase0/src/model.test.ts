import { describe, expect, it } from 'vitest'
import { demoProject } from './demo'
import {
  analyzeSections,
  applyChanges,
  clipById,
  delayTailSeconds,
  duplicateClip,
  insertTime,
  linkCount,
  makeUnique,
  proposeEchoCleanup,
  setNoteStep,
  setPatternLength,
  traceBus,
  updateSend,
  updateTrack,
} from './model'

describe('insertTime', () => {
  it('moves later clips and sections right and adds an empty section', () => {
    const project = insertTime(demoProject(), 16, 8, 'Break')
    expect(project.length).toBe(48)
    expect(clipById(project, 'c-a1-3')?.start).toBe(24)
    expect(clipById(project, 'c-a1-2')?.start).toBe(12)
    expect(project.sections.map((s) => [s.name, s.start])).toEqual([
      ['Intro', 0],
      ['Build', 8],
      ['Break', 16],
      ['Drop', 24],
      ['Outro', 40],
    ])
  })

  it('splits a clip that crosses the insert point instead of stretching it', () => {
    const project = insertTime(demoProject(), 20, 8)
    const pad = project.clips.filter((c) => c.patternId === 'pat-wave-pad' && c.start >= 16 && c.start < 40)
    expect(pad.map((c) => [c.start, c.length, c.offset])).toEqual([
      [16, 4, 0],
      [28, 12, 4],
    ])
    const drop = project.sections.find((s) => s.name === 'Drop')
    expect(drop?.length).toBe(24)
  })
})

describe('linked clips', () => {
  it('shares one pattern between repeats until made unique', () => {
    let project = demoProject()
    expect(linkCount(project, 'pat-acid-a')).toBe(6)
    const unique = makeUnique(project, 'c-a1-4')
    project = setNoteStep(unique.project, unique.patternId, 0, { note: 41 })
    expect(linkCount(project, 'pat-acid-a')).toBe(5)
    const original = project.patterns['pat-acid-a']
    const copy = project.patterns[unique.patternId]
    expect(original.kind === 'notes' && original.steps[0].note).toBe(36)
    expect(copy.kind === 'notes' && copy.steps[0].note).toBe(41)
  })

  it('leaves a single-use clip on its own pattern', () => {
    const { project, patternId } = makeUnique(demoProject(), 'c-909-1')
    expect(patternId).toBe('pat-909-hats')
    expect(Object.keys(project.patterns)).toHaveLength(Object.keys(demoProject().patterns).length)
  })

  it('duplicates a clip as a linked repeat after the original', () => {
    const { project, clipId } = duplicateClip(demoProject(), 'c-a1-6')
    expect(clipById(project, clipId)).toMatchObject({ start: 32, patternId: 'pat-acid-a' })
  })
})

describe('setPatternLength', () => {
  it('extends with empty steps and truncates without losing the first steps', () => {
    let project = setPatternLength(demoProject(), 'pat-acid-a', 24)
    const long = project.patterns['pat-acid-a']
    expect(long.kind === 'notes' && long.steps.length).toBe(24)
    expect(long.kind === 'notes' && long.steps[20].on).toBe(false)
    project = setPatternLength(project, 'pat-acid-a', 7)
    const short = project.patterns['pat-acid-a']
    expect(short.kind === 'notes' && short.steps.map((s) => s.note)).toEqual([36, 36, 48, 36, 39, 36, 51])
  })
})

describe('signal trace', () => {
  it('flags a muted track whose pre-fader send still feeds the delay', () => {
    const trace = traceBus(demoProject(), 'delay')
    const acid2 = trace.rows.find((row) => row.trackId === 'acid-2')
    expect(acid2).toMatchObject({ feeds: true, suspicious: true })
    expect(trace.rows.find((row) => row.trackId === 'acid-1')).toMatchObject({ feeds: true, suspicious: false })
  })

  it('treats solo as silencing other tracks without dropping pre-fader sends', () => {
    const project = updateTrack(updateTrack(demoProject(), 'acid-2', { mute: false }), '808', { solo: true })
    const acid2 = traceBus(project, 'delay').rows.find((row) => row.trackId === 'acid-2')
    expect(acid2?.suspicious).toBe(true)
    expect(acid2?.reason).toContain('solo')
  })

  it('reports no delay tail when FX Safe Bypass is on', () => {
    expect(delayTailSeconds(demoProject())).toBeGreaterThan(5)
    expect(delayTailSeconds({ ...demoProject(), fxSafeBypass: true })).toBe(0)
  })
})

describe('agent proposal', () => {
  it('proposes evidence-backed changes and applies only the accepted ones', () => {
    const project = demoProject()
    const proposal = proposeEchoCleanup(project, 'why is there echo in the drop')
    expect(proposal?.changes.map((c) => c.id)).toEqual(['post-acid-2', 'delay-feedback', 'reverb-wave'])
    const next = applyChanges(project, proposal!, new Set(['post-acid-2', 'delay-feedback']))
    expect(traceBus(next, 'delay').rows.some((row) => row.suspicious)).toBe(false)
    expect(next.returns.delay.feedback).toBe(0.4)
    expect(next.tracks.find((t) => t.id === 'wave')?.sends.reverb.level).toBe(0.34)
  })

  it('returns nothing when the mix has no echo problems', () => {
    let project = updateSend(demoProject(), 'acid-2', 'delay', { level: 0 })
    project = updateSend(project, 'wave', 'reverb', { level: 0.1 })
    project = { ...project, returns: { ...project.returns, delay: { ...project.returns.delay, feedback: 0.3 } } }
    expect(proposeEchoCleanup(project, 'echo')).toBeNull()
  })

  it('reduces measured smear in the drop after the fix', () => {
    const project = demoProject()
    const proposal = proposeEchoCleanup(project, 'echo')!
    const before = analyzeSections(project).find((r) => r.name === 'Drop')!
    const after = analyzeSections(applyChanges(project, proposal, new Set(proposal.changes.map((c) => c.id)))).find((r) => r.name === 'Drop')!
    expect(after.smear).toBeLessThan(before.smear)
  })
})

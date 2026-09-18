// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { createDefaultProject } from '../model'
import {
  deleteProject,
  listProjects,
  loadProject,
  parseProject,
  saveProject,
  serializeProject,
} from './projectStore'

describe('project persistence', () => {
  beforeEach(() => localStorage.clear())

  it('saves, indexes, loads, and deletes projects', () => {
    const project = createDefaultProject()
    project.name = 'Test Pattern'
    saveProject(project)
    expect(listProjects()).toEqual([{ id: expect.any(String), name: 'Test Pattern', updatedAt: expect.any(String) }])
    expect(loadProject()?.name).toBe('Test Pattern')
    const id = listProjects()[0].id
    deleteProject(id)
    expect(listProjects()).toEqual([])
  })

  it('round-trips exported project JSON', () => {
    const project = createDefaultProject()
    expect(parseProject(serializeProject(project))).toEqual(project)
  })

  it('stores the full sound and arrangement snapshot, not only pattern steps', () => {
    const project = createDefaultProject()
    project.tempo = 137
    project.masterDrive = 29
    project.delayMix = 12
    project.effectsEnabled = false
    project.bass[0].cutoff = 81
    project.rhythms[1].drums.snare.reverb = 27
    project.waveDesigner.spread = 45
    project.sampler.texture = 33
    project.decks[0].gain = 42
    project.songChain[3].bass[0] = 4
    saveProject(project, 'complete-song')
    project.bass[0].cutoff = 2
    project.songChain[3].bass[0] = 1
    expect(loadProject('complete-song')).toEqual({ ...project, bass: [{ ...project.bass[0], cutoff: 81 }, project.bass[1]], songChain: project.songChain.map((cue, index) => index === 3 ? { ...cue, bass: [4, cue.bass[1]] } : cue) })
  })

  it('rejects unrelated JSON', () => {
    expect(() => parseProject('{"hello":"world"}')).toThrow(/valid ReBirth 338 project/i)
  })
})

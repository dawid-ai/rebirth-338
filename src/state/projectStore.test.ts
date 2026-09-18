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

  it('rejects unrelated JSON', () => {
    expect(() => parseProject('{"hello":"world"}')).toThrow(/valid ReBirth 338 project/i)
  })
})

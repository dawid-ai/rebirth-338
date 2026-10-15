import { describe, expect, it } from 'vitest'
import { History } from './history'
import { createDefaultProject } from './model'
import {
  PROJECT_FORMAT,
  ProjectFormatError,
  assetFileName,
  createProjectDocument,
  migrateProject,
  projectDirectoryName,
  readProjectDocument,
  serializeProject,
} from './project-file'

describe('project documents', () => {
  it('round-trips a project with its asset manifest', () => {
    const project = createDefaultProject()
    project.name = 'ROUND TRIP'
    const asset = { id: 'a1', kind: 'sample' as const, name: 'kick.wav', mimeType: 'audio/wav', file: 'a1.wav', bytes: 4, sha256: 'abc' }
    const json = JSON.stringify(createProjectDocument(project, [asset], { savedAt: '2026-10-15T00:00:00.000Z' }))
    const document = readProjectDocument(json)
    expect(document.format).toBe(PROJECT_FORMAT)
    expect(document.project).toEqual(project)
    expect(document.assets).toEqual([asset])
  })

  it('opens a raw v1 export as a document with no assets', () => {
    const project = createDefaultProject()
    const document = readProjectDocument(serializeProject(project))
    expect(document.app.version).toBe('1.x')
    expect(document.project.bass).toHaveLength(2)
    expect(document.assets).toEqual([])
  })

  it('fills fields missing from older saves through hydration', () => {
    const { songScenes: _scenes, ...older } = createDefaultProject()
    expect(migrateProject(older).songScenes.length).toBeGreaterThan(0)
  })

  it('rejects invalid JSON, foreign data, and newer formats', () => {
    expect(() => readProjectDocument('{')).toThrow(ProjectFormatError)
    expect(() => readProjectDocument('{"hello":1}')).toThrow(ProjectFormatError)
    const newer = { ...createProjectDocument(createDefaultProject(), []), formatVersion: 99 }
    expect(() => readProjectDocument(JSON.stringify(newer))).toThrow(/newer version/)
  })

  it('drops asset entries that point outside the project directory', () => {
    const document = createProjectDocument(createDefaultProject(), [
      { id: 'ok', kind: 'deck', name: 'a.ogg', mimeType: 'audio/ogg', file: 'ok.ogg', bytes: 1, sha256: 'x' },
      { id: 'bad', kind: 'deck', name: 'b.ogg', mimeType: 'audio/ogg', file: '../../evil.ogg', bytes: 1, sha256: 'x' },
    ])
    expect(readProjectDocument(JSON.stringify(document)).assets.map((a) => a.id)).toEqual(['ok'])
  })
})

describe('file names', () => {
  it('derives asset names from the original extension or MIME type', () => {
    expect(assetFileName({ id: 'abc-1', name: 'Break.WAV', mimeType: 'audio/wav' })).toBe('abc-1.wav')
    expect(assetFileName({ id: 'x/y', name: 'PRINT', mimeType: 'audio/ogg' })).toBe('x-y.ogg')
    expect(assetFileName({ id: 'z', name: 'blob', mimeType: 'application/x-unknown' })).toBe('z.bin')
  })

  it('makes a safe project directory name', () => {
    expect(projectDirectoryName('NIGHT: SHIFT?')).toBe('NIGHT SHIFT.reborn')
    expect(projectDirectoryName('   ')).toBe('Untitled.reborn')
  })
})

describe('History', () => {
  it('undoes and redoes in order and clears redo after a new edit', () => {
    const history = new History<number>(3)
    history.record(1, 'one')
    history.record(2, 'two', 'agent')
    expect(history.lastEntry).toEqual({ label: 'two', origin: 'agent' })
    expect(history.undo(3)).toBe(2)
    expect(history.redo(2)).toBe(3)
    expect(history.undo(3)).toBe(2)
    history.record(2, 'branch')
    expect(history.canRedo).toBe(false)
  })

  it('keeps only the configured number of steps', () => {
    const history = new History<number>(2)
    for (const value of [1, 2, 3]) history.record(value)
    expect(history.undo(4)).toBe(3)
    expect(history.undo(3)).toBe(2)
    expect(history.undo(2)).toBeUndefined()
  })
})

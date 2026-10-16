import { describe, expect, it } from 'vitest'
import { TEMPLATES, createTemplateProject } from './templates'
import { migrateStudioProject } from './migrate'

describe('templates', () => {
  it.each(TEMPLATES.map((t) => t.id))('builds %s as a fresh, valid project', (id) => {
    const project = createTemplateProject(id, 'Test')
    expect(project.name).toBe('Test')
    expect(project.revision).toBe(0)
    expect(project.audit).toHaveLength(0)
    expect(migrateStudioProject(JSON.parse(JSON.stringify(project)))).toEqual(project)
    for (const clip of project.clips) {
      expect(project.tracks.some((t) => t.id === clip.trackId)).toBe(true)
      if (clip.patternId) expect(project.patterns[clip.patternId]).toBeDefined()
    }
  })

  it('gives every non-blank template audible clips within the song', () => {
    for (const { id } of TEMPLATES.filter((t) => t.id !== 'blank')) {
      const project = createTemplateProject(id)
      expect(project.clips.length).toBeGreaterThan(2)
      expect(Math.max(...project.clips.map((c) => c.start + c.length))).toBeLessThanOrEqual(project.length)
    }
  })

  it('chops the boom bap break onto pads', () => {
    const sampler = createTemplateProject('boom-bap').tracks.find((t) => t.kind === 'sampler')!
    expect(sampler.device.kind === 'sampler' && sampler.device.source?.slices).toHaveLength(8)
  })
})

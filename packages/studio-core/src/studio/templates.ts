import { type Command, executeBatch } from './commands'
import { type StudioProject, createDefaultStudioProject, emptyStudioProject } from './model'

// Starter projects for File > New. Each one is built with the same commands
// the UI, CLI, and agents use, so templates stay valid as the model evolves.

export interface TemplateInfo {
  id: string
  label: string
  detail: string
}

export const TEMPLATES: readonly TemplateInfo[] = [
  { id: 'starter', label: 'Starter rack', detail: '124 BPM · two Acid lines, Wave, 808, 909, and a Sampler' },
  { id: 'boom-bap', label: 'Boom bap', detail: '90 BPM · swung drums, a chopped break on pads, sub bass, and keys' },
  { id: 'acid-house', label: 'Acid house', detail: '126 BPM · two Acid lines over a 909 with echo' },
  { id: 'blank', label: 'Blank', detail: 'No tracks · add exactly what you need' },
]

class Builder {
  constructor(public project: StudioProject) {}

  run(type: string, params: Record<string, unknown> = {}): Record<string, unknown> {
    const { project, results } = executeBatch(this.project, [{ type, params } as Command])
    this.project = project
    return (results[0] ?? {}) as Record<string, unknown>
  }

  track(kind: string, name: string, mixer: Record<string, unknown> = {}): string {
    const trackId = String(this.run('track.add', { kind, name }).trackId)
    if (Object.keys(mixer).length) this.run('mixer.set', { trackId, ...mixer })
    return trackId
  }

  /** Writes notation into a fresh pattern for the track and returns its ID. */
  pattern(trackId: string, name: string, lanes: Record<string, string> | string): string {
    const patternId = String(this.run('pattern.create', { trackId, name }).patternId)
    if (typeof lanes === 'string') this.run('pattern.write', { patternId, steps: lanes })
    else for (const [voice, steps] of Object.entries(lanes)) this.run('pattern.write', { patternId, voice, steps })
    return patternId
  }

  params(trackId: string, values: Record<string, number>): void {
    for (const [param, value] of Object.entries(values)) this.run('parameter.set', { trackId, param: `device.${param}`, value })
  }

  clip(trackId: string, patternId: string, start: number, length: number): void {
    this.run('clip.create', { trackId, patternId, start, length })
  }

  /** A fresh project: no undo history and revision zero. */
  finish(): StudioProject {
    return { ...this.project, revision: 0, audit: [] }
  }
}

function boomBap(name: string): StudioProject {
  const b = new Builder(emptyStudioProject(name))
  b.run('project.update', { tempo: 90, swing: 0.56 })
  const drums = b.track('drum', 'Drums', { volume: -4 })
  b.run('device.update', { trackId: drums, kit: '808' })
  const chops = b.track('sampler', 'Chops', { volume: -7 })
  const bass = b.track('acid', 'Sub bass', { volume: -9 })
  b.run('device.update', { trackId: bass, waveform: 'square' })
  b.params(bass, { cutoff: 0.18, resonance: 0.1, envMod: 0.15, decay: 0.75 })
  const keys = b.track('wave', 'Keys', { volume: -14 })
  b.run('send.set', { trackId: keys, returnId: 'reverb', level: 0.35 })
  b.run('send.set', { trackId: chops, returnId: 'reverb', level: 0.08 })

  b.run('asset.add', { asset: { id: 'builtin:loop_amen.ogg', name: 'loop_amen.ogg', mimeType: 'audio/ogg', bytes: 0, duration: 0, channels: 2, sampleRate: 44100, origin: { kind: 'builtin', source: 'builtin:loop_amen.ogg', createdAt: new Date().toISOString() } } })
  b.run('sample.slice', { trackId: chops, assetId: 'builtin:loop_amen.ogg', slices: [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875], mode: 'equal', bars: 1, assignPads: true })

  const beat = b.pattern(drums, 'Head nod', { kick: 'X.......x.X.....', snare: '....X.......X...', closedHat: 'x.x.x.x.x.x.x.xx' })
  const intro = b.pattern(drums, 'Hats only', { closedHat: 'x.x.x.x.x.x.x.x.', kick: 'X...............' })
  const line = b.pattern(bass, 'Sub', 'C1 . . . . . C1 . D#1 . . . G0 . A#0 .')
  const chords = b.pattern(keys, 'Keys', 'C3 . . . . . . . D#3 . . . A#2 . . .')
  const chopClip = b.run('clip.create', { trackId: chops, start: 4, length: 2, name: 'Flip' })
  b.run('pad.record', {
    patternId: chopClip.patternId,
    hits: [
      { step: 0, pad: 0, velocity: 110 },
      { step: 3, pad: 2, velocity: 90 },
      { step: 6, pad: 1, velocity: 96 },
      { step: 8, pad: 4, velocity: 104 },
      { step: 11, pad: 6, velocity: 88 },
      { step: 14, pad: 3, velocity: 92 },
    ],
  })
  b.run('clip.duplicate', { clipId: b.project.clips[b.project.clips.length - 1].id, start: 6 })

  b.clip(drums, intro, 0, 4)
  b.clip(drums, beat, 4, 12)
  b.clip(keys, chords, 0, 16)
  b.clip(bass, line, 8, 8)
  b.run('section.add', { start: 0, length: 4, name: 'Intro', color: '#5d6e60' })
  b.run('section.add', { start: 4, length: 4, name: 'Flip', color: '#86574a' })
  b.run('section.add', { start: 8, length: 8, name: 'Verse', color: '#4d5e78' })
  b.run('scene.add', { name: 'Intro', slots: { [drums]: intro, [keys]: chords } })
  b.run('scene.add', { name: 'Verse', slots: { [drums]: beat, [keys]: chords, [bass]: line, [chops]: String(chopClip.patternId) } })
  return b.finish()
}

function acidHouse(name: string): StudioProject {
  const b = new Builder(emptyStudioProject(name))
  b.run('project.update', { tempo: 126, swing: 0.04 })
  const drums = b.track('drum', '909', { volume: -5 })
  b.run('device.update', { trackId: drums, kit: '909' })
  const acid = b.track('acid', 'Acid', { volume: -7 })
  b.run('device.update', { trackId: acid, waveform: 'sawtooth' })
  b.params(acid, { cutoff: 0.32, resonance: 0.78, envMod: 0.7, decay: 0.45, accent: 0.8, drive: 0.35 })
  b.run('send.set', { trackId: acid, returnId: 'delay', level: 0.3 })
  const answer = b.track('acid', 'Answer', { volume: -12, pan: 0.25 })
  b.run('device.update', { trackId: answer, waveform: 'square' })
  b.params(answer, { cutoff: 0.45, resonance: 0.5, envMod: 0.5 })
  b.run('send.set', { trackId: answer, returnId: 'delay', level: 0.45 })
  const pad = b.track('wave', 'Pad', { volume: -16 })
  b.run('send.set', { trackId: pad, returnId: 'reverb', level: 0.5 })

  const four = b.pattern(drums, 'Four to the floor', { kick: 'X...x...X...x...', clap: '....X.......X...', closedHat: '..x...x...x...x.', openHat: '..........X.....' })
  const roll = b.pattern(drums, 'Roll', { kick: 'X...x...X...x...', closedHat: 'xxxxxxxxxxxxxxxx', clap: '....X.......X.XX' })
  const line = b.pattern(acid, '303 line', 'C2 C2 C3~ C2 . D#2! C2 G2~ C2 . C3! A#1 C2 F2~ C2 C2')
  const reply = b.pattern(answer, 'Reply', '. . G3 . . . D#3! . . . G3~ F3 . . C3 .')
  const chord = b.pattern(pad, 'Pad', 'C4 . . . . . . . . . . . G3 . . .')

  b.clip(drums, four, 0, 16)
  b.clip(drums, roll, 16, 4)
  b.clip(drums, four, 20, 12)
  b.clip(acid, line, 4, 28)
  b.clip(answer, reply, 12, 8)
  b.clip(answer, reply, 24, 8)
  b.clip(pad, chord, 0, 32)
  b.run('automation.write', { trackId: acid, param: 'device.cutoff', points: [{ bar: 4, value: 0.2 }, { bar: 16, value: 0.62 }, { bar: 20, value: 0.3 }, { bar: 32, value: 0.7 }] })
  b.run('section.add', { start: 0, length: 4, name: 'Intro', color: '#5d6e60' })
  b.run('section.add', { start: 4, length: 12, name: 'Groove', color: '#86574a' })
  b.run('section.add', { start: 16, length: 4, name: 'Break', color: '#4d5e78' })
  b.run('section.add', { start: 20, length: 12, name: 'Drop', color: '#7a6640' })
  b.run('scene.add', { name: 'Groove', slots: { [drums]: four, [acid]: line, [pad]: chord } })
  b.run('scene.add', { name: 'Peak', slots: { [drums]: roll, [acid]: line, [answer]: reply, [pad]: chord } })
  return b.finish()
}

/** Builds a new project from a template ID. Unknown IDs give the starter rack. */
export function createTemplateProject(id: string, name = 'New Beat'): StudioProject {
  if (id === 'boom-bap') return boomBap(name)
  if (id === 'acid-house') return acidHouse(name)
  if (id === 'blank') return { ...emptyStudioProject(name), length: 16 }
  return createDefaultStudioProject(name)
}

import { encodeWav, renderStems, renderStudio } from '@reborn/audio-engine/studio'
import { desktop } from '../platform/desktop'
import { getState, toast, upsertJob } from '../state/store'
import { engine } from './host'

export interface ExportOptions {
  kind: 'mix' | 'stems'
  bitDepth: 16 | 24
  range: 'song' | 'section' | 'loop'
}

const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'export'

function save(data: ArrayBuffer, name: string) {
  if (desktop) return desktop.saveWav(data, name)
  const url = URL.createObjectURL(new Blob([data], { type: 'audio/wav' }))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
  return Promise.resolve(name)
}

export function exportRange(range: ExportOptions['range']): [number, number] {
  const s = getState()
  if (range === 'loop' && s.transport.loop) return s.transport.loop
  if (range === 'section' && s.selection.kind === 'section') {
    const id = s.selection.sectionId
    const section = s.project.sections.find((x) => x.id === id)
    if (section) return [section.start, section.start + section.length]
  }
  return [0, s.project.length]
}

export async function exportAudio(options: ExportOptions): Promise<void> {
  const { project } = getState()
  const [from, to] = exportRange(options.range)
  const controller = new AbortController()
  const id = `export-${Date.now()}`
  const label = options.kind === 'stems' ? 'Rendering stems' : 'Rendering mix'
  upsertJob({ id, label, completed: 0, total: to - from, status: 'running', cancel: () => controller.abort() })
  try {
    const progress = (completed: number, total: number) => upsertJob({ id, label, completed, total, status: 'running', cancel: () => controller.abort() })
    if (options.kind === 'mix') {
      const result = await renderStudio(project, engine.assetBuffers(), { from, to, signal: controller.signal, onProgress: progress })
      const wav = encodeWav(result.channels, result.sampleRate, options.bitDepth)
      const target = await save(wav, `${slug(project.name)}.wav`)
      upsertJob({ id, label, completed: 1, total: 1, status: 'done' })
      if (target) toast(`Exported ${options.bitDepth}-bit WAV`, 'success')
    } else {
      const stems = await renderStems(project, engine.assetBuffers(), { from, to, signal: controller.signal, onProgress: progress })
      for (const stem of stems) await save(encodeWav(stem.render.channels, stem.render.sampleRate, options.bitDepth), `${slug(project.name)}-${slug(stem.name)}.wav`)
      upsertJob({ id, label, completed: 1, total: 1, status: 'done' })
      toast(`Exported ${stems.length} stems`, 'success')
    }
  } catch (error) {
    const cancelled = controller.signal.aborted
    upsertJob({ id, label, completed: 0, total: 1, status: cancelled ? 'cancelled' : 'failed', message: String(error) })
    toast(cancelled ? 'Export cancelled' : `Export failed: ${error instanceof Error ? error.message : String(error)}`, cancelled ? 'info' : 'error')
  }
}

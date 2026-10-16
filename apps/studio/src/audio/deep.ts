import { useSyncExternalStore } from 'react'
import { studio } from '@reborn/studio-core'
import { encodeWav, renderStudio } from '@reborn/audio-engine/studio'
import { desktop } from '../platform/desktop'
import { getState, toast, upsertJob } from '../state/store'
import { engine } from './host'

// Deep analysis runs in the optional Python sidecar (desktop only). The
// studio renders a WAV, the sidecar measures it, and the result is shown as
// evidence. Nothing here edits the project, and a sidecar failure only
// fails this request.

export interface DeepFinding {
  kind: string
  metric: string
  difference: number
  message: string
}

export interface DeepResult {
  kind: 'analyze' | 'compare'
  revision: number
  backend: string
  summary: Record<string, number | null>
  findings: DeepFinding[]
  sections: { name: string; lufs: number | null; truePeak: number | null }[]
}

let result: DeepResult | null = null
let running = false
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

export function useDeep<T>(select: (state: { result: DeepResult | null; running: boolean }) => T): T {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => {
        listeners.delete(l)
      }
    },
    () => select({ result, running }),
  )
}

desktop?.onJobUpdate((update) => {
  if (update.kind !== 'analysis') return
  upsertJob({ id: 'deep-analysis', label: update.message || 'Deep analysis', completed: update.completed, total: update.total, status: update.status, cancel: () => desktop?.deepCancel() })
})

async function renderWav(): Promise<{ wav: ArrayBuffer; sections: { id: string; start: number; end: number }[]; names: Map<string, string> }> {
  const project = getState().project
  const rendered = await renderStudio(project, engine.assetBuffers())
  const barSeconds = studio.barSeconds(project)
  const sections = project.sections.map((s) => ({ id: s.id, start: s.start * barSeconds, end: Math.min(rendered.musicalSeconds, (s.start + s.length) * barSeconds) })).filter((s) => s.end > s.start)
  return { wav: encodeWav(rendered.channels, rendered.sampleRate, 24), sections, names: new Map(project.sections.map((s) => [s.id, s.name])) }
}

type Metrics = Record<string, unknown>
const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 10) / 10 : null)

export async function runDeep(kind: 'analyze' | 'compare'): Promise<void> {
  if (!desktop || running) return
  running = true
  emit()
  const revision = getState().project.revision
  upsertJob({ id: 'deep-analysis', label: 'Rendering for deep analysis', completed: 0, total: 1, status: 'running', cancel: () => desktop?.deepCancel() })
  try {
    const { wav, sections, names } = await renderWav()
    if (kind === 'analyze') {
      const response = (await desktop.deepAnalyze({ wav, sections })) as { backend: string; metrics: Metrics; sections: { id: string; metrics: Metrics }[] }
      result = {
        kind,
        revision,
        backend: response.backend,
        summary: { lufs: num(response.metrics.integratedLufs), truePeak: num(response.metrics.truePeakDbtp), crest: num(response.metrics.crestDb), centroid: num(response.metrics.spectralCentroidHz), correlation: num(response.metrics.stereoCorrelation) },
        findings: [],
        sections: response.sections.map((s) => ({ name: names.get(s.id) ?? s.id, lufs: num(s.metrics.integratedLufs), truePeak: num(s.metrics.truePeakDbtp) })),
      }
    } else {
      const response = (await desktop.deepCompare({ wav })) as { backend: string; differences: Record<string, { difference?: number }>; findings: DeepFinding[] } | null
      if (!response) return
      result = {
        kind,
        revision,
        backend: response.backend,
        summary: { lufsDifference: num(response.differences.integratedLufs?.difference), truePeakDifference: num(response.differences.truePeakDbtp?.difference), crestDifference: num(response.differences.crestDb?.difference) },
        findings: response.findings ?? [],
        sections: [],
      }
    }
    upsertJob({ id: 'deep-analysis', label: 'Deep analysis', completed: 1, total: 1, status: 'done' })
  } catch (error) {
    const message = error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(error)
    upsertJob({ id: 'deep-analysis', label: 'Deep analysis', completed: 0, total: 1, status: /cancel/i.test(message) ? 'cancelled' : 'failed', message })
    toast(/cancel/i.test(message) ? 'Deep analysis cancelled' : `Deep analysis failed: ${message}`, /cancel/i.test(message) ? 'info' : 'error')
  } finally {
    running = false
    emit()
  }
}

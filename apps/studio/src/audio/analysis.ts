import { useSyncExternalStore } from 'react'
import { type RangeAnalysis, analyzeRanges, estimateTail } from '@reborn/analysis'
import { studio } from '@reborn/studio-core'
import { renderStudio } from '@reborn/audio-engine/studio'
import { getState, upsertJob } from '../state/store'
import { engine } from './host'

// Readback: render the song offline and measure it. Reports are tied to the
// project revision they measured, so the UI can mark them stale.

export interface SectionReport extends RangeAnalysis {
  name: string
  fromBar: number
  toBar: number
}

export interface AnalysisReport {
  revision: number
  from: number
  to: number
  whole: RangeAnalysis
  sections: SectionReport[]
  /** Seconds the effects keep ringing after the music ends. */
  tailSeconds: number
  renderedAt: number
}

let report: AnalysisReport | null = null
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

export function useAnalysis(): AnalysisReport | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => {
        listeners.delete(l)
      }
    },
    () => report,
  )
}

export const latestAnalysis = () => report

export async function runAnalysis(range?: { from?: number; to?: number }, signal?: AbortSignal): Promise<AnalysisReport> {
  const project = getState().project
  const from = Math.max(0, range?.from ?? 0)
  const to = Math.min(project.length, range?.to ?? project.length)
  const id = `analysis-${Date.now()}`
  const controller = new AbortController()
  signal?.addEventListener('abort', () => controller.abort())
  upsertJob({ id, label: 'Analyzing mix', completed: 0, total: to - from, status: 'running', cancel: () => controller.abort() })
  try {
    const rendered = await renderStudio(project, engine.assetBuffers(), {
      from,
      to,
      signal: controller.signal,
      onProgress: (completed, total) => upsertJob({ id, label: 'Analyzing mix', completed, total, status: 'running', cancel: () => controller.abort() }),
    })
    const barSeconds = studio.barSeconds(project)
    const sections = project.sections.filter((s) => s.start < to && s.start + s.length > from)
    const ranges = (sections.length ? sections : [{ id: 'all', name: 'Song', start: from, length: to - from, color: '' }]).map((s) => ({
      id: s.id,
      start: (Math.max(s.start, from) - from) * barSeconds,
      end: (Math.min(s.start + s.length, to) - from) * barSeconds,
    }))
    const measured = analyzeRanges(rendered.channels, rendered.sampleRate, [{ id: 'whole', start: 0, end: rendered.musicalSeconds }, ...ranges])
    const tail = estimateTail(rendered.channels, rendered.sampleRate, rendered.musicalSeconds)
    const next: AnalysisReport = {
      revision: project.revision,
      from,
      to,
      whole: measured[0],
      sections: measured.slice(1).map((m, i) => {
        const source = sections[i] ?? { name: 'Song', start: from, length: to - from }
        return { ...m, name: source.name, fromBar: source.start, toBar: source.start + source.length }
      }),
      tailSeconds: tail.tailSeconds,
      renderedAt: Date.now(),
    }
    report = next
    emit()
    upsertJob({ id, label: 'Analyzing mix', completed: 1, total: 1, status: 'done' })
    return next
  } catch (error) {
    upsertJob({ id, label: 'Analyzing mix', completed: 0, total: 1, status: controller.signal.aborted ? 'cancelled' : 'failed', message: String(error) })
    throw error
  }
}

/** Compact text summary for agents and the CLI. */
export function summarizeReport(r: AnalysisReport, project = getState().project): Record<string, unknown> {
  return {
    measuredRevision: r.revision,
    stale: r.revision !== project.revision,
    bars: [r.from + 1, r.to],
    whole: { lufs: r.whole.loudnessLufs, truePeakDb: r.whole.truePeakDb, crestDb: r.whole.crestDb, correlation: r.whole.correlation },
    tailSeconds: r.tailSeconds,
    sections: r.sections.map((s) => ({
      name: s.name,
      bars: [s.fromBar + 1, s.toBar],
      lufs: s.loudnessLufs,
      truePeakDb: s.truePeakDb,
      crestDb: s.crestDb,
      bandShare: Object.fromEntries(Object.entries(s.bands).map(([k, v]) => [k, Math.round(v.share * 100) / 100])),
      warnings: s.warnings.map((w) => w.message),
    })),
  }
}

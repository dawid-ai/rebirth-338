import { encodeWav, isolateTrack, renderStudio } from '@reborn/audio-engine/studio'
import { studio } from '@reborn/studio-core'
import { dispatch, getState, toast, upsertJob } from '../state/store'
import { engine, storeRenderedAsset } from './host'

// Resampling prints a track, group, return, or the master over a bar range to
// a new audio asset, then places it on a new audio track at the same position.
// The asset records where it came from so you (or an agent) can trace it,
// and the whole print is one undo step.

export type ResampleSource = { kind: 'track'; trackId: string } | { kind: 'return'; returnId: string } | { kind: 'master' }

/** The loop range when one is set, otherwise the whole song. */
export function resampleRange(): [number, number] {
  const s = getState()
  return s.transport.loop ?? [0, s.project.length]
}

function sourceName(project: studio.StudioProject, source: ResampleSource): string {
  if (source.kind === 'master') return 'Master'
  if (source.kind === 'return') return project.returns.find((r) => r.id === source.returnId)?.name ?? 'Return'
  return project.tracks.find((t) => t.id === source.trackId)?.name ?? 'Track'
}

/** Renders only what the source contributes, as you hear it. */
async function renderSource(project: studio.StudioProject, source: ResampleSource, from: number, to: number) {
  const buffers = engine.assetBuffers()
  const options = { from, to, tail: 0 }
  if (source.kind === 'master') return renderStudio(project, buffers, { ...options, master: true })
  if (source.kind === 'track') return renderStudio(isolateTrack(project, source.trackId), buffers, { ...options, master: false })
  // A return's share is the mix minus the same mix with that return muted.
  // Both renders are deterministic and pre-master, so the difference is exact.
  const muted = { ...project, returns: project.returns.map((r) => (r.id === source.returnId ? { ...r, mute: true } : r)) }
  const [full, without] = await Promise.all([renderStudio(project, buffers, { ...options, master: false }), renderStudio(muted, buffers, { ...options, master: false })])
  const channels = full.channels.map((c, i) => {
    const out = new Float32Array(c.length)
    for (let n = 0; n < c.length; n += 1) out[n] = c[n] - without.channels[i][n]
    return out
  })
  return { ...full, channels: channels as typeof full.channels }
}

export async function resample(source: ResampleSource, range = resampleRange()): Promise<string | null> {
  const { project } = getState()
  const [from, to] = range
  const label = `Print ${sourceName(project, source)}`
  const name = `${sourceName(project, source)} print`
  const id = `resample-${Date.now()}`
  upsertJob({ id, label: `Printing ${name}`, completed: 0, total: 1, status: 'running' })
  try {
    const result = await renderSource(project, source, from, to)
    const buffer = new AudioBuffer({ length: result.channels[0].length, numberOfChannels: 2, sampleRate: result.sampleRate })
    result.channels.forEach((c, i) => buffer.copyToChannel(c, i))
    const wav = encodeWav(result.channels, result.sampleRate, 24)
    const assetId = await storeRenderedAsset(buffer, wav, `${name}.wav`, {
      kind: 'resample',
      source: source.kind === 'return' ? `return:${source.returnId}` : source.kind,
      trackId: source.kind === 'track' ? source.trackId : null,
      range: [from, to],
      createdAt: new Date().toISOString(),
    }, { label, key: id })
    const added = dispatch({ type: 'track.add', params: { kind: 'audio', name } }, { label, key: id })
    const trackId = (added?.[0] as { trackId?: string } | undefined)?.trackId
    // Unity gain on the new track, so the print plays back at the level it was rendered.
    if (trackId) dispatch([{ type: 'mixer.set', params: { trackId, volume: 0 } }, { type: 'clip.create', params: { trackId, start: from, length: to - from, assetId } }], { label, key: id })
    upsertJob({ id, label: `Printing ${name}`, completed: 1, total: 1, status: 'done' })
    toast(`Printed bars ${from + 1}–${to} of ${sourceName(project, source)} to a new audio track. The source is unchanged.`, 'success')
    return assetId
  } catch (error) {
    upsertJob({ id, label: `Printing ${name}`, completed: 0, total: 1, status: 'failed', message: String(error) })
    toast(`Resample failed: ${error instanceof Error ? error.message : String(error)}`, 'error')
    return null
  }
}

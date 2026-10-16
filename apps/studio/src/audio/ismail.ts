import { useSyncExternalStore } from 'react'
import type { IsmailGenerateRequest, IsmailPresets, IsmailStatus } from '@reborn/studio-core'
import { studio } from '@reborn/studio-core'
import { encodeWav } from '@reborn/audio-engine/studio'
import { loadIntoSampler } from '../components/SampleEditors'
import { desktop } from '../platform/desktop'
import { type DispatchOptions, dispatch, getState, selectedTrackId, toast, upsertJob } from '../state/store'
import { engine, storeRenderedAsset } from './host'

// Ismail tools (desktop only): sound generation and stem separation through
// the Python sidecar. Ismail reads and writes scratch WAV files; the results
// come back here and enter the project as new assets on new tracks, so the
// source material is never changed and each action is one undo step.

interface IsmailState {
  status: IsmailStatus | null
  presets: IsmailPresets | null
  busy: 'install' | 'generate' | 'separate' | null
  lastSound: { name: string; summary: string; description: string } | null
}

let state: IsmailState = { status: null, presets: null, busy: null, lastSound: null }
const listeners = new Set<() => void>()

function update(patch: Partial<IsmailState>): void {
  state = { ...state, ...patch }
  listeners.forEach((listener) => listener())
}

export function useIsmail<T>(select: (current: IsmailState) => T): T {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    () => select(state),
  )
}

desktop?.onJobUpdate((job) => {
  if (job.kind !== 'install') return
  upsertJob({ id: job.id, label: job.message || 'Installing Ismail', completed: job.completed, total: job.total, status: job.status })
})

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
const isCancel = (message: string) => /cancel|abort/i.test(message)

export async function refreshIsmail(): Promise<IsmailStatus | null> {
  if (!desktop) return null
  const status = await desktop.ismailStatus()
  update({ status })
  if (status.installed && !state.presets) {
    try {
      update({ presets: await desktop.ismailPresets() })
    } catch (error) {
      toast(`Ismail did not list its instruments: ${errorText(error)}`, 'error')
    }
  }
  return status
}

/** Installs Ismail into the app's Python environment; `separation` adds PyTorch and Demucs. */
export async function installIsmail(separation: boolean): Promise<void> {
  if (!desktop || state.busy) return
  update({ busy: 'install' })
  try {
    update({ status: await desktop.ismailInstall({ separation }), presets: null })
    await refreshIsmail()
    toast(separation ? 'Stem separation is ready.' : 'Ismail is ready. Pick an instrument and generate a sound.', 'success')
  } catch (error) {
    toast(`Installing Ismail failed: ${errorText(error)}`, 'error')
    // The panel shows the reason next to the install button.
    await refreshIsmail().catch(() => null)
  } finally {
    update({ busy: null })
  }
}

async function decodeWav(wav: Uint8Array): Promise<{ buffer: AudioBuffer; data: ArrayBuffer }> {
  const data = wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength) as ArrayBuffer
  return { buffer: await engine.decode(data), data }
}

const bars = (seconds: number) => Math.max(0.25, Math.round((seconds / studio.barSeconds(getState().project)) * 4) / 4)
const stripExtension = (name: string) => name.replace(/\.[a-z0-9]+$/i, '')

type History = DispatchOptions & { label: string; key: string }

/** Adds a new audio track at unity gain with one clip, under the given history key. */
function addAudioTrack(name: string, assetId: string, clip: { start: number; length: number; offset?: number; gain?: number; fadeIn?: number; fadeOut?: number }, history: History): string | null {
  const added = dispatch({ type: 'track.add', params: { kind: 'audio', name } }, history)
  const trackId = (added?.[0] as { trackId?: string } | undefined)?.trackId
  if (!trackId) return null
  const created = dispatch([{ type: 'mixer.set', params: { trackId, volume: 0 } }, { type: 'clip.create', params: { trackId, start: clip.start, length: clip.length, assetId } }], history)
  const clipId = (created?.[1] as { clipId?: string } | undefined)?.clipId
  const { start: _start, length: _length, ...rest } = clip
  if (clipId && Object.keys(rest).length) dispatch({ type: 'clip.set', params: { clipId, ...rest } }, history)
  return trackId
}

export interface IsmailRunOptions {
  origin?: studio.Origin
  signal?: AbortSignal
}

export interface GenerateTarget {
  /** A Sampler loads the sound; an Audio track gets a clip at `bar`. Without one, a new audio track. */
  trackId?: string
  /** 0-based bar for the clip. Defaults to the playhead. */
  bar?: number
}

export interface GeneratedSound {
  assetId: string
  trackId: string | null
  name: string
  summary: string
  description: string
}

/** Forwards an abort to the sidecar, which stops the running Ismail request. */
function cancellable(signal: AbortSignal | undefined): () => void {
  const onAbort = () => desktop?.deepCancel()
  signal?.addEventListener('abort', onAbort, { once: true })
  return () => signal?.removeEventListener('abort', onAbort)
}

/** Generates a sound with Ismail and places it as one undo step. Throws on failure. */
export async function runGenerate(request: Omit<IsmailGenerateRequest, 'bpm'>, target: GenerateTarget = {}, options: IsmailRunOptions = {}): Promise<GeneratedSound> {
  if (!desktop) throw new Error('Ismail runs in the desktop app.')
  const track = target.trackId ? getState().project.tracks.find((t) => t.id === target.trackId || t.name === target.trackId) : undefined
  if (target.trackId && !track) throw new Error(`No track ${target.trackId}.`)
  if (track && track.kind !== 'sampler' && track.kind !== 'audio') throw new Error(`${track.name} plays patterns. Choose a Sampler or Audio track, or no track for a new one.`)
  const history: History = { label: `Generate ${request.name}`, key: `ismail-generate-${Date.now()}`, origin: options.origin }
  const release = cancellable(options.signal)
  try {
    const sound = await desktop.ismailGenerate({ ...request, bpm: getState().project.tempo })
    options.signal?.throwIfAborted()
    const { buffer, data } = await decodeWav(sound.wav)
    const source = typeof request.instrument === 'string' ? request.instrument : String(request.instrument.voice ?? request.instrument.type ?? 'instrument')
    const assetId = await storeRenderedAsset(buffer, data, `${request.name}.wav`, { kind: 'generated', source: `ismail:${source} ${request.notes}`, createdAt: new Date().toISOString() }, history)
    const at = target.bar ?? Math.floor(engine.position())
    let trackId: string | null = track?.id ?? null
    if (track?.kind === 'sampler') await loadIntoSampler(track.id, assetId, history)
    else if (track?.kind === 'audio') dispatch({ type: 'clip.create', params: { trackId: track.id, start: at, length: bars(buffer.duration), assetId } }, history)
    else trackId = addAudioTrack(request.name, assetId, { start: at, length: bars(buffer.duration) }, history)
    update({ lastSound: { name: sound.name, summary: sound.summary, description: sound.description } })
    return { assetId, trackId, name: request.name, summary: sound.summary, description: sound.description }
  } finally {
    release()
  }
}

/**
 * Generates a sound from the UI. It loads into the selected Sampler, lands on
 * the selected Audio track at the playhead, or else on a new audio track.
 */
export async function generateSound(request: Omit<IsmailGenerateRequest, 'bpm'>): Promise<string | null> {
  if (!desktop || state.busy) return null
  const id = `ismail-generate-${Date.now()}`
  update({ busy: 'generate' })
  upsertJob({ id, label: `Generating ${request.name}`, completed: 0, total: 1, status: 'running', cancel: () => desktop?.deepCancel() })
  try {
    const s = getState()
    const selected = s.project.tracks.find((t) => t.id === selectedTrackId(s))
    const target = selected && (selected.kind === 'sampler' || selected.kind === 'audio') ? { trackId: selected.id } : {}
    const sound = await runGenerate(request, target)
    upsertJob({ id, label: `Generated ${request.name}`, completed: 1, total: 1, status: 'done' })
    toast(`Generated ${request.name}: ${sound.summary.replace(/^sound '[^']*': /, '')}${selected?.kind === 'sampler' ? ` and loaded it into ${selected.name}` : ''}.`, 'success')
    return sound.assetId
  } catch (error) {
    const message = errorText(error)
    upsertJob({ id, label: `Generating ${request.name}`, completed: 0, total: 1, status: isCancel(message) ? 'cancelled' : 'failed', message })
    toast(isCancel(message) ? 'Generation cancelled' : `Ismail could not generate the sound: ${message}`, isCancel(message) ? 'info' : 'error')
    return null
  } finally {
    update({ busy: null })
  }
}

export interface SeparatedStem {
  name: string
  assetId: string
  trackId: string | null
}

/**
 * Splits an asset into drums, bass, other, and vocals as one undo step. With
 * a clip, each stem lands on its own audio track aligned with that clip (same
 * start, length, offset, gain, and fades); otherwise at `bar` or the playhead.
 * The source is unchanged. Throws on failure.
 */
export async function runSeparate(assetId: string, place: { clipId?: string; bar?: number } = {}, options: IsmailRunOptions = {}): Promise<SeparatedStem[]> {
  if (!desktop) throw new Error('Ismail runs in the desktop app.')
  const status = await refreshIsmail()
  if (!status?.installed) throw new Error('Stem separation uses Ismail. Open Browser › Generate to install it.')
  if (!status.separation) throw new Error('Stem separation needs its add-on. Open Browser › Generate and click Add stem separation.')
  const s = getState()
  const asset = s.project.assets[assetId]
  if (!asset) throw new Error(`No asset ${assetId}.`)
  const buffer = engine.buffer(assetId)
  if (!buffer) throw new Error(`${asset.name} has not loaded yet. Try again in a moment.`)
  const clip = place.clipId ? s.project.clips.find((c) => c.id === place.clipId) : undefined
  if (place.clipId && !clip) throw new Error(`No clip ${place.clipId}.`)
  const base = stripExtension(asset.name)
  const history: History = { label: `Separate ${base}`, key: `ismail-separate-${Date.now()}`, origin: options.origin }
  const release = cancellable(options.signal)
  try {
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i))
    const wav = encodeWav(channels.length > 1 ? [channels[0], channels[1]] : [channels[0], channels[0]], buffer.sampleRate, 24)
    const stems = await desktop.ismailSeparate({ wav })
    options.signal?.throwIfAborted()
    const placement = clip ? { start: clip.start, length: clip.length, offset: clip.offset, gain: clip.gain, fadeIn: clip.fadeIn, fadeOut: clip.fadeOut } : { start: place.bar ?? Math.floor(engine.position()), length: bars(buffer.duration) }
    const placed: SeparatedStem[] = []
    for (const stem of stems) {
      const decoded = await decodeWav(stem.wav)
      const stemAsset = await storeRenderedAsset(decoded.buffer, decoded.data, `${base} ${stem.name}.wav`, { kind: 'generated', source: `ismail:separate ${asset.name} ${stem.name}`, createdAt: new Date().toISOString() }, history)
      placed.push({ name: stem.name, assetId: stemAsset, trackId: addAudioTrack(`${base} ${stem.name}`, stemAsset, placement, history) })
    }
    return placed
  } finally {
    release()
  }
}

/** Separates stems from the UI, with progress and a toast. */
export async function separateStems(assetId: string, clipId?: string): Promise<number> {
  if (!desktop || state.busy) return 0
  const asset = getState().project.assets[assetId]
  const name = asset ? stripExtension(asset.name) : 'audio'
  const id = `ismail-separate-${Date.now()}`
  update({ busy: 'separate' })
  upsertJob({ id, label: `Separating ${name} into stems`, completed: 0, total: 1, status: 'running', cancel: () => desktop?.deepCancel() })
  try {
    const stems = await runSeparate(assetId, { clipId })
    upsertJob({ id, label: `Separated ${name}`, completed: 1, total: 1, status: 'done' })
    toast(`Separated ${name} into ${stems.map((stem) => stem.name).join(', ')} on new audio tracks. The original is unchanged; mute it to hear the stems alone.`, 'success')
    return stems.length
  } catch (error) {
    const message = errorText(error)
    upsertJob({ id, label: `Separating ${name}`, completed: 0, total: 1, status: isCancel(message) ? 'cancelled' : 'failed', message })
    toast(isCancel(message) ? 'Stem separation cancelled' : message, isCancel(message) ? 'info' : 'error')
    return 0
  } finally {
    update({ busy: null })
  }
}

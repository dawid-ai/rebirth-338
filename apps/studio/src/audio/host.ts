import { useSyncExternalStore } from 'react'
import { studio } from '@reborn/studio-core'
import { StudioEngine, type TransportSnapshot } from '@reborn/audio-engine/studio'
import { fetchAssetBytes, putAsset } from '../platform/assetStore'
import { dispatch, getState, setState, subscribe, toast } from '../state/store'

type StudioProject = studio.StudioProject

// Owns the single audio engine and keeps it in step with the store.

export const engine = new StudioEngine(getState().project)
engine.configureDevice(getState().prefs.audio)

let lastAudio = getState().prefs.audio
subscribe(() => {
  const { audio } = getState().prefs
  if (audio === lastAudio) return
  lastAudio = audio
  engine.configureDevice(audio)
})

let lastProject: StudioProject | null = null
const loading = new Set<string>()
const failed = new Set<string>()

subscribe(() => {
  const { project } = getState()
  if (project === lastProject) return
  lastProject = project
  engine.setProject(project)
  void ensureAssets(project)
})

engine.onTransport((transport) => setState({ transport }))

/** Decodes any project assets the engine has not loaded yet. */
export async function ensureAssets(project: StudioProject): Promise<void> {
  const ids = new Set<string>(Object.keys(project.assets))
  for (const track of project.tracks) {
    if (track.device.kind === 'sampler') {
      for (const pad of track.device.pads) if (pad.assetId) ids.add(pad.assetId)
      if (track.device.source) ids.add(track.device.source.assetId)
    }
    if (track.device.kind === 'deck' && track.device.assetId) ids.add(track.device.assetId)
  }
  for (const id of ids) {
    if (engine.hasAsset(id) || loading.has(id) || failed.has(id)) continue
    loading.add(id)
    try {
      const bytes = await fetchAssetBytes(id)
      if (!bytes) {
        failed.add(id)
        continue
      }
      const info = await engine.loadAsset(id, bytes)
      const asset = getState().project.assets[id]
      if (asset && (asset.duration === 0 || asset.bytes === 0)) {
        dispatch({ type: 'asset.add', params: { asset: { ...asset, duration: info.duration, channels: info.channels, sampleRate: info.sampleRate, bytes: bytes.size } } }, { label: 'Load audio', key: `asset-${id}` })
      }
    } catch {
      failed.add(id)
    } finally {
      loading.delete(id)
    }
  }
}

export function missingAssets(project: StudioProject): string[] {
  return Object.keys(project.assets).filter((id) => failed.has(id))
}

/** Stores a dropped or chosen file as a new asset and registers it in the project. */
export async function importAudioFile(file: Blob & { name?: string }, origin: studio.AssetOrigin['kind'] = 'import'): Promise<string | null> {
  const name = file.name ?? 'audio'
  const id = studio.newId('ast')
  try {
    const info = await engine.loadAsset(id, file)
    await putAsset({ id, name, mimeType: file.type || 'audio/*', data: file })
    const asset: studio.Asset = { id, name, mimeType: file.type || 'audio/*', bytes: file.size, duration: info.duration, channels: info.channels, sampleRate: info.sampleRate, origin: { kind: origin, source: name, createdAt: new Date().toISOString() } }
    dispatch({ type: 'asset.add', params: { asset } }, { label: `Import ${name}` })
    return id
  } catch {
    toast(`${name} could not be decoded. Try WAV, MP3, OGG, or FLAC.`, 'error')
    return null
  }
}

/** Stores rendered audio (resampling, takes) as a project asset with provenance. */
export async function storeRenderedAsset(buffer: AudioBuffer, wav: ArrayBuffer, name: string, origin: studio.AssetOrigin, history: { label?: string; key?: string } = {}): Promise<string> {
  const id = studio.newId('ast')
  const blob = new Blob([wav], { type: 'audio/wav' })
  engine.setBuffer(id, buffer)
  await putAsset({ id, name, mimeType: 'audio/wav', data: blob })
  const asset: studio.Asset = { id, name, mimeType: 'audio/wav', bytes: blob.size, duration: buffer.duration, channels: buffer.numberOfChannels, sampleRate: buffer.sampleRate, origin }
  dispatch({ type: 'asset.add', params: { asset } }, { label: history.label ?? `Add ${name}`, key: history.key })
  return id
}

// Transport clock -------------------------------------------------------------

const clockListeners = new Set<() => void>()
let frame = 0
let bar = 0

function tickClock() {
  bar = engine.position()
  for (const listener of clockListeners) listener()
  frame = getState().transport.playing ? requestAnimationFrame(tickClock) : 0
}

subscribe(() => {
  if (getState().transport.playing && !frame) frame = requestAnimationFrame(tickClock)
  if (!getState().transport.playing) {
    const next = engine.position()
    if (next !== bar) {
      bar = next
      for (const listener of clockListeners) listener()
    }
  }
})

function subscribeClock(listener: () => void) {
  clockListeners.add(listener)
  return () => {
    clockListeners.delete(listener)
  }
}

/** Playhead position in bars, updated every animation frame while playing. */
export function usePlayhead<T>(select: (bar: number) => T): T {
  return useSyncExternalStore(subscribeClock, () => select(bar), () => select(bar))
}

export function transport(): TransportSnapshot {
  return engine.snapshot()
}

export async function togglePlay(): Promise<void> {
  if (engine.snapshot().playing) engine.pause()
  else await engine.play()
}

export function formatBar(value: number, beatsPerBar = 4): string {
  const whole = Math.floor(value)
  const beat = Math.floor((value - whole) * beatsPerBar)
  const tick = Math.floor(((value - whole) * beatsPerBar - beat) * 240)
  return `${String(whole + 1).padStart(3, '0')}.${beat + 1}.${String(tick).padStart(3, '0')}`
}

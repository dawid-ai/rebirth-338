import { studio } from '@reborn/studio-core'
import { StudioGraph } from './graph'
import { type AssetBuffers, EventPlayer } from './play'
import { type Launch, collectEvents } from './schedule'

type StudioProject = studio.StudioProject

export interface RenderOptions {
  /** First bar (0-based, inclusive). */
  from?: number
  /** Last bar (exclusive). Defaults to the project length. */
  to?: number
  /** Seconds rendered after `to` for delay and reverb tails. Defaults to an estimate. */
  tail?: number
  sampleRate?: number
  /** Apply the master chain. Off for stems. */
  master?: boolean
  /** Bars per offline context. Smaller chunks keep long songs fast. */
  chunkBars?: number
  launch?: Launch | null
  signal?: AbortSignal
  onProgress?: (completedBars: number, totalBars: number) => void
}

export interface RenderResult {
  channels: [Float32Array<ArrayBuffer>, Float32Array<ArrayBuffer>]
  sampleRate: number
  from: number
  to: number
  /** Seconds of musical content before the tail. */
  musicalSeconds: number
}

/** Seconds the returns keep ringing after the last note. */
export function estimateTail(project: StudioProject): number {
  let tail = 1.5
  for (const ret of project.returns) {
    if (ret.mute) continue
    if (ret.kind === 'delay') {
      const loss = -20 * Math.log10(Math.min(0.95, Math.max(0.01, ret.feedback)))
      tail = Math.max(tail, (60 / loss) * ret.time * (60 / project.tempo))
    } else tail = Math.max(tail, ret.decay * 1.1)
  }
  return Math.min(12, tail)
}

function aborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('Render cancelled.', 'AbortError')
}

/**
 * Renders the project offline with the same event scheduler and graph as
 * live playback. Chunks bypass the master chain and are summed sample-exactly;
 * the master chain then runs once over the whole mix.
 */
export async function renderStudio(project: StudioProject, buffers: AssetBuffers, options: RenderOptions = {}): Promise<RenderResult> {
  const rate = options.sampleRate ?? project.sampleRate
  const from = Math.max(0, options.from ?? 0)
  const to = Math.max(from + 1 / 16, options.to ?? project.length)
  const tail = options.tail ?? estimateTail(project)
  const barSeconds = studio.barSeconds(project)
  const chunkBars = Math.max(1, options.chunkBars ?? 8)
  const musicalSeconds = (to - from) * barSeconds
  const totalFrames = Math.ceil((musicalSeconds + tail) * rate)
  const mix: [Float32Array<ArrayBuffer>, Float32Array<ArrayBuffer>] = [new Float32Array(totalFrames), new Float32Array(totalFrames)]
  const launch = options.launch ?? null

  for (let chunk = from; chunk < to - 1e-9; chunk += chunkBars) {
    aborted(options.signal)
    const end = Math.min(to, chunk + chunkBars)
    const frameOffset = Math.round((chunk - from) * barSeconds * rate)
    const offsetSeconds = frameOffset / rate
    const events = collectEvents(project, chunk, end, launch)
    // Audio clips play entirely in the chunk where they start.
    let chunkSeconds = (end - chunk) * barSeconds + tail
    for (const event of events) {
      if (event.kind !== 'audio') continue
      const clipEnd = Math.min(event.length, Math.max(0, to - event.bar)) * barSeconds + (event.bar - chunk) * barSeconds
      chunkSeconds = Math.max(chunkSeconds, clipEnd + 0.05)
    }
    const frames = Math.min(Math.ceil(chunkSeconds * rate), totalFrames - frameOffset)
    if (frames <= 0) continue
    const context = new OfflineAudioContext(2, frames, rate)
    const graph = new StudioGraph(context, context.destination, project, { masterBypass: true })
    const player = new EventPlayer(graph, buffers)
    for (let bar = chunk; bar < end - 1e-9; bar += 1 / 16) graph.applyMixerAutomation(project, bar, Math.max(0, (bar - from) * barSeconds - offsetSeconds))
    for (const event of events) {
      const time = Math.max(0, (event.bar - from) * barSeconds - offsetSeconds)
      if (event.kind === 'audio') {
        // Trim clips at the render end so stems and partial renders stop on time.
        const length = Math.min(event.length, to - event.bar)
        player.play(project, { ...event, length }, time, barSeconds)
      } else player.play(project, event, time, barSeconds)
    }
    // Audio clips that started before `from` still play from the middle.
    if (chunk === from) {
      for (const clip of project.clips) {
        if (!clip.assetId || clip.mute || clip.start >= from || clip.start + clip.length <= from) continue
        if (launch && clip.trackId in launch.slots) continue
        player.play(project, { kind: 'audio', trackId: clip.trackId, clipId: clip.id, assetId: clip.assetId, bar: clip.start, offset: clip.offset, length: Math.min(clip.length, to - clip.start), gain: clip.gain, fadeIn: clip.fadeIn, fadeOut: clip.fadeOut }, 0, barSeconds, (from - clip.start) * barSeconds)
      }
    }
    const rendered = await context.startRendering()
    for (let channel = 0; channel < 2; channel += 1) {
      const input = rendered.getChannelData(Math.min(channel, rendered.numberOfChannels - 1))
      const target = mix[channel]
      const count = Math.min(input.length, target.length - frameOffset)
      for (let i = 0; i < count; i += 1) target[frameOffset + i] += input[i]
    }
    options.onProgress?.(end - from, to - from)
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }

  if (options.master === false) return { channels: mix, sampleRate: rate, from, to, musicalSeconds }
  aborted(options.signal)
  const context = new OfflineAudioContext(2, totalFrames, rate)
  const graph = new StudioGraph(context, context.destination, { ...project, tracks: [], returns: [] })
  const buffer = context.createBuffer(2, totalFrames, rate)
  buffer.copyToChannel(mix[0], 0)
  buffer.copyToChannel(mix[1], 1)
  const source = context.createBufferSource()
  source.buffer = buffer
  source.connect(graph.masterInput())
  source.start(0)
  const mastered = await context.startRendering()
  return { channels: [mastered.getChannelData(0).slice(), mastered.getChannelData(1).slice()], sampleRate: rate, from, to, musicalSeconds }
}

/** A copy of the project where only `trackId` (and the groups it feeds) is heard. */
export function isolateTrack(project: StudioProject, trackId: string): StudioProject {
  const keep = new Set([trackId])
  let output = project.tracks.find((t) => t.id === trackId)?.mixer.output
  while (output && output !== 'master' && !keep.has(output)) {
    keep.add(output)
    output = project.tracks.find((t) => t.id === output)?.mixer.output
  }
  return {
    ...project,
    tracks: project.tracks.map((t) =>
      keep.has(t.id)
        ? { ...t, mixer: { ...t.mixer, solo: false, mute: t.id === trackId ? false : t.mixer.mute } }
        : { ...t, mixer: { ...t.mixer, solo: false, mute: true, sends: Object.fromEntries(Object.keys(t.mixer.sends).map((id) => [id, { level: 0, tap: 'post' as const }])) } },
    ),
  }
}

export interface StemResult {
  trackId: string
  name: string
  render: RenderResult
}

/** One render per sound-producing track, without the master chain. */
export async function renderStems(project: StudioProject, buffers: AssetBuffers, options: RenderOptions = {}): Promise<StemResult[]> {
  const tracks = project.tracks.filter((t) => t.kind !== 'group' && t.kind !== 'deck' && project.clips.some((c) => c.trackId === t.id && !c.mute))
  const stems: StemResult[] = []
  for (const [index, track] of tracks.entries()) {
    const render = await renderStudio(isolateTrack(project, track.id), buffers, {
      ...options,
      master: false,
      onProgress: (done, total) => options.onProgress?.(index * total + done, tracks.length * total),
    })
    stems.push({ trackId: track.id, name: track.name, render })
  }
  return stems
}

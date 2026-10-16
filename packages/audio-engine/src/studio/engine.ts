import { studio } from '@reborn/studio-core'
import { StudioGraph } from './graph'
import { EventPlayer, effectiveTrack } from './play'
import { type Launch, collectEvents } from './schedule'
import { playAudioClip, playDrum, playPad, playAcid, playWave } from './voices'
import { clamp } from './curves'

type StudioProject = studio.StudioProject
type DrumVoiceName = studio.DrumVoiceName

const TICK_MS = 25
const LOOKAHEAD = 0.12
const CHUNK_BARS = 1 / 16

export interface TransportSnapshot {
  playing: boolean
  bar: number
  loop: [number, number] | null
  launchedSceneId: string | null
  queuedSceneId: string | null
}

export interface AssetInfo {
  duration: number
  channels: number
  sampleRate: number
}

interface DeckRuntime {
  source: AudioBufferSourceNode | null
  filterHp: BiquadFilterNode
  filterLp: BiquadFilterNode
  startedAt: number
  offset: number
  rate: number
}

export interface DeviceOptions {
  /** Device sample rate; null follows the project rate. */
  sampleRate: number | null
  /** A latency category, or a target latency in seconds (the Web Audio buffer size). */
  latency: AudioContextLatencyCategory | number
}

export class StudioEngine {
  private context: AudioContext | null = null
  private graph: StudioGraph | null = null
  private player: EventPlayer | null = null
  private project: StudioProject
  private readonly buffers = new Map<string, AudioBuffer>()
  private timer: ReturnType<typeof setInterval> | null = null
  private playing = false
  private cursorBar = 0
  private cursorTime = 0
  private anchors: { time: number; bar: number }[] = []
  private loop: [number, number] | null = null
  private launch: Launch | null = null
  private queued: { sceneId: string | null; slots: Record<string, string | null> } | null = null
  private metronome = false
  private readonly decks = new Map<string, DeckRuntime>()
  private readonly listeners = new Set<(state: TransportSnapshot) => void>()
  private readonly previewHats = new Map<string, GainNode[]>()
  private readonly previewPads = new Map<string, Map<number, Set<AudioBufferSourceNode>>>()
  private seekBar = 0
  private device: DeviceOptions = { sampleRate: null, latency: 'interactive' }

  constructor(project: StudioProject) {
    this.project = project
  }

  // Lifecycle -----------------------------------------------------------------

  private ensure(): { context: AudioContext; graph: StudioGraph; player: EventPlayer } {
    if (!this.context) {
      const Context = globalThis.AudioContext
      if (!Context) throw new Error('Web Audio is not available.')
      this.context = new Context({ latencyHint: this.device.latency, sampleRate: this.device.sampleRate ?? this.project.sampleRate })
      this.graph = new StudioGraph(this.context, this.context.destination, this.project)
      this.player = new EventPlayer(this.graph, this.buffers)
    }
    return { context: this.context, graph: this.graph!, player: this.player! }
  }

  async resume(): Promise<void> {
    const { context } = this.ensure()
    if (context.state !== 'running') await context.resume()
  }

  dispose(): void {
    this.stop()
    for (const runtime of this.decks.values()) {
      try {
        runtime.source?.stop()
      } catch {
        // Never started.
      }
    }
    this.decks.clear()
    this.previewHats.clear()
    this.previewPads.clear()
    this.graph?.dispose()
    void this.context?.close()
    this.context = null
    this.graph = null
    this.player = null
  }

  /**
   * Sets the audio device rate and latency. A running context is closed and
   * rebuilt on next use; loaded audio stays loaded.
   */
  configureDevice(options: Partial<DeviceOptions>): void {
    const next = { ...this.device, ...options }
    if (next.sampleRate === this.device.sampleRate && next.latency === this.device.latency) return
    this.device = next
    if (this.context) this.dispose()
  }

  /** Output latency the device reports, in seconds. */
  get latency(): number {
    return this.context ? this.context.baseLatency + (this.context.outputLatency || 0) : 0
  }

  setProject(project: StudioProject): void {
    this.project = project
    this.graph?.update(project)
    if (this.loop && this.loop[0] >= project.length && !this.launch) this.loop = null
  }

  // Assets --------------------------------------------------------------------

  async loadAsset(assetId: string, data: ArrayBuffer | Blob): Promise<AssetInfo> {
    const buffer = await this.decode(data)
    this.buffers.set(assetId, buffer)
    return { duration: buffer.duration, channels: buffer.numberOfChannels, sampleRate: buffer.sampleRate }
  }

  async decode(data: ArrayBuffer | Blob): Promise<AudioBuffer> {
    const { context } = this.ensure()
    const bytes = data instanceof Blob ? await data.arrayBuffer() : data.slice(0)
    return context.decodeAudioData(bytes)
  }

  setBuffer(assetId: string, buffer: AudioBuffer): void {
    this.buffers.set(assetId, buffer)
  }

  hasAsset(assetId: string): boolean {
    return this.buffers.has(assetId)
  }

  buffer(assetId: string): AudioBuffer | undefined {
    return this.buffers.get(assetId)
  }

  assetBuffers(): ReadonlyMap<string, AudioBuffer> {
    return this.buffers
  }

  // Transport ----------------------------------------------------------------

  private barSeconds() {
    return studio.barSeconds(this.project)
  }

  onTransport(listener: (state: TransportSnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private emit() {
    const state = this.snapshot()
    for (const listener of this.listeners) listener(state)
  }

  snapshot(): TransportSnapshot {
    return { playing: this.playing, bar: this.position(), loop: this.loop, launchedSceneId: this.launch?.sceneId ?? null, queuedSceneId: this.queued?.sceneId ?? null }
  }

  /** Current playhead in bars. */
  position(): number {
    if (!this.playing || !this.context) return this.seekBar
    const now = this.context.currentTime
    let anchor = this.anchors[0]
    for (const candidate of this.anchors) if (candidate.time <= now) anchor = candidate
    if (!anchor) return this.cursorBar
    return Math.max(0, anchor.bar + (now - anchor.time) / this.barSeconds())
  }

  async play(fromBar = this.seekBar): Promise<void> {
    if (this.playing) return
    await this.resume()
    const { context, player } = this.ensure()
    this.playing = true
    this.cursorBar = Math.max(0, fromBar)
    this.cursorTime = context.currentTime + 0.06
    this.anchors = [{ time: this.cursorTime, bar: this.cursorBar }]
    // Audio clips that started before the playhead still play from the middle.
    for (const clip of this.project.clips) {
      if (!clip.assetId || clip.mute || this.launch?.slots[clip.trackId] !== undefined) continue
      if (clip.start < this.cursorBar && clip.start + clip.length > this.cursorBar) {
        player.play(this.project, { kind: 'audio', trackId: clip.trackId, clipId: clip.id, assetId: clip.assetId, bar: clip.start, offset: clip.offset, length: clip.length, gain: clip.gain, fadeIn: clip.fadeIn, fadeOut: clip.fadeOut }, this.cursorTime, this.barSeconds(), (this.cursorBar - clip.start) * this.barSeconds())
      }
    }
    this.tick()
    this.timer = setInterval(() => this.tick(), TICK_MS)
    this.emit()
  }

  pause(): void {
    if (!this.playing) return
    this.seekBar = this.position()
    this.halt()
  }

  stop(): void {
    this.seekBar = this.loop ? this.loop[0] : 0
    this.halt()
    this.launch = null
    this.queued = null
    this.emit()
  }

  private halt() {
    this.playing = false
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (this.context) this.player?.stopAll(this.context.currentTime)
    this.emit()
  }

  seek(bar: number): void {
    const wasPlaying = this.playing
    if (wasPlaying) this.halt()
    this.seekBar = Math.max(0, bar)
    if (wasPlaying) void this.play(this.seekBar)
    else this.emit()
  }

  setLoop(range: [number, number] | null): void {
    this.loop = range && range[1] > range[0] ? range : null
    this.emit()
  }

  setMetronome(on: boolean): void {
    this.metronome = on
  }

  /** Launches a scene at the next bar (or immediately when stopped). */
  launchScene(sceneId: string | null, slots: Record<string, string | null>): void {
    if (!this.playing) {
      this.launch = { sceneId, slots, start: Math.floor(this.seekBar) }
      void this.play(Math.floor(this.seekBar))
      return
    }
    this.queued = { sceneId, slots }
    this.emit()
  }

  /** Returns every track to the arrangement at the next bar. */
  returnToArrangement(): void {
    if (!this.playing) {
      this.launch = null
      this.emit()
      return
    }
    this.queued = { sceneId: null, slots: {} }
    this.emit()
  }

  private tick() {
    if (!this.playing || !this.context || !this.graph || !this.player) return
    const horizon = this.context.currentTime + LOOKAHEAD
    const barSeconds = this.barSeconds()
    let guard = 0
    while (this.cursorTime < horizon && guard < 256) {
      guard += 1
      const loopEnd = this.loop?.[1]
      let end = this.cursorBar + CHUNK_BARS
      if (loopEnd !== undefined && end > loopEnd && this.cursorBar < loopEnd) end = loopEnd
      const nextBar = Math.floor(this.cursorBar + 1e-9) + 1
      if (this.queued && end > nextBar && this.cursorBar < nextBar) end = nextBar
      const events = collectEvents(this.project, this.cursorBar, end, this.launch)
      for (const event of events) this.player.play(this.project, event, this.cursorTime + (event.bar - this.cursorBar) * barSeconds, barSeconds)
      this.graph.applyMixerAutomation(this.project, this.cursorBar, this.cursorTime)
      if (this.metronome) this.click(this.cursorBar, end, this.cursorTime, barSeconds)
      this.cursorTime += (end - this.cursorBar) * barSeconds
      this.cursorBar = end
      if (this.queued && Math.abs(this.cursorBar - nextBar) < 1e-9) {
        this.launch = this.queued.sceneId === null && !Object.keys(this.queued.slots).length ? null : { sceneId: this.queued.sceneId, slots: this.queued.slots, start: nextBar }
        this.queued = null
        queueMicrotask(() => this.emit())
      }
      if (loopEnd !== undefined && this.cursorBar >= loopEnd - 1e-9) {
        this.cursorBar = this.loop![0]
        this.anchors.push({ time: this.cursorTime, bar: this.cursorBar })
      } else if (!this.loop && !this.launch && this.cursorBar >= this.project.length) {
        const endTime = this.cursorTime
        setTimeout(() => {
          if (this.playing && this.context && this.context.currentTime >= endTime - 0.01) this.stop()
        }, Math.max(0, (endTime - this.context.currentTime) * 1000))
        break
      }
    }
    if (this.anchors.length > 32) this.anchors = this.anchors.slice(-8)
  }

  private click(from: number, to: number, time: number, barSeconds: number) {
    const ctx = this.context!
    const beatsPerBar = this.project.meter.numerator
    const first = Math.ceil(from * beatsPerBar - 1e-9)
    for (let beat = first; beat / beatsPerBar < to - 1e-9; beat += 1) {
      const at = time + (beat / beatsPerBar - from) * barSeconds
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.frequency.value = beat % beatsPerBar === 0 ? 1600 : 1100
      gain.gain.setValueAtTime(0.18, at)
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.04)
      osc.connect(gain).connect(ctx.destination)
      osc.start(at)
      osc.stop(at + 0.05)
    }
  }

  // Live input -----------------------------------------------------------------

  async previewNote(trackId: string, note: number, velocity = 100, accent = false): Promise<void> {
    await this.resume()
    const { context, graph } = this.ensure()
    const track = this.project.tracks.find((t) => t.id === trackId)
    const output = graph.input(trackId)
    if (!track || !output) return
    const device = effectiveTrack(this.project, track, this.position()).device
    const length = this.barSeconds() / 8
    if (device.kind === 'acid') playAcid(graph, output, device, context.currentTime + 0.005, length, note, velocity, accent, null)
    if (device.kind === 'wave') playWave(graph, output, device, context.currentTime + 0.005, length, note, velocity, accent, false)
  }

  async previewDrum(trackId: string, voice: DrumVoiceName, velocity = 100, accent = false): Promise<void> {
    await this.resume()
    const { context, graph } = this.ensure()
    const track = this.project.tracks.find((t) => t.id === trackId)
    const output = graph.input(trackId)
    if (!track || !output || track.device.kind !== 'drum') return
    playDrum(graph, output, track.device, voice, context.currentTime + 0.005, velocity, accent, trackId, this.previewHats)
  }

  async triggerPad(trackId: string, pad: number, velocity = 100): Promise<void> {
    await this.resume()
    const { context, graph } = this.ensure()
    const track = this.project.tracks.find((t) => t.id === trackId)
    const output = graph.input(trackId)
    if (!track || !output || track.device.kind !== 'sampler') return
    const device = track.device
    const sourcePad = device.sixteenLevels === 'off' ? pad : 0
    const assetId = device.pads[sourcePad]?.assetId ?? device.source?.assetId
    const buffer = assetId ? this.buffers.get(assetId) : undefined
    if (buffer) playPad(graph, output, device, trackId, pad, buffer, context.currentTime + 0.005, this.barSeconds() / 4, velocity, this.previewPads)
  }

  /** Plays a region of an asset directly to the master, for auditioning slices. */
  async audition(assetId: string, start: number, end: number): Promise<void> {
    await this.resume()
    const { context, graph } = this.ensure()
    const buffer = this.buffers.get(assetId)
    if (!buffer) return
    const from = clamp(start) * buffer.duration
    const to = Math.max(from + 0.01, clamp(end) * buffer.duration)
    playAudioClip(graph, context.destination, buffer, context.currentTime + 0.005, from, to - from, -3, 0.002, 0.01)
  }

  // Decks ---------------------------------------------------------------------

  async deckPlay(trackId: string): Promise<void> {
    await this.resume()
    const { context, graph } = this.ensure()
    const track = this.project.tracks.find((t) => t.id === trackId)
    if (!track || track.device.kind !== 'deck' || !track.device.assetId) return
    const buffer = this.buffers.get(track.device.assetId)
    const input = graph.input(trackId)
    if (!buffer || !input) return
    this.deckStop(trackId)
    let runtime = this.decks.get(trackId)
    if (!runtime) {
      const filterHp = context.createBiquadFilter()
      filterHp.type = 'highpass'
      const filterLp = context.createBiquadFilter()
      filterLp.type = 'lowpass'
      filterHp.connect(filterLp).connect(input)
      runtime = { source: null, filterHp, filterLp, startedAt: 0, offset: track.device.cue, rate: 1 }
      this.decks.set(trackId, runtime)
    }
    const device = track.device
    const source = context.createBufferSource()
    source.buffer = buffer
    source.loop = device.loop
    if (device.loopEnd > device.loopStart) {
      source.loopStart = device.loopStart
      source.loopEnd = Math.min(buffer.duration, device.loopEnd)
    }
    runtime.rate = 2 ** (device.pitch / 12)
    source.playbackRate.value = runtime.rate
    source.connect(runtime.filterHp)
    this.updateDeck(trackId)
    source.start(context.currentTime + 0.01, clamp(runtime.offset, 0, buffer.duration - 0.01))
    runtime.source = source
    runtime.startedAt = context.currentTime + 0.01
  }

  deckStop(trackId: string): void {
    const runtime = this.decks.get(trackId)
    if (!runtime?.source || !this.context) return
    runtime.offset = this.deckTime(trackId)
    try {
      runtime.source.stop()
    } catch {
      // Already stopped.
    }
    runtime.source = null
  }

  deckCue(trackId: string): void {
    const track = this.project.tracks.find((t) => t.id === trackId)
    const runtime = this.decks.get(trackId)
    this.deckStop(trackId)
    if (runtime && track?.device.kind === 'deck') runtime.offset = track.device.cue
  }

  deckTime(trackId: string): number {
    const runtime = this.decks.get(trackId)
    if (!runtime || !this.context) return 0
    if (!runtime.source) return runtime.offset
    const elapsed = (this.context.currentTime - runtime.startedAt) * runtime.rate
    const duration = runtime.source.buffer?.duration ?? 1
    return (runtime.offset + elapsed) % duration
  }

  deckPlaying(trackId: string): boolean {
    return Boolean(this.decks.get(trackId)?.source)
  }

  updateDeck(trackId: string): void {
    const runtime = this.decks.get(trackId)
    const track = this.project.tracks.find((t) => t.id === trackId)
    if (!runtime || !this.context || track?.device.kind !== 'deck') return
    const now = this.context.currentTime
    const filter = track.device.filter
    runtime.filterHp.frequency.setTargetAtTime(filter < 0 ? 20 * 2 ** (-filter * 8) : 10, now, 0.012)
    runtime.filterLp.frequency.setTargetAtTime(filter > 0 ? 20000 * 2 ** (-filter * 6) : 22000, now, 0.012)
    const rate = 2 ** (track.device.pitch / 12)
    if (runtime.source && rate !== runtime.rate) {
      runtime.offset = this.deckTime(trackId)
      runtime.startedAt = now
      runtime.rate = rate
      runtime.source.playbackRate.setTargetAtTime(rate, now, 0.012)
    }
  }

  // Meters --------------------------------------------------------------------

  outputLevel(): number {
    return this.graph?.outputLevel() ?? 0
  }

  trackLevel(trackId: string): number {
    return this.graph?.trackLevel(trackId) ?? 0
  }

  gainReduction(): number {
    return this.graph?.gainReduction() ?? 0
  }

  get sampleRate(): number {
    return this.context?.sampleRate ?? this.project.sampleRate
  }
}

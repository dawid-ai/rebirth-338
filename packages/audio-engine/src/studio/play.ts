import { studio } from '@reborn/studio-core'
import type { StudioGraph } from './graph'
import type { StudioEvent } from './schedule'
import { type OpenHatRegistry, type PadRegistry, playAcid, playAudioClip, playDrum, playPad, playWave } from './voices'

type StudioProject = studio.StudioProject
type Track = studio.Track

export type AssetBuffers = ReadonlyMap<string, AudioBuffer>

const DEVICE_PARAM = /^(device|voice|pad)\./

/**
 * The track as it sounds at `bar`: arrangement automation applied over the
 * device, then step locks on top.
 */
export function effectiveTrack(project: StudioProject, track: Track, bar: number, locks: Record<string, number> = {}): Track {
  let result = track
  for (const lane of project.automation) {
    if (lane.trackId !== track.id || !DEVICE_PARAM.test(lane.param)) continue
    const value = studio.automationValueAt(lane, bar)
    if (value !== undefined) result = studio.setParam(result, lane.param, value)
  }
  for (const [param, value] of Object.entries(locks)) if (DEVICE_PARAM.test(param)) result = studio.setParam(result, param, value)
  return result
}

/** Plays scheduled events through a graph. One instance per graph. */
export class EventPlayer {
  private readonly openHats: OpenHatRegistry = new Map()
  private readonly pads: PadRegistry = new Map()
  private readonly sources = new Set<AudioBufferSourceNode>()

  constructor(
    private readonly graph: StudioGraph,
    private readonly buffers: AssetBuffers,
  ) {}

  play(project: StudioProject, event: StudioEvent, time: number, barSeconds: number, startAt = 0): void {
    const track = project.tracks.find((t) => t.id === event.trackId)
    const output = this.graph.input(event.trackId)
    if (!track || !output) return
    if (event.kind === 'audio') {
      const buffer = this.buffers.get(event.assetId)
      if (!buffer) return
      const source = playAudioClip(this.graph, output, buffer, time, event.offset * barSeconds, event.length * barSeconds, event.gain, event.fadeIn * barSeconds, event.fadeOut * barSeconds, startAt)
      if (source) {
        this.sources.add(source)
        source.onended = () => this.sources.delete(source)
      }
      return
    }
    const device = effectiveTrack(project, track, event.bar, event.locks).device
    if (event.kind === 'note') {
      const seconds = event.length * barSeconds
      if (device.kind === 'acid') playAcid(this.graph, output, device, time, seconds, event.note, event.velocity, event.accent, event.slideTo)
      else if (device.kind === 'wave') playWave(this.graph, output, device, time, seconds, event.note, event.velocity, event.accent, event.slide)
    } else if (event.kind === 'drum') {
      if (device.kind === 'drum') playDrum(this.graph, output, device, event.voice, time, event.velocity, event.accent, track.id, this.openHats)
    } else if (event.kind === 'pad' && device.kind === 'sampler') {
      const sourcePad = device.sixteenLevels === 'off' ? event.pad : 0
      const assetId = device.pads[sourcePad]?.assetId ?? device.source?.assetId
      const buffer = assetId ? this.buffers.get(assetId) : undefined
      if (buffer) playPad(this.graph, output, device, track.id, event.pad, buffer, time, event.length * barSeconds, event.velocity, this.pads)
    }
  }

  /** Stops audio clips and sustained pads, for transport stop. */
  stopAll(time: number): void {
    for (const source of this.sources) {
      try {
        source.stop(time)
      } catch {
        // Already stopped.
      }
    }
    this.sources.clear()
    for (const pads of this.pads.values()) {
      for (const set of pads.values()) {
        for (const source of set) {
          try {
            source.stop(time)
          } catch {
            // Already stopped.
          }
        }
      }
    }
    this.pads.clear()
  }
}

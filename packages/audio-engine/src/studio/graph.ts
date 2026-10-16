import { studio } from '@reborn/studio-core'
import { clamp, dbToGain, limiterCurve, makeImpulse, makeMetallic, makeNoise, saturationCurve } from './curves'
import type { VoiceHost } from './voices'

type StudioProject = studio.StudioProject
type Track = studio.Track
type ReturnBus = studio.ReturnBus

// The mixer graph shared by live playback and offline render:
//
//   voice → strip.input → EQ → DJ filter → drive → pre ─┬─ fader → pan → post → group or master
//                                                      └─ pre-fader sends
//                                               post ─── post-fader sends → returns → master
//   master: sum → soften → drive → compressor → volume → ceiling → meter → out
//
// Every parameter change ramps (setTargetAtTime) so edits never click.

const RAMP = 0.012

interface Strip {
  trackId: string
  input: GainNode
  low: BiquadFilterNode
  mid: BiquadFilterNode
  high: BiquadFilterNode
  highpass: BiquadFilterNode
  lowpass: BiquadFilterNode
  drive: WaveShaperNode
  driveAmount: number
  pre: GainNode
  fader: GainNode
  panner: StereoPannerNode
  post: GainNode
  meter: AnalyserNode
  output: string
  sends: Map<string, { pre: GainNode; post: GainNode }>
}

interface ReturnNodes {
  id: string
  kind: ReturnBus['kind']
  input: GainNode
  output: GainNode
  tone: BiquadFilterNode
  delay?: DelayNode
  feedback?: GainNode
  convolver?: ConvolverNode
  decay?: number
}

export class StudioGraph implements VoiceHost {
  readonly noise: AudioBuffer
  readonly metallic: AudioBuffer
  private readonly strips = new Map<string, Strip>()
  private readonly returns = new Map<string, ReturnNodes>()
  private readonly masterIn: GainNode
  private readonly soften: BiquadFilterNode
  private readonly air: BiquadFilterNode
  private readonly headroom: GainNode
  private readonly masterDrive: WaveShaperNode
  private masterDriveAmount = -1
  private readonly compressor: DynamicsCompressorNode
  private readonly masterVolume: GainNode
  private readonly limiter: WaveShaperNode
  private limiterCeiling = 0
  readonly meter: AnalyserNode
  private project: StudioProject

  constructor(
    readonly context: BaseAudioContext,
    destination: AudioNode,
    project: StudioProject,
    options: { masterBypass?: boolean } = {},
  ) {
    this.project = project
    this.noise = makeNoise(context, 2)
    this.metallic = makeMetallic(context, 2)
    this.masterIn = context.createGain()
    this.soften = context.createBiquadFilter()
    this.soften.type = 'peaking'
    this.soften.frequency.value = 3200
    this.soften.Q.value = 0.82
    this.air = context.createBiquadFilter()
    this.air.type = 'lowpass'
    this.air.Q.value = 0.5
    this.headroom = context.createGain()
    this.headroom.gain.value = 0.76
    this.masterDrive = context.createWaveShaper()
    this.masterDrive.oversample = '4x'
    this.compressor = context.createDynamicsCompressor()
    this.masterVolume = context.createGain()
    this.limiter = context.createWaveShaper()
    this.limiter.oversample = '4x'
    this.meter = context.createAnalyser()
    this.meter.fftSize = 2048
    this.meter.smoothingTimeConstant = 0.6
    // Offline chunks bypass the master chain; it runs once over the summed
    // mix so compression and limiting see the whole song, as they do live.
    if (options.masterBypass) this.masterIn.connect(destination)
    else this.masterIn.connect(this.soften).connect(this.air).connect(this.headroom).connect(this.masterDrive).connect(this.compressor).connect(this.masterVolume).connect(this.limiter).connect(this.meter).connect(destination)
    this.update(project, context.currentTime)
  }

  /** Sum point before the master chain. */
  masterInput(): AudioNode {
    return this.masterIn
  }

  /** Track strip input for voices, or null when the track no longer exists. */
  input(trackId: string): AudioNode | null {
    return this.strips.get(trackId)?.input ?? null
  }

  trackMeter(trackId: string): AnalyserNode | null {
    return this.strips.get(trackId)?.meter ?? null
  }

  update(project: StudioProject, time = this.context.currentTime): void {
    this.project = project
    this.syncReturns(project.returns, time)
    this.syncStrips(project, time)
    this.updateMaster(project, time)
  }

  /** Applies automated mixer, insert, and send values at `bar` from `time`. */
  applyMixerAutomation(project: StudioProject, bar: number, time: number): void {
    for (const lane of project.automation) {
      if (!/^(mixer|insert|send)\./.test(lane.param)) continue
      const track = project.tracks.find((t) => t.id === lane.trackId)
      const value = studio.automationValueAt(lane, bar)
      if (!track || value === undefined) continue
      this.applyStripParams(studio.setParam(track, lane.param, value), project, time, true)
    }
  }

  private syncReturns(returns: ReturnBus[], time: number) {
    const ids = new Set(returns.map((r) => r.id))
    for (const [id, nodes] of this.returns) {
      if (ids.has(id)) continue
      nodes.output.disconnect()
      this.returns.delete(id)
    }
    for (const ret of returns) {
      let nodes = this.returns.get(ret.id)
      if (!nodes || nodes.kind !== ret.kind) {
        nodes?.output.disconnect()
        nodes = this.createReturn(ret)
        this.returns.set(ret.id, nodes)
      }
      const audible = !ret.mute && !this.project.master.fxSafeBypass
      nodes.output.gain.setTargetAtTime(audible ? dbToGain(ret.level) : 0, time, RAMP)
      nodes.tone.frequency.setTargetAtTime(1200 + ret.tone ** 1.5 * 15000, time, RAMP)
      if (ret.kind === 'delay' && nodes.delay && nodes.feedback) {
        nodes.delay.delayTime.setTargetAtTime(clamp((ret.time * 60) / clamp(this.project.tempo, 40, 240), 0.01, 3.9), time, 0.03)
        nodes.feedback.gain.setTargetAtTime(clamp(ret.feedback, 0, 0.95), time, RAMP)
      }
      if (ret.kind === 'reverb' && nodes.convolver && Math.abs((nodes.decay ?? 0) - ret.decay) > 0.05) {
        nodes.convolver.buffer = makeImpulse(this.context, clamp(ret.decay, 0.2, 12), 2.6)
        nodes.decay = ret.decay
      }
    }
  }

  private createReturn(ret: ReturnBus): ReturnNodes {
    const ctx = this.context
    const input = ctx.createGain()
    const output = ctx.createGain()
    const tone = ctx.createBiquadFilter()
    tone.type = 'lowpass'
    output.connect(this.masterIn)
    if (ret.kind === 'delay') {
      const delay = ctx.createDelay(4)
      const feedback = ctx.createGain()
      input.connect(delay)
      delay.connect(tone)
      tone.connect(feedback).connect(delay)
      tone.connect(output)
      return { id: ret.id, kind: ret.kind, input, output, tone, delay, feedback }
    }
    const convolver = ctx.createConvolver()
    convolver.buffer = makeImpulse(ctx, clamp(ret.decay, 0.2, 12), 2.6)
    input.connect(convolver).connect(tone).connect(output)
    return { id: ret.id, kind: ret.kind, input, output, tone, convolver, decay: ret.decay }
  }

  private syncStrips(project: StudioProject, time: number) {
    const ids = new Set(project.tracks.map((t) => t.id))
    for (const [id, strip] of this.strips) {
      if (ids.has(id)) continue
      strip.post.disconnect()
      strip.pre.disconnect()
      this.strips.delete(id)
    }
    for (const track of project.tracks) if (!this.strips.has(track.id)) this.strips.set(track.id, this.createStrip(track.id))
    // Routing after all strips exist, so groups can receive children.
    for (const track of project.tracks) this.applyStripParams(track, project, time, false)
  }

  private createStrip(trackId: string): Strip {
    const ctx = this.context
    const input = ctx.createGain()
    const low = ctx.createBiquadFilter()
    low.type = 'lowshelf'
    low.frequency.value = 130
    const mid = ctx.createBiquadFilter()
    mid.type = 'peaking'
    mid.frequency.value = 1050
    mid.Q.value = 0.72
    const high = ctx.createBiquadFilter()
    high.type = 'highshelf'
    high.frequency.value = 6800
    const highpass = ctx.createBiquadFilter()
    highpass.type = 'highpass'
    highpass.frequency.value = 10
    const lowpass = ctx.createBiquadFilter()
    lowpass.type = 'lowpass'
    lowpass.frequency.value = 22000
    const drive = ctx.createWaveShaper()
    drive.oversample = '2x'
    const pre = ctx.createGain()
    const fader = ctx.createGain()
    const panner = ctx.createStereoPanner()
    const post = ctx.createGain()
    const meter = ctx.createAnalyser()
    meter.fftSize = 1024
    meter.smoothingTimeConstant = 0.5
    input.connect(low).connect(mid).connect(high).connect(highpass).connect(lowpass).connect(drive).connect(pre).connect(fader).connect(panner).connect(post)
    post.connect(meter)
    return { trackId, input, low, mid, high, highpass, lowpass, drive, driveAmount: -1, pre, fader, panner, post, meter, output: '', sends: new Map() }
  }

  private applyStripParams(track: Track, project: StudioProject, time: number, automationOnly: boolean) {
    const strip = this.strips.get(track.id)
    if (!strip) return
    const { inserts, mixer } = track
    strip.low.gain.setTargetAtTime(inserts.eqLow, time, RAMP)
    strip.mid.gain.setTargetAtTime(inserts.eqMid, time, RAMP)
    strip.high.gain.setTargetAtTime(inserts.eqHigh, time, RAMP)
    const filter = clamp(inserts.filter, -1, 1)
    strip.highpass.frequency.setTargetAtTime(filter < 0 ? 20 * 2 ** (-filter * 8) : 10, time, RAMP)
    strip.lowpass.frequency.setTargetAtTime(filter > 0 ? 20000 * 2 ** (-filter * 6) : 22000, time, RAMP)
    strip.highpass.Q.setTargetAtTime(0.7 + Math.max(0, -filter) * 5, time, RAMP)
    strip.lowpass.Q.setTargetAtTime(0.7 + Math.max(0, filter) * 5, time, RAMP)
    const driveAmount = Math.round(inserts.drive * 50) / 50
    if (driveAmount !== strip.driveAmount) {
      strip.drive.curve = saturationCurve(driveAmount, 512)
      strip.driveAmount = driveAmount
    }
    const audible = studio.isTrackAudible(project, track)
    strip.fader.gain.setTargetAtTime(audible ? dbToGain(mixer.volume) : 0, time, 0.008)
    strip.panner.pan.setTargetAtTime(clamp(mixer.pan, -1, 1), time, RAMP)
    if (track.kind === 'deck') strip.input.gain.setTargetAtTime(track.device.kind === 'deck' ? track.device.gain : 1, time, RAMP)
    for (const ret of project.returns) {
      let send = strip.sends.get(ret.id)
      const target = this.returns.get(ret.id)
      if (!target) continue
      if (!send) {
        send = { pre: this.context.createGain(), post: this.context.createGain() }
        send.pre.gain.value = 0
        send.post.gain.value = 0
        strip.pre.connect(send.pre).connect(target.input)
        strip.post.connect(send.post).connect(target.input)
        strip.sends.set(ret.id, send)
      }
      const value = mixer.sends[ret.id] ?? { level: 0, tap: 'post' as const }
      send.pre.gain.setTargetAtTime(value.tap === 'pre' ? value.level : 0, time, RAMP)
      send.post.gain.setTargetAtTime(value.tap === 'post' ? value.level : 0, time, RAMP)
    }
    if (automationOnly) return
    const output = mixer.output !== 'master' && this.strips.has(mixer.output) && mixer.output !== track.id ? mixer.output : 'master'
    if (output !== strip.output) {
      const previous = strip.output === 'master' ? this.masterIn : strip.output ? this.strips.get(strip.output)?.input : undefined
      if (previous) {
        try {
          strip.post.disconnect(previous)
        } catch {
          // Already disconnected.
        }
      }
      strip.post.connect(output === 'master' ? this.masterIn : this.strips.get(output)!.input)
      strip.output = output
    }
  }

  private updateMaster(project: StudioProject, time: number) {
    const { master } = project
    this.soften.gain.setTargetAtTime(-5 * master.soften, time, 0.025)
    this.air.frequency.setTargetAtTime(20000 - 10000 * master.soften, time, 0.025)
    this.headroom.gain.setTargetAtTime(0.76 - master.soften * 0.1, time, 0.02)
    const drive = Math.round(master.drive * (1 - master.soften * 0.85) * 50) / 50
    if (drive !== this.masterDriveAmount) {
      this.masterDrive.curve = saturationCurve(drive)
      this.masterDriveAmount = drive
    }
    const c = clamp(master.compress)
    this.compressor.threshold.setTargetAtTime(-7 - c * 25, time, 0.02)
    this.compressor.knee.setTargetAtTime(18 - c * 8, time, 0.02)
    this.compressor.ratio.setTargetAtTime(1.5 + c * 7.5, time, 0.02)
    this.compressor.attack.setTargetAtTime(0.022 - c * 0.017, time, 0.02)
    this.compressor.release.setTargetAtTime(0.11 + c * 0.22, time, 0.02)
    this.masterVolume.gain.setTargetAtTime(dbToGain(master.volume), time, RAMP)
    const ceiling = dbToGain(clamp(master.ceiling, -6, 0))
    if (Math.abs(ceiling - this.limiterCeiling) > 1e-4) {
      this.limiter.curve = limiterCurve(ceiling)
      this.limiterCeiling = ceiling
    }
  }

  /** Short-term RMS level of the master output, 0..1. */
  outputLevel(): number {
    return analyserLevel(this.meter)
  }

  trackLevel(trackId: string): number {
    const meter = this.strips.get(trackId)?.meter
    return meter ? analyserLevel(meter) : 0
  }

  gainReduction(): number {
    return clamp(Math.abs(this.compressor.reduction) / 24)
  }

  dispose(): void {
    for (const strip of this.strips.values()) {
      strip.post.disconnect()
      strip.pre.disconnect()
    }
    for (const ret of this.returns.values()) ret.output.disconnect()
    this.meter.disconnect()
  }
}

const scratch = new Float32Array(2048)

function analyserLevel(analyser: AnalyserNode): number {
  const data = scratch.subarray(0, analyser.fftSize)
  analyser.getFloatTimeDomainData(data)
  let sum = 0
  for (let i = 0; i < data.length; i += 1) sum += data[i] * data[i]
  return clamp(Math.sqrt(sum / data.length) * 3.2)
}

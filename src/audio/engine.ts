import {
  createDefaultProject,
  drumNames,
  fxPadNames,
  type BassStep,
  type BassVoice,
  type DrumName,
  type DrumVoice,
  type DeckState,
  type ProjectState,
  type SamplerSlot,
} from '../model'
import { applyDubstepBarAutomation, DUBSTEP_AUTOMATION_FRAMES, DUBSTEP_SONG_CHAIN } from '../demo/dubstepDemo'

const STEPS = 16
const LOOK_AHEAD_MS = 25
const SCHEDULE_AHEAD_SECONDS = 0.12

const clamp = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, value))
const unit = (value: number) => clamp(value / 100)
const midiToHz = (note: number) => 440 * 2 ** ((clamp(note, 12, 108) - 69) / 12)

type StepListener = (step: number, bar?: number) => void
type RoutedDrumVoice = DrumVoice & { machineIndex: number; machineDelay: number; machineReverb: number }
type SourceBus = { input: GainNode; low: BiquadFilterNode; mid: BiquadFilterNode; high: BiquadFilterNode; output: GainNode }

export type MixerChannel =
  | { kind: 'bass'; index: 0 | 1 }
  | { kind: 'drum'; machineIndex: 0 | 1; name: DrumName }
  | { kind: 'wave' }
  | { kind: 'sampler' }
  | { kind: 'deck'; index: 0 | 1 }

/** Centralised mute/solo policy shared by realtime playback and offline export. */
export function isMixerChannelAudible(project: ProjectState, channel: MixerChannel): boolean {
  const anySolo = project.bass.some((voice) => voice.solo)
    || project.rhythms.some((machine) => machine.solo || drumNames.some((name) => machine.drums[name].solo))
    || project.waveDesigner.solo
    || project.sampler.solo
    || project.decks.some((deck) => deck.solo)
  if (channel.kind === 'sampler') return !project.sampler.muted && (!anySolo || project.sampler.solo)
  if (channel.kind === 'deck') {
    const deck = project.decks[channel.index]
    return !deck.muted && (!anySolo || deck.solo)
  }
  if (channel.kind === 'wave') return !project.waveDesigner.muted && (!anySolo || project.waveDesigner.solo)
  if (channel.kind === 'bass') {
    const voice = project.bass[channel.index]
    return !voice.muted && (!anySolo || voice.solo)
  }
  const machine = project.rhythms[channel.machineIndex]
  const voice = machine.drums[channel.name]
  return !machine.muted && !voice.muted && (!anySolo || machine.solo || voice.solo)
}

/** Equal-power deck gains. Deck A contains the 303s; deck B contains both rhythm machines. */
export function crossfaderGains(crossfader: number): [number, number] {
  const position = (clamp(crossfader, -100, 100) + 100) / 200
  return [Math.cos(position * Math.PI / 2), Math.sin(position * Math.PI / 2)]
}

export function beatRepeatSeconds(project: Pick<ProjectState, 'tempo' | 'performance'>): number {
  return 60 / clamp(project.tempo, 40, 240) / project.performance.beatRepeatDivision
}

export function tempoDelaySeconds(tempo: number, value: number): number {
  const beatLengths = [0.125, 0.25, 0.375, 0.5, 0.75, 1]
  const index = Math.round(unit(value) * (beatLengths.length - 1))
  return 60 / clamp(tempo, 40, 240) * beatLengths[index]
}

export function deckPlaybackRate(deck: Pick<DeckState, 'rate' | 'pitch'>): number {
  return clamp(deck.rate, 0.25, 4) * 2 ** (clamp(deck.pitch, -24, 24) / 12)
}

export function samplePlaybackRegion(slot: Pick<SamplerSlot, 'trimStart' | 'trimEnd' | 'pitch'>, duration: number): { start: number; end: number; rate: number } {
  const start = clamp(slot.trimStart) * Math.max(0, duration)
  const end = Math.max(start + Math.min(0.005, duration), clamp(slot.trimEnd) * Math.max(0, duration))
  return { start, end: Math.min(duration, end), rate: 2 ** (clamp(slot.pitch, -24, 24) / 12) }
}

class AudioGraph {
  private readonly masterInput: GainNode
  private readonly masterHeadroom: GainNode
  private readonly masterGain: GainNode
  private readonly limiter: WaveShaperNode
  private readonly analyser: AnalyserNode
  private readonly compressor: DynamicsCompressorNode
  private readonly drive: WaveShaperNode
  private readonly masterFilter: BiquadFilterNode
  private readonly harshnessFilter: BiquadFilterNode
  private readonly airFilter: BiquadFilterNode
  private readonly repeatDry: GainNode
  private readonly beatRepeatDelay: DelayNode
  private readonly beatRepeatInput: GainNode
  private readonly beatRepeatFeedback: GainNode
  private readonly beatRepeatWet: GainNode
  private readonly delayInput: GainNode
  private readonly delay: DelayNode
  private readonly delayFeedback: GainNode
  private readonly delayWet: GainNode
  private readonly reverbInput: GainNode
  private readonly reverbWet: GainNode
  private readonly reverbTone: BiquadFilterNode
  private readonly noiseBuffer: AudioBuffer
  private readonly metallicBuffer: AudioBuffer
  private readonly sourceBuses: SourceBus[]
  private activeOpenHats: [GainNode[], GainNode[]] = [[], []]
  private readonly deckInputs: [GainNode, GainNode]
  private readonly deckHighpass: [BiquadFilterNode, BiquadFilterNode]
  private readonly deckLowpass: [BiquadFilterNode, BiquadFilterNode]
  private readonly deckLow: [BiquadFilterNode, BiquadFilterNode]
  private readonly deckMid: [BiquadFilterNode, BiquadFilterNode]
  private readonly deckHigh: [BiquadFilterNode, BiquadFilterNode]
  private readonly deckPanners: [StereoPannerNode, StereoPannerNode]
  private readonly deckOutputs: [GainNode, GainNode]
  private readonly deckDelaySends: [GainNode, GainNode]
  private readonly deckReverbSends: [GainNode, GainNode]
  private activeSamples = new Map<number, Set<AudioBufferSourceNode>>()
  private warpedBuffers = new Map<string, AudioBuffer>()

  constructor(
    private readonly context: BaseAudioContext,
    destination: AudioNode,
    private project: ProjectState,
  ) {
    this.masterInput = context.createGain()
    this.masterHeadroom = context.createGain()
    this.masterHeadroom.gain.value = 0.76
    this.drive = context.createWaveShaper()
    this.drive.curve = makeSaturationCurve(1024, 0)
    this.drive.oversample = '4x'
    this.masterFilter = context.createBiquadFilter()
    this.masterFilter.type = 'lowpass'
    this.harshnessFilter = context.createBiquadFilter()
    this.harshnessFilter.type = 'peaking'
    this.harshnessFilter.frequency.value = 3200
    this.harshnessFilter.Q.value = 0.82
    this.airFilter = context.createBiquadFilter()
    this.airFilter.type = 'lowpass'
    this.airFilter.frequency.value = 20_000
    this.airFilter.Q.value = 0.5
    this.compressor = context.createDynamicsCompressor()
    this.compressor.threshold.value = -18
    this.compressor.knee.value = 12
    this.compressor.ratio.value = 4
    this.compressor.attack.value = 0.006
    this.compressor.release.value = 0.18
    this.masterGain = context.createGain()
    this.limiter = context.createWaveShaper()
    this.limiter.curve = makeLimiterCurve(1024)
    this.limiter.oversample = '4x'
    this.analyser = context.createAnalyser()
    this.analyser.fftSize = 256
    this.analyser.smoothingTimeConstant = 0.72
    this.repeatDry = context.createGain()
    this.beatRepeatInput = context.createGain()
    this.beatRepeatDelay = context.createDelay(2)
    this.beatRepeatFeedback = context.createGain()
    this.beatRepeatWet = context.createGain()
    this.masterInput.connect(this.repeatDry).connect(this.masterFilter)
    this.masterInput.connect(this.beatRepeatInput).connect(this.beatRepeatDelay)
    this.beatRepeatDelay.connect(this.beatRepeatFeedback).connect(this.beatRepeatDelay)
    this.beatRepeatDelay.connect(this.beatRepeatWet).connect(this.masterFilter)
    this.masterFilter.connect(this.harshnessFilter).connect(this.airFilter).connect(this.masterHeadroom).connect(this.drive).connect(this.compressor).connect(this.masterGain).connect(this.limiter).connect(this.analyser).connect(destination)

    this.delayInput = context.createGain()
    this.delay = context.createDelay(2)
    this.delayFeedback = context.createGain()
    this.delayWet = context.createGain()
    this.delayInput.connect(this.delay)
    this.delay.connect(this.delayFeedback).connect(this.delay)
    this.delay.connect(this.delayWet).connect(this.masterInput)

    this.reverbInput = context.createGain()
    const convolver = context.createConvolver()
    convolver.buffer = makeImpulse(context, 1.65, 2.6)
    this.reverbTone = context.createBiquadFilter()
    this.reverbTone.type = 'lowpass'
    this.reverbWet = context.createGain()
    this.reverbInput.connect(convolver).connect(this.reverbTone).connect(this.reverbWet).connect(this.masterInput)
    this.noiseBuffer = makeNoise(context, 2)
    this.metallicBuffer = makeMetallicCymbal(context, 2)
    this.sourceBuses = Array.from({ length: 6 }, () => {
      const input = context.createGain()
      const low = context.createBiquadFilter()
      const mid = context.createBiquadFilter()
      const high = context.createBiquadFilter()
      const output = context.createGain()
      low.type = 'lowshelf'
      low.frequency.value = 130
      mid.type = 'peaking'
      mid.frequency.value = 1050
      mid.Q.value = 0.72
      high.type = 'highshelf'
      high.frequency.value = 6800
      input.connect(low).connect(mid).connect(high).connect(output).connect(this.masterInput)
      return { input, low, mid, high, output }
    })
    const deckNodes = [0, 1].map(() => {
      const input = context.createGain()
      const highpass = context.createBiquadFilter()
      const lowpass = context.createBiquadFilter()
      const low = context.createBiquadFilter()
      const mid = context.createBiquadFilter()
      const high = context.createBiquadFilter()
      const panner = context.createStereoPanner()
      const output = context.createGain()
      const delaySend = context.createGain()
      const reverbSend = context.createGain()
      highpass.type = 'highpass'
      lowpass.type = 'lowpass'
      low.type = 'lowshelf'; low.frequency.value = 130
      mid.type = 'peaking'; mid.frequency.value = 1050; mid.Q.value = 0.72
      high.type = 'highshelf'; high.frequency.value = 6800
      input.connect(highpass).connect(lowpass).connect(low).connect(mid).connect(high).connect(panner).connect(output).connect(this.masterInput)
      output.connect(delaySend).connect(this.delayInput)
      output.connect(reverbSend).connect(this.reverbInput)
      return { input, highpass, lowpass, low, mid, high, panner, output, delaySend, reverbSend }
    })
    this.deckInputs = [deckNodes[0].input, deckNodes[1].input]
    this.deckHighpass = [deckNodes[0].highpass, deckNodes[1].highpass]
    this.deckLowpass = [deckNodes[0].lowpass, deckNodes[1].lowpass]
    this.deckLow = [deckNodes[0].low, deckNodes[1].low]
    this.deckMid = [deckNodes[0].mid, deckNodes[1].mid]
    this.deckHigh = [deckNodes[0].high, deckNodes[1].high]
    this.deckPanners = [deckNodes[0].panner, deckNodes[1].panner]
    this.deckOutputs = [deckNodes[0].output, deckNodes[1].output]
    this.deckDelaySends = [deckNodes[0].delaySend, deckNodes[1].delaySend]
    this.deckReverbSends = [deckNodes[0].reverbSend, deckNodes[1].reverbSend]
    this.updateProject(project)
  }

  updateProject(project: ProjectState): void {
    this.project = project
    const now = this.context.currentTime
    this.masterGain.gain.setTargetAtTime(clamp(project.master), now, 0.015)
    const compression = unit(project.compressor)
    const smooth = project.smoothOutput
    const soften = smooth ? unit(project.softenAmount) : 0
    this.masterHeadroom.gain.setTargetAtTime(0.76 - soften * 0.1, now, 0.02)
    this.drive.curve = makeSaturationCurve(1024, unit(project.masterDrive) * (1 - soften * 0.85))
    this.limiter.curve = makeLimiterCurve(1024, smooth ? 0.94 : 0.84)
    this.masterFilter.frequency.setTargetAtTime(300 + Math.pow(unit(project.filterCutoff), 1.6) * 19_000, now, 0.02)
    this.masterFilter.Q.setTargetAtTime(0.3 + unit(project.filterResonance) * 14, now, 0.02)
    this.harshnessFilter.gain.setTargetAtTime(-5 * soften, now, 0.025)
    this.airFilter.frequency.setTargetAtTime(20_000 - 10_000 * soften, now, 0.025)
    this.compressor.threshold.setTargetAtTime(-7 - compression * 25, now, 0.02)
    this.compressor.knee.setTargetAtTime(18 - compression * 8, now, 0.02)
    this.compressor.ratio.setTargetAtTime(1.5 + compression * 7.5, now, 0.02)
    this.compressor.attack.setTargetAtTime(0.022 - compression * 0.017, now, 0.02)
    this.compressor.release.setTargetAtTime(0.11 + compression * 0.22, now, 0.02)
    this.delay.delayTime.setTargetAtTime(tempoDelaySeconds(project.tempo, project.delayTime), now, 0.02)
    this.delayInput.gain.setTargetAtTime(project.effectsEnabled ? 1 : 0, now, 0.01)
    this.reverbInput.gain.setTargetAtTime(project.effectsEnabled ? 1 : 0, now, 0.01)
    this.delayFeedback.gain.setTargetAtTime(project.effectsEnabled ? unit(project.delayFeedback) * 0.72 : 0, now, 0.02)
    this.delayWet.gain.setTargetAtTime(project.effectsEnabled ? unit(project.delayMix) * 0.82 : 0, now, 0.01)
    this.reverbWet.gain.setTargetAtTime(project.effectsEnabled ? unit(project.reverbMix) * 0.72 : 0, now, 0.01)
    this.reverbTone.frequency.setTargetAtTime(1200 + Math.pow(unit(project.reverbTone), 1.5) * 13_000, now, 0.02)
    const repeatMix = unit(project.performance.beatRepeatMix)
    const repeatActive = project.effectsEnabled && project.performance.beatRepeat
    this.beatRepeatDelay.delayTime.setTargetAtTime(beatRepeatSeconds(project), now, 0.008)
    this.beatRepeatInput.gain.setTargetAtTime(repeatActive ? 1 : 0, now, 0.006)
    this.beatRepeatFeedback.gain.setTargetAtTime(repeatActive ? 0.35 + unit(project.performance.beatRepeatDecay) * 0.59 : 0, now, 0.006)
    this.beatRepeatWet.gain.setTargetAtTime(repeatActive ? repeatMix * 0.88 : 0, now, 0.006)
    this.repeatDry.gain.setTargetAtTime(repeatActive ? 1 - repeatMix * 0.38 : 1, now, 0.006)
    const deckCrossfade = crossfaderGains(project.crossfader)
    project.decks.forEach((deck, index) => {
      const filter = clamp(deck.filter, -100, 100) / 100
      const highpass = filter < 0 ? 20 * 2 ** (-filter * 8) : 20
      const lowpass = filter > 0 ? 20_000 * 2 ** (-filter * 6) : 20_000
      this.deckHighpass[index].frequency.setTargetAtTime(highpass, now, 0.012)
      this.deckLowpass[index].frequency.setTargetAtTime(lowpass, now, 0.012)
      this.deckHighpass[index].Q.setTargetAtTime(0.7 + Math.abs(filter) * 5, now, 0.012)
      this.deckLowpass[index].Q.setTargetAtTime(0.7 + Math.abs(filter) * 5, now, 0.012)
      this.deckLow[index].gain.setTargetAtTime((deck.eqLow - 50) * 0.3, now, 0.012)
      this.deckMid[index].gain.setTargetAtTime((deck.eqMid - 50) * 0.3, now, 0.012)
      this.deckHigh[index].gain.setTargetAtTime((deck.eqHigh - 50) * 0.3, now, 0.012)
      this.deckPanners[index].pan.setTargetAtTime(clamp(deck.pan / 100, -1, 1), now, 0.012)
      this.deckOutputs[index].gain.setTargetAtTime(isMixerChannelAudible(project, { kind: 'deck', index: index as 0 | 1 }) ? unit(deck.gain) * deckCrossfade[index] : 0, now, 0.008)
      this.deckDelaySends[index].gain.setTargetAtTime(unit(deck.delay) * 0.62, now, 0.012)
      this.deckReverbSends[index].gain.setTargetAtTime(unit(deck.reverb) * 0.62, now, 0.012)
    })
    const [sourceA, sourceB] = crossfaderGains(project.crossfader)
    this.sourceBuses.forEach((bus, index) => {
      const settings = index < 2 ? project.bass[index] : index < 4 ? project.rhythms[index - 2] : index === 4 ? project.waveDesigner : project.sampler
      bus.low.gain.setTargetAtTime((settings.eqLow - 50) * 0.3, now, 0.012)
      bus.mid.gain.setTargetAtTime((settings.eqMid - 50) * 0.3, now, 0.012)
      bus.high.gain.setTargetAtTime((settings.eqHigh - 50) * 0.3, now, 0.012)
      const audible = index === 5 ? isMixerChannelAudible(project, { kind: 'sampler' }) : true
      bus.output.gain.setTargetAtTime(audible ? (index < 2 ? sourceA : index < 4 ? sourceB : 1) : 0, now, 0.008)
    })
  }

  connectDeck(index: number, source: AudioNode): void {
    source.connect(this.deckInputs[index === 1 ? 1 : 0])
  }

  getOutputLevel(): number {
    const samples = new Uint8Array(this.analyser.fftSize)
    this.analyser.getByteTimeDomainData(samples)
    let energy = 0
    for (const sample of samples) {
      const normalized = (sample - 128) / 128
      energy += normalized * normalized
    }
    return clamp(Math.sqrt(energy / samples.length) * 3.2)
  }

  getWaveform(): number[] {
    const samples = new Uint8Array(96)
    this.analyser.fftSize = 256
    const full = new Uint8Array(this.analyser.fftSize)
    this.analyser.getByteTimeDomainData(full)
    for (let index = 0; index < samples.length; index += 1) samples[index] = full[Math.floor(index * full.length / samples.length)]
    return Array.from(samples, (sample) => (sample - 128) / 128)
  }

  getGainReduction(): number {
    return clamp(Math.abs(this.compressor.reduction) / 24)
  }

  triggerBass(index: number, step: BassStep, time: number, duration: number, preview = false, nextStep?: BassStep): void {
    const voice = this.project.bass[index]
    if (!voice || !isMixerChannelAudible(this.project, { kind: 'bass', index: index as 0 | 1 }) || (!step.active && !preview)) return
    const accent = step.accent ? unit(voice.accent) : 0
    const frequency = midiToHz(step.note + step.octave * 12 + voice.tune * 0.12)
    const oscillatorMix = this.context.createGain()
    const oscillators: Array<{ node: OscillatorNode; ratio: number }> = []
    const dcBlocker = this.context.createBiquadFilter()
    const filterA = this.context.createBiquadFilter()
    const filterB = this.context.createBiquadFilter()
    const amp = this.context.createGain()
    const warmth = this.context.createWaveShaper()
    const panner = this.context.createStereoPanner()
    if (voice.oscSource === 'designer') {
      const spread = unit(voice.designerSpread) * 28
      ;[-spread, 0, spread].forEach((detune, oscillatorIndex) => {
        const node = this.context.createOscillator()
        const level = this.context.createGain()
        node.type = voice.designerWaveform
        node.frequency.setValueAtTime(frequency, time)
        node.detune.value = detune
        level.gain.value = oscillatorIndex === 1 ? 0.46 : 0.27
        node.connect(level).connect(oscillatorMix)
        oscillators.push({ node, ratio: 1 })
      })
    } else {
      const oscillator = this.context.createOscillator()
      const oscillatorBody = this.context.createOscillator()
      const bodyGain = this.context.createGain()
      oscillator.type = voice.waveform
      oscillator.frequency.setValueAtTime(frequency, time)
      oscillator.connect(oscillatorMix)
      oscillatorBody.type = 'sine'
      oscillatorBody.frequency.setValueAtTime(frequency / 2, time)
      bodyGain.gain.value = step.note + step.octave * 12 <= 48 ? 0.17 : 0.06
      oscillatorBody.connect(bodyGain).connect(oscillatorMix)
      oscillators.push({ node: oscillator, ratio: 1 }, { node: oscillatorBody, ratio: 0.5 })
    }
    dcBlocker.type = 'highpass'
    dcBlocker.frequency.value = 24
    dcBlocker.Q.value = 0.55
    if (step.slide && nextStep) {
      const target = midiToHz(nextStep.note + nextStep.octave * 12 + voice.tune * 0.12)
      oscillators.forEach(({ node, ratio }) => {
        node.frequency.setValueAtTime(frequency * ratio, time + duration * 0.45)
        node.frequency.exponentialRampToValueAtTime(target * ratio, time + duration * 1.05)
      })
    }

    const cutoff = 55 + Math.pow(unit(voice.cutoff), 2.15) * 6800
    const envAmount = 1 + unit(voice.envMod) * 8
    const peak = Math.min(15000, cutoff * envAmount * (1 + accent * 0.45))
    const decay = 0.055 + unit(voice.decay) * 0.72
    ;[filterA, filterB].forEach((filter, filterIndex) => {
      filter.type = 'lowpass'
      filter.Q.value = 1.5 + unit(voice.resonance) * (filterIndex ? 13 : 19)
      filter.frequency.setValueAtTime(peak, time)
      filter.frequency.exponentialRampToValueAtTime(Math.max(45, cutoff), time + decay)
    })
    amp.gain.setValueAtTime(0.0001, time)
    amp.gain.exponentialRampToValueAtTime((0.11 + accent * 0.13) * unit(voice.level), time + 0.004)
    const noteLength = step.slide ? duration * 1.92 : duration * 0.88
    amp.gain.setValueAtTime(Math.max(0.025, 0.08 * unit(voice.level)), time + Math.min(noteLength * 0.6, decay))
    amp.gain.exponentialRampToValueAtTime(0.0001, time + noteLength)
    warmth.curve = makeSaturationCurve(512, unit(voice.drive))
    warmth.oversample = '4x'
    panner.pan.value = clamp(voice.pan / 100, -1, 1)
    oscillatorMix.connect(dcBlocker).connect(filterA).connect(filterB).connect(amp).connect(warmth).connect(panner)
    this.route(panner, index, unit(voice.delay) * 0.7, unit(voice.reverb) * 0.6)
    oscillators.forEach(({ node }) => {
      node.start(time)
      node.stop(time + noteLength + 0.04)
    })
  }

  triggerDrum(name: DrumName, time: number, velocity = 1, machineIndex = 0): void {
    const machine = this.project.rhythms[machineIndex]
    const baseVoice = machine.drums[name]
    const voice: RoutedDrumVoice = {
      ...baseVoice,
      pan: clamp(baseVoice.pan + machine.pan, -100, 100),
      machineIndex,
      machineDelay: machine.delay,
      machineReverb: machine.reverb,
    }
    const level = unit(voice.level) * unit(machine.level) * clamp(velocity, 0, 1.3)
    if (level <= 0 || !isMixerChannelAudible(this.project, { kind: 'drum', machineIndex: machineIndex as 0 | 1, name })) return
    switch (name) {
      case 'kick': this.kick(time, voice, level, machine.kit); break
      case 'snare': this.snare(time, voice, level, machine.kit); break
      case 'clap': this.clap(time, voice, level); break
      case 'closedHat': this.hat(time, voice, level, false, machine.kit, machineIndex); break
      case 'openHat': this.hat(time, voice, level, true, machine.kit, machineIndex); break
      case 'lowTom': this.tom(time, voice, level, 92); break
      case 'midTom': this.tom(time, voice, level, 132); break
      case 'highTom': this.tom(time, voice, level, 188); break
      case 'rim': this.rim(time, voice, level); break
      case 'cowbell': this.cowbell(time, voice, level); break
    }
  }

  triggerWave(step: BassStep, time: number, duration: number, preview = false): void {
    const voice = this.project.waveDesigner
    if (!isMixerChannelAudible(this.project, { kind: 'wave' }) || (!step.active && !preview)) return
    const frequency = midiToHz(step.note + step.octave * 12 + voice.tune * 0.12)
    const oscillatorMix = this.context.createGain()
    const filter = this.context.createBiquadFilter()
    const amp = this.context.createGain()
    const warmth = this.context.createWaveShaper()
    const panner = this.context.createStereoPanner()
    const accent = step.accent ? 1.2 : 1
    const attack = 0.003 + unit(voice.attack) * 0.28
    const release = 0.04 + unit(voice.release) * 0.82
    const gate = Math.max(attack + 0.02, duration * (step.slide ? 1.8 : 0.9))
    const cutoff = 90 + Math.pow(unit(voice.cutoff), 1.7) * 15_000
    const spread = unit(voice.spread) * 28

    ;[-spread, 0, spread].forEach((detune, index) => {
      const oscillator = this.context.createOscillator()
      const level = this.context.createGain()
      oscillator.type = voice.waveform
      oscillator.frequency.setValueAtTime(frequency, time)
      oscillator.detune.value = detune
      level.gain.value = index === 1 ? 0.46 : 0.27
      oscillator.connect(level).connect(oscillatorMix)
      oscillator.start(time)
      oscillator.stop(time + gate + release + 0.03)
    })

    filter.type = 'lowpass'
    filter.Q.value = 0.5 + unit(voice.resonance) * 15
    filter.frequency.setValueAtTime(Math.min(18_000, cutoff * (step.accent ? 1.45 : 1.12)), time)
    filter.frequency.exponentialRampToValueAtTime(Math.max(80, cutoff), time + attack + 0.08)
    const peak = Math.max(0.0001, unit(voice.level) * 0.16 * accent)
    amp.gain.setValueAtTime(0.0001, time)
    amp.gain.exponentialRampToValueAtTime(peak, time + attack)
    amp.gain.setValueAtTime(peak * 0.68, time + gate)
    amp.gain.exponentialRampToValueAtTime(0.0001, time + gate + release)
    warmth.curve = makeSaturationCurve(512, unit(voice.drive))
    warmth.oversample = '4x'
    panner.pan.value = clamp(voice.pan / 100, -1, 1)
    oscillatorMix.connect(filter).connect(amp).connect(warmth).connect(panner)
    this.route(panner, 4, unit(voice.delay) * 0.62, unit(voice.reverb) * 0.62)
  }

  private route(source: AudioNode, channelIndex: number | null, delayAmount = 0, reverbAmount = 0): void {
    let sendMultiplier = 1
    if (channelIndex !== null) {
      const [deckA, deckB] = crossfaderGains(this.project.crossfader)
      sendMultiplier = channelIndex < 2 ? deckA : channelIndex < 4 ? deckB : 1
      source.connect(this.sourceBuses[channelIndex].input)
    } else {
      source.connect(this.masterInput)
    }
    if (delayAmount > 0) {
      const send = this.context.createGain()
      send.gain.value = delayAmount * sendMultiplier
      source.connect(send).connect(this.delayInput)
    }
    if (reverbAmount > 0) {
      const send = this.context.createGain()
      send.gain.value = reverbAmount * sendMultiplier
      source.connect(send).connect(this.reverbInput)
    }
  }

  private pan(source: AudioNode, voice: RoutedDrumVoice, delay = 0, reverb = 0.03): void {
    const panner = this.context.createStereoPanner()
    panner.pan.value = clamp(voice.pan / 100, -1, 1)
    source.connect(panner)
    const delaySend = clamp(delay + unit(voice.delay) * 0.62 + unit(voice.machineDelay) * 0.28)
    const reverbSend = clamp(reverb + unit(voice.reverb) * 0.62 + unit(voice.machineReverb) * 0.28)
    this.route(panner, 2 + voice.machineIndex, delaySend, reverbSend)
  }

  private kick(time: number, voice: RoutedDrumVoice, level: number, kit: '808' | '909'): void {
    const osc = this.context.createOscillator()
    const knock = this.context.createOscillator()
    const gain = this.context.createGain()
    const knockGain = this.context.createGain()
    const tone = this.context.createBiquadFilter()
    const is808 = kit === '808'
    const decay = (is808 ? 0.24 : 0.13) + unit(voice.decay) * (is808 ? 0.86 : 0.58)
    const base = (is808 ? 34 : 43) + unit(voice.tune) * (is808 ? 25 : 34)
    osc.type = 'sine'
    osc.frequency.setValueAtTime(base * 3.8, time)
    osc.frequency.exponentialRampToValueAtTime(base, time + 0.045)
    knock.type = 'triangle'
    knock.frequency.setValueAtTime(base * (is808 ? 2.1 : 2.8), time)
    knock.frequency.exponentialRampToValueAtTime(base * 1.1, time + 0.055)
    tone.type = 'lowpass'
    tone.frequency.value = 480 + unit(voice.tone) * 1600
    gain.gain.setValueAtTime(level * 0.95, time)
    gain.gain.exponentialRampToValueAtTime(0.0001, time + decay)
    knockGain.gain.setValueAtTime(level * (is808 ? 0.12 : 0.22), time)
    knockGain.gain.exponentialRampToValueAtTime(0.0001, time + (is808 ? 0.11 : 0.075))
    osc.connect(tone).connect(gain)
    knock.connect(knockGain)
    this.pan(gain, voice)
    this.pan(knockGain, voice)
    if (!is808) {
      const click = this.noise(time, 0.018, 3200, 'highpass', level * 0.11)
      this.pan(click, voice)
    }
    osc.start(time)
    knock.start(time)
    osc.stop(time + decay + 0.02)
    knock.stop(time + 0.14)
  }

  private snare(time: number, voice: RoutedDrumVoice, level: number, kit: '808' | '909'): void {
    const is808 = kit === '808'
    const decay = 0.1 + unit(voice.decay) * (is808 ? 0.38 : 0.29)
    const noise = this.noise(time, decay, (is808 ? 720 : 1120) + unit(voice.tone) * 2600, 'highpass', level * (is808 ? 0.43 : 0.56))
    this.pan(noise, voice, 0.02, 0.1)
    const osc = this.context.createOscillator()
    const membrane = this.context.createOscillator()
    const gain = this.context.createGain()
    const membraneGain = this.context.createGain()
    osc.type = 'triangle'
    osc.frequency.value = (is808 ? 118 : 157) + unit(voice.tune) * 90
    membrane.type = 'sine'
    membrane.frequency.value = osc.frequency.value * (is808 ? 1.56 : 1.92)
    gain.gain.setValueAtTime(level * 0.32, time)
    gain.gain.exponentialRampToValueAtTime(0.0001, time + decay * 0.7)
    membraneGain.gain.setValueAtTime(level * (is808 ? 0.14 : 0.19), time)
    membraneGain.gain.exponentialRampToValueAtTime(0.0001, time + decay * 0.42)
    osc.connect(gain)
    membrane.connect(membraneGain)
    this.pan(gain, voice)
    this.pan(membraneGain, voice, 0.01, 0.045)
    osc.start(time)
    membrane.start(time)
    osc.stop(time + decay)
    membrane.stop(time + decay)
  }

  private clap(time: number, voice: RoutedDrumVoice, level: number): void {
    const decay = 0.13 + unit(voice.decay) * 0.35
    ;[0, 0.018, 0.035].forEach((offset, index) => {
      const burst = this.noise(time + offset, decay, 700 + unit(voice.tone) * 1200, 'bandpass', level * (index ? 0.3 : 0.43))
      this.pan(burst, voice, 0.05, 0.18)
    })
  }

  private hat(time: number, voice: RoutedDrumVoice, level: number, open: boolean, kit: '808' | '909', machineIndex: number): void {
    if (!open) {
      this.activeOpenHats[machineIndex].forEach((gain) => {
        gain.gain.cancelScheduledValues(time)
        gain.gain.setTargetAtTime(0.0001, time, 0.004)
      })
      this.activeOpenHats[machineIndex] = []
    }
    const decay = open ? 0.18 + unit(voice.decay) * 0.62 : 0.025 + unit(voice.decay) * 0.11
    const kitOffset = kit === '909' ? 900 : 0
    const noise = this.noise(time, decay, 5200 + kitOffset + unit(voice.tone) * 4500, 'highpass', level * (kit === '909' ? 0.32 : 0.25))
    if (open) this.activeOpenHats[machineIndex].push(noise)
    this.pan(noise, voice, open ? 0.05 : 0.01, open ? 0.16 : 0.04)
    const metallic = this.context.createBufferSource()
    const metallicFilter = this.context.createBiquadFilter()
    const metallicGain = this.context.createGain()
    metallicFilter.type = 'highpass'
    metallicFilter.frequency.value = kit === '909' ? 6900 : 5400
    metallicGain.gain.setValueAtTime(level * (open ? 0.035 : 0.055), time)
    metallicGain.gain.exponentialRampToValueAtTime(0.0001, time + decay)
    metallic.buffer = this.metallicBuffer
    metallic.playbackRate.value = kit === '909' ? 1.13 : 1
    metallic.connect(metallicFilter).connect(metallicGain)
    this.pan(metallicGain, voice, open ? 0.04 : 0.008, open ? 0.12 : 0.025)
    metallic.start(time)
    metallic.stop(time + decay + 0.01)
  }

  private tom(time: number, voice: RoutedDrumVoice, level: number, root: number): void {
    const osc = this.context.createOscillator()
    const gain = this.context.createGain()
    const decay = 0.1 + unit(voice.decay) * 0.48
    const frequency = root * (0.72 + unit(voice.tune) * 0.6)
    osc.type = 'sine'
    osc.frequency.setValueAtTime(frequency * 1.4, time)
    osc.frequency.exponentialRampToValueAtTime(frequency, time + 0.035)
    gain.gain.setValueAtTime(level * 0.56, time)
    gain.gain.exponentialRampToValueAtTime(0.0001, time + decay)
    osc.connect(gain)
    this.pan(gain, voice, 0.01, 0.08)
    osc.start(time)
    osc.stop(time + decay + 0.02)
  }

  private rim(time: number, voice: RoutedDrumVoice, level: number): void {
    const osc = this.context.createOscillator()
    const filter = this.context.createBiquadFilter()
    const gain = this.context.createGain()
    osc.type = 'square'
    osc.frequency.value = 380 + unit(voice.tune) * 420
    filter.type = 'bandpass'
    filter.frequency.value = 950 + unit(voice.tone) * 900
    filter.Q.value = 5
    gain.gain.setValueAtTime(level * 0.28, time)
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.055)
    osc.connect(filter).connect(gain)
    this.pan(gain, voice, 0, 0.06)
    osc.start(time)
    osc.stop(time + 0.065)
  }

  private cowbell(time: number, voice: RoutedDrumVoice, level: number): void {
    const mix = this.context.createGain()
    const gain = this.context.createGain()
    const filter = this.context.createBiquadFilter()
    const decay = 0.08 + unit(voice.decay) * 0.38
    ;[540, 800].forEach((base) => {
      const osc = this.context.createOscillator()
      osc.type = 'square'
      osc.frequency.value = base * (0.8 + unit(voice.tune) * 0.4)
      osc.connect(mix)
      osc.start(time)
      osc.stop(time + decay)
    })
    filter.type = 'bandpass'
    filter.frequency.value = 1100 + unit(voice.tone) * 900
    filter.Q.value = 2
    gain.gain.setValueAtTime(level * 0.2, time)
    gain.gain.exponentialRampToValueAtTime(0.0001, time + decay)
    mix.connect(filter).connect(gain)
    this.pan(gain, voice, 0.04, 0.1)
  }

  triggerSample(slotIndex: number, buffer: AudioBuffer, time: number, velocity = 1, loopDuration?: number, pitchOffset = 0): void {
    const sampler = this.project.sampler
    const slot = sampler.slots[slotIndex]
    if (!slot || !isMixerChannelAudible(this.project, { kind: 'sampler' }) || slot.gain <= 0) return
    if (slot.chokeGroup > 0) sampler.slots.forEach((candidate, index) => {
      if (index !== slotIndex && candidate.chokeGroup === slot.chokeGroup) this.stopSample(index, time)
    })
    const warpRatio = slot.warp ? clamp(slot.sourceBpm / clamp(this.project.tempo, 40, 240), 0.4, 2.5) : 1
    const cacheKey = `${slotIndex}:${buffer.duration}:${slot.reverse}:${warpRatio.toFixed(3)}:${sampler.sampleRate}`
    let playable = this.warpedBuffers.get(cacheKey)
    if (!playable) {
      const oriented = slot.reverse ? reverseAudioBuffer(this.context, buffer) : buffer
      const stretched = Math.abs(warpRatio - 1) > 0.015 ? timeStretchBuffer(this.context, oriented, warpRatio) : oriented
      playable = sampler.sampleRate < 99 ? reduceSampleRateBuffer(this.context, stretched, sampler.sampleRate) : stretched
      this.warpedBuffers.set(cacheKey, playable)
    }
    const { start, end, rate } = samplePlaybackRegion({ ...slot, pitch: slot.pitch + pitchOffset }, playable.duration)
    const source = this.context.createBufferSource()
    const gain = this.context.createGain()
    const filter = this.context.createBiquadFilter()
    const crusher = this.context.createWaveShaper()
    const warmth = this.context.createWaveShaper()
    const panner = this.context.createStereoPanner()
    source.buffer = playable
    source.playbackRate.value = rate
    source.loop = slot.mode === 'loop'
    source.loopStart = start
    source.loopEnd = end
    const normalization = slot.normalize ? Math.min(4, 0.92 / Math.max(0.01, audioBufferPeak(playable))) : 1
    const peakGain = unit(slot.gain) * unit(sampler.level) * clamp(velocity, 0, 1.3) * normalization
    const playbackSeconds = (end - start) / rate
    const attack = Math.min(playbackSeconds * 0.45, 0.002 + unit(slot.attack) * 0.35)
    const release = Math.min(playbackSeconds * 0.45, 0.006 + unit(slot.release) * 0.8)
    gain.gain.setValueAtTime(0.0001, time)
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, peakGain), time + attack)
    panner.pan.value = clamp(sampler.pan / 100, -1, 1)
    filter.type = 'lowpass'
    filter.frequency.value = 500 + Math.pow(unit(slot.filter) * (0.24 + unit(sampler.sampleRate) * 0.76), 1.5) * 19_000
    filter.Q.value = 0.7
    crusher.curve = makeBitCrushCurve(2048, 4 + Math.round(unit(sampler.bitDepth) * 12))
    warmth.curve = makeSaturationCurve(512, unit(sampler.drive))
    warmth.oversample = '2x'
    source.connect(filter).connect(crusher).connect(warmth).connect(gain).connect(panner)
    this.route(panner, 5, unit(sampler.delay) * 0.62, unit(sampler.reverb) * 0.62)
    if (sampler.texture > 0) {
      const texture = this.context.createBufferSource()
      const textureGain = this.context.createGain()
      texture.buffer = this.noiseBuffer
      texture.loop = true
      textureGain.gain.value = unit(sampler.texture) * 0.018 * peakGain
      texture.connect(textureGain).connect(gain)
      texture.start(time)
      texture.stop(time + Math.min(playbackSeconds, loopDuration ?? playbackSeconds) + 0.02)
      const wobble = this.context.createOscillator()
      const wobbleDepth = this.context.createGain()
      wobble.type = 'sine'
      wobble.frequency.value = 0.35 + unit(sampler.texture) * 2.1
      wobbleDepth.gain.value = unit(sampler.texture) * 15
      wobble.connect(wobbleDepth).connect(source.detune)
      wobble.start(time)
      wobble.stop(time + Math.min(playbackSeconds, loopDuration ?? playbackSeconds) + 0.02)
    }
    const active = this.activeSamples.get(slotIndex) ?? new Set<AudioBufferSourceNode>()
    active.add(source)
    this.activeSamples.set(slotIndex, active)
    source.onended = () => active.delete(source)
    if (source.loop) {
      source.start(time, start)
      if (loopDuration !== undefined) {
        const releaseStart = Math.max(time + attack, time + loopDuration - release)
        gain.gain.setValueAtTime(Math.max(0.0001, peakGain), releaseStart)
        gain.gain.exponentialRampToValueAtTime(0.0001, time + loopDuration)
        source.stop(time + loopDuration + 0.002)
      }
    } else {
      const releaseStart = Math.max(time + attack, time + playbackSeconds - release)
      gain.gain.setValueAtTime(Math.max(0.0001, peakGain), releaseStart)
      gain.gain.exponentialRampToValueAtTime(0.0001, time + playbackSeconds)
      source.start(time, start, end - start)
    }
  }

  stopSample(slotIndex: number, time = this.context.currentTime): void {
    this.activeSamples.get(slotIndex)?.forEach((source) => {
      try { source.stop(time) } catch { /* source already stopped */ }
    })
    this.activeSamples.delete(slotIndex)
  }

  clearSampleCache(slotIndex: number): void {
    for (const key of this.warpedBuffers.keys()) if (key.startsWith(`${slotIndex}:`)) this.warpedBuffers.delete(key)
  }

  triggerPerformancePad(index: number, time: number): void {
    switch ((index % fxPadNames.length + fxPadNames.length) % fxPadNames.length) {
      case 0: this.impact(time); break
      case 1: this.riser(time); break
      case 2: this.laser(time); break
      case 3: this.dubSiren(time); break
      case 4: this.subDrop(time); break
      case 5: this.noiseHit(time); break
      case 6: this.vinylStop(time); break
      case 7: this.tapeStab(time); break
      case 8: this.airHorn(time); break
      case 9: this.vocalChop(time); break
      case 10: this.scratch(time); break
      case 11: this.bellHit(time); break
    }
  }

  private impact(time: number): void {
    const noise = this.noise(time, 0.82, 180, 'lowpass', 0.52)
    this.route(noise, null, 0.12, 0.42)
    const osc = this.context.createOscillator()
    const gain = this.context.createGain()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(92, time)
    osc.frequency.exponentialRampToValueAtTime(28, time + 0.72)
    gain.gain.setValueAtTime(0.64, time)
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.86)
    osc.connect(gain)
    this.route(gain, null, 0.08, 0.22)
    osc.start(time)
    osc.stop(time + 0.9)
  }

  private riser(time: number): void {
    const source = this.context.createBufferSource()
    const filter = this.context.createBiquadFilter()
    const gain = this.context.createGain()
    source.buffer = this.noiseBuffer
    source.loop = true
    filter.type = 'bandpass'
    filter.Q.value = 2.6
    filter.frequency.setValueAtTime(240, time)
    filter.frequency.exponentialRampToValueAtTime(9800, time + 1.45)
    gain.gain.setValueAtTime(0.0001, time)
    gain.gain.exponentialRampToValueAtTime(0.4, time + 1.32)
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 1.48)
    source.connect(filter).connect(gain)
    this.route(gain, null, 0.22, 0.35)
    source.start(time)
    source.stop(time + 1.5)
  }

  private laser(time: number): void {
    const osc = this.context.createOscillator()
    const gain = this.context.createGain()
    osc.type = 'sawtooth'
    osc.frequency.setValueAtTime(2100, time)
    osc.frequency.exponentialRampToValueAtTime(74, time + 0.34)
    gain.gain.setValueAtTime(0.22, time)
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.38)
    osc.connect(gain)
    this.route(gain, null, 0.55, 0.12)
    osc.start(time)
    osc.stop(time + 0.4)
  }

  private dubSiren(time: number): void {
    const carrier = this.context.createOscillator()
    const lfo = this.context.createOscillator()
    const modulation = this.context.createGain()
    const gain = this.context.createGain()
    carrier.type = 'square'
    carrier.frequency.value = 510
    lfo.type = 'sine'
    lfo.frequency.value = 5.2
    modulation.gain.value = 190
    lfo.connect(modulation).connect(carrier.frequency)
    gain.gain.setValueAtTime(0.0001, time)
    gain.gain.exponentialRampToValueAtTime(0.16, time + 0.025)
    gain.gain.setValueAtTime(0.16, time + 0.72)
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 1.08)
    carrier.connect(gain)
    this.route(gain, null, 0.48, 0.3)
    carrier.start(time)
    lfo.start(time)
    carrier.stop(time + 1.1)
    lfo.stop(time + 1.1)
  }

  private subDrop(time: number): void {
    const osc = this.context.createOscillator()
    const gain = this.context.createGain()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(118, time)
    osc.frequency.exponentialRampToValueAtTime(25, time + 0.95)
    gain.gain.setValueAtTime(0.68, time)
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 1.05)
    osc.connect(gain)
    this.route(gain, null, 0.03, 0.05)
    osc.start(time)
    osc.stop(time + 1.08)
  }

  private noiseHit(time: number): void {
    const source = this.context.createBufferSource()
    const filter = this.context.createBiquadFilter()
    const gain = this.context.createGain()
    source.buffer = this.noiseBuffer
    filter.type = 'bandpass'
    filter.Q.value = 0.65
    filter.frequency.setValueAtTime(7200, time)
    filter.frequency.exponentialRampToValueAtTime(420, time + 0.48)
    gain.gain.setValueAtTime(0.44, time)
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.52)
    source.connect(filter).connect(gain)
    this.route(gain, null, 0.18, 0.28)
    source.start(time)
    source.stop(time + 0.54)
  }

  private vinylStop(time: number): void {
    const osc = this.context.createOscillator()
    const gain = this.context.createGain()
    const filter = this.context.createBiquadFilter()
    osc.type = 'sawtooth'
    osc.frequency.setValueAtTime(118, time)
    osc.frequency.exponentialRampToValueAtTime(22, time + 0.82)
    filter.type = 'lowpass'
    filter.frequency.setValueAtTime(4200, time)
    filter.frequency.exponentialRampToValueAtTime(180, time + 0.78)
    gain.gain.setValueAtTime(0.22, time)
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.86)
    osc.connect(filter).connect(gain)
    this.route(gain, null, 0.18, 0.08)
    osc.start(time); osc.stop(time + 0.88)
  }

  private tapeStab(time: number): void {
    const filter = this.context.createBiquadFilter()
    const gain = this.context.createGain()
    filter.type = 'lowpass'; filter.frequency.value = 1800; filter.Q.value = 4.2
    gain.gain.setValueAtTime(0.0001, time)
    gain.gain.exponentialRampToValueAtTime(0.16, time + 0.008)
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.38)
    ;[146.83, 174.61, 220].forEach((frequency, index) => {
      const osc = this.context.createOscillator()
      osc.type = index === 1 ? 'square' : 'sawtooth'
      osc.frequency.value = frequency
      osc.detune.value = index * 5 - 5
      osc.connect(filter)
      osc.start(time); osc.stop(time + 0.4)
    })
    filter.connect(gain); this.route(gain, null, 0.34, 0.26)
  }

  private airHorn(time: number): void {
    const gain = this.context.createGain()
    const filter = this.context.createBiquadFilter()
    filter.type = 'bandpass'; filter.frequency.value = 540; filter.Q.value = 1.3
    gain.gain.setValueAtTime(0.0001, time)
    gain.gain.exponentialRampToValueAtTime(0.24, time + 0.018)
    gain.gain.setValueAtTime(0.2, time + 0.42)
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.72)
    ;[233.08, 293.66, 349.23].forEach((frequency, index) => {
      const osc = this.context.createOscillator()
      osc.type = 'sawtooth'; osc.frequency.value = frequency; osc.detune.value = index * 7
      osc.connect(filter); osc.start(time); osc.stop(time + 0.74)
    })
    filter.connect(gain); this.route(gain, null, 0.46, 0.32)
  }

  private vocalChop(time: number): void {
    const osc = this.context.createOscillator()
    const filter = this.context.createBiquadFilter()
    const gain = this.context.createGain()
    osc.type = 'sawtooth'; osc.frequency.value = 164.81
    filter.type = 'bandpass'; filter.Q.value = 7
    filter.frequency.setValueAtTime(720, time)
    filter.frequency.linearRampToValueAtTime(1250, time + 0.11)
    filter.frequency.linearRampToValueAtTime(540, time + 0.24)
    gain.gain.setValueAtTime(0.0001, time)
    gain.gain.exponentialRampToValueAtTime(0.2, time + 0.006)
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.13)
    gain.gain.setValueAtTime(0.0001, time + 0.145)
    gain.gain.exponentialRampToValueAtTime(0.15, time + 0.158)
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.29)
    osc.connect(filter).connect(gain); this.route(gain, null, 0.28, 0.38)
    osc.start(time); osc.stop(time + 0.31)
  }

  private scratch(time: number): void {
    const source = this.context.createBufferSource()
    const filter = this.context.createBiquadFilter()
    const gain = this.context.createGain()
    source.buffer = this.noiseBuffer
    filter.type = 'bandpass'; filter.Q.value = 6
    filter.frequency.setValueAtTime(900, time)
    filter.frequency.exponentialRampToValueAtTime(6200, time + 0.12)
    filter.frequency.exponentialRampToValueAtTime(480, time + 0.29)
    filter.frequency.exponentialRampToValueAtTime(4200, time + 0.43)
    gain.gain.setValueAtTime(0.0001, time)
    gain.gain.exponentialRampToValueAtTime(0.3, time + 0.01)
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.46)
    source.connect(filter).connect(gain); this.route(gain, null, 0.08, 0.16)
    source.start(time); source.stop(time + 0.48)
  }

  private bellHit(time: number): void {
    const gain = this.context.createGain()
    gain.gain.setValueAtTime(0.0001, time)
    gain.gain.exponentialRampToValueAtTime(0.22, time + 0.004)
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 1.3)
    ;[440, 1188, 2068].forEach((frequency, index) => {
      const osc = this.context.createOscillator()
      const partial = this.context.createGain()
      osc.type = 'sine'; osc.frequency.value = frequency
      partial.gain.value = 1 / (index + 1)
      osc.connect(partial).connect(gain); osc.start(time); osc.stop(time + 1.34)
    })
    this.route(gain, null, 0.44, 0.55)
  }

  private noise(time: number, duration: number, frequency: number, type: BiquadFilterType, level: number): GainNode {
    const source = this.context.createBufferSource()
    const filter = this.context.createBiquadFilter()
    const gain = this.context.createGain()
    source.buffer = this.noiseBuffer
    filter.type = type
    filter.frequency.value = frequency
    filter.Q.value = type === 'bandpass' ? 0.8 : 0.3
    const attack = Math.min(0.0015, duration * 0.12)
    gain.gain.setValueAtTime(0.0001, time)
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, level), time + attack)
    gain.gain.exponentialRampToValueAtTime(0.0001, time + duration)
    source.connect(filter).connect(gain)
    source.start(time)
    source.stop(time + duration + 0.01)
    return gain
  }
}

export interface LoadedAudioInfo {
  duration: number
  channels: number
  sampleRate: number
}

export interface DeckPlaybackState extends LoadedAudioInfo {
  loaded: boolean
  playing: boolean
  position: number
}

export interface ExportWavOptions {
  signal?: AbortSignal
  onProgress?: (completedBars: number, totalBars: number) => void
  bars?: number
}

type DeckRuntime = {
  buffer: AudioBuffer | null
  source: AudioBufferSourceNode | null
  sourceGain: GainNode | null
  playing: boolean
  offset: number
  startedAt: number
  rate: number
}

const emptyDeckRuntime = (): DeckRuntime => ({ buffer: null, source: null, sourceGain: null, playing: false, offset: 0, startedAt: 0, rate: 1 })

/** Browser audio engine with a drift-resistant look-ahead sequencer. */
export class GrooveEngine {
  private context: AudioContext | null = null
  private graph: AudioGraph | null = null
  private project: ProjectState = createDefaultProject()
  private timer: ReturnType<typeof setInterval> | null = null
  private nextStepTime = 0
  private step = 0
  private songBar = 0
  private paused = false
  private positioned = false
  private callbackTimers = new Set<ReturnType<typeof setTimeout>>()
  private decks: [DeckRuntime, DeckRuntime] = [emptyDeckRuntime(), emptyDeckRuntime()]
  private sampleBuffers = new Map<number, AudioBuffer>()
  private songSnapshot: { bar: number; project: ProjectState } | null = null

  constructor(private readonly onStep: StepListener = () => undefined) {}

  setProject(project: ProjectState): void {
    if (this.context) {
      this.decks.forEach((runtime, index) => {
        if (!runtime.source || !runtime.playing) return
        runtime.offset = this.deckPosition(index)
        runtime.startedAt = this.context!.currentTime
        const deck = project.decks[index]
        runtime.rate = deckPlaybackRate(deck)
        runtime.source.playbackRate.setTargetAtTime(runtime.rate, this.context!.currentTime, 0.012)
        const duration = runtime.buffer?.duration ?? 0
        const loopEnd = deck.loopEnd > deck.loopStart ? Math.min(duration, deck.loopEnd) : duration
        runtime.source.loop = deck.loop
        runtime.source.loopStart = Math.min(deck.loopStart, Math.max(0, loopEnd - 0.01))
        runtime.source.loopEnd = loopEnd
      })
    }
    this.project = project
    this.songSnapshot = null
    this.graph?.updateProject(project)
  }

  setTempo(tempo: number): void {
    this.setProject({ ...this.project, tempo: clamp(tempo, 40, 240) })
  }

  setSwing(swing: number): void {
    this.setProject({ ...this.project, swing: clamp(swing, 0, 75) })
  }

  getOutputLevel(): number {
    return this.graph?.getOutputLevel() ?? 0
  }

  getWaveform(): number[] {
    return this.graph?.getWaveform() ?? []
  }

  getGainReduction(): number {
    return this.graph?.getGainReduction() ?? 0
  }

  getTransportPosition(): { step: number; bar: number; songLength: number } {
    return { step: this.step, bar: this.songBar, songLength: this.project.songChain.length }
  }

  setSongPosition(bar: number, step = 0): void {
    this.songBar = Math.min(Math.max(0, Math.floor(bar)), Math.max(0, this.project.songChain.length - 1))
    this.step = Math.min(15, Math.max(0, Math.floor(step)))
    this.songSnapshot = null
    this.positioned = true
  }

  async start(): Promise<void> {
    this.ensureContext()
    await this.context!.resume()
    if (this.timer) return
    if (!this.paused && !this.positioned) {
      this.step = 0
      this.songBar = 0
    }
    this.paused = false
    this.positioned = false
    this.nextStepTime = this.context!.currentTime + 0.05
    this.timer = setInterval(() => this.scheduler(), LOOK_AHEAD_MS)
    this.scheduler()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.callbackTimers.forEach(clearTimeout)
    this.callbackTimers.clear()
    this.step = 0
    this.songBar = 0
    this.paused = false
    this.positioned = false
    this.onStep(-1)
  }

  pause(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.callbackTimers.forEach(clearTimeout)
    this.callbackTimers.clear()
    this.paused = true
  }

  async previewBass(voiceIndex: number, note: number): Promise<void> {
    this.ensureContext()
    await this.context!.resume()
    this.graph!.triggerBass(voiceIndex, { active: true, note, accent: false, slide: false, octave: 0 }, this.context!.currentTime + 0.008, 0.2, true)
  }

  async previewDrum(name: DrumName, machineIndex = 0): Promise<void> {
    this.ensureContext()
    await this.context!.resume()
    this.graph!.triggerDrum(name, this.context!.currentTime + 0.008, 1, machineIndex)
  }

  async previewWave(note: number): Promise<void> {
    this.ensureContext()
    await this.context!.resume()
    this.graph!.triggerWave({ active: true, note, accent: false, slide: false, octave: 0 }, this.context!.currentTime + 0.008, 0.35, true)
  }

  async triggerPerformancePad(index: number): Promise<void> {
    this.ensureContext()
    await this.context!.resume()
    this.graph!.triggerPerformancePad(index, this.context!.currentTime + 0.008)
  }

  /** Alias retained for integrations that call the pads preview controls. */
  async previewFxPad(index: number): Promise<void> {
    return this.triggerPerformancePad(index)
  }

  async loadDeck(index: number, data: ArrayBuffer | Blob): Promise<LoadedAudioInfo> {
    const deckIndex = index === 1 ? 1 : 0
    this.ensureContext()
    const bytes = data instanceof Blob ? await data.arrayBuffer() : data.slice(0)
    const buffer = await this.context!.decodeAudioData(bytes)
    this.pauseDeck(deckIndex)
    this.decks[deckIndex] = { ...emptyDeckRuntime(), buffer, offset: clamp(this.project.decks[deckIndex].cuePoint, 0, buffer.duration) }
    return audioInfo(buffer)
  }

  unloadDeck(index: number): void {
    const deckIndex = index === 1 ? 1 : 0
    this.pauseDeck(deckIndex)
    this.decks[deckIndex] = emptyDeckRuntime()
  }

  async playDeck(index: number): Promise<void> {
    const deckIndex = index === 1 ? 1 : 0
    this.ensureContext()
    await this.context!.resume()
    const runtime = this.decks[deckIndex]
    if (!runtime.buffer || runtime.playing) return
    this.startDeck(deckIndex, runtime.offset)
  }

  pauseDeck(index: number): void {
    const deckIndex = index === 1 ? 1 : 0
    const runtime = this.decks[deckIndex]
    if (!runtime.playing) return
    runtime.offset = this.deckPosition(deckIndex)
    runtime.playing = false
    const source = runtime.source
    const sourceGain = runtime.sourceGain
    runtime.source = null
    runtime.sourceGain = null
    if (source && sourceGain && this.context) {
      const stopAt = this.context.currentTime + 0.01
      sourceGain.gain.cancelScheduledValues(this.context.currentTime)
      sourceGain.gain.setTargetAtTime(0.0001, this.context.currentTime, 0.003)
      try { source.stop(stopAt) } catch { /* source already stopped */ }
    } else {
      try { source?.stop() } catch { /* source already stopped */ }
    }
  }

  cueDeck(index: number): void {
    const deckIndex = index === 1 ? 1 : 0
    this.pauseDeck(deckIndex)
    const duration = this.decks[deckIndex].buffer?.duration ?? 0
    this.decks[deckIndex].offset = clamp(this.project.decks[deckIndex].cuePoint, 0, duration)
  }

  async seekDeck(index: number, seconds: number): Promise<void> {
    const deckIndex = index === 1 ? 1 : 0
    const runtime = this.decks[deckIndex]
    const wasPlaying = runtime.playing
    this.pauseDeck(deckIndex)
    runtime.offset = clamp(seconds, 0, runtime.buffer?.duration ?? 0)
    if (wasPlaying) await this.playDeck(deckIndex)
  }

  /** Jog/scratch interaction. Positive deltas move forward, negative deltas rewind. */
  async jogDeck(index: number, deltaSeconds: number): Promise<void> {
    await this.seekDeck(index, this.deckPosition(index === 1 ? 1 : 0) + clamp(deltaSeconds, -5, 5))
  }

  async scratchDeck(index: number, deltaSeconds: number): Promise<void> {
    await this.jogDeck(index, deltaSeconds)
  }

  getDeckState(index: number): DeckPlaybackState {
    const deckIndex = index === 1 ? 1 : 0
    const runtime = this.decks[deckIndex]
    return {
      loaded: Boolean(runtime.buffer),
      playing: runtime.playing,
      position: this.deckPosition(deckIndex),
      duration: runtime.buffer?.duration ?? 0,
      channels: runtime.buffer?.numberOfChannels ?? 0,
      sampleRate: runtime.buffer?.sampleRate ?? 0,
    }
  }

  async loadSample(slotIndex: number, data: ArrayBuffer | Blob): Promise<LoadedAudioInfo> {
    this.ensureContext()
    const bytes = data instanceof Blob ? await data.arrayBuffer() : data.slice(0)
    const buffer = await this.context!.decodeAudioData(bytes)
    this.sampleBuffers.set(slotIndex, buffer)
    this.graph?.clearSampleCache(slotIndex)
    return audioInfo(buffer)
  }

  unloadSample(slotIndex: number): void {
    this.stopSample(slotIndex)
    this.sampleBuffers.delete(slotIndex)
    this.graph?.clearSampleCache(slotIndex)
  }

  async triggerSample(slotIndex: number, velocity = 1, pitchOffset = 0): Promise<void> {
    this.ensureContext()
    await this.context!.resume()
    const buffer = this.sampleBuffers.get(slotIndex)
    if (buffer) {
      const repeats = this.project.sampler.noteRepeat ? 4 : 1
      const interval = this.project.sampler.noteRepeat ? 60 / clamp(this.project.tempo, 40, 240) / this.project.sampler.noteRepeat : 0
      for (let repeat = 0; repeat < repeats; repeat += 1) this.graph!.triggerSample(slotIndex, buffer, this.context!.currentTime + 0.008 + repeat * interval, velocity, undefined, pitchOffset)
    }
  }

  stopSample(slotIndex: number): void {
    this.graph?.stopSample(slotIndex)
  }

  getSampleInfo(slotIndex: number): LoadedAudioInfo | null {
    const buffer = this.sampleBuffers.get(slotIndex)
    return buffer ? audioInfo(buffer) : null
  }

  getSampleWaveform(slotIndex: number, points = 160): number[] {
    const buffer = this.sampleBuffers.get(slotIndex)
    if (!buffer) return []
    const data = buffer.getChannelData(0)
    return Array.from({ length: points }, (_, point) => {
      const from = Math.floor(point * data.length / points)
      const to = Math.max(from + 1, Math.floor((point + 1) * data.length / points))
      let peak = 0
      for (let index = from; index < to; index += 1) peak = Math.max(peak, Math.abs(data[index]))
      return peak
    })
  }

  detectSampleSlices(slotIndex: number, count = 8): number[] {
    const buffer = this.sampleBuffers.get(slotIndex)
    if (!buffer) return []
    const data = buffer.getChannelData(0)
    const slices = [0]
    const search = Math.max(64, Math.floor(data.length / count / 3))
    for (let slice = 1; slice < count; slice += 1) {
      const center = Math.floor(data.length * slice / count)
      let best = center
      let energy = -1
      for (let index = Math.max(1, center - search); index < Math.min(data.length - 1, center + search); index += 32) {
        const transient = Math.abs(data[index] - data[index - 1]) + Math.abs(data[index]) * 0.35
        if (transient > energy) { energy = transient; best = index }
      }
      slices.push(best / data.length)
    }
    return [...slices, 1]
  }

  copySampleBuffer(from: number, to: number): void {
    const buffer = this.sampleBuffers.get(from)
    if (buffer) this.sampleBuffers.set(to, buffer)
  }

  exportDeckWav(index: number): Blob | null {
    const deckIndex = index === 1 ? 1 : 0
    const buffer = this.decks[deckIndex].buffer
    if (!buffer) return null
    const deck = this.project.decks[deckIndex]
    const start = Math.floor(clamp(deck.loop && deck.loopEnd > deck.loopStart ? deck.loopStart : 0, 0, buffer.duration) * buffer.sampleRate)
    const end = Math.max(start + 1, Math.floor(clamp(deck.loop && deck.loopEnd > deck.loopStart ? deck.loopEnd : buffer.duration, 0, buffer.duration) * buffer.sampleRate))
    const channels = [0, 1].map((channel) => buffer.getChannelData(Math.min(channel, buffer.numberOfChannels - 1)).slice(start, end))
    applyOutputCeiling(channels, -0.3)
    return new Blob([encodeWavChannels(channels, buffer.sampleRate)], { type: 'audio/wav' })
  }

  async exportWav(project: ProjectState, options: ExportWavOptions = {}): Promise<Blob> {
    if (typeof OfflineAudioContext === 'undefined') throw new Error('Offline audio export is not supported in this browser.')
    const bars = Math.max(1, Math.min(options.bars ?? (project.mode === 'song' ? project.songChain.length : 4), project.mode === 'song' ? project.songChain.length : 128))
    const secondsPerStep = 60 / clamp(project.tempo, 40, 240) / 4
    const rate = 44_100
    const tailSeconds = 2.2
    const barSeconds = STEPS * secondsPerStep
    const outputFrames = Math.ceil((bars * barSeconds + tailSeconds + 0.05) * rate)
    const output = [new Float32Array(outputFrames), new Float32Array(outputFrames)] as const
    // Keeping contexts small avoids Chrome's super-linear graph compilation cost on long arrangements.
    const barsPerChunk = 6
    const renderChunk = async (firstBar: number): Promise<{ firstBar: number; chunkBars: number; rendered: AudioBuffer }> => {
      if (options.signal?.aborted) throw new DOMException('WAV export was cancelled.', 'AbortError')
      const chunkBars = Math.min(barsPerChunk, bars - firstBar)
      const leadIn = firstBar === 0 ? 0.05 : 0.001
      const chunkDuration = chunkBars * barSeconds + tailSeconds + leadIn
      const offline = new OfflineAudioContext(2, Math.ceil(chunkDuration * rate), rate)
      const graph = new AudioGraph(offline, offline.destination, project)
      let time = leadIn
      let snapshot = project
      for (let localBar = 0; localBar < chunkBars; localBar += 1) {
        const songBar = firstBar + localBar
        snapshot = project.mode === 'song' ? projectAtSongBar(project, songBar) : project
        graph.updateProject(snapshot)
        if (project.mode === 'song') scheduleArrangementFx(graph, project, songBar, time)
        for (let step = 0; step < STEPS; step += 1) {
          schedulePatternStep(graph, snapshot, step, time, secondsPerStep, this.sampleBuffers)
          time += swungStepDuration(project, step)
        }
      }
      let rendered: AudioBuffer
      try {
        rendered = await offline.startRendering()
      } catch (error) {
        throw new Error(`WAV export failed while rendering bars ${firstBar + 1}-${firstBar + chunkBars}.`, { cause: error })
      }
      return { firstBar, chunkBars, rendered }
    }
    const chunkStarts = Array.from({ length: Math.ceil(bars / barsPerChunk) }, (_, index) => index * barsPerChunk)
    const renderConcurrency = 2
    let completedBars = 0
    for (let batch = 0; batch < chunkStarts.length; batch += renderConcurrency) {
      const results = await Promise.all(chunkStarts.slice(batch, batch + renderConcurrency).map(renderChunk))
      for (const { firstBar, chunkBars, rendered } of results) {
        const outputOffset = Math.round(firstBar * barSeconds * rate)
        for (let channel = 0; channel < 2; channel += 1) {
          const input = rendered.getChannelData(channel)
          const available = Math.min(input.length, output[channel].length - outputOffset)
          for (let frame = 0; frame < available; frame += 1) output[channel][outputOffset + frame] += input[frame]
        }
        completedBars += chunkBars
        options.onProgress?.(completedBars, bars)
      }
      // Yield so progress paints and cancellation/user input remain responsive between chunks.
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    }
    applyOutputCeiling(output, -0.3)
    return new Blob([encodeWavChannels(output, rate)], { type: 'audio/wav' })
  }

  dispose(): void {
    this.stop()
    const context = this.context
    this.context = null
    this.graph = null
    this.decks.forEach((_, index) => this.pauseDeck(index))
    this.decks = [emptyDeckRuntime(), emptyDeckRuntime()]
    this.sampleBuffers.clear()
    if (context && context.state !== 'closed') void context.close()
  }

  private ensureContext(): void {
    if (this.context) return
    const AudioContextClass = globalThis.AudioContext
    if (!AudioContextClass) throw new Error('Web Audio is not supported in this browser.')
    this.context = new AudioContextClass({ latencyHint: 'interactive' })
    this.graph = new AudioGraph(this.context, this.context.destination, this.project)
  }

  private scheduler(): void {
    if (!this.context || !this.graph) return
    while (this.nextStepTime < this.context.currentTime + SCHEDULE_AHEAD_SECONDS) {
      const scheduledStep = this.step
      const scheduledBar = this.songBar
      const scheduledTime = this.nextStepTime
      const duration = 60 / clamp(this.project.tempo, 40, 240) / 4
      if (this.project.mode === 'song' && (!this.songSnapshot || this.songSnapshot.bar !== this.songBar)) {
        this.songSnapshot = { bar: this.songBar, project: projectAtSongBar(this.project, this.songBar) }
      }
      const snapshot = this.project.mode === 'song' ? this.songSnapshot!.project : this.project
      if (scheduledStep === 0) this.graph.updateProject(snapshot)
      if (this.project.mode === 'song' && scheduledStep === 0) scheduleArrangementFx(this.graph, this.project, this.songBar, scheduledTime)
      schedulePatternStep(this.graph, snapshot, scheduledStep, scheduledTime, duration, this.sampleBuffers)
      const delay = Math.max(0, (scheduledTime - this.context.currentTime) * 1000)
      const callback = setTimeout(() => {
        this.callbackTimers.delete(callback)
        this.onStep(scheduledStep, scheduledBar)
      }, delay)
      this.callbackTimers.add(callback)
      this.nextStepTime += swungStepDuration(this.project, scheduledStep)
      this.step = (this.step + 1) % STEPS
      if (this.step === 0 && this.project.mode === 'song') this.songBar = (this.songBar + 1) % Math.max(1, this.project.songChain.length)
    }
  }

  private startDeck(index: 0 | 1, offset: number): void {
    if (!this.context || !this.graph) return
    const runtime = this.decks[index]
    const buffer = runtime.buffer
    if (!buffer) return
    const settings = this.project.decks[index]
    const source = this.context.createBufferSource()
    const sourceGain = this.context.createGain()
    const loopEnd = settings.loopEnd > settings.loopStart ? Math.min(buffer.duration, settings.loopEnd) : buffer.duration
    const loopStart = Math.min(settings.loopStart, Math.max(0, loopEnd - 0.01))
    source.buffer = buffer
    source.loop = settings.loop
    source.loopStart = loopStart
    source.loopEnd = loopEnd
    runtime.rate = deckPlaybackRate(settings)
    source.playbackRate.value = runtime.rate
    runtime.source = source
    runtime.sourceGain = sourceGain
    runtime.playing = true
    runtime.startedAt = this.context.currentTime
    runtime.offset = clamp(offset, 0, Math.max(0, buffer.duration - 0.001))
    sourceGain.gain.setValueAtTime(0.0001, this.context.currentTime)
    sourceGain.gain.exponentialRampToValueAtTime(1, this.context.currentTime + 0.008)
    source.connect(sourceGain)
    this.graph.connectDeck(index, sourceGain)
    source.onended = () => {
      if (runtime.source !== source) return
      runtime.source = null
      runtime.sourceGain = null
      runtime.playing = false
      runtime.offset = clamp(settings.cuePoint, 0, buffer.duration)
    }
    source.start(this.context.currentTime + 0.008, runtime.offset)
  }

  private deckPosition(index: number): number {
    const runtime = this.decks[index === 1 ? 1 : 0]
    const duration = runtime.buffer?.duration ?? 0
    if (!runtime.playing || !this.context) return clamp(runtime.offset, 0, duration)
    let position = runtime.offset + (this.context.currentTime - runtime.startedAt) * runtime.rate
    const settings = this.project.decks[index === 1 ? 1 : 0]
    if (settings.loop) {
      const end = settings.loopEnd > settings.loopStart ? Math.min(duration, settings.loopEnd) : duration
      const start = Math.min(settings.loopStart, Math.max(0, end - 0.01))
      const length = end - start
      if (length > 0 && position >= end) position = start + ((position - start) % length)
    }
    return clamp(position, 0, duration)
  }
}

function projectAtSongBar(project: ProjectState, bar: number): ProjectState {
  const source = isAuthoredDubstepArrangement(project) ? applyDubstepBarAutomation(project, bar) : project
  const cue = source.songChain[bar % Math.max(1, source.songChain.length)] ?? { bass: [0, 0], drums: [0, 0] }
  return {
    ...source,
    bass: source.bass.map((voice, index) => ({ ...voice, steps: voice.patterns[cue.bass[index]] ?? voice.steps })) as [BassVoice, BassVoice],
    rhythms: source.rhythms.map((machine, index) => ({ ...machine, steps: machine.patterns[cue.drums[index]] ?? machine.steps })) as ProjectState['rhythms'],
  }
}

function isAuthoredDubstepArrangement(project: ProjectState): boolean {
  if (project.songChain.length !== DUBSTEP_SONG_CHAIN.length) return false
  return project.songChain.every((cue, index) => cue.bass[0] === DUBSTEP_SONG_CHAIN[index].bass[0]
    && cue.bass[1] === DUBSTEP_SONG_CHAIN[index].bass[1]
    && cue.drums[0] === DUBSTEP_SONG_CHAIN[index].drums[0]
    && cue.drums[1] === DUBSTEP_SONG_CHAIN[index].drums[1])
}

function scheduleArrangementFx(graph: AudioGraph, project: ProjectState, bar: number, time: number): void {
  if (!project.demoAutoMix || !isAuthoredDubstepArrangement(project)) return
  const cue = DUBSTEP_AUTOMATION_FRAMES.find((frame) => frame.bar === bar + 1)?.fxPad
  if (cue) graph.triggerPerformancePad(fxPadNames.indexOf(cue), time)
}

export function createGrooveEngine(onStep?: StepListener): GrooveEngine {
  return new GrooveEngine(onStep)
}

function schedulePatternStep(
  graph: AudioGraph,
  project: ProjectState,
  step: number,
  time: number,
  duration: number,
  sampleBuffers: ReadonlyMap<number, AudioBuffer> = new Map(),
): void {
  project.bass.forEach((voice, index) => graph.triggerBass(index, voice.steps[step], time, duration, false, voice.steps[(step + 1) % STEPS]))
  graph.triggerWave(project.waveDesigner.steps[step], time, duration)
  project.rhythms.forEach((machine, machineIndex) => {
    drumNames.filter((name) => name !== 'openHat' && name !== 'closedHat').forEach((name) => {
      const hit = machine.steps[name][step]
      if (hit) graph.triggerDrum(name, time, hit === 2 ? 1.18 : 0.82, machineIndex)
    })
    const openHat = machine.steps.openHat[step]
    if (openHat) graph.triggerDrum('openHat', time, openHat === 2 ? 1.18 : 0.82, machineIndex)
    const closedHat = machine.steps.closedHat[step]
    if (closedHat) graph.triggerDrum('closedHat', time, closedHat === 2 ? 1.18 : 0.82, machineIndex)
  })
  project.sampler.slots.forEach((slot, slotIndex) => {
    const hit = slot.steps[step]
    const buffer = sampleBuffers.get(slotIndex)
    const probability = clamp((slot.stepProbabilities[step] ?? 100) / 100)
    if (hit && buffer && Math.random() <= probability) {
      const velocity = clamp((slot.stepVelocities[step] ?? 100) / 100 * (hit === 2 ? 1.16 : 1), 0.05, 1.3)
      const ratchets = Math.max(1, Math.min(4, Math.round(slot.stepRatchets[step] ?? 1)))
      const nudge = clamp(slot.stepNudges[step] ?? 0, -45, 45) / 1000
      for (let ratchet = 0; ratchet < ratchets; ratchet += 1) graph.triggerSample(slotIndex, buffer, time + nudge + ratchet * duration / ratchets, velocity, duration / ratchets * 0.92)
    }
  })
}

export function swungStepDuration(project: Pick<ProjectState, 'tempo' | 'swing'>, step: number): number {
  const base = 60 / clamp(project.tempo, 40, 240) / 4
  const swing = clamp(project.swing, 0, 75) / 100
  return base * (step % 2 === 0 ? 1 + swing : 1 - swing)
}

function makeNoise(context: BaseAudioContext, seconds: number): AudioBuffer {
  const buffer = context.createBuffer(1, Math.ceil(context.sampleRate * seconds), context.sampleRate)
  const data = buffer.getChannelData(0)
  let last = 0
  for (let i = 0; i < data.length; i += 1) {
    const white = Math.random() * 2 - 1
    last = last * 0.15 + white * 0.85
    data[i] = last
  }
  return buffer
}

/** Pre-bakes the six inharmonic square partials once instead of allocating six oscillators per hat hit. */
function makeMetallicCymbal(context: BaseAudioContext, seconds: number): AudioBuffer {
  const buffer = context.createBuffer(1, Math.ceil(context.sampleRate * seconds), context.sampleRate)
  const data = buffer.getChannelData(0)
  const frequencies = [355, 475.7, 536.1, 646.1, 766.8, 933.7]
  const phases = frequencies.map(() => 0)
  for (let sample = 0; sample < data.length; sample += 1) {
    let value = 0
    for (let partial = 0; partial < frequencies.length; partial += 1) {
      phases[partial] += frequencies[partial] / context.sampleRate
      phases[partial] %= 1
      value += phases[partial] < 0.5 ? 1 : -1
    }
    data[sample] = value / frequencies.length
  }
  return buffer
}

function makeImpulse(context: BaseAudioContext, seconds: number, decay: number): AudioBuffer {
  const length = Math.ceil(context.sampleRate * seconds)
  const impulse = context.createBuffer(2, length, context.sampleRate)
  for (let channel = 0; channel < 2; channel += 1) {
    const data = impulse.getChannelData(channel)
    let damped = 0
    for (let i = 0; i < length; i += 1) {
      const progress = i / length
      const white = Math.random() * 2 - 1
      const damping = 0.42 + progress * 0.5
      damped = damped * damping + white * (1 - damping)
      const diffusionFade = Math.min(1, i / Math.max(1, context.sampleRate * 0.012))
      data[i] = damped * diffusionFade * (1 - progress) ** decay * 0.86
    }
  }
  return impulse
}

/** Low-level signals stay linear; the wet amount progressively rounds louder peaks. */
export function makeSaturationCurve(size: number, amount: number): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(size)
  const mix = clamp(amount)
  const drive = 1 + mix * 7
  for (let i = 0; i < size; i += 1) {
    const x = (i * 2) / (size - 1) - 1
    const saturated = Math.tanh(x * drive) / Math.tanh(drive)
    curve[i] = x * (1 - mix) + saturated * mix
  }
  return curve
}

function makeLimiterCurve(size: number, threshold = 0.84): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(size)
  const ceiling = 0.985
  const normalization = 1 - Math.exp(-4)
  for (let index = 0; index < size; index += 1) {
    const input = index * 2 / (size - 1) - 1
    const magnitude = Math.abs(input)
    if (magnitude <= threshold) {
      curve[index] = input
      continue
    }
    const knee = (magnitude - threshold) / (1 - threshold)
    const limited = threshold + (ceiling - threshold) * (1 - Math.exp(-4 * knee)) / normalization
    curve[index] = Math.sign(input) * limited
  }
  return curve
}

export function makeBitCrushCurve(size: number, bits: number): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(size)
  const levels = 2 ** Math.max(2, Math.min(16, Math.round(bits)))
  for (let index = 0; index < size; index += 1) {
    const input = index / (size - 1) * 2 - 1
    curve[index] = Math.round(input * levels) / levels
  }
  return curve
}

function audioBufferPeak(buffer: AudioBuffer): number {
  let peak = 0
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const data = buffer.getChannelData(channel)
    for (let index = 0; index < data.length; index += 1) peak = Math.max(peak, Math.abs(data[index]))
  }
  return peak
}

/** Small overlap-add granular stretcher used for tempo matching without repitching. */
function timeStretchBuffer(context: BaseAudioContext, source: AudioBuffer, ratio: number): AudioBuffer {
  const outputLength = Math.max(1, Math.round(source.length * ratio))
  const output = context.createBuffer(source.numberOfChannels, outputLength, source.sampleRate)
  const grain = Math.max(256, Math.round(source.sampleRate * 0.045))
  const hopOut = Math.max(64, Math.floor(grain / 4))
  const hopIn = hopOut / ratio
  for (let channel = 0; channel < source.numberOfChannels; channel += 1) {
    const input = source.getChannelData(channel)
    const target = output.getChannelData(channel)
    const weights = new Float32Array(outputLength)
    for (let out = 0, cursor = 0; out < outputLength; out += hopOut, cursor += hopIn) {
      const start = Math.floor(cursor)
      for (let sample = 0; sample < grain && start + sample < input.length && out + sample < outputLength; sample += 1) {
        const window = 0.5 - 0.5 * Math.cos(2 * Math.PI * sample / Math.max(1, grain - 1))
        target[out + sample] += input[start + sample] * window
        weights[out + sample] += window
      }
    }
    for (let index = 0; index < target.length; index += 1) if (weights[index] > 0.001) target[index] /= weights[index]
  }
  return output
}

function reduceSampleRateBuffer(context: BaseAudioContext, source: AudioBuffer, amount: number): AudioBuffer {
  const output = context.createBuffer(source.numberOfChannels, source.length, source.sampleRate)
  const hold = 1 + Math.round((1 - unit(amount)) * 31)
  for (let channel = 0; channel < source.numberOfChannels; channel += 1) {
    const input = source.getChannelData(channel)
    const target = output.getChannelData(channel)
    let value = 0
    for (let index = 0; index < input.length; index += 1) {
      if (index % hold === 0) value = input[index]
      target[index] = value
    }
  }
  return output
}

function reverseAudioBuffer(context: BaseAudioContext, source: AudioBuffer): AudioBuffer {
  const output = context.createBuffer(source.numberOfChannels, source.length, source.sampleRate)
  for (let channel = 0; channel < source.numberOfChannels; channel += 1) {
    const input = source.getChannelData(channel)
    const target = output.getChannelData(channel)
    for (let index = 0; index < input.length; index += 1) target[index] = input[input.length - 1 - index]
  }
  return output
}

function audioInfo(buffer: AudioBuffer): LoadedAudioInfo {
  return { duration: buffer.duration, channels: buffer.numberOfChannels, sampleRate: buffer.sampleRate }
}

/** Applies a transparent final gain trim after overlapping chunk tails are summed. */
export function applyOutputCeiling(channels: readonly Float32Array[], ceilingDb = -0.3): number {
  let peak = 0
  for (const channel of channels) {
    for (let index = 0; index < channel.length; index += 1) peak = Math.max(peak, Math.abs(channel[index]))
  }
  const ceiling = 10 ** (ceilingDb / 20)
  const gain = peak > ceiling ? ceiling / peak : 1
  if (gain < 1) {
    for (const channel of channels) {
      for (let index = 0; index < channel.length; index += 1) channel[index] *= gain
    }
  }
  return gain
}

function encodeWavChannels(channelData: readonly Float32Array[], sampleRate: number): ArrayBuffer {
  const channels = Math.min(2, channelData.length)
  const frames = Math.min(...channelData.slice(0, channels).map((channel) => channel.length))
  const bytesPerSample = 2
  const output = new ArrayBuffer(44 + frames * channels * bytesPerSample)
  const view = new DataView(output)
  const write = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i))
  }
  write(0, 'RIFF')
  view.setUint32(4, output.byteLength - 8, true)
  write(8, 'WAVE')
  write(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, channels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * channels * bytesPerSample, true)
  view.setUint16(32, channels * bytesPerSample, true)
  view.setUint16(34, 16, true)
  write(36, 'data')
  view.setUint32(40, frames * channels * bytesPerSample, true)
  let offset = 44
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      // TPDF dither replaces correlated 16-bit truncation distortion with inaudible broadband noise.
      const dither = (Math.random() + Math.random() - 1) / 0x7fff
      const sample = clamp(channelData[channel][frame] + dither, -1, 1)
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
      offset += 2
    }
  }
  return output
}

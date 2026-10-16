import type { studio } from '@reborn/studio-core'
import { bitCrushCurve, clamp, midiToHz, reverseBuffer, saturationCurve } from './curves'

type AcidDevice = studio.AcidDevice
type WaveDevice = studio.WaveDevice
type DrumDevice = studio.DrumDevice
type SamplerDevice = studio.SamplerDevice
type DrumVoiceName = studio.DrumVoiceName
type DrumVoiceState = studio.DrumVoiceState

// Device voices ported from the v1 engine. Each voice builds a short-lived
// node chain at `time` and connects it to `output` (the track strip input).

export interface VoiceHost {
  context: BaseAudioContext
  noise: AudioBuffer
  metallic: AudioBuffer
}

const curveCache = new Map<string, Float32Array<ArrayBuffer>>()
function cached(key: string, make: () => Float32Array<ArrayBuffer>) {
  let curve = curveCache.get(key)
  if (!curve) {
    curve = make()
    curveCache.set(key, curve)
  }
  return curve
}
const drive = (amount: number) => cached(`sat:${amount.toFixed(2)}`, () => saturationCurve(amount, 512))

export function playAcid(host: VoiceHost, output: AudioNode, device: AcidDevice, time: number, duration: number, note: number, velocity: number, accentOn: boolean, slideTo: number | null): void {
  const ctx = host.context
  const accent = accentOn ? device.accent : 0
  const frequency = midiToHz(note + device.tune)
  const mix = ctx.createGain()
  const oscillators: { node: OscillatorNode; ratio: number }[] = []
  if (device.source === 'designer') {
    const spread = device.spread * 28
    ;[-spread, 0, spread].forEach((detune, index) => {
      const node = ctx.createOscillator()
      const level = ctx.createGain()
      node.type = device.designerWaveform
      node.frequency.setValueAtTime(frequency, time)
      node.detune.value = detune
      level.gain.value = index === 1 ? 0.46 : 0.27
      node.connect(level).connect(mix)
      oscillators.push({ node, ratio: 1 })
    })
  } else {
    const osc = ctx.createOscillator()
    const body = ctx.createOscillator()
    const bodyGain = ctx.createGain()
    osc.type = device.waveform
    osc.frequency.setValueAtTime(frequency, time)
    osc.connect(mix)
    body.type = 'sine'
    body.frequency.setValueAtTime(frequency / 2, time)
    bodyGain.gain.value = note <= 48 ? 0.17 : 0.06
    body.connect(bodyGain).connect(mix)
    oscillators.push({ node: osc, ratio: 1 }, { node: body, ratio: 0.5 })
  }
  if (slideTo !== null) {
    const target = midiToHz(slideTo + device.tune)
    for (const { node, ratio } of oscillators) {
      node.frequency.setValueAtTime(frequency * ratio, time + duration * 0.22)
      node.frequency.exponentialRampToValueAtTime(target * ratio, time + duration * 0.52)
    }
  }
  const dc = ctx.createBiquadFilter()
  dc.type = 'highpass'
  dc.frequency.value = 24
  dc.Q.value = 0.55
  const cutoff = 55 + device.cutoff ** 2.15 * 6800
  const peak = Math.min(15000, cutoff * (1 + device.envMod * 8) * (1 + accent * 0.45))
  const decay = 0.055 + device.decay * 0.72
  const filters = [ctx.createBiquadFilter(), ctx.createBiquadFilter()]
  filters.forEach((filter, index) => {
    filter.type = 'lowpass'
    filter.Q.value = 1.5 + device.resonance * (index ? 13 : 19)
    filter.frequency.setValueAtTime(peak, time)
    filter.frequency.exponentialRampToValueAtTime(Math.max(45, cutoff), time + decay)
  })
  const amp = ctx.createGain()
  const level = device.level * clamp(velocity / 100, 0.05, 1.27)
  const gate = slideTo !== null ? duration * 0.96 : duration * 0.88
  amp.gain.setValueAtTime(0.0001, time)
  amp.gain.exponentialRampToValueAtTime(Math.max(0.0001, (0.11 + accent * 0.13) * level), time + 0.004)
  amp.gain.setValueAtTime(Math.max(0.025, 0.08 * level), time + Math.min(gate * 0.6, decay))
  amp.gain.exponentialRampToValueAtTime(0.0001, time + gate)
  const warmth = ctx.createWaveShaper()
  warmth.curve = drive(device.drive)
  warmth.oversample = '4x'
  mix.connect(dc).connect(filters[0]).connect(filters[1]).connect(amp).connect(warmth).connect(output)
  for (const { node } of oscillators) {
    node.start(time)
    node.stop(time + gate + 0.04)
  }
}

export function playWave(host: VoiceHost, output: AudioNode, device: WaveDevice, time: number, duration: number, note: number, velocity: number, accent: boolean, sliding: boolean): void {
  const ctx = host.context
  const frequency = midiToHz(note + device.tune)
  const mix = ctx.createGain()
  const attack = 0.003 + device.attack * 0.28
  const release = 0.04 + device.release * 0.82
  const gate = Math.max(attack + 0.02, duration * (sliding ? 1.8 : 0.9))
  const cutoff = 90 + device.cutoff ** 1.7 * 15000
  const spread = device.spread * 28
  ;[-spread, 0, spread].forEach((detune, index) => {
    const osc = ctx.createOscillator()
    const level = ctx.createGain()
    osc.type = device.waveform
    osc.frequency.setValueAtTime(frequency, time)
    osc.detune.value = detune
    level.gain.value = index === 1 ? 0.46 : 0.27
    osc.connect(level).connect(mix)
    osc.start(time)
    osc.stop(time + gate + release + 0.03)
  })
  const filter = ctx.createBiquadFilter()
  filter.type = 'lowpass'
  filter.Q.value = 0.5 + device.resonance * 15
  filter.frequency.setValueAtTime(Math.min(18000, cutoff * (accent ? 1.45 : 1.12)), time)
  filter.frequency.exponentialRampToValueAtTime(Math.max(80, cutoff), time + attack + 0.08)
  const amp = ctx.createGain()
  const peak = Math.max(0.0001, device.level * 0.16 * (accent ? 1.2 : 1) * clamp(velocity / 100, 0.05, 1.27))
  amp.gain.setValueAtTime(0.0001, time)
  amp.gain.exponentialRampToValueAtTime(peak, time + attack)
  amp.gain.setValueAtTime(peak * 0.68, time + gate)
  amp.gain.exponentialRampToValueAtTime(0.0001, time + gate + release)
  const warmth = ctx.createWaveShaper()
  warmth.curve = drive(device.drive)
  warmth.oversample = '4x'
  mix.connect(filter).connect(amp).connect(warmth).connect(output)
}

function noiseBurst(host: VoiceHost, time: number, duration: number, frequency: number, type: BiquadFilterType, level: number): GainNode {
  const ctx = host.context
  const source = ctx.createBufferSource()
  const filter = ctx.createBiquadFilter()
  const gain = ctx.createGain()
  source.buffer = host.noise
  filter.type = type
  filter.frequency.value = frequency
  filter.Q.value = type === 'bandpass' ? 0.8 : 0.3
  gain.gain.setValueAtTime(0.0001, time)
  gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, level), time + Math.min(0.0015, duration * 0.12))
  gain.gain.exponentialRampToValueAtTime(0.0001, time + duration)
  source.connect(filter).connect(gain)
  // Start at a time-derived offset so consecutive hits do not sound identical,
  // while staying deterministic.
  source.start(time, (time * 7.31) % Math.max(0.01, host.noise.duration - duration - 0.02))
  source.stop(time + duration + 0.01)
  return gain
}

/** Open-hat gain nodes per track, so a closed hat can choke them. */
export type OpenHatRegistry = Map<string, GainNode[]>

export function playDrum(host: VoiceHost, output: AudioNode, device: DrumDevice, voiceName: DrumVoiceName, time: number, velocity: number, accent: boolean, chokeKey: string, openHats: OpenHatRegistry): void {
  const voice: DrumVoiceState = device.voices[voiceName]
  if (!voice || voice.mute) return
  const ctx = host.context
  const level = voice.level * device.level * clamp((velocity / 100) * (accent ? 1.18 : 0.82), 0, 1.4)
  if (level <= 0) return
  const panner = ctx.createStereoPanner()
  panner.pan.value = clamp(voice.pan, -1, 1)
  panner.connect(output)
  const is808 = device.kit === '808'
  const start = (node: OscillatorNode | AudioBufferSourceNode, stop: number) => {
    node.start(time)
    node.stop(time + stop)
  }
  switch (voiceName) {
    case 'kick': {
      const osc = ctx.createOscillator()
      const knock = ctx.createOscillator()
      const gain = ctx.createGain()
      const knockGain = ctx.createGain()
      const tone = ctx.createBiquadFilter()
      const decay = (is808 ? 0.24 : 0.13) + voice.decay * (is808 ? 0.86 : 0.58)
      const base = (is808 ? 34 : 43) + voice.tune * (is808 ? 25 : 34)
      osc.type = 'sine'
      osc.frequency.setValueAtTime(base * 3.8, time)
      osc.frequency.exponentialRampToValueAtTime(base, time + 0.045)
      knock.type = 'triangle'
      knock.frequency.setValueAtTime(base * (is808 ? 2.1 : 2.8), time)
      knock.frequency.exponentialRampToValueAtTime(base * 1.1, time + 0.055)
      tone.type = 'lowpass'
      tone.frequency.value = 480 + voice.tone * 1600
      gain.gain.setValueAtTime(level * 0.95, time)
      gain.gain.exponentialRampToValueAtTime(0.0001, time + decay)
      knockGain.gain.setValueAtTime(level * (is808 ? 0.12 : 0.22), time)
      knockGain.gain.exponentialRampToValueAtTime(0.0001, time + (is808 ? 0.11 : 0.075))
      osc.connect(tone).connect(gain).connect(panner)
      knock.connect(knockGain).connect(panner)
      if (!is808) noiseBurst(host, time, 0.018, 3200, 'highpass', level * 0.11).connect(panner)
      start(osc, decay + 0.02)
      start(knock, 0.14)
      break
    }
    case 'snare': {
      const decay = 0.1 + voice.decay * (is808 ? 0.38 : 0.29)
      noiseBurst(host, time, decay, (is808 ? 720 : 1120) + voice.tone * 2600, 'highpass', level * (is808 ? 0.43 : 0.56)).connect(panner)
      const osc = ctx.createOscillator()
      const membrane = ctx.createOscillator()
      const gain = ctx.createGain()
      const membraneGain = ctx.createGain()
      osc.type = 'triangle'
      osc.frequency.value = (is808 ? 118 : 157) + voice.tune * 90
      membrane.type = 'sine'
      membrane.frequency.value = osc.frequency.value * (is808 ? 1.56 : 1.92)
      gain.gain.setValueAtTime(level * 0.32, time)
      gain.gain.exponentialRampToValueAtTime(0.0001, time + decay * 0.7)
      membraneGain.gain.setValueAtTime(level * (is808 ? 0.14 : 0.19), time)
      membraneGain.gain.exponentialRampToValueAtTime(0.0001, time + decay * 0.42)
      osc.connect(gain).connect(panner)
      membrane.connect(membraneGain).connect(panner)
      start(osc, decay)
      start(membrane, decay)
      break
    }
    case 'clap': {
      const decay = 0.13 + voice.decay * 0.35
      ;[0, 0.018, 0.035].forEach((offset, index) => noiseBurst(host, time + offset, decay, 700 + voice.tone * 1200, 'bandpass', level * (index ? 0.3 : 0.43)).connect(panner))
      break
    }
    case 'closedHat':
    case 'openHat': {
      const open = voiceName === 'openHat'
      if (!open) {
        for (const gain of openHats.get(chokeKey) ?? []) {
          gain.gain.cancelScheduledValues(time)
          gain.gain.setTargetAtTime(0.0001, time, 0.004)
        }
        openHats.set(chokeKey, [])
      }
      const decay = open ? 0.18 + voice.decay * 0.62 : 0.025 + voice.decay * 0.11
      const noise = noiseBurst(host, time, decay, 5200 + (is808 ? 0 : 900) + voice.tone * 4500, 'highpass', level * (is808 ? 0.25 : 0.32))
      noise.connect(panner)
      if (open) openHats.set(chokeKey, [...(openHats.get(chokeKey) ?? []).slice(-3), noise])
      const metallic = ctx.createBufferSource()
      const metallicFilter = ctx.createBiquadFilter()
      const metallicGain = ctx.createGain()
      metallicFilter.type = 'highpass'
      metallicFilter.frequency.value = is808 ? 5400 : 6900
      metallicGain.gain.setValueAtTime(level * (open ? 0.035 : 0.055), time)
      metallicGain.gain.exponentialRampToValueAtTime(0.0001, time + decay)
      metallic.buffer = host.metallic
      metallic.playbackRate.value = is808 ? 1 : 1.13
      metallic.connect(metallicFilter).connect(metallicGain).connect(panner)
      if (open) openHats.set(chokeKey, [...(openHats.get(chokeKey) ?? []), metallicGain])
      start(metallic, decay + 0.01)
      break
    }
    case 'lowTom':
    case 'midTom':
    case 'highTom': {
      const root = voiceName === 'lowTom' ? 92 : voiceName === 'midTom' ? 132 : 188
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      const decay = 0.1 + voice.decay * 0.48
      const frequency = root * (0.72 + voice.tune * 0.6)
      osc.type = 'sine'
      osc.frequency.setValueAtTime(frequency * 1.4, time)
      osc.frequency.exponentialRampToValueAtTime(frequency, time + 0.035)
      gain.gain.setValueAtTime(level * 0.56, time)
      gain.gain.exponentialRampToValueAtTime(0.0001, time + decay)
      osc.connect(gain).connect(panner)
      start(osc, decay + 0.02)
      break
    }
    case 'rim': {
      const osc = ctx.createOscillator()
      const filter = ctx.createBiquadFilter()
      const gain = ctx.createGain()
      osc.type = 'square'
      osc.frequency.value = 380 + voice.tune * 420
      filter.type = 'bandpass'
      filter.frequency.value = 950 + voice.tone * 900
      filter.Q.value = 5
      gain.gain.setValueAtTime(level * 0.28, time)
      gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.055)
      osc.connect(filter).connect(gain).connect(panner)
      start(osc, 0.065)
      break
    }
    case 'cowbell': {
      const mix = ctx.createGain()
      const gain = ctx.createGain()
      const filter = ctx.createBiquadFilter()
      const decay = 0.08 + voice.decay * 0.38
      for (const base of [540, 800]) {
        const osc = ctx.createOscillator()
        osc.type = 'square'
        osc.frequency.value = base * (0.8 + voice.tune * 0.4)
        osc.connect(mix)
        start(osc, decay)
      }
      filter.type = 'bandpass'
      filter.frequency.value = 1100 + voice.tone * 900
      filter.Q.value = 2
      gain.gain.setValueAtTime(level * 0.2, time)
      gain.gain.exponentialRampToValueAtTime(0.0001, time + decay)
      mix.connect(filter).connect(gain).connect(panner)
      break
    }
  }
}

const reversed = new WeakMap<AudioBuffer, AudioBuffer>()

/** Active pad sources per track and pad, for choke groups and stop. */
export type PadRegistry = Map<string, Map<number, Set<AudioBufferSourceNode>>>

export function playPad(
  host: VoiceHost,
  output: AudioNode,
  device: SamplerDevice,
  trackId: string,
  padIndex: number,
  buffer: AudioBuffer,
  time: number,
  length: number,
  velocity: number,
  registry: PadRegistry,
): void {
  const ctx = host.context
  const levels = device.sixteenLevels
  // Sixteen Levels plays pad 1's sound on every pad with a graded parameter.
  const sourcePad = levels === 'off' ? padIndex : 0
  const pad = device.pads[sourcePad]
  if (!pad || pad.gain <= 0) return
  const grade = padIndex / 15
  const pitch = pad.pitch + (levels === 'pitch' ? padIndex - 8 : 0)
  const velocityScale = levels === 'velocity' ? 0.12 + grade * 0.88 : clamp(velocity / 100, 0.05, 1.27)
  const filterAmount = levels === 'filter' ? 0.1 + grade * 0.9 : pad.filter
  const trackPads = registry.get(trackId) ?? new Map<number, Set<AudioBufferSourceNode>>()
  registry.set(trackId, trackPads)
  if (pad.choke !== null) {
    device.pads.forEach((other, index) => {
      if (index === padIndex || other.choke !== pad.choke) return
      for (const source of trackPads.get(index) ?? []) {
        try {
          source.stop(time)
        } catch {
          // Already stopped.
        }
      }
      trackPads.delete(index)
    })
  }
  let playable = buffer
  if (pad.reverse) {
    playable = reversed.get(buffer) ?? reverseBuffer(ctx, buffer)
    reversed.set(buffer, playable)
  }
  const rate = 2 ** (clamp(pitch, -36, 36) / 12)
  const regionStart = clamp(pad.reverse ? 1 - pad.end : pad.start) * playable.duration
  const regionEnd = Math.max(regionStart + 0.005, clamp(pad.reverse ? 1 - pad.start : pad.end) * playable.duration)
  const source = ctx.createBufferSource()
  source.buffer = playable
  source.playbackRate.value = rate
  const filter = ctx.createBiquadFilter()
  filter.type = 'lowpass'
  filter.frequency.value = 500 + filterAmount ** 1.5 * 19000
  filter.Q.value = 0.7
  const gain = ctx.createGain()
  const peak = Math.max(0.0001, pad.gain * device.level * velocityScale)
  const regionSeconds = (regionEnd - regionStart) / rate
  const sustain = pad.mode === 'loop' ? Math.max(0.02, length) : regionSeconds
  const attack = Math.min(sustain * 0.45, 0.002 + pad.attack * 0.35)
  const release = Math.min(sustain * 0.45, 0.006 + pad.release * 0.8)
  gain.gain.setValueAtTime(0.0001, time)
  gain.gain.exponentialRampToValueAtTime(peak, time + attack)
  gain.gain.setValueAtTime(peak, Math.max(time + attack, time + sustain - release))
  gain.gain.exponentialRampToValueAtTime(0.0001, time + sustain)
  let chain: AudioNode = source.connect(filter)
  if (device.crush > 0.01) {
    const crusher = ctx.createWaveShaper()
    const bits = Math.round(16 - device.crush * 12)
    crusher.curve = cached(`crush:${bits}`, () => bitCrushCurve(bits))
    chain = chain.connect(crusher)
  }
  if (device.drive > 0.01) {
    const warmth = ctx.createWaveShaper()
    warmth.curve = drive(device.drive)
    warmth.oversample = '2x'
    chain = chain.connect(warmth)
  }
  chain.connect(gain).connect(output)
  const active = trackPads.get(padIndex) ?? new Set<AudioBufferSourceNode>()
  active.add(source)
  trackPads.set(padIndex, active)
  source.onended = () => active.delete(source)
  if (pad.mode === 'loop') {
    source.loop = true
    source.loopStart = regionStart
    source.loopEnd = regionEnd
    source.start(time, regionStart)
    source.stop(time + sustain + 0.005)
  } else {
    source.start(time, regionStart, regionEnd - regionStart)
  }
}

export function playAudioClip(host: VoiceHost, output: AudioNode, buffer: AudioBuffer, time: number, offsetSeconds: number, durationSeconds: number, gainDb: number, fadeInSeconds: number, fadeOutSeconds: number, startAt = 0): AudioBufferSourceNode | null {
  const ctx = host.context
  // When playback starts in the middle of a clip, skip into the audio.
  const skip = Math.max(0, startAt)
  const remaining = durationSeconds - skip
  const from = offsetSeconds + skip
  if (remaining <= 0.001 || from >= buffer.duration) return null
  const source = ctx.createBufferSource()
  const gain = ctx.createGain()
  source.buffer = buffer
  const peak = 10 ** (gainDb / 20)
  const fadeIn = Math.max(0.002, fadeInSeconds - skip)
  const fadeOut = Math.max(0.004, Math.min(fadeOutSeconds, remaining / 2))
  gain.gain.setValueAtTime(0, time)
  gain.gain.linearRampToValueAtTime(peak, time + Math.min(fadeIn, remaining / 2))
  gain.gain.setValueAtTime(peak, time + remaining - fadeOut)
  gain.gain.linearRampToValueAtTime(0, time + remaining)
  source.connect(gain).connect(output)
  source.start(time, from, Math.min(remaining, buffer.duration - from))
  return source
}

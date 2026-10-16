import {
  type AutomationChannel,
  type BassStep,
  type BassVoice,
  type DeckState,
  type DrumName,
  type ProjectState,
  type RhythmMachineState,
  type SamplerSlot,
  type SamplerState,
  type WaveDesignerState,
  applyChannelAutomation,
  drumNames,
} from '../model'
import { DUBSTEP_SONG_CHAIN, applyDubstepBarAutomation } from '../demo/dubstepDemo'
import {
  type AcidDevice,
  type Asset,
  type AutomationLane,
  type AutomationPoint,
  type Clip,
  type DeckDevice,
  type DrumDevice,
  type DrumHit,
  type DrumVoiceName,
  type NotePattern,
  type NoteStep,
  type PadHit,
  type PadPattern,
  type PadState,
  type ReturnBus,
  type SamplerDevice,
  type Scene,
  type Section,
  type StudioProject,
  type Track,
  type WaveDevice,
  DRUM_VOICES,
  TRACK_COLORS,
  clamp,
  createTrack,
  defaultPad,
  emptyDrumHit,
  emptyNoteStep,
  emptyStudioProject,
  macrosFor,
  newId,
} from './model'
import { makeClip } from './ops'

// Maps a v1 (RE:BORN 338) project onto the v2 track/pattern/clip model.
// The v1 project is never modified. Anything that cannot be represented
// exactly is listed in the report.

export interface ImportReport {
  /** Facts about how the project was mapped. */
  notes: string[]
  /** Places where the v2 result does not reproduce v1 exactly. */
  approximations: string[]
}

const u = (value: number) => clamp(value / 100, 0, 1)
const eqDb = (value: number) => clamp((value - 50) * 0.3, -12, 12)
const toDb = (gain: number) => (gain <= 0.001 ? -60 : clamp(20 * Math.log10(gain), -60, 6))
const DELAY_BEATS = [0.125, 0.25, 0.375, 0.5, 0.75, 1]
const bankName = (index: number) => `${'ABCD'[Math.floor(index / 8)] ?? 'X'}${(index % 8) + 1}`
const crossfade = (value: number): [number, number] => {
  const position = (clamp(value, -100, 100) + 100) / 200
  return [Math.cos((position * Math.PI) / 2), Math.sin((position * Math.PI) / 2)]
}

function isAuthoredDubstep(project: ProjectState): boolean {
  return (
    project.songChain.length === DUBSTEP_SONG_CHAIN.length &&
    project.songChain.every((cue, index) => cue.bass.every((v, i) => v === DUBSTEP_SONG_CHAIN[index].bass[i]) && cue.drums.every((v, i) => v === DUBSTEP_SONG_CHAIN[index].drums[i]))
  )
}

const noteSteps = (steps: BassStep[]): NoteStep[] =>
  steps.map((step) => (step.active ? { ...emptyNoteStep(step.note + step.octave * 12), on: true, accent: step.accent, slide: step.slide } : emptyNoteStep(step.note + step.octave * 12)))

function notePattern(name: string, steps: BassStep[]): NotePattern {
  return { id: newId('pat'), name, kind: 'notes', length: steps.length || 16, division: 16, swing: null, steps: noteSteps(steps) }
}

function drumPattern(name: string, rows: Record<DrumName, (0 | 1 | 2)[]>): ReturnType<typeof drumPatternBase> {
  return drumPatternBase(name, rows)
}

function drumPatternBase(name: string, rows: Record<DrumName, (0 | 1 | 2)[]>) {
  const length = Math.max(1, ...drumNames.map((n) => rows[n]?.length ?? 0))
  const lanes = Object.fromEntries(
    DRUM_VOICES.map((voice) => [voice, Array.from({ length }, (_, i): DrumHit => {
      const hit = rows[voice as DrumName]?.[i] ?? 0
      return { ...emptyDrumHit(), on: hit > 0, accent: hit === 2 }
    })]),
  ) as Record<DrumVoiceName, DrumHit[]>
  return { id: newId('pat'), name, kind: 'drums' as const, length, division: 16, swing: null, lanes }
}

function guessMime(name: string): string {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase()
  return ext === 'ogg' ? 'audio/ogg' : ext === 'mp3' ? 'audio/mpeg' : ext === 'flac' ? 'audio/flac' : ext === 'wav' ? 'audio/wav' : 'audio/*'
}

interface ChannelMap {
  trackId: string
  /** v1 key → [v2 param, convert]. */
  keys: Record<string, [string, (value: number) => number]>
}

export function importV1Project(source: ProjectState): { project: StudioProject; report: ImportReport } {
  const v1 = structuredClone(source)
  const report: ImportReport = { notes: [], approximations: [] }
  const project = emptyStudioProject(v1.name || 'Imported')
  project.tempo = clamp(v1.tempo, 40, 240)
  project.swing = clamp(v1.swing / 100, 0, 0.75)
  project.length = Math.max(1, v1.songChain.length)
  const returns = project.returns
  const delayOn = v1.effectsEnabled && v1.delayMix > 0
  const reverbOn = v1.effectsEnabled && v1.reverbMix > 0
  const globalDelay = delayOn ? 0.3 : 0
  const globalReverb = reverbOn ? 0.24 : 0
  const [deckA, deckB] = crossfade(v1.crossfader)
  if (v1.crossfader !== 0) report.approximations.push(`The crossfader at ${v1.crossfader} is baked into Acid, drum, and deck track volumes.`)
  if (v1.mode === 'pattern') report.notes.push('The project was in Pattern mode; its song chain still imports as the arrangement, and a “Current” scene holds the selected patterns.')

  returns.forEach((ret) => {
    if (ret.kind === 'delay') {
      ret.time = DELAY_BEATS[Math.round(u(v1.delayTime) * (DELAY_BEATS.length - 1))]
      ret.feedback = u(v1.delayFeedback) * 0.72
      ret.level = toDb(u(v1.delayMix) * 0.82)
      ret.mute = !v1.effectsEnabled
    } else {
      ret.decay = 2.2
      ret.tone = u(v1.reverbTone)
      ret.level = toDb(u(v1.reverbMix) * 0.72)
      ret.mute = !v1.effectsEnabled
    }
  })
  project.master = {
    // Both engines share the same 0.76 headroom stage, so the v1 master gain
    // carries over as is.
    volume: toDb(clamp(v1.master, 0, 1.5)),
    ceiling: -0.3,
    drive: u(v1.masterDrive),
    compress: u(v1.compressor),
    soften: v1.smoothOutput ? u(v1.softenAmount) : 0,
    fxSafeBypass: !v1.effectsEnabled,
  }
  if (v1.filterCutoff < 94 || v1.filterResonance > 11) report.approximations.push('The v1 master filter has no v2 equivalent and was dropped; use a track or group filter instead.')
  if (v1.performance.beatRepeat) report.approximations.push('Live Beat Repeat was on; it is a Perform-view effect in v2 and starts off.')

  const tracks: Track[] = []
  const channels = new Map<AutomationChannel, ChannelMap>()
  const color = () => TRACK_COLORS[tracks.length % TRACK_COLORS.length]
  const mixerKeys = (send: number): ChannelMap['keys'] => ({
    pan: ['mixer.pan', (v) => clamp(v / 100, -1, 1)],
    eqLow: ['insert.eqLow', eqDb],
    eqMid: ['insert.eqMid', eqDb],
    eqHigh: ['insert.eqHigh', eqDb],
    delay: ['send.delay', (v) => clamp(globalDelay + u(v) * send, 0, 1)],
    reverb: ['send.reverb', (v) => clamp(globalReverb + u(v) * send, 0, 1)],
  })
  const applyMixer = (track: Track, state: { pan: number; muted: boolean; solo: boolean; eqLow: number; eqMid: number; eqHigh: number; delay: number; reverb: number }, sendScale: number, crossGain = 1) => {
    // v1 applies the equal-power crossfader gain (−3 dB at center) to Acid,
    // drum, and deck buses; v2 has no crossfader, so it moves into volume.
    track.mixer.volume = toDb(crossGain)
    track.mixer.pan = clamp(state.pan / 100, -1, 1)
    track.mixer.mute = state.muted
    track.mixer.solo = state.solo
    track.inserts = { ...track.inserts, eqLow: eqDb(state.eqLow), eqMid: eqDb(state.eqMid), eqHigh: eqDb(state.eqHigh) }
    track.mixer.sends.delay = { level: clamp(globalDelay + u(state.delay) * sendScale, 0, 1), tap: 'post' }
    track.mixer.sends.reverb = { level: clamp(globalReverb + u(state.reverb) * sendScale, 0, 1), tap: 'post' }
  }

  // Acid Synths --------------------------------------------------------------
  const acidTracks = v1.bass.map((voice: BassVoice, index) => {
    const track = createTrack('acid', `Acid ${index + 1}`, color(), returns)
    const device: AcidDevice = {
      kind: 'acid',
      source: voice.oscSource,
      waveform: voice.waveform,
      designerWaveform: voice.designerWaveform,
      spread: u(voice.designerSpread),
      tune: clamp(voice.tune * 0.12, -12, 12),
      cutoff: u(voice.cutoff),
      resonance: u(voice.resonance),
      envMod: u(voice.envMod),
      decay: u(voice.decay),
      accent: u(voice.accent),
      drive: u(voice.drive),
      level: u(voice.level),
    }
    track.device = device
    applyMixer(track, voice, 0.7, deckA)
    tracks.push(track)
    channels.set(`bass-${index}` as AutomationChannel, {
      trackId: track.id,
      keys: {
        ...mixerKeys(0.7),
        cutoff: ['device.cutoff', u],
        resonance: ['device.resonance', u],
        envMod: ['device.envMod', u],
        decay: ['device.decay', u],
        accent: ['device.accent', u],
        drive: ['device.drive', u],
        level: ['device.level', u],
        designerSpread: ['device.spread', u],
        tune: ['device.tune', (v) => clamp(v * 0.12, -12, 12)],
      },
    })
    return track
  })

  // Wave Synth ---------------------------------------------------------------
  const waveVoice: WaveDesignerState = v1.waveDesigner
  const waveTrack = createTrack('wave', 'Wave', color(), returns)
  waveTrack.device = {
    kind: 'wave',
    waveform: waveVoice.waveform,
    spread: u(waveVoice.spread),
    tune: clamp(waveVoice.tune * 0.12, -12, 12),
    cutoff: u(waveVoice.cutoff),
    resonance: u(waveVoice.resonance),
    attack: u(waveVoice.attack),
    release: u(waveVoice.release),
    drive: u(waveVoice.drive),
    level: u(waveVoice.level),
  } satisfies WaveDevice
  applyMixer(waveTrack, waveVoice, 0.62)
  tracks.push(waveTrack)
  channels.set('wave', {
    trackId: waveTrack.id,
    keys: {
      ...mixerKeys(0.62),
      cutoff: ['device.cutoff', u],
      resonance: ['device.resonance', u],
      attack: ['device.attack', u],
      release: ['device.release', u],
      spread: ['device.spread', u],
      drive: ['device.drive', u],
      level: ['device.level', u],
      tune: ['device.tune', (v) => clamp(v * 0.12, -12, 12)],
    },
  })

  // Drum machines ------------------------------------------------------------
  const drumTracks = v1.rhythms.map((machine: RhythmMachineState, index) => {
    const track = createTrack('drum', machine.kit, color(), returns)
    const device: DrumDevice = {
      kind: 'drum',
      kit: machine.kit,
      level: u(machine.level),
      voices: Object.fromEntries(
        DRUM_VOICES.map((voice) => {
          const v = machine.drums[voice as DrumName]
          return [voice, { level: u(v.level), tone: u(v.tone), decay: u(v.decay), tune: u(v.tune), pan: clamp((v.pan + machine.pan) / 100, -1, 1), mute: v.muted }]
        }),
      ) as DrumDevice['voices'],
    }
    track.device = device
    const voiceDelay = drumNames.reduce((sum, n) => sum + u(machine.drums[n].delay), 0) / drumNames.length
    const voiceReverb = drumNames.reduce((sum, n) => sum + u(machine.drums[n].reverb), 0) / drumNames.length
    applyMixer(track, { ...machine, pan: 0, delay: 0, reverb: 0 }, 0, deckB)
    track.mixer.sends.delay.level = clamp(globalDelay + u(machine.delay) * 0.28 + voiceDelay * 0.62, 0, 1)
    track.mixer.sends.reverb.level = clamp(globalReverb + u(machine.reverb) * 0.28 + voiceReverb * 0.62, 0, 1)
    const spread = (key: 'delay' | 'reverb') => {
      const values = drumNames.map((n) => machine.drums[n][key])
      return Math.max(...values) - Math.min(...values)
    }
    if (spread('delay') > 5 || spread('reverb') > 5) report.approximations.push(`${machine.kit} per-voice echo and reverb sends were averaged into one track send.`)
    if (drumNames.some((n) => machine.drums[n].solo)) report.approximations.push(`${machine.kit} per-voice solo became a track solo.`)
    if (drumNames.some((n) => machine.drums[n].solo)) track.mixer.solo = true
    tracks.push(track)
    channels.set(`drums-${index}` as AutomationChannel, {
      trackId: track.id,
      keys: {
        eqLow: ['insert.eqLow', eqDb],
        eqMid: ['insert.eqMid', eqDb],
        eqHigh: ['insert.eqHigh', eqDb],
        level: ['device.level', u],
        ...Object.fromEntries(
          drumNames.flatMap((n) => [
            [`${n}.level`, [`voice.${n}.level`, u]],
            [`${n}.tone`, [`voice.${n}.tone`, u]],
            [`${n}.decay`, [`voice.${n}.decay`, u]],
            [`${n}.tune`, [`voice.${n}.tune`, u]],
            [`${n}.pan`, [`voice.${n}.pan`, (v: number) => clamp(v / 100, -1, 1)]],
          ]),
        ),
      },
    })
    return track
  })

  // Samplers -----------------------------------------------------------------
  const sampler: SamplerState = v1.sampler
  const usedSlot = (slot: SamplerSlot) => Boolean(slot.assetId) || slot.steps.some(Boolean)
  const banks = [sampler.slots.slice(0, 16), sampler.slots.slice(16, 32)].filter((bank, index) => index === 0 || bank.some(usedSlot))
  const assetIds = new Set<string>()
  const samplerTracks = banks.map((slots, bankIndex) => {
    const track = createTrack('sampler', bankIndex ? 'Sampler B' : 'Sampler', color(), returns)
    const pads: PadState[] = Array.from({ length: 16 }, (_, i) => {
      const slot = slots[i]
      if (!slot) return defaultPad(i)
      if (slot.assetId) assetIds.add(slot.assetId)
      return {
        name: slot.name || `Pad ${i + 1}`,
        assetId: slot.assetId,
        start: clamp(slot.trimStart, 0, 1),
        end: clamp(slot.trimEnd, 0, 1),
        pitch: clamp(slot.pitch, -24, 24),
        gain: u(slot.gain),
        reverse: slot.reverse,
        mode: slot.mode,
        attack: u(slot.attack),
        release: u(slot.release),
        choke: slot.chokeGroup > 0 ? slot.chokeGroup : null,
        filter: u(slot.filter),
      }
    })
    if (slots.some((slot) => slot.warp || slot.normalize)) report.approximations.push('Sample warp and normalize flags are not yet applied by the v2 sampler.')
    track.device = {
      kind: 'sampler',
      level: u(sampler.level),
      drive: u(sampler.drive),
      crush: 1 - u(sampler.bitDepth),
      sixteenLevels: sampler.sixteenLevels === 'off' ? 'off' : sampler.sixteenLevels,
      source: null,
      pads,
    } satisfies SamplerDevice
    applyMixer(track, sampler, 0.62)
    tracks.push(track)
    return { track, slots }
  })
  if (sampler.texture > 0 || sampler.sampleRate < 100) report.approximations.push('Sampler texture and sample-rate reduction were dropped; crush keeps the bit depth.')
  if (samplerTracks[0]) {
    channels.set('sampler', {
      trackId: samplerTracks[0].track.id,
      keys: {
        ...mixerKeys(0.62),
        level: ['device.level', u],
        drive: ['device.drive', u],
        bitDepth: ['device.crush', (v) => 1 - u(v)],
        ...Object.fromEntries(
          Array.from({ length: 16 }, (_, i) => [
            [`slots.${i}.gain`, [`pad.${i}.gain`, u]],
            [`slots.${i}.pitch`, [`pad.${i}.pitch`, (v: number) => clamp(v, -24, 24)]],
            [`slots.${i}.attack`, [`pad.${i}.attack`, u]],
            [`slots.${i}.release`, [`pad.${i}.release`, u]],
            [`slots.${i}.filter`, [`pad.${i}.filter`, u]],
          ]).flat(),
        ),
      },
    })
  }

  // Decks --------------------------------------------------------------------
  v1.decks.forEach((deck: DeckState, index) => {
    const track = createTrack('deck', `Deck ${'AB'[index]}`, color(), returns)
    if (deck.assetId) assetIds.add(deck.assetId)
    track.device = { kind: 'deck', assetId: deck.assetId, gain: u(deck.gain), pitch: clamp(deck.pitch, -12, 12), filter: clamp(deck.filter / 100, -1, 1), loop: deck.loop, loopStart: deck.loopStart, loopEnd: deck.loopEnd, cue: deck.cuePoint } satisfies DeckDevice
    applyMixer(track, deck, 0.62, index === 0 ? deckA : deckB)
    if (deck.rate !== 1) report.approximations.push(`Deck ${'AB'[index]} rate ${deck.rate}× was folded into its pitch.`)
    if (deck.rate !== 1) (track.device as DeckDevice).pitch = clamp(deck.pitch + 12 * Math.log2(deck.rate), -12, 12)
    tracks.push(track)
    channels.set(`deck-${index}` as AutomationChannel, {
      trackId: track.id,
      keys: { ...mixerKeys(0.62), gain: ['device.gain', u], pitch: ['device.pitch', (v) => clamp(v, -12, 12)], filter: ['device.filter', (v) => clamp(v / 100, -1, 1)] },
    })
  })
  report.notes.push('Decks import as Deck tracks for live play in Perform view, as in v1; they are not part of the arrangement.')

  for (const track of tracks) track.macros = macrosFor(track)
  project.tracks = tracks

  // Assets -------------------------------------------------------------------
  for (const id of assetIds) {
    const builtin = id.startsWith('builtin:')
    const name = builtin ? id.slice('builtin:'.length) : (v1.sampler.slots.find((s) => s.assetId === id)?.name ?? v1.decks.find((d) => d.assetId === id)?.name ?? id)
    const asset: Asset = { id, name, mimeType: guessMime(name), bytes: 0, duration: 0, channels: 2, sampleRate: 44100, origin: { kind: builtin ? 'builtin' : 'v1', source: id, createdAt: new Date().toISOString() } }
    project.assets[id] = asset
  }

  // Patterns and arrangement --------------------------------------------------
  const patterns: StudioProject['patterns'] = {}
  const bassPatternIds = acidTracks.map(() => new Map<number, string>())
  const drumPatternIds = drumTracks.map(() => new Map<number, string>())
  const bassPattern = (voice: number, index: number) => {
    const known = bassPatternIds[voice].get(index)
    if (known) return known
    const steps = v1.bass[voice].patterns[index] ?? v1.bass[voice].steps
    const pattern = notePattern(`${acidTracks[voice].name} ${bankName(index)}`, steps)
    patterns[pattern.id] = pattern
    bassPatternIds[voice].set(index, pattern.id)
    return pattern.id
  }
  const drumPatternId = (machine: number, index: number) => {
    const known = drumPatternIds[machine].get(index)
    if (known) return known
    const rows = v1.rhythms[machine].patterns[index] ?? v1.rhythms[machine].steps
    const pattern = drumPattern(`${drumTracks[machine].name} ${bankName(index)}`, rows)
    patterns[pattern.id] = pattern
    drumPatternIds[machine].set(index, pattern.id)
    return pattern.id
  }

  const clips: Clip[] = []
  const chain = v1.songChain.length ? v1.songChain : [{ bass: [0, 0] as [number, number], drums: [0, 0] as [number, number] }]
  const addRuns = (trackId: string, refs: string[]) => {
    let start = 0
    for (let bar = 1; bar <= refs.length; bar += 1) {
      if (bar === refs.length || refs[bar] !== refs[start]) {
        clips.push(makeClip(trackId, start, bar - start, { patternId: refs[start] }))
        start = bar
      }
    }
  }
  acidTracks.forEach((track, voice) => addRuns(track.id, chain.map((cue) => bassPattern(voice, cue.bass[voice]))))
  drumTracks.forEach((track, machine) => addRuns(track.id, chain.map((cue) => drumPatternId(machine, cue.drums[machine]))))

  const wavePattern = notePattern('Wave', v1.waveDesigner.steps)
  patterns[wavePattern.id] = wavePattern
  if (wavePattern.steps.some((s) => s.on)) clips.push(makeClip(waveTrack.id, 0, chain.length, { patternId: wavePattern.id }))

  const tempoStep = 60 / project.tempo / 4
  const samplerPatternIds = samplerTracks.map(({ track, slots }) => {
    const hits: PadHit[] = []
    slots.forEach((slot, pad) => {
      slot.steps.forEach((hit, step) => {
        if (!hit) return
        const velocity = clamp(Math.round(((slot.stepVelocities[step] ?? 100) / 100) * (hit === 2 ? 1.16 : 1) * 110), 1, 127)
        hits.push({
          step,
          pad,
          velocity,
          probability: clamp(slot.stepProbabilities[step] ?? 100, 0, 100),
          ratchet: clamp(Math.round(slot.stepRatchets[step] ?? 1), 1, 4),
          micro: clamp((slot.stepNudges[step] ?? 0) / 1000 / tempoStep, -0.5, 0.5),
          locks: {},
        })
      })
    })
    const pattern: PadPattern = { id: newId('pat'), name: `${track.name} pads`, kind: 'pads', length: 16, division: 16, swing: null, hits: hits.sort((a, z) => a.step - z.step || a.pad - z.pad) }
    patterns[pattern.id] = pattern
    if (hits.length) clips.push(makeClip(track.id, 0, chain.length, { patternId: pattern.id }))
    return pattern.id
  })

  project.patterns = patterns
  project.clips = clips

  // Sections and scenes ------------------------------------------------------
  const sceneMarks = [...v1.songScenes].sort((a, z) => a.start - z.start).filter((s) => s.start < chain.length)
  const sectionColors = ['#5d6e60', '#77704d', '#86574a', '#51616f', '#7a5a78', '#5f7a64']
  project.sections = sceneMarks.map<Section>((mark, index) => ({
    id: newId('sec'),
    name: mark.name,
    start: mark.start,
    length: (sceneMarks[index + 1]?.start ?? chain.length) - mark.start,
    color: sectionColors[index % sectionColors.length],
  }))
  const sceneAt = (name: string, cue: (typeof chain)[number]): Scene => ({
    id: newId('scn'),
    name,
    slots: {
      ...Object.fromEntries(acidTracks.map((t, voice) => [t.id, bassPattern(voice, cue.bass[voice])])),
      ...Object.fromEntries(drumTracks.map((t, machine) => [t.id, drumPatternId(machine, cue.drums[machine])])),
      ...(wavePattern.steps.some((s) => s.on) ? { [waveTrack.id]: wavePattern.id } : {}),
      ...Object.fromEntries(samplerTracks.map(({ track }, i) => [track.id, samplerPatternIds[i]])),
    },
  })
  project.scenes = sceneMarks.map((mark) => sceneAt(mark.name, chain[mark.start]))
  if (v1.mode === 'pattern') {
    const current = { bass: v1.bass.map((v) => v.bank * 8 + v.pattern) as [number, number], drums: v1.rhythms.map((m) => m.bank * 8 + m.pattern) as [number, number] }
    project.scenes.unshift(sceneAt('Current', current))
  }
  project.patterns = patterns

  // Automation ---------------------------------------------------------------
  project.automation = importAutomation(v1, channels, report)
  const authored = isAuthoredDubstep(v1)
  if (authored) report.notes.push('The demo’s scripted per-bar mix moves became arrangement automation.')

  report.notes.push(`Imported ${tracks.length} tracks, ${Object.keys(patterns).length} patterns, ${clips.length} clips, ${project.sections.length} sections, and ${project.automation.length} automation lanes.`)
  return { project, report }
}

function mappedValues(project: ProjectState, channels: Map<AutomationChannel, ChannelMap>): Map<string, number> {
  const values = new Map<string, number>()
  const read = (channel: AutomationChannel, key: string): unknown => {
    const [head, field] = key.split('.')
    if (channel.startsWith('bass')) return (project.bass[Number(channel.at(-1))] as unknown as Record<string, unknown>)[key]
    if (channel === 'wave') return (project.waveDesigner as unknown as Record<string, unknown>)[key]
    if (channel.startsWith('drums')) {
      const machine = project.rhythms[Number(channel.at(-1))]
      return field ? machine.drums[head as DrumName]?.[field as 'level'] : (machine as unknown as Record<string, unknown>)[key]
    }
    if (channel === 'sampler') {
      if (head === 'slots') {
        const [, slot, slotField] = key.split('.')
        return (project.sampler.slots[Number(slot)] as unknown as Record<string, unknown>)?.[slotField]
      }
      return (project.sampler as unknown as Record<string, unknown>)[key]
    }
    return (project.decks[Number(channel.at(-1))] as unknown as Record<string, unknown>)[key]
  }
  for (const [channel, map] of channels) {
    for (const [key, [param, convert]] of Object.entries(map.keys)) {
      const raw = read(channel, key)
      if (typeof raw === 'number') values.set(`${map.trackId}|${param}`, convert(raw))
    }
  }
  return values
}

function importAutomation(v1: ProjectState, channels: Map<AutomationChannel, ChannelMap>, report: ImportReport): AutomationLane[] {
  const authored = isAuthoredDubstep(v1)
  const bars = Math.max(1, v1.songChain.length)
  const stepKeys = new Set<string>()
  let dropped = 0
  for (const [channel, lane] of Object.entries(v1.channelAutomation) as [AutomationChannel, NonNullable<ProjectState['channelAutomation'][AutomationChannel]>][]) {
    const keys = channels.get(channel)?.keys ?? {}
    for (const patch of [...Object.values(lane.bars), ...Object.values(lane.steps)]) {
      for (const [key, value] of Object.entries(patch)) if (typeof value !== 'number' || !keys[key]) dropped += 1
    }
    Object.keys(lane.steps).forEach((position) => stepKeys.add(position))
  }
  if (dropped) report.approximations.push(`${dropped} automation values (mute, solo, or waveform switches) have no v2 automation target and were dropped.`)

  const base = mappedValues(v1, channels)
  const last = new Map(base)
  const points = new Map<string, AutomationPoint[]>()
  const emit = (key: string, bar: number, value: number) => {
    if (Math.abs((last.get(key) ?? NaN) - value) < 1e-9) return
    last.set(key, value)
    const list = points.get(key) ?? []
    if (!list.length) list.push({ bar: 0, value: base.get(key) ?? value, curve: 'hold' })
    list.push({ bar, value, curve: 'hold' })
    points.set(key, list)
  }
  for (let bar = 0; bar < bars; bar += 1) {
    const atBar = applyChannelAutomation(authored ? applyDubstepBarAutomation(v1, bar) : v1, bar, -1)
    const barValues = mappedValues(atBar, channels)
    for (let step = 0; step < 16; step += 1) {
      const values = stepKeys.has(`${bar}:${step}`) ? mappedValues(applyChannelAutomation(atBar, bar, step), channels) : barValues
      for (const [key, value] of values) emit(key, bar + step / 16, value)
      if (!stepKeys.has(`${bar}:${step}`) && step === 0) {
        // Bar values apply from the downbeat; skip the remaining steps unless a
        // later step in this bar has its own override.
        if (![...stepKeys].some((k) => k.startsWith(`${bar}:`))) break
      }
    }
  }
  return [...points.entries()].map(([key, list]) => {
    const [trackId, param] = key.split('|')
    return { id: newId('aut'), trackId, param, points: list }
  })
}

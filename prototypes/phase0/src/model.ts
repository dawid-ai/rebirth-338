// Phase 0 prototype model. It is deliberately small and audio-free: it
// exists to validate the v2 editing model (tracks, patterns, clips,
// sections, sends) before any of it moves into `studio-core`.

export type TrackKind = 'acid' | 'wave' | 'drum' | 'sampler'
export type BusId = 'delay' | 'reverb'
export type Origin = 'manual' | 'agent'
export type Band = 'sub' | 'bass' | 'lowMid' | 'mid' | 'harsh' | 'air'
export type SliceMode = 'transient' | 'equal' | 'beat' | 'bar'

export const BANDS: Band[] = ['sub', 'bass', 'lowMid', 'mid', 'harsh', 'air']
export const BAND_LABELS: Record<Band, string> = {
  sub: 'Sub',
  bass: 'Bass',
  lowMid: 'Low-mid',
  mid: 'Mid',
  harsh: 'Harsh',
  air: 'Air',
}

export interface Send {
  level: number
  tap: 'pre' | 'post'
}

export interface Track {
  id: string
  name: string
  kind: TrackKind
  device: string
  color: string
  volume: number
  pan: number
  mute: boolean
  solo: boolean
  sends: Record<BusId, Send>
  macros: number[]
}

export interface DelayBus {
  id: 'delay'
  name: string
  level: number
  mute: boolean
  feedback: number
  beats: number
}

export interface ReverbBus {
  id: 'reverb'
  name: string
  level: number
  mute: boolean
  decay: number
}

export interface NoteStep {
  on: boolean
  note: number
  accent: boolean
  slide: boolean
  velocity: number
  probability: number
  ratchet: number
}

export interface DrumLane {
  voice: string
  hits: number[]
}

export interface PadHit {
  step: number
  pad: number
  velocity: number
}

interface PatternBase {
  id: string
  name: string
  length: number
}

export type Pattern =
  | (PatternBase & { kind: 'notes'; steps: NoteStep[] })
  | (PatternBase & { kind: 'drums'; lanes: DrumLane[] })
  | (PatternBase & { kind: 'pads'; hits: PadHit[] })

export interface Clip {
  id: string
  trackId: string
  patternId: string
  start: number
  length: number
  offset: number
}

export interface Section {
  id: string
  name: string
  start: number
  length: number
  color: string
}

export interface Sample {
  id: string
  name: string
  seed: number
  bars: number
  bpm: number
  bpmConfidence: number
  key: string | null
  keyConfidence: number
  mode: SliceMode
  slices: number[]
  pads: (number | null)[]
}

export interface Project {
  name: string
  tempo: number
  swing: number
  length: number
  tracks: Track[]
  returns: { delay: DelayBus; reverb: ReverbBus }
  patterns: Record<string, Pattern>
  clips: Clip[]
  sections: Section[]
  sample: Sample | null
  fxSafeBypass: boolean
}

export const MACRO_NAMES: Record<TrackKind, string[]> = {
  acid: ['Cutoff', 'Reso', 'Env mod', 'Decay', 'Accent', 'Drive', 'Tune', 'Glide'],
  wave: ['Position', 'Morph', 'Cutoff', 'Reso', 'Attack', 'Release', 'Detune', 'Width'],
  drum: ['Kick tune', 'Kick decay', 'Snare tone', 'Snappy', 'Hat decay', 'Tom tune', 'Drive', 'Comp'],
  sampler: ['Pitch', 'Start', 'Filter', 'Reso', 'Attack', 'Release', 'Crush', 'Swing'],
}

let counter = 0
export const uid = (prefix: string) => `${prefix}-${(++counter).toString(36)}${Math.random().toString(36).slice(2, 6)}`

export const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
export const dbToGain = (db: number) => 10 ** (db / 20)
export const clipEnd = (clip: Clip) => clip.start + clip.length
export const STEPS_PER_BAR = 16

export function emptyStep(note = 36): NoteStep {
  return { on: false, note, accent: false, slide: false, velocity: 100, probability: 100, ratchet: 1 }
}

export function linkCount(project: Project, patternId: string) {
  return project.clips.filter((clip) => clip.patternId === patternId).length
}

export function trackById(project: Project, id: string) {
  return project.tracks.find((track) => track.id === id)
}

export function clipById(project: Project, id: string) {
  return project.clips.find((clip) => clip.id === id)
}

export function updatePattern(project: Project, id: string, change: (pattern: Pattern) => Pattern): Project {
  const pattern = project.patterns[id]
  if (!pattern) return project
  return { ...project, patterns: { ...project.patterns, [id]: change(pattern) } }
}

export function setNoteStep(project: Project, patternId: string, index: number, patch: Partial<NoteStep>): Project {
  return updatePattern(project, patternId, (pattern) => {
    if (pattern.kind !== 'notes' || index < 0 || index >= pattern.length) return pattern
    const steps = pattern.steps.map((step, i) => (i === index ? { ...step, ...patch } : step))
    return { ...pattern, steps }
  })
}

export function cycleDrumHit(project: Project, patternId: string, lane: number, index: number): Project {
  return updatePattern(project, patternId, (pattern) => {
    if (pattern.kind !== 'drums') return pattern
    const lanes = pattern.lanes.map((row, i) =>
      i === lane ? { ...row, hits: row.hits.map((hit, j) => (j === index ? (hit + 1) % 3 : hit)) } : row,
    )
    return { ...pattern, lanes }
  })
}

export function setPatternLength(project: Project, patternId: string, length: number): Project {
  const next = clamp(Math.round(length), 1, 64)
  return updatePattern(project, patternId, (pattern) => {
    if (pattern.kind === 'notes') {
      const root = pattern.steps[0]?.note ?? 36
      const steps = Array.from({ length: next }, (_, i) => pattern.steps[i] ?? emptyStep(root))
      return { ...pattern, length: next, steps }
    }
    if (pattern.kind === 'drums') {
      const lanes = pattern.lanes.map((lane) => ({
        ...lane,
        hits: Array.from({ length: next }, (_, i) => lane.hits[i] ?? 0),
      }))
      return { ...pattern, length: next, lanes }
    }
    return { ...pattern, length: next, hits: pattern.hits.filter((hit) => hit.step < next) }
  })
}

export function makeUnique(project: Project, clipId: string): { project: Project; patternId: string } {
  const clip = clipById(project, clipId)
  if (!clip) return { project, patternId: '' }
  const source = project.patterns[clip.patternId]
  if (!source || linkCount(project, source.id) < 2) return { project, patternId: clip.patternId }
  const patternId = uid('pat')
  const copy: Pattern = structuredClone({ ...source, id: patternId, name: `${source.name} (unique)` })
  return {
    patternId,
    project: {
      ...project,
      patterns: { ...project.patterns, [patternId]: copy },
      clips: project.clips.map((c) => (c.id === clipId ? { ...c, patternId } : c)),
    },
  }
}

// Inserts empty bars at `at`. Clips and sections that start at or after
// `at` move right; a clip that crosses `at` splits so no material slides
// into the following section.
export function insertTime(project: Project, at: number, bars: number, name = 'New section'): Project {
  if (bars <= 0) return project
  const clips: Clip[] = []
  for (const clip of project.clips) {
    if (clip.start >= at) clips.push({ ...clip, start: clip.start + bars })
    else if (clipEnd(clip) > at) {
      const head = at - clip.start
      clips.push({ ...clip, length: head })
      clips.push({ ...clip, id: uid('clip'), start: at + bars, length: clip.length - head, offset: clip.offset + head })
    } else clips.push(clip)
  }
  const crossed = project.sections.find((s) => s.start < at && s.start + s.length > at)
  const sections = project.sections.map((section) => {
    if (section.start >= at) return { ...section, start: section.start + bars }
    if (section === crossed) return { ...section, length: section.length + bars }
    return section
  })
  if (!crossed) sections.push({ id: uid('sec'), name, start: at, length: bars, color: '#8a8f86' })
  sections.sort((a, b) => a.start - b.start)
  return { ...project, clips, sections, length: project.length + bars }
}

export function moveClip(project: Project, clipId: string, start: number): Project {
  const nextStart = Math.max(0, Math.round(start))
  const clips = project.clips.map((clip) => (clip.id === clipId ? { ...clip, start: nextStart } : clip))
  const end = Math.max(...clips.map(clipEnd))
  return { ...project, clips, length: Math.max(project.length, end) }
}

export function resizeClip(project: Project, clipId: string, length: number): Project {
  const nextLength = Math.max(1, Math.round(length))
  const clips = project.clips.map((clip) => (clip.id === clipId ? { ...clip, length: nextLength } : clip))
  const end = Math.max(...clips.map(clipEnd))
  return { ...project, clips, length: Math.max(project.length, end) }
}

export function duplicateClip(project: Project, clipId: string): { project: Project; clipId: string } {
  const clip = clipById(project, clipId)
  if (!clip) return { project, clipId }
  const copy = { ...clip, id: uid('clip'), start: clipEnd(clip) }
  return { clipId: copy.id, project: moveClip({ ...project, clips: [...project.clips, copy] }, copy.id, copy.start) }
}

export function newPattern(kind: TrackKind, name: string): Pattern {
  const id = uid('pat')
  if (kind === 'drum') {
    return {
      id,
      name,
      kind: 'drums',
      length: 16,
      lanes: ['BD', 'SD', 'CH', 'OH', 'CP', 'LT', 'HT', 'RS'].map((voice) => ({ voice, hits: Array(16).fill(0) })),
    }
  }
  if (kind === 'sampler') return { id, name, kind: 'pads', length: 64, hits: [] }
  return { id, name, kind: 'notes', length: 16, steps: Array.from({ length: 16 }, () => emptyStep(kind === 'wave' ? 48 : 36)) }
}

export function createClip(project: Project, trackId: string, start: number, length = 4): { project: Project; clipId: string } {
  const track = trackById(project, trackId)
  if (!track) return { project, clipId: '' }
  const count = project.clips.filter((clip) => clip.trackId === trackId).length + 1
  const pattern = newPattern(track.kind, `${track.name} ${String.fromCharCode(64 + Math.min(count, 26))}`)
  const clip: Clip = { id: uid('clip'), trackId, patternId: pattern.id, start: Math.max(0, Math.round(start)), length, offset: 0 }
  const next = { ...project, patterns: { ...project.patterns, [pattern.id]: pattern }, clips: [...project.clips, clip] }
  return { clipId: clip.id, project: moveClip(next, clip.id, clip.start) }
}

export function deleteClip(project: Project, clipId: string): Project {
  const clip = clipById(project, clipId)
  if (!clip) return project
  const clips = project.clips.filter((c) => c.id !== clipId)
  const patterns = { ...project.patterns }
  if (!clips.some((c) => c.patternId === clip.patternId)) delete patterns[clip.patternId]
  return { ...project, clips, patterns }
}

export function updateTrack(project: Project, trackId: string, patch: Partial<Track>): Project {
  return { ...project, tracks: project.tracks.map((track) => (track.id === trackId ? { ...track, ...patch } : track)) }
}

export function updateSend(project: Project, trackId: string, bus: BusId, patch: Partial<Send>): Project {
  return {
    ...project,
    tracks: project.tracks.map((track) =>
      track.id === trackId ? { ...track, sends: { ...track.sends, [bus]: { ...track.sends[bus], ...patch } } } : track,
    ),
  }
}

export function updateDelay(project: Project, patch: Partial<DelayBus>): Project {
  return { ...project, returns: { ...project.returns, delay: { ...project.returns.delay, ...patch } } }
}

export function updateReverb(project: Project, patch: Partial<ReverbBus>): Project {
  return { ...project, returns: { ...project.returns, reverb: { ...project.returns.reverb, ...patch } } }
}

export function updateSection(project: Project, sectionId: string, patch: Partial<Section>): Project {
  return { ...project, sections: project.sections.map((s) => (s.id === sectionId ? { ...s, ...patch } : s)) }
}

// Signal tracing -----------------------------------------------------------

export function isAudible(project: Project, track: Track) {
  const soloActive = project.tracks.some((t) => t.solo)
  return !track.mute && (!soloActive || track.solo)
}

export interface TraceRow {
  trackId: string
  trackName: string
  level: number
  tap: 'pre' | 'post'
  feeds: boolean
  suspicious: boolean
  reason: string
}

export interface BusTrace {
  bus: BusId
  name: string
  audible: boolean
  reason: string
  rows: TraceRow[]
}

const pct = (value: number) => `${Math.round(value * 100)}%`

export function traceBus(project: Project, bus: BusId): BusTrace {
  const ret = project.returns[bus]
  const audible = !ret.mute && !project.fxSafeBypass
  const reason = project.fxSafeBypass
    ? 'FX Safe Bypass is on; the return is silent but send values are kept.'
    : ret.mute
      ? `${ret.name} return is muted.`
      : `${ret.name} return is live at ${ret.level.toFixed(1)} dB into Master.`
  const rows = project.tracks.map<TraceRow>((track) => {
    const send = track.sends[bus]
    const trackAudible = isAudible(project, track)
    const silencedBy = track.mute ? 'muted' : 'silenced by another track’s solo'
    const feeds = send.level > 0 && (trackAudible || send.tap === 'pre')
    let text = 'No send.'
    if (send.level > 0 && trackAudible) text = `${send.tap === 'pre' ? 'Pre' : 'Post'}-fader send at ${pct(send.level)}.`
    else if (send.level > 0 && send.tap === 'pre') text = `${track.name} is ${silencedBy}, but its pre-fader send at ${pct(send.level)} still feeds ${ret.name}.`
    else if (send.level > 0) text = `${track.name} is ${silencedBy}; its post-fader send is silent.`
    return {
      trackId: track.id,
      trackName: track.name,
      level: send.level,
      tap: send.tap,
      feeds,
      suspicious: feeds && !trackAudible,
      reason: text,
    }
  })
  return { bus, name: ret.name, audible, reason, rows }
}

export function delayTailSeconds(project: Project) {
  const trace = traceBus(project, 'delay')
  if (!trace.audible || !trace.rows.some((row) => row.feeds)) return 0
  const { feedback, beats } = project.returns.delay
  const lossPerRepeat = -20 * Math.log10(clamp(feedback, 0.01, 0.95))
  return (60 / lossPerRepeat) * beats * (60 / project.tempo)
}

// Section analysis ----------------------------------------------------------

const PROFILES: Record<TrackKind, Record<Band, number>> = {
  acid: { sub: 0.22, bass: 0.82, lowMid: 0.6, mid: 0.52, harsh: 0.38, air: 0.1 },
  wave: { sub: 0.08, bass: 0.28, lowMid: 0.5, mid: 0.72, harsh: 0.42, air: 0.32 },
  drum: { sub: 0.92, bass: 0.58, lowMid: 0.3, mid: 0.4, harsh: 0.5, air: 0.62 },
  sampler: { sub: 0.3, bass: 0.48, lowMid: 0.72, mid: 0.62, harsh: 0.4, air: 0.4 },
}

export interface SectionReport {
  sectionId: string
  name: string
  bands: Record<Band, number>
  peak: number
  rms: number
  smear: number
  warnings: string[]
}

export function analyzeSections(project: Project): SectionReport[] {
  const delay = traceBus(project, 'delay')
  const reverb = traceBus(project, 'reverb')
  const delayGain = delay.audible ? dbToGain(project.returns.delay.level) : 0
  const reverbGain = reverb.audible ? dbToGain(project.returns.reverb.level) : 0
  return project.sections.map((section) => {
    const end = section.start + section.length
    const bands = Object.fromEntries(BANDS.map((band) => [band, 0])) as Record<Band, number>
    let sum = 0
    let smear = 0
    for (const track of project.tracks) {
      const present = project.clips.some((c) => c.trackId === track.id && c.start < end && clipEnd(c) > section.start)
      if (!present) continue
      const audible = isAudible(project, track)
      const gain = audible ? dbToGain(track.volume) : 0
      for (const band of BANDS) bands[band] += PROFILES[track.kind][band] * gain
      sum += gain
      const d = delay.rows.find((r) => r.trackId === track.id)
      const r = reverb.rows.find((row) => row.trackId === track.id)
      if (d?.feeds) smear += d.level * delayGain * project.returns.delay.feedback * 1.6
      if (r?.feeds) smear += r.level * reverbGain * (project.returns.reverb.decay / 4)
    }
    bands.lowMid += smear * 0.5
    bands.mid += smear * 0.35
    for (const band of BANDS) bands[band] = clamp(bands[band] / 2.1, 0, 1)
    const peak = sum > 0 ? Math.min(0.4, 20 * Math.log10(sum * 0.42 + smear * 0.15)) : -Infinity
    const rms = peak - (10.5 - smear * 4)
    const warnings: string[] = []
    if (bands.sub > 0.78) warnings.push('Sub buildup')
    if (smear > 0.3) warnings.push('Echo smear')
    if (bands.lowMid > 0.8) warnings.push('Low-mid masking')
    if (peak > -0.3) warnings.push('Clipping risk')
    return { sectionId: section.id, name: section.name, bands, peak, rms, smear, warnings }
  })
}

// Agent proposals -----------------------------------------------------------

export interface ProposalChange {
  id: string
  summary: string
  target: string
  before: string
  after: string
  evidence: string
  focus: { trackId?: string; bus?: BusId }
  apply: (project: Project) => Project
}

export interface Proposal {
  id: string
  request: string
  intent: string
  changes: ProposalChange[]
}

export function proposeEchoCleanup(project: Project, request: string): Proposal | null {
  const changes: ProposalChange[] = []
  const delay = traceBus(project, 'delay')
  for (const row of delay.rows.filter((r) => r.suspicious)) {
    changes.push({
      id: `post-${row.trackId}`,
      summary: `Make ${row.trackName}’s delay send post-fader`,
      target: `${row.trackName} → ${delay.name}`,
      before: `Pre-fader ${pct(row.level)}`,
      after: `Post-fader ${pct(row.level)}`,
      evidence: row.reason,
      focus: { trackId: row.trackId, bus: 'delay' },
      apply: (p) => updateSend(p, row.trackId, 'delay', { tap: 'post' }),
    })
  }
  const { feedback } = project.returns.delay
  if (feedback > 0.45) {
    const before = delayTailSeconds(project)
    const after = delayTailSeconds(updateDelay(project, { feedback: 0.4 }))
    changes.push({
      id: 'delay-feedback',
      summary: `Shorten the ${delay.name} tail`,
      target: `${delay.name} feedback`,
      before: pct(feedback),
      after: '40%',
      evidence: `Measured tail ${before.toFixed(1)} s at ${project.tempo} BPM; 40% feedback gives ${after.toFixed(1)} s.`,
      focus: { bus: 'delay' },
      apply: (p) => updateDelay(p, { feedback: 0.4 }),
    })
  }
  const reports = analyzeSections(project)
  const busiest = reports.reduce<SectionReport | null>((best, r) => (!best || r.bands.lowMid > best.bands.lowMid ? r : best), null)
  for (const track of project.tracks) {
    const send = track.sends.reverb
    if (send.level <= 0.25 || !busiest || busiest.bands.lowMid < 0.45) continue
    changes.push({
      id: `reverb-${track.id}`,
      summary: `Trim ${track.name}’s reverb send`,
      target: `${track.name} → ${project.returns.reverb.name}`,
      before: pct(send.level),
      after: '18%',
      evidence: `Low-mid energy in ${busiest.name} reads ${busiest.bands.lowMid.toFixed(2)}; ${track.name} sends ${pct(send.level)} into a ${project.returns.reverb.decay.toFixed(1)} s plate.`,
      focus: { trackId: track.id, bus: 'reverb' },
      apply: (p) => updateSend(p, track.id, 'reverb', { level: 0.18 }),
    })
  }
  if (!changes.length) return null
  return {
    id: uid('prop'),
    request,
    intent: 'Remove the unintended echo and tighten the drop without changing the musical parts.',
    changes,
  }
}

export function applyChanges(project: Project, proposal: Proposal, ids: ReadonlySet<string>): Project {
  return proposal.changes.filter((change) => ids.has(change.id)).reduce((p, change) => change.apply(p), project)
}

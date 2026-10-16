import {
  type AutomationLane,
  type AutomationPoint,
  type Clip,
  type DrumHit,
  type DrumVoiceName,
  type NoteStep,
  type Pattern,
  type Section,
  type StudioProject,
  type Track,
  DRUM_VOICES,
  clamp,
  clipById,
  clipEnd,
  createPatternFor,
  emptyDrumHit,
  emptyNoteStep,
  getParam,
  isTrackAudible,
  linkCount,
  newId,
  noteName,
  parseNoteName,
  trackById,
} from './model'

export class StudioError extends Error {
  constructor(
    readonly code: 'invalid' | 'not_found' | 'conflict',
    message: string,
  ) {
    super(message)
    this.name = 'StudioError'
  }
}

export function requireTrack(project: StudioProject, id: string): Track {
  const track = trackById(project, id) ?? project.tracks.find((t) => t.name.toLowerCase() === String(id).toLowerCase())
  if (!track) throw new StudioError('not_found', `No track "${id}".`)
  return track
}

export function requireClip(project: StudioProject, id: string): Clip {
  const clip = clipById(project, id)
  if (!clip) throw new StudioError('not_found', `No clip "${id}".`)
  return clip
}

export function requirePattern(project: StudioProject, id: string): Pattern {
  const pattern = project.patterns[id]
  if (!pattern) throw new StudioError('not_found', `No pattern "${id}".`)
  return pattern
}

export const updateTrack = (project: StudioProject, id: string, change: (track: Track) => Track): StudioProject => ({
  ...project,
  tracks: project.tracks.map((t) => (t.id === id ? change(t) : t)),
})

export const updatePattern = (project: StudioProject, id: string, change: (pattern: Pattern) => Pattern): StudioProject => ({
  ...project,
  patterns: { ...project.patterns, [id]: change(requirePattern(project, id)) },
})

export const updateClip = (project: StudioProject, id: string, change: (clip: Clip) => Clip): StudioProject => ({
  ...project,
  clips: project.clips.map((c) => (c.id === id ? change(c) : c)),
})

export function fitLength(project: StudioProject): StudioProject {
  const end = Math.max(project.length, ...project.clips.map(clipEnd), ...project.sections.map((s) => s.start + s.length))
  return end === project.length ? project : { ...project, length: Math.ceil(end) }
}

// Patterns -------------------------------------------------------------------

export function resizePattern(pattern: Pattern, length: number): Pattern {
  const next = clamp(Math.round(length), 1, 64)
  if (pattern.kind === 'notes') {
    const root = pattern.steps[0]?.note ?? 36
    return { ...pattern, length: next, steps: Array.from({ length: next }, (_, i) => pattern.steps[i] ?? emptyNoteStep(root)) }
  }
  if (pattern.kind === 'drums') {
    const lanes = Object.fromEntries(DRUM_VOICES.map((v) => [v, Array.from({ length: next }, (_, i) => pattern.lanes[v]?.[i] ?? emptyDrumHit())])) as Record<DrumVoiceName, DrumHit[]>
    return { ...pattern, length: next, lanes }
  }
  return { ...pattern, length: next, hits: pattern.hits.filter((h) => h.step < next) }
}

/**
 * Note notation: space-separated tokens. A note name (`C2`, `D#3`) plays,
 * `.` or `-` rests. Suffix `!` accents and `~` slides into the next step.
 */
export function parseNoteNotation(text: string, root = 36): NoteStep[] {
  const tokens = text.trim().split(/\s+/).filter(Boolean)
  if (!tokens.length || tokens.length > 64) throw new StudioError('invalid', 'Note patterns need 1–64 steps.')
  return tokens.map((token) => {
    if (token === '.' || token === '-' || token === '_') return emptyNoteStep(root)
    const accent = token.includes('!')
    const slide = token.includes('~')
    const note = parseNoteName(token.replace(/[!~]/g, ''))
    if (note === null) throw new StudioError('invalid', `"${token}" is not a note. Use names like C2, D#3, or "." for a rest.`)
    return { ...emptyNoteStep(note), on: true, accent, slide }
  })
}

export function formatNoteNotation(steps: NoteStep[]): string {
  return steps.map((s) => (s.on ? `${noteName(s.note).replace('♯', '#')}${s.accent ? '!' : ''}${s.slide ? '~' : ''}` : '.')).join(' ')
}

/** Drum notation: one character per step. `x` hit, `X` accent, `.` off. */
export function parseDrumNotation(text: string): DrumHit[] {
  const chars = [...text.replace(/\s+/g, '')]
  if (!chars.length || chars.length > 64) throw new StudioError('invalid', 'Drum lanes need 1–64 steps.')
  return chars.map((char) => {
    if (char === '.' || char === '-' || char === '_') return emptyDrumHit()
    if (char === 'x' || char === 'o') return { ...emptyDrumHit(), on: true }
    if (char === 'X' || char === 'O') return { ...emptyDrumHit(), on: true, accent: true }
    throw new StudioError('invalid', `"${char}" is not a drum step. Use x, X, or ".".`)
  })
}

export const formatDrumNotation = (hits: DrumHit[]) => hits.map((h) => (h.on ? (h.accent ? 'X' : 'x') : '.')).join('')

export function resolveDrumVoice(name: string): DrumVoiceName {
  const lower = name.toLowerCase()
  const aliases: Record<string, DrumVoiceName> = { bd: 'kick', sd: 'snare', cp: 'clap', ch: 'closedHat', hh: 'closedHat', hat: 'closedHat', oh: 'openHat', lt: 'lowTom', mt: 'midTom', ht: 'highTom', rs: 'rim', rim: 'rim', cb: 'cowbell' }
  const voice = DRUM_VOICES.find((v) => v.toLowerCase() === lower) ?? aliases[lower]
  if (!voice) throw new StudioError('invalid', `Unknown drum voice "${name}".`)
  return voice
}

// Clips ----------------------------------------------------------------------

export function makeClip(trackId: string, start: number, length: number, refs: { patternId?: string | null; assetId?: string | null }): Clip {
  return { id: newId('clp'), trackId, patternId: refs.patternId ?? null, assetId: refs.assetId ?? null, start, length, offset: 0, gain: 0, transpose: 0, mute: false, fadeIn: 0, fadeOut: 0 }
}

export function createClip(project: StudioProject, trackId: string, start: number, length: number, refs: { patternId?: string | null; assetId?: string | null; patternName?: string } = {}): { project: StudioProject; clip: Clip } {
  const track = requireTrack(project, trackId)
  if (!(start >= 0) || !(length > 0)) throw new StudioError('invalid', 'Clips need a start of 0 or more and a positive length.')
  let next = project
  let patternId = refs.patternId ?? null
  if (patternId) requirePattern(project, patternId)
  if (!patternId && !refs.assetId) {
    const count = project.clips.filter((c) => c.trackId === track.id).length
    const pattern = createPatternFor(track, refs.patternName ?? `${track.name} ${String.fromCharCode(65 + (count % 26))}`)
    if (pattern) {
      next = { ...next, patterns: { ...next.patterns, [pattern.id]: pattern } }
      patternId = pattern.id
    }
  }
  if (refs.assetId && !project.assets[refs.assetId]) throw new StudioError('not_found', `No asset "${refs.assetId}".`)
  const clip = makeClip(track.id, start, length, { patternId, assetId: refs.assetId ?? null })
  return { project: fitLength({ ...next, clips: [...next.clips, clip] }), clip }
}

export function moveClip(project: StudioProject, id: string, start: number, trackId?: string): StudioProject {
  const clip = requireClip(project, id)
  if (trackId && trackId !== clip.trackId) {
    const from = requireTrack(project, clip.trackId)
    const to = requireTrack(project, trackId)
    if (from.kind !== to.kind) throw new StudioError('invalid', `A ${from.kind} clip cannot move to a ${to.kind} track.`)
  }
  return fitLength(updateClip(project, id, (c) => ({ ...c, start: Math.max(0, start), trackId: trackId ?? c.trackId })))
}

export function resizeClip(project: StudioProject, id: string, length: number): StudioProject {
  requireClip(project, id)
  if (!(length > 0)) throw new StudioError('invalid', 'Clip length must be positive.')
  return fitLength(updateClip(project, id, (c) => ({ ...c, length })))
}

export function duplicateClip(project: StudioProject, id: string, start?: number): { project: StudioProject; clip: Clip } {
  const source = requireClip(project, id)
  const clip = { ...source, id: newId('clp'), start: start ?? clipEnd(source) }
  return { project: fitLength({ ...project, clips: [...project.clips, clip] }), clip }
}

export function deleteClip(project: StudioProject, id: string): StudioProject {
  const clip = requireClip(project, id)
  const clips = project.clips.filter((c) => c.id !== id)
  const stillUsed = clips.some((c) => c.patternId === clip.patternId) || project.scenes.some((s) => Object.values(s.slots).includes(clip.patternId))
  const patterns = { ...project.patterns }
  if (clip.patternId && !stillUsed) delete patterns[clip.patternId]
  return { ...project, clips, patterns }
}

export function makeUnique(project: StudioProject, id: string): { project: StudioProject; patternId: string | null } {
  const clip = requireClip(project, id)
  if (!clip.patternId || linkCount(project, clip.patternId) < 2) return { project, patternId: clip.patternId }
  const source = requirePattern(project, clip.patternId)
  const copy: Pattern = { ...structuredClone(source), id: newId('pat'), name: uniqueName(project, source.name) }
  return {
    patternId: copy.id,
    project: { ...project, patterns: { ...project.patterns, [copy.id]: copy }, clips: project.clips.map((c) => (c.id === id ? { ...c, patternId: copy.id } : c)) },
  }
}

function uniqueName(project: StudioProject, base: string): string {
  const names = new Set(Object.values(project.patterns).map((p) => p.name))
  const stem = base.replace(/ \d+$/, '')
  for (let n = 2; ; n += 1) if (!names.has(`${stem} ${n}`)) return `${stem} ${n}`
}

export function splitClip(project: StudioProject, id: string, at: number): { project: StudioProject; right: Clip } {
  const clip = requireClip(project, id)
  if (!(at > clip.start && at < clipEnd(clip))) throw new StudioError('invalid', 'Split point must fall inside the clip.')
  const head = at - clip.start
  const right: Clip = { ...clip, id: newId('clp'), start: at, length: clip.length - head, offset: clip.offset + head, fadeIn: 0 }
  const left = { ...clip, length: head, fadeOut: 0 }
  return { project: { ...project, clips: project.clips.flatMap((c) => (c.id === id ? [left, right] : [c])) }, right }
}

// Time -----------------------------------------------------------------------

function shiftPoints(points: AutomationPoint[], at: number, bars: number): AutomationPoint[] {
  return points.map((p) => (p.bar >= at ? { ...p, bar: p.bar + bars } : p))
}

/**
 * Inserts empty bars at `at`. Later clips, sections, and automation move
 * right; a clip crossing `at` splits so material never slides into the next
 * section. A section crossing `at` grows; otherwise a new section is added.
 */
export function insertTime(project: StudioProject, at: number, bars: number, name = 'New section'): { project: StudioProject; sectionId: string | null } {
  if (!(bars > 0) || !(at >= 0)) throw new StudioError('invalid', 'Insert needs a position of 0 or more and a positive length.')
  const clips: Clip[] = []
  for (const clip of project.clips) {
    if (clip.start >= at) clips.push({ ...clip, start: clip.start + bars })
    else if (clipEnd(clip) > at) {
      const head = at - clip.start
      clips.push({ ...clip, length: head, fadeOut: 0 })
      clips.push({ ...clip, id: newId('clp'), start: at + bars, length: clip.length - head, offset: clip.offset + head, fadeIn: 0 })
    } else clips.push(clip)
  }
  const crossed = project.sections.find((s) => s.start < at && s.start + s.length > at)
  const sections: Section[] = project.sections.map((s) => (s.start >= at ? { ...s, start: s.start + bars } : s === crossed ? { ...s, length: s.length + bars } : s))
  let sectionId: string | null = null
  if (!crossed) {
    sectionId = newId('sec')
    sections.push({ id: sectionId, name, start: at, length: bars, color: '#7a7f76' })
  }
  sections.sort((a, b) => a.start - b.start)
  const automation = project.automation.map((lane) => ({ ...lane, points: shiftPoints(lane.points, at, bars) }))
  return { project: { ...project, clips, sections, automation, length: project.length + bars }, sectionId }
}

/** Removes `bars` starting at `at`, trimming anything that overlaps the range. */
export function deleteTime(project: StudioProject, at: number, bars: number): StudioProject {
  if (!(bars > 0) || !(at >= 0)) throw new StudioError('invalid', 'Delete needs a position of 0 or more and a positive length.')
  const end = at + bars
  const clips: Clip[] = []
  for (const clip of project.clips) {
    const cEnd = clipEnd(clip)
    if (cEnd <= at) clips.push(clip)
    else if (clip.start >= end) clips.push({ ...clip, start: clip.start - bars })
    else if (clip.start >= at && cEnd <= end) continue
    else if (clip.start < at && cEnd > end) clips.push({ ...clip, length: clip.length - bars })
    else if (clip.start < at) clips.push({ ...clip, length: at - clip.start, fadeOut: 0 })
    else clips.push({ ...clip, start: at, length: cEnd - end, offset: clip.offset + (end - clip.start), fadeIn: 0 })
  }
  const sections = project.sections.flatMap((s) => {
    const sEnd = s.start + s.length
    if (sEnd <= at) return [s]
    if (s.start >= end) return [{ ...s, start: s.start - bars }]
    const kept = Math.max(0, at - s.start) + Math.max(0, sEnd - end)
    return kept > 0 ? [{ ...s, start: Math.min(s.start, at), length: kept }] : []
  })
  const automation = project.automation.map((lane) => ({
    ...lane,
    points: lane.points.filter((p) => p.bar < at || p.bar >= end).map((p) => (p.bar >= end ? { ...p, bar: p.bar - bars } : p)),
  }))
  return { ...project, clips, sections, automation, length: Math.max(1, project.length - bars) }
}

// Automation -----------------------------------------------------------------

export function laneFor(project: StudioProject, trackId: string, param: string): AutomationLane | undefined {
  return project.automation.find((l) => l.trackId === trackId && l.param === param)
}

/** Arrangement automation value at `bar`, or undefined before the first point. */
export function automationValueAt(lane: AutomationLane | undefined, bar: number): number | undefined {
  if (!lane?.points.length) return undefined
  const points = lane.points
  if (bar < points[0].bar) return undefined
  let index = points.length - 1
  for (let i = 0; i < points.length; i += 1) {
    if (points[i].bar > bar) {
      index = i - 1
      break
    }
  }
  const current = points[index]
  const next = points[index + 1]
  if (!next || current.curve === 'hold' || next.bar === current.bar) return current.value
  const t = (bar - current.bar) / (next.bar - current.bar)
  return current.value + (next.value - current.value) * t
}

/**
 * Effective parameter value. Precedence:
 * device base value → arrangement automation → step lock.
 */
export function resolveParam(project: StudioProject, track: Track, param: string, bar: number, locks?: Record<string, number>): number | undefined {
  if (locks && param in locks) return locks[param]
  const automated = automationValueAt(laneFor(project, track.id, param), bar)
  return automated ?? getParam(track, param)
}

export function writeAutomation(project: StudioProject, trackId: string, param: string, points: AutomationPoint[], range?: [number, number]): StudioProject {
  requireTrack(project, trackId)
  const existing = laneFor(project, trackId, param)
  const kept = (existing?.points ?? []).filter((p) => !range || p.bar < range[0] || p.bar > range[1])
  const merged = [...kept, ...points.map((p) => ({ bar: Math.max(0, p.bar), value: p.value, curve: p.curve ?? 'linear' }))].sort((a, b) => a.bar - b.bar)
  const lane: AutomationLane = { id: existing?.id ?? newId('aut'), trackId, param, points: merged }
  return { ...project, automation: existing ? project.automation.map((l) => (l.id === existing.id ? lane : l)) : [...project.automation, lane] }
}

export function clearAutomation(project: StudioProject, trackId: string, param: string, range?: [number, number]): StudioProject {
  return {
    ...project,
    automation: project.automation
      .map((lane) => (lane.trackId === trackId && lane.param === param ? { ...lane, points: range ? lane.points.filter((p) => p.bar < range[0] || p.bar > range[1]) : [] } : lane))
      .filter((lane) => lane.points.length > 0),
  }
}

// Signal trace ---------------------------------------------------------------

export interface TraceStep {
  trackId: string
  name: string
  feeds: boolean
  suspicious: boolean
  reason: string
  level: number
  tap: 'pre' | 'post'
}

export interface ReturnTrace {
  returnId: string
  name: string
  audible: boolean
  reason: string
  sources: TraceStep[]
}

export interface TrackPath {
  trackId: string
  audible: boolean
  path: string[]
  reason: string
}

/** Explains whether a track reaches the master and why. */
export function traceTrack(project: StudioProject, trackId: string): TrackPath {
  const track = requireTrack(project, trackId)
  const path = [track.name]
  let audible = isTrackAudible(project, track)
  let reason = audible ? 'Audible.' : track.mixer.mute ? `${track.name} is muted.` : `${track.name} is silenced by another track’s solo.`
  if (audible && track.mixer.volume <= -60) {
    audible = false
    reason = `${track.name}’s fader is at −∞.`
  }
  const seen = new Set([track.id])
  let output = track.mixer.output
  while (output !== 'master') {
    const group = trackById(project, output)
    if (!group || seen.has(group.id)) break
    seen.add(group.id)
    path.push(group.name)
    if (audible && group.mixer.mute) {
      audible = false
      reason = `Its group ${group.name} is muted.`
    }
    output = group.mixer.output
  }
  path.push('Master')
  return { trackId, audible, path, reason }
}

export function traceReturn(project: StudioProject, returnId: string): ReturnTrace {
  const ret = project.returns.find((r) => r.id === returnId)
  if (!ret) throw new StudioError('not_found', `No return "${returnId}".`)
  const audible = !ret.mute && !project.master.fxSafeBypass && ret.level > -60
  const reason = project.master.fxSafeBypass
    ? 'FX Safe Bypass is on; returns are silent and send values are kept.'
    : ret.mute
      ? `${ret.name} is muted.`
      : ret.level <= -60
        ? `${ret.name}’s return fader is at −∞, so its sends are inaudible.`
        : `${ret.name} is live at ${ret.level.toFixed(1)} dB.`
  const sources = project.tracks.map<TraceStep>((track) => {
    const send = track.mixer.sends[returnId] ?? { level: 0, tap: 'post' as const }
    const path = traceTrack(project, track.id)
    const feeds = send.level > 0 && (path.audible || send.tap === 'pre')
    const pct = `${Math.round(send.level * 100)}%`
    let text = 'No send.'
    if (send.level > 0 && path.audible) text = `${send.tap === 'pre' ? 'Pre' : 'Post'}-fader send at ${pct}.`
    else if (send.level > 0 && send.tap === 'pre') text = `${path.reason.replace(/\.$/, '')}, but its pre-fader send at ${pct} still feeds ${ret.name}.`
    else if (send.level > 0) text = `${path.reason.replace(/\.$/, '')}; its post-fader send is silent.`
    return { trackId: track.id, name: track.name, feeds, suspicious: feeds && !path.audible, reason: text, level: send.level, tap: send.tap }
  })
  return { returnId, name: ret.name, audible, reason, sources }
}

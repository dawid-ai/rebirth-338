import { studio } from '@reborn/studio-core'
import { dispatch, getState, select, subscribe, toast } from '../state/store'
import { engine } from './host'

// Records live input (pads, computer keys, MIDI) while record is armed and
// the transport runs. When recording stops, each track's take becomes a new
// pattern and clip in one undoable step.

interface Hit {
  trackId: string
  bar: number
  pad?: number
  note?: number
  velocity: number
}

let take: Hit[] = []
let wasRecording = false

export function recordHit(hit: Omit<Hit, 'bar'>): void {
  const s = getState()
  if (!s.recording || !s.transport.playing) return
  take.push({ ...hit, bar: engine.position() })
}

function commit() {
  const hits = take
  take = []
  if (!hits.length) return
  const byTrack = new Map<string, Hit[]>()
  for (const hit of hits) byTrack.set(hit.trackId, [...(byTrack.get(hit.trackId) ?? []), hit])
  for (const [trackId, trackHits] of byTrack) {
    const project = getState().project
    const track = project.tracks.find((t) => t.id === trackId)
    if (!track) continue
    const start = Math.floor(Math.min(...trackHits.map((h) => h.bar)))
    const end = Math.max(start + 1, Math.ceil(Math.max(...trackHits.map((h) => h.bar)) + 1e-6))
    const bars = Math.min(4, end - start)
    const length = bars * 16
    const created = dispatch({ type: 'pattern.create', params: { trackId, name: `${track.name} take`, length } }, { label: 'Record take' })
    const patternId = (created?.[0] as { patternId: string } | undefined)?.patternId
    if (!patternId) continue
    const quantize = (bar: number) => {
      const exact = (bar - start) * 16
      const step = Math.round(exact)
      return { step, micro: Math.max(-0.5, Math.min(0.5, exact - step)) }
    }
    const commands: studio.Command[] = []
    if (track.kind === 'sampler') {
      const padHits = trackHits.map((h) => ({ ...quantize(h.bar), pad: h.pad ?? 0, velocity: h.velocity })).filter((h) => h.step >= 0 && h.step < length)
      commands.push({ type: 'pad.record', params: { patternId, hits: padHits, length } })
    } else {
      for (const h of trackHits) {
        const { step, micro } = quantize(h.bar)
        if (step < 0 || step >= length || h.note === undefined) continue
        commands.push({ type: 'step.set', params: { patternId, index: step, on: true, note: h.note, velocity: Math.max(1, Math.min(127, Math.round(h.velocity))), micro } })
      }
    }
    commands.push({ type: 'clip.create', params: { trackId, start, length: bars, patternId } })
    const results = dispatch(commands, { label: `Record ${trackHits.length} hits on ${track.name}` })
    const clipId = (results?.[results.length - 1] as { clipId: string } | undefined)?.clipId
    if (clipId) select({ kind: 'clip', clipId })
    toast(`Recorded ${trackHits.length} hits into a ${bars}-bar clip on ${track.name}`, 'success')
  }
}

subscribe(() => {
  const s = getState()
  const active = s.recording && s.transport.playing
  if (wasRecording && !active) commit()
  wasRecording = active
})

/** Note numbers for computer-keyboard playing: A row white keys, W row black keys. */
export const NOTE_KEYS: Record<string, number> = { a: 0, w: 1, s: 2, e: 3, d: 4, f: 5, t: 6, g: 7, y: 8, h: 9, u: 10, j: 11, k: 12, o: 13, l: 14 }

/** MPC layout, pad 1 bottom-left, kept clear of the transport shortcuts. */
export const PAD_KEYS = ['m', ',', '.', '/', 'j', 'k', 'l', ';', 'u', 'i', 'o', 'p', '7', '8', '9', '0']
export const PAD_ORDER = [12, 13, 14, 15, 8, 9, 10, 11, 4, 5, 6, 7, 0, 1, 2, 3]

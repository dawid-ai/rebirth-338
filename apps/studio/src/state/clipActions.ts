import { engine } from '../audio/host'
import { dispatch, getState, select, toast } from './store'

/** Splits the selected clip at the playhead (snapped to 1/16 bar). */
export function splitSelectedClip(): void {
  const s = getState()
  const sel = s.selection
  if (sel.kind !== 'clip' && sel.kind !== 'step') return void toast('Select a clip to split.')
  const clip = s.project.clips.find((c) => c.id === sel.clipId)
  if (!clip) return
  const at = Math.round(engine.position() * 16) / 16
  if (!(at > clip.start && at < clip.start + clip.length)) return void toast('Move the playhead inside the clip to split it there.')
  const results = dispatch({ type: 'clip.split', params: { clipId: clip.id, at } }, { label: 'Split clip' })
  const right = (results?.[0] as { clipId?: string } | undefined)?.clipId
  if (right) select({ kind: 'clip', clipId: right })
}

/** Plays from the start of the selected clip or section, or from the playhead. */
export function playFromSelection(): void {
  const s = getState()
  const sel = s.selection
  const clip = sel.kind === 'clip' || sel.kind === 'step' ? s.project.clips.find((c) => c.id === sel.clipId) : undefined
  const section = sel.kind === 'section' ? s.project.sections.find((x) => x.id === sel.sectionId) : undefined
  const start = clip?.start ?? section?.start ?? engine.position()
  if (s.transport.playing) engine.stop()
  void engine.play(start)
}

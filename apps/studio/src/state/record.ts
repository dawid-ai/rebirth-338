import { engine } from '../audio/host'
import { dispatch, getState } from './store'

// With record armed and the transport running, control moves become
// arrangement automation at the playhead, on a 1/16-bar grid.

export function recordParamMove(trackId: string, param: string, value: number): void {
  const s = getState()
  if (!s.recording || !s.transport.playing) return
  const bar = Math.round(engine.position() * 16) / 16
  dispatch({ type: 'automation.write', params: { trackId, param, points: [{ bar, value }] } }, { label: 'Record automation', key: `rec-${trackId}-${param}` })
}

/** Records every parameter a macro drives. */
export function recordMacroMove(trackId: string, index: number, value: number): void {
  const macro = getState().project.tracks.find((t) => t.id === trackId)?.macros[index]
  for (const target of macro?.targets ?? []) recordParamMove(trackId, target.param, target.min + (target.max - target.min) * value)
}

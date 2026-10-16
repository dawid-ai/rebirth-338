import { studio } from '@reborn/studio-core'
import { engine, togglePlay } from '../audio/host'
import { dispatch, getState, selectedTrackId, setPrefs, setState, toast } from '../state/store'
import { recordMacroMove, recordParamMove } from '../state/record'
import { type MidiTarget, bindControl, describeControl, lookupControl, parseMidi } from './midi'

// Connects MIDI inputs: learned controls drive parameters, macros, and the
// transport through the same undoable commands as the mouse. Unmapped notes
// go to the caller, which plays the selected instrument.

export interface MidiCallbacks {
  onNote: (note: number, velocity: number) => void
  onRecordToggle: () => void
}

type Access = MIDIAccess & { onstatechange: ((event: Event) => void) | null }

export function startMidi(callbacks: MidiCallbacks): () => void {
  const nav = navigator as Navigator & { requestMIDIAccess?: () => Promise<MIDIAccess> }
  if (!nav.requestMIDIAccess) return () => undefined
  let access: Access | null = null
  const listeners = new Map<MIDIInput, EventListener>()

  const attach = () => {
    if (!access) return
    const names: string[] = []
    access.inputs.forEach((input) => {
      names.push(input.name ?? input.id)
      if (listeners.has(input)) return
      const listener = ((event: MIDIMessageEvent) => {
        if (event.data) handleMessage(input.name ?? input.id, event.data, callbacks)
      }) as EventListener
      input.addEventListener('midimessage', listener)
      listeners.set(input, listener)
    })
    setState({ midiInputs: names })
  }

  nav
    .requestMIDIAccess()
    .then((midi) => {
      access = midi as Access
      access.onstatechange = attach
      attach()
    })
    .catch(() => setState({ midiInputs: [] }))

  return () => {
    if (access) access.onstatechange = null
    for (const [input, listener] of listeners) input.removeEventListener('midimessage', listener)
    listeners.clear()
  }
}

export function handleMessage(input: string, data: ArrayLike<number>, callbacks: MidiCallbacks): void {
  const parsed = parseMidi(data)
  if (!parsed) return
  const s = getState()
  if (s.midiLearn) {
    const target = s.midiLearn.target
    if (!target) return
    setPrefs({ midiProfiles: bindControl(s.prefs.midiProfiles, input, parsed.control, target) })
    setState({ midiLearn: { target: null } })
    toast(`${describeControl(parsed.control)} on ${input} now controls ${target.label}`, 'success')
    return
  }
  const target = lookupControl(s.prefs.midiProfiles, input, parsed.control)
  if (target) applyTarget(target, parsed.kind, parsed.value, callbacks)
  else if (parsed.kind === 'note') callbacks.onNote(Number(parsed.control.split(':')[2]), Math.round(parsed.value * 127))
}

function applyTarget(target: MidiTarget, kind: 'cc' | 'note', value: number, callbacks: MidiCallbacks): void {
  const s = getState()
  if (target.kind === 'transport') {
    // Buttons send 127 on press and 0 on release; act on the press only.
    if (kind === 'cc' && value < 0.5) return
    if (target.action === 'play') void togglePlay()
    else if (target.action === 'stop') engine.stop()
    else callbacks.onRecordToggle()
    return
  }
  if (target.kind === 'macro') {
    const trackId = selectedTrackId(s)
    const track = s.project.tracks.find((t) => t.id === trackId)
    if (!track || !track.macros[target.index]) return
    dispatch({ type: 'macro.set', params: { trackId: track.id, index: target.index, value } }, { label: `${track.name} ${track.macros[target.index].name}`, key: `macro-${track.id}-${target.index}` })
    recordMacroMove(track.id, target.index, value)
    return
  }
  const track = s.project.tracks.find((t) => t.id === target.trackId)
  const spec = track ? studio.findParamSpec(track, target.param) : undefined
  if (!track || !spec) return
  const next = studio.denormalize(spec, value)
  dispatch({ type: 'parameter.set', params: { trackId: track.id, param: target.param, value: next } }, { label: target.label, key: `midi-${track.id}-${target.param}` })
  recordParamMove(track.id, target.param, next)
}

/** Turns learn mode on or off. */
export function toggleMidiLearn(): void {
  const on = !getState().midiLearn
  setState({ midiLearn: on ? { target: null } : null })
  document.body.classList.toggle('midi-learning', on)
}

/**
 * While learning, a click on any control tagged with `data-midi-target`
 * selects it instead of moving it.
 */
export function installLearnPicker(): () => void {
  const onPointerDown = (event: PointerEvent) => {
    if (!getState().midiLearn) return
    const element = (event.target as Element | null)?.closest<HTMLElement>('[data-midi-target]')
    if (!element?.dataset.midiTarget) return
    event.preventDefault()
    event.stopPropagation()
    const target = JSON.parse(element.dataset.midiTarget) as MidiTarget
    setState({ midiLearn: { target } })
  }
  const onClick = (event: MouseEvent) => {
    if (getState().midiLearn && (event.target as Element | null)?.closest('[data-midi-target]')) {
      event.preventDefault()
      event.stopPropagation()
    }
  }
  document.addEventListener('pointerdown', onPointerDown, true)
  document.addEventListener('click', onClick, true)
  return () => {
    document.removeEventListener('pointerdown', onPointerDown, true)
    document.removeEventListener('click', onClick, true)
  }
}

/** The attribute value that makes an element a learn target. */
export const midiTarget = (target: MidiTarget): string => JSON.stringify(target)

// MIDI controller mapping: message parsing and per-device profiles. Bindings
// are stored per input name, so each controller keeps its own layout.

export type MidiTarget =
  | { kind: 'param'; trackId: string; param: string; label: string }
  /** A macro on whichever track is selected, so one knob row follows focus. */
  | { kind: 'macro'; index: number; label: string }
  | { kind: 'transport'; action: 'play' | 'stop' | 'record'; label: string }

/** Input name → control ID (`cc:1:74`, `note:10:36`) → target. */
export type MidiProfiles = Record<string, Record<string, MidiTarget>>

export interface MidiControl {
  control: string
  kind: 'cc' | 'note'
  /** 0..1 */
  value: number
}

/** Parses a control change or note-on. Other messages return null. */
export function parseMidi(data: ArrayLike<number>): MidiControl | null {
  if (data.length < 3) return null
  const type = data[0] & 0xf0
  const channel = (data[0] & 0x0f) + 1
  if (type === 0xb0) return { control: `cc:${channel}:${data[1]}`, kind: 'cc', value: data[2] / 127 }
  if (type === 0x90 && data[2] > 0) return { control: `note:${channel}:${data[1]}`, kind: 'note', value: data[2] / 127 }
  return null
}

export function sameTarget(a: MidiTarget, b: MidiTarget): boolean {
  if (a.kind === 'param' && b.kind === 'param') return a.trackId === b.trackId && a.param === b.param
  if (a.kind === 'macro' && b.kind === 'macro') return a.index === b.index
  if (a.kind === 'transport' && b.kind === 'transport') return a.action === b.action
  return false
}

/** Binds a control to a target on one input. A target keeps one control per input. */
export function bindControl(profiles: MidiProfiles, input: string, control: string, target: MidiTarget): MidiProfiles {
  const profile = Object.fromEntries(Object.entries(profiles[input] ?? {}).filter(([id, t]) => id !== control && !sameTarget(t, target)))
  return { ...profiles, [input]: { ...profile, [control]: target } }
}

export function unbindControl(profiles: MidiProfiles, input: string, control: string): MidiProfiles {
  const { [control]: _removed, ...rest } = profiles[input] ?? {}
  return { ...profiles, [input]: rest }
}

export function lookupControl(profiles: MidiProfiles, input: string, control: string): MidiTarget | undefined {
  return profiles[input]?.[control]
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

/** Readable control name, for example `CC 74 · ch 1` or `C1 · ch 10`. */
export function describeControl(control: string): string {
  const [kind, channel, number] = control.split(':')
  const n = Number(number)
  if (kind === 'cc') return `CC ${n} · ch ${channel}`
  return `${NOTE_NAMES[n % 12]}${Math.floor(n / 12) - 1} · ch ${channel}`
}

import { Cable, X } from 'lucide-react'
import { toggleMidiLearn } from '../midi/host'
import { describeControl, unbindControl } from '../midi/midi'
import { getState, setPrefs, useStudio } from '../state/store'

// MIDI learn: pick a control on screen, then move a knob or press a pad on
// the device. Bindings are saved per device and listed here for removal.

export function MidiLearnBar() {
  const learn = useStudio((s) => s.midiLearn)
  const inputs = useStudio((s) => s.midiInputs) ?? []
  const profiles = useStudio((s) => s.prefs.midiProfiles)
  if (!learn) return null
  const bindings = Object.entries(profiles).flatMap(([input, controls]) => Object.entries(controls).map(([control, target]) => ({ input, control, target })))
  return (
    <section className="midi-learn" role="region" aria-label="MIDI learn" aria-live="polite">
      <header>
        <Cable size={15} />
        <strong>MIDI learn</strong>
        <span>
          {!inputs.length
            ? 'No MIDI device is connected. Plug one in; it appears here automatically.'
            : learn.target
              ? `Now move a knob or press a button on your device to control ${learn.target.label}.`
              : 'Click a knob, a macro, or Play, Stop, or Record. Then move a control on your device.'}
        </span>
        <button type="button" className="chip-btn" onClick={toggleMidiLearn}>
          Done
        </button>
      </header>
      {bindings.length > 0 && (
        <ul>
          {bindings.map(({ input, control, target }) => (
            <li key={`${input}|${control}`}>
              <span>{describeControl(control)}</span>
              <small>{input}</small>
              <b>{target.label}</b>
              <button
                type="button"
                className="icon-btn"
                aria-label={`Remove ${describeControl(control)} from ${target.label}`}
                onClick={() => setPrefs({ midiProfiles: unbindControl(getState().prefs.midiProfiles, input, control) })}
              >
                <X size={13} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

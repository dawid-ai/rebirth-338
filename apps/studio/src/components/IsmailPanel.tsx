import { Download, Sparkles } from 'lucide-react'
import { useEffect, useState } from 'react'
import { generateSound, installIsmail, refreshIsmail, useIsmail } from '../audio/ismail'
import { desktop } from '../platform/desktop'

const DRUMS = new Set(['kick', 'snare', 'clap', 'hat', 'kit'])

/** Browser tab: synthesize sounds with Ismail's instruments and voices. */
export function IsmailPanel() {
  const status = useIsmail((s) => s.status)
  const presets = useIsmail((s) => s.presets)
  const busy = useIsmail((s) => s.busy)
  const last = useIsmail((s) => s.lastSound)
  const [instrument, setInstrument] = useState('preset:acid_bass')
  const [notes, setNotes] = useState('0 C2 0.5 110')
  const [name, setName] = useState('')
  const [tail, setTail] = useState(1)

  useEffect(() => {
    if (desktop) void refreshIsmail()
  }, [])

  if (!desktop) {
    return (
      <div className="browser-list">
        <p className="browser-note">Sound generation and stem separation use Ismail, which runs in the RE:BORN desktop app.</p>
      </div>
    )
  }
  if (!status) return <div className="browser-list"><p className="browser-note">Checking for Ismail…</p></div>

  if (!status.installed) {
    return (
      <div className="browser-list ismail">
        <p className="browser-note">
          Ismail is an open-source audio toolkit: synths, modeled instruments, and analysis that reads audio back as text. RE:BORN uses it to make sounds and split recordings into stems.
        </p>
        <p className="browser-note">Installing downloads it from GitHub and its libraries from PyPI into RE:BORN's own Python environment. It needs Python 3.10 or later and about 650 MB of disk space.</p>
        <button type="button" className="chip-btn" disabled={busy !== null} onClick={() => void installIsmail(false)}>
          <Download size={13} />
          {busy === 'install' ? 'Installing Ismail…' : 'Install Ismail'}
        </button>
        {status.message && <p className="browser-note is-error">{status.message}</p>}
      </div>
    )
  }

  const [kind, value] = instrument.split(':') as ['preset' | 'voice', string]
  const preset = presets?.presets.find((p) => p.name === value)
  const label = name.trim() || value.replace(/_/g, ' ')
  const generate = () => void generateSound({ name: label, instrument: kind === 'voice' ? { type: 'code', voice: value } : value, notes, tailSeconds: tail })
  const pick = (next: string) => {
    setInstrument(next)
    const [nextKind, nextValue] = next.split(':')
    const type = nextKind === 'preset' ? presets?.presets.find((p) => p.name === nextValue)?.type : 'code'
    // Drum voices ignore pitch; a short hit is the useful default.
    if (type && DRUMS.has(type)) setNotes('0 C1 0.25 120')
  }

  return (
    <div className="browser-list ismail">
      <p className="browser-note">Make a sound with Ismail. It loads into the selected Sampler, lands on the selected Audio track at the playhead, or gets a new audio track.</p>
      <label className="field">
        <span className="field-label">Instrument</span>
        <select value={instrument} onChange={(event) => pick(event.target.value)} aria-label="Ismail instrument">
          <optgroup label="Presets">
            {(presets?.presets ?? []).map((p) => (
              <option key={p.name} value={`preset:${p.name}`}>
                {p.name.replace(/_/g, ' ')} · {p.type}
              </option>
            ))}
          </optgroup>
          {presets && presets.voices.length > 0 && (
            <optgroup label="Voices">
              {presets.voices.map((v) => (
                <option key={v.name} value={`voice:${v.name}`} title={v.summary}>
                  {v.name} · {v.family.replace(/^built-in\//, '')}
                </option>
              ))}
            </optgroup>
          )}
        </select>
      </label>
      {kind === 'voice' && <p className="browser-note">{presets?.voices.find((v) => v.name === value)?.summary}</p>}
      <label className="field">
        <span className="field-label">Notes</span>
        <textarea rows={3} value={notes} spellCheck={false} onKeyDown={(event) => event.stopPropagation()} onChange={(event) => setNotes(event.target.value)} aria-describedby="ismail-notes-help" />
      </label>
      <p className="browser-note" id="ismail-notes-help">
        One note per line or separated by <code>;</code>: start beat, pitch, length in beats, velocity. <code>0 C3 1; 1 G3 0.5 90</code> plays two notes; <code>0 C3,E3,G3 2</code> is a chord. Beats follow the project tempo.
      </p>
      <div className="ismail-row">
        <label className="field">
          <span className="field-label">Name</span>
          <input type="text" value={name} placeholder={value.replace(/_/g, ' ')} onKeyDown={(event) => event.stopPropagation()} onChange={(event) => setName(event.target.value)} />
        </label>
        <label className="field">
          <span className="field-label">Tail (s)</span>
          <input type="number" min={0} max={10} step={0.5} value={tail} onKeyDown={(event) => event.stopPropagation()} onChange={(event) => setTail(Math.max(0, Math.min(10, Number(event.target.value) || 0)))} />
        </label>
      </div>
      <button type="button" className="chip-btn primary" disabled={busy !== null || !notes.trim()} onClick={generate} title={preset ? `Ismail ${preset.type} preset` : undefined}>
        <Sparkles size={13} />
        {busy === 'generate' ? 'Generating…' : `Generate ${label}`}
      </button>
      {last && (
        <details className="ismail-report">
          <summary>
            {last.name}: {last.summary.replace(/^sound '[^']*': /, '')}
          </summary>
          <pre>{last.description}</pre>
        </details>
      )}
      <h4>Stem separation</h4>
      {status.separation ? (
        <p className="browser-note">Select an audio clip, a deck, or a Sampler's source and click Separate stems in the inspector.</p>
      ) : (
        <>
          <p className="browser-note">Split a recording into drums, bass, other, and vocals with Demucs. This adds PyTorch and Demucs (about 700 MB more); the model weights download the first time you separate.</p>
          <button type="button" className="chip-btn" disabled={busy !== null} onClick={() => void installIsmail(true)}>
            <Download size={13} />
            {busy === 'install' ? 'Installing…' : 'Add stem separation'}
          </button>
        </>
      )}
      <p className="browser-note">Ismail {status.version}</p>
    </div>
  )
}

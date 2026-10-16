import { Download, X } from 'lucide-react'
import { useState } from 'react'
import { type ExportOptions, exportAudio, exportRange } from '../audio/export'
import { useStudio } from '../state/store'

export function ExportDialog({ onClose }: { onClose: () => void }) {
  const [options, setOptions] = useState<ExportOptions>({ kind: 'mix', bitDepth: 16, range: 'song' })
  const hasSection = useStudio((s) => s.selection.kind === 'section')
  const hasLoop = useStudio((s) => Boolean(s.transport.loop))
  const [from, to] = exportRange(options.range)
  const choice = <K extends keyof ExportOptions>(key: K, value: ExportOptions[K], label: string, disabled = false) => (
    <button type="button" role="radio" aria-checked={options[key] === value} className={options[key] === value ? 'is-on' : ''} disabled={disabled} onClick={() => setOptions((o) => ({ ...o, [key]: value }))}>
      {label}
    </button>
  )
  return (
    <div className="modal-backdrop" onPointerDown={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Export audio" onPointerDown={(event) => event.stopPropagation()}>
        <header>
          <h2>Export audio</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </header>
        <div className="modal-body">
          <div className="field">
            <span className="field-label">What</span>
            <div className="seg" role="radiogroup" aria-label="Export type">
              {choice('kind', 'mix', 'Full mix')}
              {choice('kind', 'stems', 'Stems (one file per track)')}
            </div>
          </div>
          <div className="field">
            <span className="field-label">Range</span>
            <div className="seg" role="radiogroup" aria-label="Range">
              {choice('range', 'song', 'Whole song')}
              {choice('range', 'section', 'Selected section', !hasSection)}
              {choice('range', 'loop', 'Loop range', !hasLoop)}
            </div>
            <span className="field-hint">
              Bars {from + 1}–{to}, plus the effect tail.
            </span>
          </div>
          <div className="field">
            <span className="field-label">Format</span>
            <div className="seg" role="radiogroup" aria-label="Bit depth">
              {choice('bitDepth', 16, '16-bit with dither')}
              {choice('bitDepth', 24, '24-bit')}
            </div>
            <span className="field-hint">The master ceiling keeps true peaks under its setting. Stems skip the master chain.</span>
          </div>
        </div>
        <footer>
          <button type="button" className="chip-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="chip-btn primary"
            onClick={() => {
              void exportAudio(options)
              onClose()
            }}
          >
            <Download size={13} />
            Export
          </button>
        </footer>
      </div>
    </div>
  )
}

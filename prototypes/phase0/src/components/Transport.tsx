import { Circle, Download, Pause, Play, Redo2, Repeat, SkipBack, Sparkles, Square, Undo2 } from 'lucide-react'
import { clock, formatPosition, useClock } from '../clock'
import { useStudio } from '../studio'

interface TransportProps {
  onOpenPalette: () => void
}

function PositionReadout() {
  const text = useClock((position) => formatPosition(position))
  const seconds = useClock((position) => Math.floor(position * 2))
  const studio = useStudio()
  const elapsed = (seconds / 2) * (240 / studio.project.tempo)
  return (
    <div className="readout" aria-label="Song position">
      <strong>{text}</strong>
      <small>
        {Math.floor(elapsed / 60)}:{String(Math.floor(elapsed % 60)).padStart(2, '0')}
      </small>
    </div>
  )
}

export function Transport({ onOpenPalette }: TransportProps) {
  const studio = useStudio()
  const playing = useClock((_, isPlaying) => isPlaying)
  const { project } = studio
  const lastEdit = studio.past[studio.past.length - 1]

  return (
    <header className="transport" role="toolbar" aria-label="Transport">
      <div className="mark">
        <span className="mark-logo" aria-hidden="true">
          RE<b>:</b>BORN
        </span>
        <div className="mark-project">
          <strong>{project.name}</strong>
          <small>{studio.past.length ? `Edited · ${studio.past.length} steps` : 'Saved'}</small>
        </div>
      </div>

      <div className="t-group">
        <button type="button" className="icon-btn" onClick={studio.undo} disabled={!studio.past.length} title={lastEdit ? `Undo ${lastEdit.label} (Ctrl+Z)` : 'Nothing to undo'} aria-label="Undo">
          <Undo2 size={16} />
        </button>
        <button type="button" className="icon-btn" onClick={studio.redo} disabled={!studio.future.length} title="Redo (Ctrl+Shift+Z)" aria-label="Redo">
          <Redo2 size={16} />
        </button>
      </div>

      <div className="t-group t-transport">
        <button type="button" className="icon-btn" onClick={() => clock.seek(0)} title="Return to start (Home)" aria-label="Return to start">
          <SkipBack size={16} />
        </button>
        <button
          type="button"
          className="icon-btn"
          onClick={() => {
            clock.pause()
            clock.seek(0)
          }}
          title="Stop"
          aria-label="Stop"
        >
          <Square size={14} />
        </button>
        <button type="button" className={`icon-btn play${playing ? ' is-on' : ''}`} onClick={() => (playing ? clock.pause() : clock.play())} title="Play or pause (Space)" aria-label={playing ? 'Pause' : 'Play'}>
          {playing ? <Pause size={18} /> : <Play size={18} />}
        </button>
        <button
          type="button"
          className={`icon-btn rec${studio.recordArmed ? ' is-on' : ''}`}
          onClick={() => studio.setRecordArmed(!studio.recordArmed)}
          aria-pressed={studio.recordArmed}
          title="Arm recording (R). Pad hits record into Sampler while playing."
          aria-label="Record"
        >
          <Circle size={14} fill="currentColor" />
        </button>
        <button
          type="button"
          className={`icon-btn${studio.loopOn ? ' is-on' : ''}`}
          onClick={() => studio.setLoopOn(!studio.loopOn)}
          aria-pressed={studio.loopOn}
          title="Loop the selected section, or the whole song"
          aria-label="Loop"
        >
          <Repeat size={16} />
        </button>
      </div>

      <PositionReadout />

      <div className="t-group t-tempo">
        <label className="tempo">
          <input
            type="number"
            min={60}
            max={200}
            value={project.tempo}
            aria-label="Tempo in BPM"
            onKeyDown={(event) => event.stopPropagation()}
            onChange={(event) => {
              const tempo = Number(event.target.value)
              if (tempo >= 60 && tempo <= 200) studio.commit('Set tempo', (p) => ({ ...p, tempo }), { key: 'tempo' })
            }}
          />
          <span>BPM</span>
        </label>
        <label className="tempo swing">
          <input
            type="number"
            min={0}
            max={75}
            value={Math.round(project.swing * 100)}
            aria-label="Global swing percent"
            onKeyDown={(event) => event.stopPropagation()}
            onChange={(event) => {
              const swing = Number(event.target.value) / 100
              if (swing >= 0 && swing <= 0.75) studio.commit('Set swing', (p) => ({ ...p, swing }), { key: 'swing' })
            }}
          />
          <span>Swing</span>
        </label>
      </div>

      <div className="t-spacer" />

      <div className="health" title="Prototype: no audio device is opened. Meters are simulated.">
        <i className="health-dot" />
        <span>CPU 6%</span>
      </div>

      <button type="button" className="t-btn" title="Export lands in Phase 4" disabled>
        <Download size={15} />
        <span>Export</span>
      </button>
      <button type="button" className={`t-btn agent${studio.proposal ? ' has-pending' : ''}`} onClick={onOpenPalette} title="Command palette and agent (Ctrl+K)">
        <Sparkles size={15} />
        <span>{studio.agentBusy ? 'Thinking…' : studio.proposal ? 'Review proposal' : 'Agent'}</span>
        <kbd>Ctrl K</kbd>
      </button>
    </header>
  )
}

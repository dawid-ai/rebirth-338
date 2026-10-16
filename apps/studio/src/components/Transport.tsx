import { Circle, Download, Gauge, Pause, Play, Redo2, Repeat, SkipBack, Sparkles, Square, Timer, Undo2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { engine, formatBar, togglePlay, usePlayhead } from '../audio/host'
import { dispatch, getState, isEdited, redo, setPrefs, setState, undo, useStudio } from '../state/store'
import { ExportDialog } from './ExportDialog'

function Position() {
  const text = usePlayhead((bar) => formatBar(bar))
  const tempo = useStudio((s) => s.project.tempo)
  const seconds = usePlayhead((bar) => Math.floor(bar * 4 * (60 / tempo)))
  return (
    <div className="readout" aria-label="Song position">
      <strong>{text}</strong>
      <small>
        {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}
      </small>
    </div>
  )
}

function Health() {
  const [level, setLevel] = useState(0)
  const [reduction, setReduction] = useState(0)
  const playing = useStudio((s) => s.transport.playing)
  useEffect(() => {
    if (!playing) {
      setLevel(0)
      return
    }
    let frame = 0
    const loop = () => {
      setLevel(engine.outputLevel())
      setReduction(engine.gainReduction())
      frame = requestAnimationFrame(loop)
    }
    frame = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(frame)
  }, [playing])
  return (
    <div className="health" title={`Output level and compressor gain reduction. Audio runs at ${engine.sampleRate / 1000} kHz.`}>
      <span className="health-meter" aria-hidden="true">
        <i style={{ transform: `scaleX(${level})` }} className={level > 0.92 ? 'hot' : undefined} />
      </span>
      <Gauge size={13} />
      <span>GR {Math.round(reduction * 24)} dB</span>
    </div>
  )
}

function TapTempo() {
  const taps = useRef<number[]>([])
  return (
    <button
      type="button"
      className="icon-btn sm"
      title="Tap tempo"
      aria-label="Tap tempo"
      onClick={() => {
        const now = performance.now()
        taps.current = [...taps.current.filter((t) => now - t < 2500), now]
        if (taps.current.length < 3) return
        const gaps = taps.current.slice(1).map((t, i) => t - taps.current[i])
        const bpm = Math.round(60000 / (gaps.reduce((a, b) => a + b, 0) / gaps.length))
        if (bpm >= 40 && bpm <= 240) dispatch({ type: 'project.update', params: { tempo: bpm } }, { label: 'Tap tempo', key: 'tempo' })
      }}
    >
      <Timer size={13} />
    </button>
  )
}

export function Transport() {
  const playing = useStudio((s) => s.transport.playing)
  const loop = useStudio((s) => s.transport.loop)
  const recording = useStudio((s) => s.recording)
  const name = useStudio((s) => s.project.name)
  const tempo = useStudio((s) => s.project.tempo)
  const swing = useStudio((s) => s.project.swing)
  const edited = useStudio(isEdited)
  const canUndo = useStudio((s) => s.past.length > 0)
  const canRedo = useStudio((s) => s.future.length > 0)
  const lastLabel = useStudio((s) => s.past[s.past.length - 1]?.label)
  const metronome = useStudio((s) => s.prefs.metronome)
  const pending = useStudio((s) => s.proposals.filter((p) => p.status === 'pending').length)
  const jobs = useStudio((s) => s.jobs)
  const path = useStudio((s) => s.document.path)
  const [exporting, setExporting] = useState(false)

  const toggleLoop = () => {
    if (loop) return engine.setLoop(null)
    const s = getState()
    const section = s.selection.kind === 'section' ? s.project.sections.find((x) => x.id === (s.selection as { sectionId: string }).sectionId) : null
    engine.setLoop(section ? [section.start, section.start + section.length] : [0, s.project.length])
  }

  return (
    <header className="transport" role="toolbar" aria-label="Transport">
      <div className="mark">
        <span className="mark-logo" aria-hidden="true">
          RE<b>:</b>BORN
        </span>
        <div className="mark-project" title={path ?? 'Not saved to a folder yet'}>
          <strong>{name}</strong>
          <small>{edited ? 'Unsaved changes' : path ? 'Saved' : 'Not saved'}</small>
        </div>
      </div>

      <div className="t-group">
        <button type="button" className="icon-btn" onClick={undo} disabled={!canUndo} title={lastLabel ? `Undo ${lastLabel} (Ctrl+Z)` : 'Nothing to undo'} aria-label="Undo">
          <Undo2 size={16} />
        </button>
        <button type="button" className="icon-btn" onClick={redo} disabled={!canRedo} title="Redo (Ctrl+Shift+Z)" aria-label="Redo">
          <Redo2 size={16} />
        </button>
      </div>

      <div className="t-group t-transport">
        <button type="button" className="icon-btn" onClick={() => engine.seek(loop ? loop[0] : 0)} title="Return to start (Home)" aria-label="Return to start">
          <SkipBack size={16} />
        </button>
        <button type="button" className="icon-btn" onClick={() => engine.stop()} title="Stop and return to start" aria-label="Stop">
          <Square size={14} />
        </button>
        <button type="button" className={`icon-btn play${playing ? ' is-on' : ''}`} onClick={() => void togglePlay()} title="Play or pause (Space)" aria-label={playing ? 'Pause' : 'Play'}>
          {playing ? <Pause size={18} /> : <Play size={18} />}
        </button>
        <button
          type="button"
          className={`icon-btn rec${recording ? ' is-on' : ''}`}
          onClick={() => setState({ recording: !recording })}
          aria-pressed={recording}
          title="Arm recording (R). Pads, notes, scene launches, and macro moves record while playing."
          aria-label="Record"
        >
          <Circle size={14} fill="currentColor" />
        </button>
        <button type="button" className={`icon-btn${loop ? ' is-on' : ''}`} onClick={toggleLoop} aria-pressed={Boolean(loop)} title="Loop the selected section, or the whole song (L)" aria-label="Loop">
          <Repeat size={16} />
        </button>
      </div>

      <Position />

      <div className="t-group t-tempo">
        <label className="tempo">
          <input
            type="number"
            min={40}
            max={240}
            value={tempo}
            aria-label="Tempo in BPM"
            onKeyDown={(event) => event.stopPropagation()}
            onChange={(event) => {
              const value = Number(event.target.value)
              if (value >= 40 && value <= 240) dispatch({ type: 'project.update', params: { tempo: value } }, { label: 'Change tempo', key: 'tempo' })
            }}
          />
          <span>BPM</span>
        </label>
        <TapTempo />
        <label className="tempo swing">
          <input
            type="number"
            min={0}
            max={75}
            value={Math.round(swing * 100)}
            aria-label="Global swing percent"
            onKeyDown={(event) => event.stopPropagation()}
            onChange={(event) => {
              const value = Number(event.target.value) / 100
              if (value >= 0 && value <= 0.75) dispatch({ type: 'project.update', params: { swing: value } }, { label: 'Change swing', key: 'swing' })
            }}
          />
          <span>Swing</span>
        </label>
        <button
          type="button"
          className={`t-chip${metronome ? ' is-on' : ''}`}
          aria-pressed={metronome}
          onClick={() => {
            engine.setMetronome(!metronome)
            setPrefs({ metronome: !metronome })
          }}
          title="Metronome"
        >
          Click
        </button>
      </div>

      <div className="t-spacer" />
      {jobs.filter((j) => j.status === 'running').map((job) => (
        <div key={job.id} className="job-pill" title={job.label}>
          <span>{job.label}</span>
          <i style={{ width: `${Math.round((job.completed / Math.max(1, job.total)) * 100)}%` }} />
          {job.cancel && (
            <button type="button" onClick={job.cancel} aria-label={`Cancel ${job.label}`}>
              ×
            </button>
          )}
        </div>
      ))}
      <Health />

      <button type="button" className="t-btn" onClick={() => setExporting(true)} title="Export WAV or stems">
        <Download size={15} />
        <span>Export</span>
      </button>
      <button type="button" className={`t-btn agent${pending ? ' has-pending' : ''}`} onClick={() => setState({ agentOpen: true })} title="Agent (Ctrl+K for commands)">
        <Sparkles size={15} />
        <span>{pending ? `${pending} proposal${pending === 1 ? '' : 's'}` : 'Agent'}</span>
      </button>
      {exporting && <ExportDialog onClose={() => setExporting(false)} />}
    </header>
  )
}

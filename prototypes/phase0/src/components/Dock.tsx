import { ArrowRight, Keyboard, Link2, Minus, Plus, Unlink } from 'lucide-react'
import { type CSSProperties, type PointerEvent, useEffect, useMemo, useRef, useState } from 'react'
import { breakPeaks, distributeToPads, slicePositions } from '../break'
import { useClock } from '../clock'
import {
  type Clip,
  type Pattern,
  type Project,
  type Sample,
  type SliceMode,
  type Track,
  MACRO_NAMES,
  STEPS_PER_BAR,
  clamp,
  clipById,
  clipEnd,
  cycleDrumHit,
  linkCount,
  makeUnique,
  setNoteStep,
  setPatternLength,
  trackById,
  updateTrack,
} from '../model'
import { type Selection, selectedTrackId, useStudio } from '../studio'
import { Knob } from './Controls'
import { MixDock } from './Mix'

// MPC layout on the right hand: pad 1 is bottom-left. These keys avoid the
// global shortcuts (Space, R, 1–4, Z/X), so pads never steal transport keys.
export const PAD_KEYS = ['m', ',', '.', '/', 'j', 'k', 'l', ';', 'u', 'i', 'o', 'p', '7', '8', '9', '0']
const PAD_ORDER = [12, 13, 14, 15, 8, 9, 10, 11, 4, 5, 6, 7, 0, 1, 2, 3]
const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B']
export const noteName = (midi: number) => `${NOTE_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`

type EditorKind = 'steps' | 'drums' | 'pads' | 'chop' | 'chain' | 'mix' | 'empty'

function editorFor(view: string, selection: Selection, project: Project): EditorKind {
  if (view === 'mix') return 'mix'
  if (selection.kind === 'sample') return project.sample ? 'chop' : 'empty'
  if (selection.kind === 'clip' || selection.kind === 'step') {
    const clip = clipById(project, selection.clipId)
    const pattern = clip && project.patterns[clip.patternId]
    if (!pattern) return 'empty'
    return pattern.kind === 'notes' ? 'steps' : pattern.kind === 'drums' ? 'drums' : 'pads'
  }
  if (selection.kind === 'track') {
    const track = trackById(project, selection.trackId)
    if (track?.kind === 'sampler' && project.sample) return 'chop'
    return 'chain'
  }
  return 'empty'
}

const DEFAULT_HEIGHT: Record<EditorKind, number> = { steps: 330, drums: 300, pads: 320, chop: 330, chain: 220, mix: 320, empty: 200 }

function useClipStep(clip: Clip | undefined, pattern: Pattern | undefined) {
  return useClock((position, playing) => {
    if (!playing || !clip || !pattern || position < clip.start || position >= clipEnd(clip)) return -1
    return Math.floor((position - clip.start + clip.offset) * STEPS_PER_BAR) % pattern.length
  })
}

function LinkBar({ clip, pattern }: { clip: Clip; pattern: Pattern }) {
  const studio = useStudio()
  const links = linkCount(studio.project, pattern.id)
  return (
    <div className={`link-bar${links > 1 ? ' is-linked' : ''}`}>
      {links > 1 ? (
        <>
          <Link2 size={13} />
          <span>
            Editing <b>{pattern.name}</b>, used by {links} clips. Edits change all of them.
          </span>
          <button
            type="button"
            className="chip-btn"
            onClick={() => {
              const result = makeUnique(studio.project, clip.id)
              studio.commit(`Make ${pattern.name} unique`, () => result.project)
              studio.markTask('unique')
            }}
          >
            <Unlink size={12} />
            Make unique
          </button>
        </>
      ) : (
        <>
          <span className="dot" />
          <span>
            <b>{pattern.name}</b> is used by this clip only.
          </span>
        </>
      )}
    </div>
  )
}

function LengthControl({ pattern }: { pattern: Pattern }) {
  const studio = useStudio()
  const set = (length: number) => studio.commit('Change pattern length', (p) => setPatternLength(p, pattern.id, length), { key: `len-${pattern.id}` })
  return (
    <div className="length-ctl" title="Pattern length in steps (1–64). Each track can use its own length.">
      <span>Length</span>
      <button type="button" className="icon-btn sm" aria-label="Shorter pattern" onClick={() => set(pattern.length - 1)}>
        <Minus size={12} />
      </button>
      <output>{pattern.length}</output>
      <button type="button" className="icon-btn sm" aria-label="Longer pattern" onClick={() => set(pattern.length + 1)}>
        <Plus size={12} />
      </button>
      <span className="muted">steps · 1/16</span>
    </div>
  )
}

function StepEditor({ clip, pattern, track }: { clip: Clip; pattern: Extract<Pattern, { kind: 'notes' }>; track: Track }) {
  const studio = useStudio()
  const { selection } = studio
  const playing = useClipStep(clip, pattern)
  const notes = pattern.steps.filter((s) => s.on).map((s) => s.note)
  const lowest = notes.length ? Math.min(...notes) : (pattern.steps[0]?.note ?? 36)
  const [low, setLow] = useState(() => Math.floor(lowest / 12) * 12)
  const rows = Array.from({ length: 13 }, (_, i) => low + 12 - i)
  const selectedIndex = selection.kind === 'step' && selection.clipId === clip.id ? selection.index : -1

  const edit = (label: string, index: number, patch: Parameters<typeof setNoteStep>[3]) => {
    studio.commit(label, (p) => setNoteStep(p, pattern.id, index, patch))
    studio.select({ kind: 'step', clipId: clip.id, index })
    if (track.kind === 'acid') studio.markTask('pattern')
  }

  return (
    <div className="editor steps-editor">
      <div className="editor-bar">
        <LinkBar clip={clip} pattern={pattern} />
        <LengthControl pattern={pattern} />
        <div className="octave-ctl">
          <button type="button" className="icon-btn sm" aria-label="Show lower notes" onClick={() => setLow(Math.max(0, low - 12))}>
            <Minus size={12} />
          </button>
          <span>
            {noteName(low)}–{noteName(low + 12)}
          </span>
          <button type="button" className="icon-btn sm" aria-label="Show higher notes" onClick={() => setLow(Math.min(96, low + 12))}>
            <Plus size={12} />
          </button>
        </div>
      </div>
      <div className="bone grid-scroll">
        <div className="note-grid" style={{ gridTemplateColumns: `44px repeat(${pattern.length}, minmax(22px, 1fr))` }}>
          <span className="grid-corner" />
          {pattern.steps.map((_, i) => (
            <button
              key={`h${i}`}
              type="button"
              className={`step-head${i % 4 === 0 ? ' beat' : ''}${i === selectedIndex ? ' is-selected' : ''}${i === playing ? ' is-playing' : ''}`}
              onClick={() => studio.select({ kind: 'step', clipId: clip.id, index: i })}
              aria-label={`Select step ${i + 1}`}
            >
              {i + 1}
            </button>
          ))}
          {rows.map((note) => (
            <div key={note} className={`note-row${NOTE_NAMES[note % 12].includes('♯') ? ' sharp' : ''}`} style={{ display: 'contents' }}>
              <span className="note-label">{note % 12 === 0 || note === rows[0] ? noteName(note) : NOTE_NAMES[note % 12]}</span>
              {pattern.steps.map((step, i) => {
                const on = step.on && step.note === note
                return (
                  <button
                    key={i}
                    type="button"
                    className={`cell${on ? ' is-on' : ''}${on && step.accent ? ' accent' : ''}${on && step.slide ? ' slide' : ''}${i % 4 === 0 ? ' beat' : ''}${i === playing ? ' is-playing' : ''}${i === selectedIndex ? ' col-selected' : ''}${NOTE_NAMES[note % 12].includes('♯') ? ' sharp' : ''}`}
                    aria-label={`${noteName(note)} on step ${i + 1}${on ? ', on' : ''}`}
                    aria-pressed={on}
                    onClick={() => edit(on ? 'Clear step' : 'Set step note', i, on ? { on: false } : { on: true, note })}
                  />
                )
              })}
            </div>
          ))}
          <span className="note-label flag">Accent</span>
          {pattern.steps.map((step, i) => (
            <button key={`a${i}`} type="button" className={`flag-cell accent${step.accent ? ' is-on' : ''}`} aria-pressed={step.accent} aria-label={`Accent step ${i + 1}`} onClick={() => edit('Toggle accent', i, { accent: !step.accent })}>
              {step.accent ? 'A' : ''}
            </button>
          ))}
          <span className="note-label flag">Slide</span>
          {pattern.steps.map((step, i) => (
            <button key={`s${i}`} type="button" className={`flag-cell slide${step.slide ? ' is-on' : ''}`} aria-pressed={step.slide} aria-label={`Slide step ${i + 1}`} onClick={() => edit('Toggle slide', i, { slide: !step.slide })}>
              {step.slide ? '⌒' : ''}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

function DrumEditor({ clip, pattern }: { clip: Clip; pattern: Extract<Pattern, { kind: 'drums' }> }) {
  const studio = useStudio()
  const playing = useClipStep(clip, pattern)
  return (
    <div className="editor drums-editor">
      <div className="editor-bar">
        <LinkBar clip={clip} pattern={pattern} />
        <LengthControl pattern={pattern} />
        <span className="muted legend">Click: off → hit → accent</span>
      </div>
      <div className="bone grid-scroll">
        <div className="drum-grid" style={{ gridTemplateColumns: `44px repeat(${pattern.length}, minmax(22px, 1fr))` }}>
          {pattern.lanes.map((lane, row) => (
            <div key={lane.voice} style={{ display: 'contents' }}>
              <span className="note-label">{lane.voice}</span>
              {lane.hits.map((hit, i) => (
                <button
                  key={i}
                  type="button"
                  className={`cell drum${hit ? ' is-on' : ''}${hit === 2 ? ' accent' : ''}${i % 4 === 0 ? ' beat' : ''}${i === playing ? ' is-playing' : ''}`}
                  aria-label={`${lane.voice} step ${i + 1}: ${['off', 'hit', 'accent'][hit]}`}
                  onClick={() => studio.commit(`Edit ${lane.voice}`, (p) => cycleDrumHit(p, pattern.id, row, i))}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

export function PadGrid({ sample }: { sample: Sample | null }) {
  const studio = useStudio()
  const { lastPad } = studio
  return (
    <div className="pad-grid" role="group" aria-label="Sampler pads">
      {PAD_ORDER.map((pad) => {
        const key = PAD_KEYS[pad]
        const slice = sample?.pads[pad] ?? null
        const hit = lastPad?.pad === pad
        return (
          <button
            key={pad}
            type="button"
            className={`pad${slice === null ? ' is-empty' : ''}`}
            onPointerDown={() => {
              studio.triggerPad(pad)
              if (slice !== null) studio.select({ kind: 'sample', slice })
            }}
            aria-label={`Pad ${pad + 1}${slice === null ? ', empty' : `, slice ${slice + 1}`}`}
          >
            {hit && <i key={lastPad.at} className="pad-flash" />}
            <kbd>{key.toUpperCase()}</kbd>
            <span>{slice === null ? '—' : `S${slice + 1}`}</span>
          </button>
        )
      })}
    </div>
  )
}

function PadsEditor({ clip, pattern }: { clip: Clip; pattern: Extract<Pattern, { kind: 'pads' }> }) {
  const studio = useStudio()
  const playing = useClipStep(clip, pattern)
  return (
    <div className="editor pads-editor">
      <div className="editor-bar">
        <LinkBar clip={clip} pattern={pattern} />
        <span className="muted legend">{pattern.hits.length} hits · {pattern.length / STEPS_PER_BAR} bars</span>
      </div>
      <div className="pads-split">
        <div className="bone grid-scroll">
          <div className="trigger-lane" style={{ gridTemplateColumns: `36px repeat(${pattern.length}, minmax(9px, 1fr))` }}>
            {Array.from({ length: 16 }, (_, pad) => (
              <div key={pad} style={{ display: 'contents' }}>
                <span className="note-label">P{pad + 1}</span>
                {Array.from({ length: pattern.length }, (_, i) => {
                  const on = pattern.hits.some((h) => h.pad === pad && h.step === i)
                  return <span key={i} className={`tcell${on ? ' is-on' : ''}${i % 16 === 0 ? ' bar' : i % 4 === 0 ? ' beat' : ''}${i === playing ? ' is-playing' : ''}`} />
                })}
              </div>
            ))}
          </div>
        </div>
        <PadGrid sample={studio.project.sample} />
      </div>
    </div>
  )
}

function updateSample(project: Project, patch: Partial<Sample>): Project {
  if (!project.sample) return project
  const sample = { ...project.sample, ...patch }
  sample.pads = sample.pads.map((slice) => (slice !== null && slice < sample.slices.length ? slice : null))
  return { ...project, sample }
}

const MODES: { id: SliceMode; label: string }[] = [
  { id: 'transient', label: 'Transient' },
  { id: 'equal', label: 'Equal 16' },
  { id: 'beat', label: 'Beat' },
  { id: 'bar', label: 'Bar' },
]

function ChopEditor({ sample }: { sample: Sample }) {
  const studio = useStudio()
  const { selection } = studio
  const peaks = useMemo(() => breakPeaks(sample.seed, 480), [sample.seed])
  const [analyzing, setAnalyzing] = useState(true)
  const svgRef = useRef<SVGSVGElement>(null)
  const drag = useRef<number | null>(null)
  const selectedSlice = selection.kind === 'sample' ? selection.slice : null

  useEffect(() => {
    setAnalyzing(true)
    const timer = window.setTimeout(() => setAnalyzing(false), 750)
    return () => window.clearTimeout(timer)
  }, [sample.id])

  const toFraction = (clientX: number) => {
    const rect = svgRef.current!.getBoundingClientRect()
    return clamp((clientX - rect.left) / rect.width, 0, 0.999)
  }
  const sliceAt = (x: number) => {
    let index = 0
    sample.slices.forEach((start, i) => {
      if (start <= x) index = i
    })
    return index
  }

  const onMarkerDown = (event: PointerEvent<SVGRectElement>, index: number) => {
    event.stopPropagation()
    ;(event.currentTarget as Element).setPointerCapture(event.pointerId)
    drag.current = index
    studio.select({ kind: 'sample', slice: index })
  }
  const onMove = (event: PointerEvent<SVGSVGElement>) => {
    const index = drag.current
    if (index === null) return
    const lower = index > 0 ? sample.slices[index - 1] + 0.005 : 0
    const upper = index < sample.slices.length - 1 ? sample.slices[index + 1] - 0.005 : 0.995
    const x = clamp(toFraction(event.clientX), lower, upper)
    const slices = sample.slices.map((s, i) => (i === index ? x : s))
    studio.commit('Move slice marker', (p) => updateSample(p, { slices }), { key: `slice-${index}` })
  }

  const grid = Array.from({ length: sample.bars * 4 }, (_, i) => i / (sample.bars * 4))
  const playheadSlice = selectedSlice ?? -1

  return (
    <div className="editor chop-editor">
      <div className="editor-bar">
        <div className="analysis">
          <strong className="file">{sample.name}</strong>
          {analyzing ? (
            <span className="analyzing">Detecting tempo, downbeat, and transients…</span>
          ) : (
            <>
              <span title="Detected tempo and confidence">
                {sample.bpm} BPM <em>{Math.round(sample.bpmConfidence * 100)}%</em>
              </span>
              <span title="Detected key and confidence">{sample.key ? <>{sample.key} <em className="low">{Math.round(sample.keyConfidence * 100)}%</em></> : 'Key: none detected'}</span>
              <span>{sample.bars} bars · {sample.slices.length} slices</span>
            </>
          )}
        </div>
        <div className="seg" role="radiogroup" aria-label="Slice mode">
          {MODES.map((mode) => (
            <button
              key={mode.id}
              type="button"
              role="radio"
              aria-checked={sample.mode === mode.id}
              className={sample.mode === mode.id ? 'is-on' : ''}
              onClick={() => studio.commit(`Slice by ${mode.label.toLowerCase()}`, (p) => updateSample(p, { mode: mode.id, slices: slicePositions(sample.seed, mode.id) }))}
            >
              {mode.label}
            </button>
          ))}
        </div>
        <button type="button" className="chip-btn" onClick={() => studio.commit('Distribute slices to pads', (p) => updateSample(p, { pads: distributeToPads(sample.slices) }))} title="Assign slices 1–16 to pads 1–16">
          Slices <ArrowRight size={12} /> pads
        </button>
        <button
          type="button"
          className={`chip-btn${studio.keysToPads ? ' is-on' : ''}`}
          aria-pressed={studio.keysToPads}
          onClick={() => studio.setKeysToPads(!studio.keysToPads)}
          title="When on, the keys M , . /  J K L ;  U I O P  7 8 9 0 play pads 1–16"
        >
          <Keyboard size={12} /> Keys → pads
        </button>
      </div>
      <div className="chop-split">
        <div className={`bone wave-wrap${analyzing ? ' is-analyzing' : ''}`}>
          <svg
            ref={svgRef}
            className="wave"
            viewBox="0 0 1000 140"
            preserveAspectRatio="none"
            onPointerMove={onMove}
            onPointerUp={() => (drag.current = null)}
            onPointerDown={(event) => {
              const index = sliceAt(toFraction(event.clientX))
              studio.select({ kind: 'sample', slice: index })
              const pad = sample.pads.indexOf(index)
              if (pad >= 0) studio.triggerPad(pad)
            }}
            onDoubleClick={(event) => {
              const x = toFraction(event.clientX)
              const slices = [...sample.slices, x].sort((a, b) => a - b)
              studio.commit('Add slice marker', (p) => updateSample(p, { slices }))
              studio.select({ kind: 'sample', slice: slices.indexOf(x) })
            }}
            role="img"
            aria-label={`Waveform of ${sample.name} with ${sample.slices.length} slices. Double-click to add a marker; drag markers to move them.`}
          >
            {grid.map((x, i) => (
              <line key={i} className={i % 4 === 0 ? 'wgrid bar' : 'wgrid'} x1={x * 1000} x2={x * 1000} y1={0} y2={140} />
            ))}
            {sample.slices.map((start, i) => {
              const end = sample.slices[i + 1] ?? 1
              return i === playheadSlice ? <rect key={`sel${i}`} className="slice-sel" x={start * 1000} width={(end - start) * 1000} y={0} height={140} /> : null
            })}
            {peaks.map((peak, i) => (
              <rect key={i} className="peak" x={(i / peaks.length) * 1000} width={1000 / peaks.length - 0.6} y={70 - peak * 64} height={Math.max(1, peak * 128)} />
            ))}
            {sample.slices.map((start, i) => (
              <g key={`m${i}`} className={`marker${i === playheadSlice ? ' is-selected' : ''}`}>
                <line x1={start * 1000} x2={start * 1000} y1={0} y2={140} />
                <rect x={start * 1000 - 1} y={0} width={18} height={14} onPointerDown={(event) => onMarkerDown(event, i)} />
                <text x={start * 1000 + 3} y={10}>
                  {i + 1}
                </text>
              </g>
            ))}
          </svg>
          {analyzing && <div className="scan" aria-hidden="true" />}
        </div>
        <PadGrid sample={sample} />
      </div>
    </div>
  )
}

function ChainEditor({ track }: { track: Track }) {
  const studio = useStudio()
  const stages = [
    { name: track.device, note: 'Source' },
    { name: track.kind === 'acid' ? 'Drive · Filter env' : track.kind === 'drum' ? 'Voice EQ' : 'Tone', note: 'Device FX' },
    { name: 'Empty slot', note: 'Insert FX', empty: true },
    { name: `${track.volume.toFixed(1)} dB · ${track.pan === 0 ? 'C' : track.pan < 0 ? `L${Math.round(-track.pan * 100)}` : `R${Math.round(track.pan * 100)}`}`, note: 'Fader / pan' },
    { name: `Delay ${Math.round(track.sends.delay.level * 100)}% ${track.sends.delay.tap} · Plate ${Math.round(track.sends.reverb.level * 100)}%`, note: 'Sends' },
    { name: 'Master', note: 'Output' },
  ]
  return (
    <div className="editor chain-editor">
      <div className="editor-bar">
        <span className="muted">Signal path for <b>{track.name}</b>. Select a clip to edit its pattern.</span>
        <button type="button" className="chip-btn" onClick={() => studio.setView('mix')}>
          Open in Mix
        </button>
      </div>
      <ol className="chain">
        {stages.map((stage, i) => (
          <li key={i} className={stage.empty ? 'is-empty' : undefined}>
            <small>{stage.note}</small>
            <strong>{stage.name}</strong>
          </li>
        ))}
      </ol>
    </div>
  )
}

function MacroRow({ track }: { track: Track }) {
  const studio = useStudio()
  return (
    <div className="macros" aria-label={`${track.name} macros`}>
      <span className="macros-label" style={{ '--track': track.color } as CSSProperties}>
        {track.name}
      </span>
      {MACRO_NAMES[track.kind].map((name, i) => (
        <Knob
          key={name}
          size="sm"
          label={name}
          value={track.macros[i]}
          onChange={(value) =>
            studio.commit(`Set ${track.name} ${name}`, (p) => updateTrack(p, track.id, { macros: track.macros.map((m, j) => (j === i ? value : m)) }), { key: `macro-${track.id}-${i}` })
          }
        />
      ))}
    </div>
  )
}

export function Dock() {
  const studio = useStudio()
  const { project, selection, view } = studio
  const editor = editorFor(view, selection, project)
  const [heights, setHeights] = useState<Partial<Record<EditorKind, number>>>({})
  const height = heights[editor] ?? Math.min(DEFAULT_HEIGHT[editor], Math.round(window.innerHeight * 0.46))
  const resize = useRef<{ y: number; height: number } | null>(null)
  const trackId = selectedTrackId(project, selection)
  const track = trackId ? trackById(project, trackId) : undefined
  const clip = selection.kind === 'clip' || selection.kind === 'step' ? clipById(project, selection.clipId) : undefined
  const pattern = clip ? project.patterns[clip.patternId] : undefined

  return (
    <section className="dock" style={{ height }} aria-label="Detail dock">
      <div
        className="dock-grip"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize dock"
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId)
          resize.current = { y: event.clientY, height }
        }}
        onPointerMove={(event) => {
          if (!resize.current) return
          const next = clamp(resize.current.height + resize.current.y - event.clientY, 180, 460)
          setHeights((h) => ({ ...h, [editor]: next }))
        }}
        onPointerUp={() => (resize.current = null)}
      />
      {track && view !== 'mix' && <MacroRow track={track} />}
      <div className="dock-body">
        {editor === 'mix' && <MixDock />}
        {editor === 'steps' && clip && pattern?.kind === 'notes' && track && <StepEditor key={pattern.id} clip={clip} pattern={pattern} track={track} />}
        {editor === 'drums' && clip && pattern?.kind === 'drums' && <DrumEditor clip={clip} pattern={pattern} />}
        {editor === 'pads' && clip && pattern?.kind === 'pads' && <PadsEditor clip={clip} pattern={pattern} />}
        {editor === 'chop' && project.sample && <ChopEditor sample={project.sample} />}
        {editor === 'chain' && track && <ChainEditor track={track} />}
        {editor === 'empty' && (
          <div className="dock-empty">
            <p>Select a clip to edit it here. The dock always shows the editor for the current selection.</p>
            <ul>
              <li>
                <kbd>Double-click</kbd> an empty lane to create a clip
              </li>
              <li>
                <kbd>Ctrl D</kbd> duplicates the selected clip as a linked repeat
              </li>
              <li>
                <kbd>Ctrl K</kbd> opens the command palette and agent
              </li>
            </ul>
          </div>
        )}
      </div>
    </section>
  )
}

import { Keyboard, Link2, Minus, Plus, Unlink } from 'lucide-react'
import { type CSSProperties, useRef, useState } from 'react'
import { studio } from '@reborn/studio-core'
import { engine, usePlayhead } from '../audio/host'
import { modifiers } from '../state/modifiers'
import { dispatch, getState, select, selectedTrackId, setPrefs, useStudio } from '../state/store'
import { AudioClipEditor, ChopEditor, PadGrid } from './SampleEditors'
import { Knob } from './Controls'
import { MixDock } from './MixDock'

type Clip = studio.Clip
type Pattern = studio.Pattern
type NotePattern = studio.NotePattern
type DrumPattern = studio.DrumPattern
type PadPattern = studio.PadPattern
type Track = studio.Track

type Editor = 'steps' | 'drums' | 'pads' | 'chop' | 'audio' | 'lane' | 'chain' | 'mix' | 'empty'

const DEFAULT_HEIGHT: Record<Editor, number> = { steps: 330, drums: 340, pads: 330, chop: 340, audio: 300, lane: 260, chain: 230, mix: 330, empty: 190 }

function useEditor(): { editor: Editor; track?: Track; clip?: Clip; pattern?: Pattern } {
  const view = useStudio((s) => s.view)
  const selection = useStudio((s) => s.selection)
  const project = useStudio((s) => s.project)
  if (view === 'mix' && !['clip', 'step'].includes(selection.kind)) return { editor: 'mix' }
  const trackId = selectedTrackId(getState())
  const track = trackId ? project.tracks.find((t) => t.id === trackId) : undefined
  if (selection.kind === 'clip' || selection.kind === 'step') {
    const clip = project.clips.find((c) => c.id === selection.clipId)
    if (!clip) return { editor: 'empty' }
    if (clip.assetId) return { editor: 'audio', track, clip }
    const pattern = clip.patternId ? project.patterns[clip.patternId] : undefined
    if (!pattern) return { editor: 'empty' }
    return { editor: pattern.kind === 'notes' ? 'steps' : pattern.kind === 'drums' ? 'drums' : 'pads', track, clip, pattern }
  }
  if (selection.kind === 'lane') return { editor: 'lane', track }
  if ((selection.kind === 'slice' || selection.kind === 'pad') && track) return { editor: 'chop', track }
  if (selection.kind === 'track' && track) return { editor: track.kind === 'sampler' && track.device.kind === 'sampler' && track.device.source ? 'chop' : 'chain', track }
  if (view === 'mix') return { editor: 'mix' }
  return { editor: 'empty' }
}

function useClipStep(clip: Clip | undefined, pattern: Pattern | undefined) {
  return usePlayhead((bar) => {
    if (!clip || !pattern || !getState().transport.playing || bar < clip.start || bar >= studio.clipEnd(clip)) return -1
    return Math.floor((bar - clip.start + clip.offset) * pattern.division) % pattern.length
  })
}

function LinkBar({ clip, pattern }: { clip: Clip; pattern: Pattern }) {
  const links = useStudio((s) => studio.linkCount(s.project, pattern.id))
  return (
    <div className={`link-bar${links > 1 ? ' is-linked' : ''}`}>
      {links > 1 ? (
        <>
          <Link2 size={13} />
          <span>
            <b>{pattern.name}</b> is used by {links} clips. Edits change all of them.
          </span>
          <button type="button" className="chip-btn" onClick={() => dispatch({ type: 'clip.makeUnique', params: { clipId: clip.id } }, { label: `Make ${pattern.name} unique` })}>
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
  const set = (patch: Record<string, number>) => dispatch({ type: 'pattern.update', params: { patternId: pattern.id, ...patch } }, { label: 'Change pattern length', key: `len-${pattern.id}` })
  return (
    <div className="length-ctl" title="Steps per cycle (1–64) and step size. Each track can use its own length.">
      <span>Length</span>
      <button type="button" className="icon-btn sm" aria-label="Shorter pattern" onClick={() => set({ length: Math.max(1, pattern.length - 1) })}>
        <Minus size={12} />
      </button>
      <output>{pattern.length}</output>
      <button type="button" className="icon-btn sm" aria-label="Longer pattern" onClick={() => set({ length: Math.min(64, pattern.length + 1) })}>
        <Plus size={12} />
      </button>
      <select value={pattern.division} aria-label="Step size" onChange={(event) => set({ division: Number(event.target.value) })}>
        {[4, 8, 16, 32, 64].map((d) => (
          <option key={d} value={d}>
            1/{d}
          </option>
        ))}
      </select>
    </div>
  )
}

const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B']
const isSharp = (midi: number) => NOTE_NAMES[((midi % 12) + 12) % 12].includes('♯')

function NoteEditor({ clip, pattern, track }: { clip: Clip; pattern: NotePattern; track: Track }) {
  const selection = useStudio((s) => s.selection)
  const playing = useClipStep(clip, pattern)
  const [mode, setMode] = useState<'roll' | 'steps'>('roll')
  const notes = pattern.steps.filter((s) => s.on).map((s) => s.note)
  const lowest = notes.length ? Math.min(...notes) : (pattern.steps[0]?.note ?? 36)
  const [low, setLow] = useState(() => Math.floor(lowest / 12) * 12)
  const rows = Array.from({ length: 13 }, (_, i) => low + 12 - i)
  const selectedIndex = selection.kind === 'step' && selection.clipId === clip.id ? selection.index : -1
  const edit = (label: string, index: number, patch: Record<string, unknown>) => {
    dispatch({ type: 'step.set', params: { patternId: pattern.id, index, ...patch } }, { label })
    select({ kind: 'step', clipId: clip.id, index })
    if (patch.on && typeof patch.note === 'number') void engine.previewNote(track.id, patch.note as number)
  }
  const columns = `44px repeat(${pattern.length}, minmax(20px, 1fr))`
  return (
    <div className="editor steps-editor">
      <div className="editor-bar">
        <LinkBar clip={clip} pattern={pattern} />
        <LengthControl pattern={pattern} />
        <div className="seg sm" role="radiogroup" aria-label="Editor style">
          <button type="button" role="radio" aria-checked={mode === 'roll'} className={mode === 'roll' ? 'is-on' : ''} onClick={() => setMode('roll')}>
            Piano roll
          </button>
          <button type="button" role="radio" aria-checked={mode === 'steps'} className={mode === 'steps' ? 'is-on' : ''} onClick={() => setMode('steps')}>
            Step row
          </button>
        </div>
        {mode === 'roll' && (
          <div className="octave-ctl">
            <button type="button" className="icon-btn sm" aria-label="Lower octave" onClick={() => setLow(Math.max(0, low - 12))}>
              <Minus size={12} />
            </button>
            <span>
              {studio.noteName(low)}–{studio.noteName(low + 12)}
            </span>
            <button type="button" className="icon-btn sm" aria-label="Higher octave" onClick={() => setLow(Math.min(108, low + 12))}>
              <Plus size={12} />
            </button>
          </div>
        )}
      </div>
      {mode === 'roll' ? (
        <div className="bone grid-scroll">
          <div className="note-grid" style={{ gridTemplateColumns: columns }}>
            <span className="grid-corner" />
            {pattern.steps.map((_, i) => (
              <button key={`h${i}`} type="button" className={`step-head${i % 4 === 0 ? ' beat' : ''}${i === selectedIndex ? ' is-selected' : ''}${i === playing ? ' is-playing' : ''}`} onClick={() => select({ kind: 'step', clipId: clip.id, index: i })} aria-label={`Select step ${i + 1}`}>
                {i + 1}
              </button>
            ))}
            {rows.map((note) => (
              <div key={note} style={{ display: 'contents' }}>
                <span className="note-label">{note % 12 === 0 || note === rows[0] ? studio.noteName(note) : NOTE_NAMES[note % 12]}</span>
                {pattern.steps.map((step, i) => {
                  const on = step.on && step.note === note
                  return (
                    <button
                      key={i}
                      type="button"
                      className={`cell${on ? ' is-on' : ''}${on && step.accent ? ' accent' : ''}${on && step.slide ? ' slide' : ''}${on && Object.keys(step.locks).length ? ' locked' : ''}${i % 4 === 0 ? ' beat' : ''}${i === playing ? ' is-playing' : ''}${i === selectedIndex ? ' col-selected' : ''}${isSharp(note) ? ' sharp' : ''}`}
                      aria-label={`${studio.noteName(note)} on step ${i + 1}${on ? ', on' : ''}`}
                      aria-pressed={on}
                      onClick={() => edit(on ? 'Clear step' : 'Set note', i, on ? { on: false } : { on: true, note })}
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
      ) : (
        <div className="step-row-wrap">
          <div className="step-row" style={{ gridTemplateColumns: `repeat(${Math.min(16, pattern.length)}, minmax(52px, 1fr))` }}>
            {pattern.steps.map((step, i) => (
              <div key={i} className={`step-tile${step.on ? ' is-on' : ''}${i === playing ? ' is-playing' : ''}${i === selectedIndex ? ' is-selected' : ''}`}>
                <button type="button" className="step-led" aria-pressed={step.on} aria-label={`Step ${i + 1} ${step.on ? 'on' : 'off'}`} onClick={() => edit('Toggle step', i, { on: !step.on, note: step.note })} />
                <button type="button" className="step-note" onClick={() => select({ kind: 'step', clipId: clip.id, index: i })} title="Select to edit the note in the inspector">
                  {studio.noteName(step.note)}
                </button>
                <div className="step-flags">
                  <button type="button" className={step.accent ? 'is-on accent' : ''} aria-pressed={step.accent} onClick={() => edit('Toggle accent', i, { accent: !step.accent })} aria-label={`Accent step ${i + 1}`}>
                    Acc
                  </button>
                  <button type="button" className={step.slide ? 'is-on' : ''} aria-pressed={step.slide} onClick={() => edit('Toggle slide', i, { slide: !step.slide })} aria-label={`Slide step ${i + 1}`}>
                    Sld
                  </button>
                </div>
                <div className="step-oct">
                  <button type="button" aria-label={`Step ${i + 1} octave down`} onClick={() => edit('Octave down', i, { note: Math.max(0, step.note - 12) })}>
                    −
                  </button>
                  <button type="button" aria-label={`Step ${i + 1} octave up`} onClick={() => edit('Octave up', i, { note: Math.min(127, step.note + 12) })}>
                    +
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function DrumEditor({ clip, pattern, track }: { clip: Clip; pattern: DrumPattern; track: Track }) {
  const playing = useClipStep(clip, pattern)
  const selection = useStudio((s) => s.selection)
  const voices = track.device.kind === 'drum' ? track.device.voices : null
  return (
    <div className="editor drums-editor">
      <div className="editor-bar">
        <LinkBar clip={clip} pattern={pattern} />
        <LengthControl pattern={pattern} />
        <span className="muted legend">Click: off → hit → accent. Right-click selects the step for probability, ratchet, and locks.</span>
      </div>
      <div className="bone grid-scroll">
        <div className="drum-grid" style={{ gridTemplateColumns: `52px repeat(${pattern.length}, minmax(20px, 1fr))` }}>
          {studio.DRUM_VOICES.map((voice) => (
            <div key={voice} style={{ display: 'contents' }}>
              <button type="button" className={`note-label drum-voice${voices?.[voice].mute ? ' is-muted' : ''}`} onClick={() => void engine.previewDrum(track.id, voice)} title="Click to audition">
                {studio.DRUM_VOICE_LABELS[voice]}
              </button>
              {pattern.lanes[voice].map((hit, i) => {
                const selected = selection.kind === 'step' && selection.clipId === clip.id && selection.index === i && selection.voice === voice
                return (
                  <button
                    key={i}
                    type="button"
                    className={`cell drum${hit.on ? ' is-on' : ''}${hit.accent ? ' accent' : ''}${hit.probability < 100 || hit.ratchet > 1 ? ' modded' : ''}${i % 4 === 0 ? ' beat' : ''}${i === playing ? ' is-playing' : ''}${selected ? ' col-selected' : ''}`}
                    aria-label={`${studio.DRUM_VOICE_LABELS[voice]} step ${i + 1}: ${hit.on ? (hit.accent ? 'accent' : 'hit') : 'off'}`}
                    onClick={() => {
                      const next = !hit.on ? { on: true, accent: false } : !hit.accent ? { on: true, accent: true } : { on: false, accent: false }
                      dispatch({ type: 'drum.step.set', params: { patternId: pattern.id, voice, index: i, ...next } }, { label: `Edit ${studio.DRUM_VOICE_LABELS[voice]}` })
                      if (next.on) void engine.previewDrum(track.id, voice, 100, next.accent)
                    }}
                    onContextMenu={(event) => {
                      event.preventDefault()
                      select({ kind: 'step', clipId: clip.id, index: i, voice })
                    }}
                  />
                )
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function PadsEditor({ clip, pattern, track }: { clip: Clip; pattern: PadPattern; track: Track }) {
  const playing = useClipStep(clip, pattern)
  return (
    <div className="editor pads-editor">
      <div className="editor-bar">
        <LinkBar clip={clip} pattern={pattern} />
        <LengthControl pattern={pattern} />
        <span className="muted legend">
          {pattern.hits.length} hits · click the lane to add or remove hits
        </span>
      </div>
      <div className="pads-split">
        <div className="bone grid-scroll">
          <div className="trigger-lane" style={{ gridTemplateColumns: `36px repeat(${pattern.length}, minmax(9px, 1fr))` }}>
            {Array.from({ length: 16 }, (_, pad) => (
              <div key={pad} style={{ display: 'contents' }}>
                <span className="note-label">P{pad + 1}</span>
                {Array.from({ length: pattern.length }, (_, i) => {
                  const on = pattern.hits.some((h) => h.pad === pad && h.step === i)
                  return (
                    <button
                      key={i}
                      type="button"
                      className={`tcell${on ? ' is-on' : ''}${i % 16 === 0 ? ' bar' : i % 4 === 0 ? ' beat' : ''}${i === playing ? ' is-playing' : ''}`}
                      aria-label={`Pad ${pad + 1} step ${i + 1}${on ? ', on' : ''}`}
                      onClick={() => dispatch({ type: 'pad.hit', params: { patternId: pattern.id, step: i, pad, velocity: on ? 0 : 100 } }, { label: on ? 'Remove pad hit' : 'Add pad hit' })}
                    />
                  )
                })}
              </div>
            ))}
          </div>
        </div>
        <PadGrid track={track} />
      </div>
    </div>
  )
}

function LaneEditor({ track }: { track: Track }) {
  const selection = useStudio((s) => s.selection)
  const length = useStudio((s) => s.project.length)
  if (selection.kind !== 'lane') return null
  const spec = studio.findParamSpec(track, selection.param)
  return (
    <div className="editor lane-editor">
      <div className="editor-bar">
        <strong className="panel-title">{spec?.label ?? selection.param} automation</strong>
        <span className="muted">Edit points on the lane in Arrange: click to add, drag to move, Alt-click to remove. Locks on steps win over automation.</span>
        <button type="button" className="chip-btn" onClick={() => dispatch({ type: 'automation.clear', params: { trackId: track.id, param: selection.param } }, { label: 'Clear automation' })}>
          Clear lane
        </button>
      </div>
      <p className="precedence pad-x">device {spec ? studio.formatParam(spec, studio.getParam(track, selection.param) ?? spec.default) : ''} → arrangement automation (bars 1–{length}) → step locks</p>
    </div>
  )
}

function ChainView({ track }: { track: Track }) {
  const returns = useStudio((s) => s.project.returns)
  const ins = track.inserts
  const setInsert = (param: string, value: number) => dispatch({ type: 'parameter.set', params: { trackId: track.id, param, value } }, { label: `${track.name} ${param.split('.')[1]}`, key: `ins-${track.id}-${param}` })
  return (
    <div className="editor chain-editor">
      <div className="editor-bar">
        <span className="muted">
          Signal path for <b>{track.name}</b>. Select a clip to edit its pattern; device controls are in the inspector.
        </span>
      </div>
      <ol className="chain">
        <li>
          <small>Source</small>
          <strong>{studio.DEVICE_NAMES[track.kind]}</strong>
        </li>
        <li className="chain-inserts">
          <small>Insert EQ · filter · drive</small>
          <div className="chain-knobs">
            <Knob size="sm" label="Low" value={(ins.eqLow + 12) / 24} defaultValue={0.5} format={(v) => `${(v * 24 - 12).toFixed(1)} dB`} onChange={(v) => setInsert('insert.eqLow', v * 24 - 12)} />
            <Knob size="sm" label="Mid" value={(ins.eqMid + 12) / 24} defaultValue={0.5} format={(v) => `${(v * 24 - 12).toFixed(1)} dB`} onChange={(v) => setInsert('insert.eqMid', v * 24 - 12)} />
            <Knob size="sm" label="High" value={(ins.eqHigh + 12) / 24} defaultValue={0.5} format={(v) => `${(v * 24 - 12).toFixed(1)} dB`} onChange={(v) => setInsert('insert.eqHigh', v * 24 - 12)} />
            <Knob size="sm" label="Filter" value={(ins.filter + 1) / 2} defaultValue={0.5} format={(v) => (Math.abs(v - 0.5) < 0.01 ? 'Off' : v < 0.5 ? `HP ${Math.round((0.5 - v) * 200)}` : `LP ${Math.round((v - 0.5) * 200)}`)} onChange={(v) => setInsert('insert.filter', v * 2 - 1)} />
            <Knob size="sm" label="Drive" value={ins.drive} defaultValue={0} onChange={(v) => setInsert('insert.drive', v)} />
          </div>
        </li>
        <li>
          <small>Fader · pan</small>
          <strong>
            {track.mixer.volume.toFixed(1)} dB · {Math.abs(track.mixer.pan) < 0.01 ? 'C' : track.mixer.pan < 0 ? `L${Math.round(-track.mixer.pan * 100)}` : `R${Math.round(track.mixer.pan * 100)}`}
          </strong>
        </li>
        <li>
          <small>Sends</small>
          <strong>{returns.map((r) => `${r.name} ${Math.round((track.mixer.sends[r.id]?.level ?? 0) * 100)}% ${track.mixer.sends[r.id]?.tap ?? 'post'}`).join(' · ')}</strong>
        </li>
        <li>
          <small>Output</small>
          <strong>{track.mixer.output === 'master' ? 'Master' : (getState().project.tracks.find((t) => t.id === track.mixer.output)?.name ?? 'Master')}</strong>
        </li>
      </ol>
    </div>
  )
}

function MacroRow({ track }: { track: Track }) {
  const selection = useStudio((s) => s.selection)
  const stepTarget = selection.kind === 'step' ? getState().project.clips.find((c) => c.id === selection.clipId) : undefined
  return (
    <div className="macros" aria-label={`${track.name} macros`}>
      <span className="macros-label" style={{ '--track': track.color } as CSSProperties}>
        {track.name}
      </span>
      {track.macros.map((macro, index) => (
        <Knob
          key={macro.name}
          size="sm"
          label={macro.name}
          value={macro.value}
          onChange={(value) => {
            const altLock = modifiers.alt && stepTarget && selection.kind === 'step'
            if (altLock && stepTarget?.patternId) {
              const target = macro.targets[0]
              if (!target) return
              const pattern = getState().project.patterns[stepTarget.patternId]
              const locked = target.min + (target.max - target.min) * value
              if (pattern?.kind === 'notes') dispatch({ type: 'step.set', params: { patternId: pattern.id, index: selection.index, locks: { [target.param]: locked } } }, { label: `Lock ${macro.name} on step ${selection.index + 1}`, key: `lock-${pattern.id}-${selection.index}-${target.param}` })
              else if (pattern?.kind === 'drums' && selection.voice) dispatch({ type: 'drum.step.set', params: { patternId: pattern.id, voice: selection.voice, index: selection.index, locks: { [target.param]: locked } } }, { label: `Lock ${macro.name} on step ${selection.index + 1}`, key: `lock-${pattern.id}-${selection.index}-${target.param}` })
              return
            }
            dispatch({ type: 'macro.set', params: { trackId: track.id, index, value } }, { label: `${track.name} ${macro.name}`, key: `macro-${track.id}-${index}` })
            recordMacroMove(track.id, index, value)
          }}
        />
      ))}
      {selection.kind === 'step' && <span className="lock-hint">Hold Alt while turning to lock a value to step {selection.index + 1}</span>}
    </div>
  )
}

/** While recording and playing, macro moves become arrangement automation. */
function recordMacroMove(trackId: string, index: number, value: number) {
  const s = getState()
  if (!s.recording || !s.transport.playing) return
  const track = s.project.tracks.find((t) => t.id === trackId)
  const target = track?.macros[index]?.targets[0]
  if (!target) return
  const bar = Math.round(engine.position() * 16) / 16
  dispatch({ type: 'automation.write', params: { trackId, param: target.param, points: [{ bar, value: target.min + (target.max - target.min) * value }] } }, { label: 'Record automation', key: `rec-${trackId}-${index}` })
}

export function Dock() {
  const { editor, track, clip, pattern } = useEditor()
  const heights = useStudio((s) => s.prefs.dockHeights)
  const height = heights[editor] ?? Math.min(DEFAULT_HEIGHT[editor], Math.round(window.innerHeight * 0.44))
  const resize = useRef<{ y: number; height: number } | null>(null)
  const keysToPads = useStudio((s) => s.prefs.keysToPads)
  return (
    <section className="dock" style={{ height }} aria-label="Detail dock" data-region="dock" tabIndex={-1}>
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
          const next = Math.max(160, Math.min(480, resize.current.height + resize.current.y - event.clientY))
          setPrefs({ dockHeights: { ...getState().prefs.dockHeights, [editor]: next } })
        }}
        onPointerUp={() => (resize.current = null)}
      />
      {track && editor !== 'mix' && track.macros.length > 0 && <MacroRow track={track} />}
      <div className="dock-body">
        {editor === 'mix' && <MixDock />}
        {editor === 'steps' && clip && pattern?.kind === 'notes' && track && <NoteEditor key={pattern.id} clip={clip} pattern={pattern} track={track} />}
        {editor === 'drums' && clip && pattern?.kind === 'drums' && track && <DrumEditor clip={clip} pattern={pattern} track={track} />}
        {editor === 'pads' && clip && pattern?.kind === 'pads' && track && <PadsEditor clip={clip} pattern={pattern} track={track} />}
        {editor === 'chop' && track && <ChopEditor track={track} />}
        {editor === 'audio' && clip && <AudioClipEditor clip={clip} />}
        {editor === 'lane' && track && <LaneEditor track={track} />}
        {editor === 'chain' && track && <ChainView track={track} />}
        {editor === 'empty' && (
          <div className="dock-empty">
            <p>Select a clip, track, or lane. The dock always shows the editor for the current selection.</p>
            <ul>
              <li>
                <kbd>Double-click</kbd> an empty lane to create a clip
              </li>
              <li>
                <kbd>Ctrl D</kbd> duplicates the selected clip as a linked repeat
              </li>
              <li>
                <kbd>Ctrl K</kbd> opens the command palette
              </li>
              <li>
                <kbd>F1</kbd> opens help and the shortcut map
              </li>
            </ul>
            <button type="button" className="chip-btn" aria-pressed={keysToPads} onClick={() => setPrefs({ keysToPads: !keysToPads })}>
              <Keyboard size={13} />
              {keysToPads ? 'Computer keys play instruments: on' : 'Play instruments with computer keys'}
            </button>
            {keysToPads && <p className="muted small">Computer keys play the selected instrument: A–K for notes (Z and X change octave), or the pad grid on a Sampler.</p>}
          </div>
        )}
      </div>
    </section>
  )
}

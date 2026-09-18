import { useCallback, useEffect, useRef, useState } from 'react'
import {
  CircleHelp, Disc3, Download, FileDown, FolderOpen, Gauge, Headphones, Keyboard as KeyboardIcon,
  Minus, Pause, Play, Plus, Radio, Redo2, RotateCcw, Save, SkipBack,
  SkipForward, Square, Trash2, Undo2, Upload, Waves,
} from 'lucide-react'
import { drumNames, fxPadNames, hydrateProject, normalizeSongScenes, restoreBassDefaults, restoreDeckDefaults, restoreRhythmDefaults, restoreSamplerDefaults, restoreWaveDefaults, transferWaveToBass, wipeBassPattern, wipeRhythmPattern, wipeSamplerPattern, wipeWavePattern, type BassVoice, type DeckState, type DesignerWaveform, type DrumName, type DrumStep, type ProjectState, type RhythmMachineState, type SamplerState, type WaveDesignerState } from './model'
import { GrooveEngine, isMixerChannelAudible, type DeckPlaybackState } from './audio/engine'
import { deleteProject, listProjects, loadProject, saveProject, type ProjectSummary } from './state/projectStore'
import { deleteAudioAsset, restoreProjectAudioAssets, saveAudioAsset } from './state/audioAssetStore'
import { DUBSTEP_SONG_CHAIN, applyDubstepBarAutomation } from './demo/dubstepDemo'
import { createDemoProject, demoCatalog, type DemoId } from './demo/catalog'

const noteNames = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B']
const blackKeyPositions = [12.5, 25, 50, 62.5, 75]
const tonalKeyOffsets: Record<string, number> = {
  KeyZ: 0, KeyS: 1, KeyX: 2, KeyD: 3, KeyC: 4, KeyV: 5, KeyG: 6,
  KeyB: 7, KeyH: 8, KeyN: 9, KeyJ: 10, KeyM: 11, Comma: 12,
  KeyQ: 12, Digit2: 13, KeyW: 14, Digit3: 15, KeyE: 16, KeyR: 17,
  Digit5: 18, KeyT: 19, Digit6: 20, KeyY: 21, Digit7: 22, KeyU: 23, KeyI: 24,
}
const triggerKeyCodes = ['KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyT', 'KeyY', 'KeyU', 'KeyI', 'KeyO', 'KeyP', 'BracketLeft', 'BracketRight']
type KeyboardTarget = 'bass-0' | 'bass-1' | 'wave' | 'drums-0' | 'drums-1' | 'sampler' | 'fx'
const keyboardTargets: Array<{ id: KeyboardTarget; label: string }> = [
  { id: 'bass-0', label: '303·1' }, { id: 'bass-1', label: '303·2' }, { id: 'wave', label: 'WAVE' },
  { id: 'drums-0', label: '808' }, { id: 'drums-1', label: '909' }, { id: 'sampler', label: 'SAMPLE' }, { id: 'fx', label: 'FX' },
]

type KnobProps = {
  label: string
  value: number
  onChange: (value: number) => void
  accent?: 'acid' | 'amber' | 'silver'
  compact?: boolean
  bipolar?: boolean
}

function Knob({ label, value, onChange, accent = 'acid', compact, bipolar }: KnobProps) {
  const normalized = bipolar ? (value + 100) / 2 : value
  const angle = -135 + normalized * 2.7
  const inputRef = useRef<HTMLInputElement>(null)
  const drag = useRef<{ y: number; value: number } | null>(null)
  const clampValue = (next: number) => Math.max(bipolar ? -100 : 0, Math.min(100, Math.round(next)))
  return (
    <label className={`knob-control ${compact ? 'compact' : ''}`} title={`${label}: ${Math.round(value)}`}>
      <span
        className={`knob knob-${accent}`}
        style={{ '--angle': `${angle}deg` } as React.CSSProperties}
        onPointerDown={(event) => { if (event.button !== 0) return; drag.current = { y: event.clientY, value }; event.currentTarget.setPointerCapture(event.pointerId); inputRef.current?.focus() }}
        onPointerMove={(event) => { if (!drag.current) return; const precision = event.shiftKey ? 0.18 : 0.9; onChange(clampValue(drag.current.value + (drag.current.y - event.clientY) * precision)) }}
        onPointerUp={(event) => { drag.current = null; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId) }}
        onPointerCancel={() => { drag.current = null }}
        onWheel={(event) => { event.preventDefault(); onChange(clampValue(value + (event.deltaY < 0 ? 1 : -1) * (event.shiftKey ? 1 : 3))) }}
        onDoubleClick={() => onChange(bipolar ? 0 : 50)}
      >
        <span className="knob-cap"><i /></span>
        <input
          ref={inputRef}
          aria-label={label}
          type="range"
          min={bipolar ? -100 : 0}
          max="100"
          value={value}
          onChange={(event) => onChange(Number(event.target.value))}
        />
      </span>
      <span className="control-label">{label}</span>
      <output>{value > 0 && bipolar ? '+' : ''}{Math.round(value)}</output>
    </label>
  )
}

function Screw({ dark = false }: { dark?: boolean }) {
  return <i className={`screw ${dark ? 'dark' : ''}`} aria-hidden="true" />
}

function IconButton({ label, active, danger, onClick, children }: { label: string; active?: boolean; danger?: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button className={`icon-button ${active ? 'active' : ''} ${danger ? 'danger' : ''}`} aria-label={label} aria-pressed={active === undefined ? undefined : active} title={label} onClick={onClick}>{children}</button>
}

function PatternSelector({ bank, pattern, onBank, onPattern }: { bank: number; pattern: number; onBank: (bank: number) => void; onPattern: (pattern: number) => void }) {
  return (
    <div className="pattern-selector">
      <span className="micro-title">PATTERN MEMORY</span>
      <div className="pattern-row banks">
        {['A', 'B', 'C', 'D'].map((item, index) => <button key={item} aria-pressed={bank === index} className={bank === index ? 'selected' : ''} onClick={() => onBank(index)}>{item}</button>)}
      </div>
      <div className="pattern-row numbers">
        {Array.from({ length: 8 }, (_, index) => <button key={index} aria-pressed={pattern === index} className={pattern === index ? 'selected' : ''} onClick={() => onPattern(index)}>{index + 1}</button>)}
      </div>
    </div>
  )
}

function WaveSwitch({ value, onChange }: { value: BassVoice['waveform']; onChange: (value: BassVoice['waveform']) => void }) {
  return (
    <div className="wave-switch" aria-label="Oscillator waveform">
      <button aria-pressed={value === 'sawtooth'} className={value === 'sawtooth' ? 'selected' : ''} onClick={() => onChange('sawtooth')}><span className="wave-icon saw" />SAW</button>
      <button aria-pressed={value === 'square'} className={value === 'square' ? 'selected' : ''} onClick={() => onChange('square')}><span className="wave-icon square" />SQR</button>
    </div>
  )
}

function PianoKeyboard({ selected, onPlay }: { selected: number; onPlay: (note: number) => void }) {
  const [octave, setOctave] = useState(() => Math.max(-2, Math.min(5, Math.floor(selected / 12) - 3)))
  const keyboardNotes = Array.from({ length: 13 }, (_, index) => 36 + octave * 12 + index)
  const whiteKeyboardNotes = keyboardNotes.filter((note) => ![1, 3, 6, 8, 10].includes(note % 12))
  const blackKeyboardNotes = keyboardNotes.filter((note) => [1, 3, 6, 8, 10].includes(note % 12))
  const key = (note: number, black = false, left?: number) => (
    <button
      key={note}
      type="button"
      className={`${black ? 'black-key' : 'white-key'} ${selected === note ? 'selected' : ''}`}
      style={black ? ({ '--key-left': `${left}%` } as React.CSSProperties) : undefined}
      onClick={() => onPlay(note)}
      aria-label={`${noteNames[note % 12]}${Math.floor(note / 12) - 1}`}
    >
      <span>{noteNames[note % 12]}<sup>{Math.floor(note / 12) - 1}</sup></span>
    </button>
  )
  return <div className="piano-keyboard-control" role="group" aria-label={`Piano keyboard octave ${octave + 2}`}>
    <button className="piano-octave-button" aria-label="Piano octave down" disabled={octave <= -2} onClick={() => setOctave((value) => Math.max(-2, value - 1))}>−</button>
    <div className="piano-keyboard" role="group" aria-label={`Piano notes in octave ${octave + 2}`}>
      <div className="white-keys">{whiteKeyboardNotes.map((note) => key(note))}</div>
      <div className="black-keys">{blackKeyboardNotes.map((note, index) => key(note, true, blackKeyPositions[index]))}</div>
      <span className="piano-octave-readout">OCT {octave + 2}</span>
    </div>
    <button className="piano-octave-button" aria-label="Piano octave up" disabled={octave >= 5} onClick={() => setOctave((value) => Math.min(5, value + 1))}>+</button>
  </div>
}

const lowerToneCodes = ['KeyZ', 'KeyS', 'KeyX', 'KeyD', 'KeyC', 'KeyV', 'KeyG', 'KeyB', 'KeyH', 'KeyN', 'KeyJ', 'KeyM', 'Comma']
const upperToneCodes = ['KeyQ', 'Digit2', 'KeyW', 'Digit3', 'KeyE', 'KeyR', 'Digit5', 'KeyT', 'Digit6', 'KeyY', 'Digit7', 'KeyU', 'KeyI']
const levelKeyCodes = [...lowerToneCodes, ...upperToneCodes.slice(0, 3)]
const displayKey = (code: string) => code === 'Comma' ? ',' : code === 'BracketLeft' ? '[' : code === 'BracketRight' ? ']' : code.replace('Key', '').replace('Digit', '')

function ComputerKeyboard({ target, octave, pressed, sampler, onTarget, onOctave }: { target: KeyboardTarget; octave: number; pressed: ReadonlySet<string>; sampler: SamplerState; onTarget: (target: KeyboardTarget) => void; onOctave: (octave: number) => void }) {
  const tonal = target === 'bass-0' || target === 'bass-1' || target === 'wave'
  const levels = target === 'sampler' && sampler.sixteenLevels !== 'off'
  const triggerLabels = levels
    ? Array.from({ length: 16 }, (_, index) => sampler.sixteenLevels === 'velocity' ? `${Math.round((index + 1) / 16 * 127)}` : `${Math.round(-12 + index / 15 * 24) > 0 ? '+' : ''}${Math.round(-12 + index / 15 * 24)}`)
    : target.startsWith('drums')
    ? drumNames.map((name) => drumLabels[name])
    : target === 'sampler'
      ? Array.from({ length: 8 }, (_, index) => `S${index + 1}`)
      : fxPadNames.map((name) => name.replace(/([A-Z])/g, ' $1').slice(0, 5).toUpperCase())
  const toneRow = (codes: string[]) => <div className="key-map-row">{codes.map((code) => {
    const note = 36 + octave * 12 + tonalKeyOffsets[code]
    return <span key={code} className={pressed.has(code) ? 'pressed' : ''}><kbd>{displayKey(code)}</kbd><small>{noteNames[note % 12]}{Math.floor(note / 12) - 1}</small></span>
  })}</div>
  return <section className="computer-keyboard" aria-label="Computer keyboard performance control">
    <div className="keyboard-heading"><KeyboardIcon /><div><span>PERFORMANCE INPUT</span><strong>COMPUTER KEYS</strong></div><i className="input-live">LIVE</i></div>
    <div className="keyboard-targets" role="group" aria-label="Keyboard target">{keyboardTargets.map((item) => <button key={item.id} aria-pressed={target === item.id} className={target === item.id ? 'active' : ''} onClick={() => onTarget(item.id)}>{item.label}</button>)}</div>
    <div className={`keyboard-map ${tonal ? 'tonal' : 'trigger'}`} aria-label={tonal ? 'Tonal keyboard map' : 'Trigger key map'}>
      {tonal ? <>{toneRow(upperToneCodes)}{toneRow(lowerToneCodes)}</> : <div className="key-map-row">{triggerLabels.map((label, index) => { const code = levels ? levelKeyCodes[index] : triggerKeyCodes[index]; return <span key={`${label}-${index}`} className={pressed.has(code) ? 'pressed' : ''}><kbd>{displayKey(code)}</kbd><small>{label}</small></span> })}</div>}
    </div>
    <div className="octave-control"><button aria-label="Keyboard octave down" disabled={!tonal || octave <= -2} onClick={() => onOctave(octave - 1)}>−</button><span>{tonal ? `OCT ${octave + 2}–${octave + 4}` : levels ? `16 ${sampler.sixteenLevels.toUpperCase()}` : `${triggerLabels.length} VOICES`}</span><button aria-label="Keyboard octave up" disabled={!tonal || octave >= 5} onClick={() => onOctave(octave + 1)}>+</button><small>{tonal ? '− / + OR [ / ]' : levels ? 'Z–W LEVELS' : 'Q–P TRIGGER'}</small></div>
  </section>
}

function BassUnit({ index, voice, currentStep, onChange, onPreview }: { index: number; voice: BassVoice; currentStep: number; onChange: (voice: BassVoice) => void; onPreview: (note: number) => void }) {
  const setParam = <K extends keyof BassVoice>(key: K, value: BassVoice[K]) => onChange({ ...voice, [key]: value })
  const setStep = (stepIndex: number, patch: Partial<BassVoice['steps'][number]>) => {
    const steps = voice.steps.map((step, cursor) => cursor === stepIndex ? { ...step, ...patch } : step)
    const patternIndex = voice.bank * 8 + voice.pattern
    const patterns = voice.patterns.map((pattern, cursor) => cursor === patternIndex ? steps : pattern)
    onChange({ ...voice, steps, patterns })
  }
  const selectPattern = (bank: number, pattern: number) => {
    const currentIndex = voice.bank * 8 + voice.pattern
    const targetIndex = bank * 8 + pattern
    const patterns = voice.patterns.map((item, cursor) => cursor === currentIndex ? voice.steps : item)
    onChange({ ...voice, bank, pattern, patterns, steps: patterns[targetIndex] })
  }
  const [editStep, setEditStep] = useState(0)
  const selected = voice.steps[editStep]

  return (
    <section className={`machine bass-machine unit-${index + 1}`} id={`bass-${index + 1}`}>
      <Screw /><Screw /><Screw /><Screw />
      <header className="machine-header">
        <div className="brand-block"><span>RB</span><strong>303</strong></div>
        <div><p className="eyebrow">COMPUTER CONTROLLED</p><h2>BASS LINE <em>0{index + 1}</em></h2><small>{voice.name} / ANALOG MODELLED VOICE</small></div>
        <div className="machine-actions"><div className="machine-reset-actions"><button title="Clear all notes, accents, slides, and octave offsets in this 16-step pattern" onClick={() => onChange(wipeBassPattern(voice, index ? 43 : 36))}>WIPE ALL</button><button title="Restore factory sound and mixer controls; patterns stay intact" onClick={() => onChange(restoreBassDefaults(voice, index as 0 | 1))}>DEFAULT</button></div><span className="routing-label">MIXER CHANNEL {index + 1}</span><span className="pattern-chip">{String.fromCharCode(65 + voice.bank)}{voice.pattern + 1}</span></div>
      </header>

      <div className="bass-topline">
        <PatternSelector bank={voice.bank} pattern={voice.pattern} onBank={(bank) => selectPattern(bank, voice.pattern)} onPattern={(pattern) => selectPattern(voice.bank, pattern)} />
        <div className="oscillator-block">
          <span className="micro-title">VCO / SOURCE</span>
          <div className="osc-source-switch" role="group" aria-label={`303 ${index + 1} oscillator source`}><button aria-pressed={voice.oscSource === 'classic'} className={voice.oscSource === 'classic' ? 'selected' : ''} onClick={() => setParam('oscSource', 'classic')}>CLASSIC</button><button aria-pressed={voice.oscSource === 'designer'} className={voice.oscSource === 'designer' ? 'selected' : ''} onClick={() => setParam('oscSource', 'designer')}>WAVE</button></div>
          {voice.oscSource === 'classic'
            ? <WaveSwitch value={voice.waveform} onChange={(waveform) => setParam('waveform', waveform)} />
            : <div className="designer-source-readout"><strong>{voice.designerWaveform.toUpperCase()}</strong><span>UNISON {voice.designerSpread}</span></div>}
        </div>
      </div>

      <div className="synth-controls">
        <Knob label="CUTOFF" value={voice.cutoff} onChange={(value) => setParam('cutoff', value)} />
        <Knob label="RESONANCE" value={voice.resonance} onChange={(value) => setParam('resonance', value)} />
        <Knob label="ENV MOD" value={voice.envMod} onChange={(value) => setParam('envMod', value)} />
        <Knob label="DECAY" value={voice.decay} onChange={(value) => setParam('decay', value)} />
        <Knob label="ACCENT" value={voice.accent} onChange={(value) => setParam('accent', value)} accent="amber" />
        <div className="mini-effects">
          <Knob compact bipolar label="TUNE" value={voice.tune} onChange={(value) => setParam('tune', value)} accent="silver" />
          <Knob compact label="DRIVE" value={voice.drive} onChange={(value) => setParam('drive', value)} accent="amber" />
        </div>
      </div>

      <div className="sequencer-wrap">
        <div className="step-labels">{Array.from({ length: 16 }, (_, i) => <span key={i}>{String(i + 1).padStart(2, '0')}</span>)}</div>
        <div className="bass-steps">
          {voice.steps.map((step, stepIndex) => (
            <button
              key={stepIndex}
              aria-pressed={step.active}
              className={`${step.active ? 'on' : ''} ${step.accent ? 'accent' : ''} ${step.slide ? 'slide' : ''} ${editStep === stepIndex ? 'editing' : ''} ${currentStep === stepIndex ? 'playing' : ''}`}
              onClick={() => { setEditStep(stepIndex); setStep(stepIndex, { active: !step.active }) }}
              onContextMenu={(event) => { event.preventDefault(); setEditStep(stepIndex); setStep(stepIndex, { active: false, accent: false, slide: false, octave: 0 }) }}
              aria-label={`Step ${stepIndex + 1}, ${step.active ? noteNames[step.note % 12] : 'off'}`}
            >
              <i className="step-led" />
              <strong>{step.active ? noteNames[step.note % 12] : '—'}</strong>
              <small>{step.active ? (Math.floor(step.note / 12) - 1) : ''}</small>
              <span className="step-flags">{step.accent ? 'A' : ''}{step.slide ? 'S' : ''}</span>
            </button>
          ))}
        </div>
        <div className="step-editor">
          <div className="step-readout"><span>EDIT STEP</span><strong>{String(editStep + 1).padStart(2, '0')}</strong></div>
          <PianoKeyboard selected={selected.note} onPlay={(note) => { setStep(editStep, { note, active: true }); onPreview(note) }} />
          <button aria-pressed={selected.octave === -1} className={`function-key ${selected.octave === -1 ? 'active' : ''}`} onClick={() => setStep(editStep, { octave: selected.octave === -1 ? 0 : -1 })}>DOWN</button>
          <button aria-pressed={selected.octave === 1} className={`function-key ${selected.octave === 1 ? 'active' : ''}`} onClick={() => setStep(editStep, { octave: selected.octave === 1 ? 0 : 1 })}>UP</button>
          <button aria-pressed={selected.accent} className={`function-key amber ${selected.accent ? 'active' : ''}`} onClick={() => setStep(editStep, { accent: !selected.accent })}>ACCENT</button>
          <button aria-pressed={selected.slide} className={`function-key aqua ${selected.slide ? 'active' : ''}`} onClick={() => setStep(editStep, { slide: !selected.slide })}>SLIDE</button>
          <button className="function-key clear" onClick={() => setStep(editStep, { active: false, accent: false, slide: false, octave: 0 })}>CLEAR</button>
        </div>
      </div>
    </section>
  )
}

const designerWaveforms: DesignerWaveform[] = ['sine', 'triangle', 'sawtooth', 'square']

function WaveDesigner({ voice, currentStep, onChange, onPreview, onSend }: { voice: WaveDesignerState; currentStep: number; onChange: (voice: WaveDesignerState) => void; onPreview: (note: number) => void; onSend: (index: 0 | 1) => void }) {
  const [editStep, setEditStep] = useState(0)
  const selected = voice.steps[editStep]
  const setParam = <K extends keyof WaveDesignerState>(key: K, value: WaveDesignerState[K]) => onChange({ ...voice, [key]: value })
  const setStep = (index: number, patch: Partial<WaveDesignerState['steps'][number]>) => setParam('steps', voice.steps.map((step, cursor) => cursor === index ? { ...step, ...patch } : step))
  return <section className="wave-designer" id="wave-designer">
    <Screw dark /><Screw dark /><Screw dark /><Screw dark />
    <header className="wave-designer-header"><div className="wave-mark"><Waves /><span>WD</span></div><div><p className="eyebrow">HARMONIC SYNTHESIS</p><h2>WAVE DESIGNER</h2><small>THREE-VOICE UNISON / MIXER CHANNEL 5</small></div><div className="machine-reset-actions"><button title="Clear every note, accent, hold, and octave offset in this 16-step lane" onClick={() => onChange(wipeWavePattern(voice))}>WIPE ALL</button><button title="Restore factory sound and mixer controls; the sequence stays intact" onClick={() => onChange(restoreWaveDefaults(voice))}>DEFAULT</button></div><label><span>PATCH NAME</span><input aria-label="Wave Designer patch name" maxLength={18} value={voice.name} onChange={(event) => setParam('name', event.target.value.toUpperCase())} /></label></header>
    <div className="designer-transfer"><span>SEND OSCILLATOR + TONE</span><button onClick={() => onSend(0)}>LOAD INTO 303·1</button><button onClick={() => onSend(1)}>LOAD INTO 303·2</button><small>Keeps the 303 sequence and mixer channel</small></div>
    <div className="wave-designer-controls">
      <div className="designer-waveforms"><span className="micro-title">OSCILLATOR SHAPE</span>{designerWaveforms.map((waveform) => <button key={waveform} aria-pressed={voice.waveform === waveform} className={voice.waveform === waveform ? 'active' : ''} onClick={() => setParam('waveform', waveform)}>{waveform.toUpperCase()}</button>)}</div>
      <Knob label="CUTOFF" value={voice.cutoff} onChange={(cutoff) => setParam('cutoff', cutoff)} />
      <Knob label="RESONANCE" value={voice.resonance} onChange={(resonance) => setParam('resonance', resonance)} />
      <Knob label="ATTACK" value={voice.attack} onChange={(attack) => setParam('attack', attack)} accent="silver" />
      <Knob label="RELEASE" value={voice.release} onChange={(release) => setParam('release', release)} accent="silver" />
      <Knob label="SPREAD" value={voice.spread} onChange={(spread) => setParam('spread', spread)} accent="amber" />
      <Knob label="DRIVE" value={voice.drive} onChange={(drive) => setParam('drive', drive)} accent="amber" />
      <Knob bipolar label="TUNE" value={voice.tune} onChange={(tune) => setParam('tune', tune)} accent="silver" />
    </div>
    <div className="designer-sequencer">
      <div className="designer-steps">{voice.steps.map((step, index) => <button key={index} aria-label={`Wave step ${index + 1}, ${step.active ? noteNames[step.note % 12] : 'off'}`} aria-pressed={step.active} className={`${step.active ? 'on' : ''} ${step.accent ? 'accent' : ''} ${editStep === index ? 'editing' : ''} ${currentStep === index ? 'playing' : ''}`} onClick={() => { setEditStep(index); setStep(index, { active: !step.active }) }} onContextMenu={(event) => { event.preventDefault(); setEditStep(index); setStep(index, { active: false, accent: false, slide: false, octave: 0 }) }}><small>{String(index + 1).padStart(2, '0')}</small><strong>{step.active ? noteNames[step.note % 12] : '—'}</strong></button>)}</div>
      <div className="designer-editor"><div className="step-readout"><span>EDIT STEP</span><strong>{String(editStep + 1).padStart(2, '0')}</strong></div><PianoKeyboard selected={selected.note} onPlay={(note) => { setStep(editStep, { note, active: true }); onPreview(note) }} /><button aria-pressed={selected.accent} className={`function-key amber ${selected.accent ? 'active' : ''}`} onClick={() => setStep(editStep, { accent: !selected.accent })}>ACCENT</button><button aria-pressed={selected.slide} className={`function-key aqua ${selected.slide ? 'active' : ''}`} onClick={() => setStep(editStep, { slide: !selected.slide })}>HOLD</button><button className="function-key clear" onClick={() => setStep(editStep, { active: false, accent: false, slide: false, octave: 0 })}>CLEAR</button></div>
    </div>
  </section>
}

const drumLabels: Record<DrumName, string> = {
  kick: 'BD', snare: 'SD', clap: 'CP', closedHat: 'CH', openHat: 'OH', lowTom: 'LT', midTom: 'MT', highTom: 'HT', rim: 'RS', cowbell: 'CB',
}

function DrumMachine({ machine, machineIndex, currentStep, update, preview }: { machine: RhythmMachineState; machineIndex: number; currentStep: number; update: (machine: RhythmMachineState) => void; preview: (drum: DrumName) => void }) {
  const drum = machine.selectedDrum
  const params = machine.drums[drum]
  const updateDrumParam = (key: keyof typeof params, value: number) => update({ ...machine, drums: { ...machine.drums, [drum]: { ...params, [key]: value } } })
  const cycleStep = (index: number) => {
    const row = [...machine.steps[drum]]
    row[index] = ((row[index] + 1) % 3) as DrumStep
    const steps = { ...machine.steps, [drum]: row }
    const slot = machine.bank * 8 + machine.pattern
    const patterns = machine.patterns.map((pattern, cursor) => cursor === slot ? steps : pattern)
    update({ ...machine, steps, patterns })
    if (row[index]) preview(drum)
  }
  const clearStep = (index: number) => {
    const row = [...machine.steps[drum]]
    row[index] = 0
    const steps = { ...machine.steps, [drum]: row }
    const slot = machine.bank * 8 + machine.pattern
    update({ ...machine, steps, patterns: machine.patterns.map((pattern, cursor) => cursor === slot ? steps : pattern) })
  }
  const selectPattern = (bank: number, pattern: number) => {
    const currentSlot = machine.bank * 8 + machine.pattern
    const targetSlot = bank * 8 + pattern
    const patterns = machine.patterns.map((item, cursor) => cursor === currentSlot ? machine.steps : item)
    update({ ...machine, bank, pattern, patterns, steps: patterns[targetSlot] })
  }

  return (
    <section className={`machine drum-machine drum-${machine.kit}`} id={`drum-${machine.kit}`}>
      <Screw dark /><Screw dark /><Screw dark /><Screw dark />
      <header className="drum-header">
        <div className="brand-block dark"><span>RB</span><strong>{machine.kit}</strong></div>
        <div><p className="eyebrow">RHYTHM COMPOSER</p><h2>DRUM MACHINE</h2><small>{machine.kit === '808' ? 'ANALOG DRUM SYNTHESIS' : 'HYBRID TRANSIENT ENGINE'}</small></div>
        <div className="drum-header-actions"><div className="machine-reset-actions"><button title="Clear hits and accents from all ten voices in this 16-step pattern" onClick={() => update(wipeRhythmPattern(machine))}>WIPE ALL</button><button title="Restore factory voice and mixer controls; patterns stay intact" onClick={() => update(restoreRhythmDefaults(machine, machineIndex as 0 | 1))}>DEFAULT</button></div><span className="routing-label">MIXER CHANNEL {machineIndex + 3}</span><span className="pattern-chip">{String.fromCharCode(65 + machine.bank)}{machine.pattern + 1}</span></div>
        <div className="kit-badge"><span>ENGINE {machineIndex + 1}</span><strong>DEDICATED / ONLINE</strong></div>
      </header>
      <div className="drum-layout">
        <PatternSelector bank={machine.bank} pattern={machine.pattern} onBank={(bank) => selectPattern(bank, machine.pattern)} onPattern={(pattern) => selectPattern(machine.bank, pattern)} />
        <div className="drum-voices">
          {drumNames.map((name) => <button key={name} aria-pressed={name === drum} className={`${name === drum ? 'selected' : ''}`} onClick={() => { update({ ...machine, selectedDrum: name }); preview(name) }}><i />{drumLabels[name]}<span>{name.replace(/([A-Z])/g, ' $1')}</span></button>)}
        </div>
        <div className="drum-params">
          <div className="selected-drum-label"><span>VOICE</span><strong>{drum.replace(/([A-Z])/g, ' $1')}</strong></div>
          <Knob compact label="LEVEL" value={params.level} onChange={(value) => updateDrumParam('level', value)} accent="amber" />
          <Knob compact label="TONE" value={params.tone} onChange={(value) => updateDrumParam('tone', value)} accent="silver" />
          <Knob compact label="DECAY" value={params.decay} onChange={(value) => updateDrumParam('decay', value)} accent="silver" />
          <Knob compact label="TUNE" value={params.tune} onChange={(value) => updateDrumParam('tune', value)} accent="silver" />
          <Knob compact bipolar label="PAN" value={params.pan} onChange={(value) => updateDrumParam('pan', value)} accent="silver" />
          <Knob compact label="ECHO" value={params.delay} onChange={(value) => updateDrumParam('delay', value)} accent="amber" />
          <Knob compact label="SPACE" value={params.reverb} onChange={(value) => updateDrumParam('reverb', value)} accent="silver" />
          <button aria-label={`${machine.kit} ${drum} voice mute`} aria-pressed={params.muted} className={`voice-action ${params.muted ? 'active mute' : ''}`} onClick={() => update({ ...machine, drums: { ...machine.drums, [drum]: { ...params, muted: !params.muted } } })}>{params.muted ? 'VOICE ON' : 'VOICE MUTE'}</button>
          <button aria-label={`${machine.kit} ${drum} voice solo`} aria-pressed={params.solo} className={`voice-action ${params.solo ? 'active solo' : ''}`} onClick={() => update({ ...machine, drums: { ...machine.drums, [drum]: { ...params, solo: !params.solo } } })}>VOICE SOLO</button>
        </div>
      </div>
      <div className="drum-sequencer">
        <div className="drum-step-info"><span>PROGRAMMING</span><strong>{drumLabels[drum]}</strong><small>LEFT: CYCLE · RIGHT: CLEAR</small></div>
        <div className="drum-step-bank">
          {machine.steps[drum].map((value, index) => <button key={index} aria-label={`${machine.kit} ${drum} step ${index + 1}: ${value === 2 ? 'accent' : value ? 'hit' : 'off'}`} aria-pressed={Boolean(value)} className={`${value ? 'on' : ''} ${value === 2 ? 'accent' : ''} ${currentStep === index ? 'playing' : ''}`} onContextMenu={(event) => { event.preventDefault(); clearStep(index) }} onClick={() => cycleStep(index)}><span>{index + 1}</span><i /></button>)}
        </div>
      </div>
    </section>
  )
}

function Meter({ level }: { level: number }) {
  return <div className="meter" aria-label={`Master level ${Math.round(level * 100)} percent`}>{Array.from({ length: 18 }, (_, i) => <i key={i} className={i / 18 < level ? i > 14 ? 'hot' : i > 11 ? 'warm' : 'lit' : ''} />)}</div>
}

function ChannelStrip({ label, level, pan, delay, reverb, eq, muted, solo, onLevel, onPan, onDelay, onReverb, onEq, onMute, onSolo }: { label: string; level: number; pan: number; delay: number; reverb: number; eq: [number, number, number]; muted: boolean; solo: boolean; onLevel: (value: number) => void; onPan: (value: number) => void; onDelay: (value: number) => void; onReverb: (value: number) => void; onEq: (band: 0 | 1 | 2, value: number) => void; onMute: () => void; onSolo: () => void }) {
  return <div className={`channel-strip ${muted ? 'muted' : ''} ${solo ? 'soloed' : ''}`}>
    <span className="channel-name">{label}</span>
    <i className="channel-led" />
    <Knob compact bipolar label="PAN" value={pan} onChange={onPan} accent="silver" />
    <div className="channel-eq">{(['LO', 'MID', 'HI'] as const).map((name, index) => <label key={name}><span>{name}</span><input aria-label={`${label} ${name} EQ`} type="range" min="0" max="100" value={eq[index]} onChange={(event) => onEq(index as 0 | 1 | 2, Number(event.target.value))} /></label>)}</div>
    <input className="channel-fader" aria-label={`${label} level`} type="range" min="0" max="100" value={level} onChange={(event) => onLevel(Number(event.target.value))} />
    <output>{Math.round(level)}</output>
    <label className="channel-send"><span>ECHO</span><input aria-label={`${label} echo send`} type="range" min="0" max="100" value={delay} onChange={(event) => onDelay(Number(event.target.value))} /></label>
    <label className="channel-send"><span>SPACE</span><input aria-label={`${label} reverb send`} type="range" min="0" max="100" value={reverb} onChange={(event) => onReverb(Number(event.target.value))} /></label>
    <div className="channel-buttons"><button aria-label={`Mute ${label}`} aria-pressed={muted} className={muted ? 'active mute' : ''} onClick={onMute}>M</button><button aria-label={`Solo ${label}`} aria-pressed={solo} className={solo ? 'active solo' : ''} onClick={onSolo}>S</button></div>
  </div>
}

function Scope({ samples }: { samples: number[] }) {
  const values = samples.length ? samples : Array.from({ length: 96 }, () => 0)
  const path = values.map((value, index) => `${index ? 'L' : 'M'} ${(index / (values.length - 1)) * 360} ${37 - value * 31}`).join(' ')
  return <div className={`scope ${samples.length ? 'running' : ''}`}><svg viewBox="0 0 360 74" preserveAspectRatio="none"><path d={path} /></svg><span>LIVE MASTER SIGNAL</span></div>
}

function saveBlob(data: Blob, filename: string) {
  const link = document.createElement('a')
  link.href = URL.createObjectURL(data)
  link.download = filename
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(link.href), 1000)
}

function applySongPosition(project: ProjectState, barIndex: number): ProjectState {
  const authoredDemo = project.songChain.length === DUBSTEP_SONG_CHAIN.length && project.songChain.every((cue, index) => cue.bass.every((slot, voice) => slot === DUBSTEP_SONG_CHAIN[index].bass[voice]) && cue.drums.every((slot, machine) => slot === DUBSTEP_SONG_CHAIN[index].drums[machine]))
  const source = authoredDemo ? applyDubstepBarAutomation(project, barIndex) : project
  const cue = source.songChain[barIndex % source.songChain.length]
  const bass = source.bass.map((voice, index) => {
    const slot = cue.bass[index]
    return { ...voice, bank: Math.floor(slot / 8), pattern: slot % 8, steps: voice.patterns[slot] }
  }) as [BassVoice, BassVoice]
  const rhythms = source.rhythms.map((rhythm, index) => {
    const slot = cue.drums[index]
    return { ...rhythm, bank: Math.floor(slot / 8), pattern: slot % 8, steps: rhythm.patterns[slot] }
  }) as [RhythmMachineState, RhythmMachineState]
  return { ...source, bass, rhythms }
}

function SongStrip({ project, bar, onJump, onCapture, onInsert, onRemove, onAddScene, onRemoveScene, onRenameScene }: { project: ProjectState; bar: number; onJump: (bar: number) => void; onCapture: (bar: number) => void; onInsert: (bar: number) => void; onRemove: (bar: number) => void; onAddScene: (bar: number) => void; onRemoveScene: (index: number) => void; onRenameScene: (index: number, name: string) => void }) {
  const track = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const strip = track.current
    const active = strip?.querySelector<HTMLElement>('.song-bar.active')
    if (!strip || !active) return
    const stripBounds = strip.getBoundingClientRect()
    const activeBounds = active.getBoundingClientRect()
    strip.scrollBy({ left: activeBounds.left + activeBounds.width / 2 - stripBounds.left - stripBounds.width / 2, behavior: 'smooth' })
  }, [bar])
  const groups = Array.from({ length: Math.ceil(project.songChain.length / 8) }, (_, group) => project.songChain.slice(group * 8, group * 8 + 8))
  const activeScene = project.songScenes.reduce((active, scene, index) => scene.start < bar ? index : active, 0)
  const isMarker = project.songScenes[activeScene]?.start === bar - 1
  return <section className="song-strip">
    <div className="song-title"><span>ARRANGEMENT / {project.songChain.length} BARS</span><strong>{project.name}</strong><small>CURRENT BAR <b>{String(bar).padStart(2, '0')}</b> · SELECT TO AUDITION</small><label className="scene-name-editor"><span>ACTIVE SCENE</span><input aria-label="Active scene name" maxLength={18} value={project.songScenes[activeScene]?.name ?? ''} onChange={(event) => onRenameScene(activeScene, event.target.value)} /></label><div className="scene-marker-actions"><button disabled={isMarker} onClick={() => onAddScene(bar)}>MARK SCENE HERE</button><button disabled={activeScene === 0 || !isMarker} onClick={() => onRemoveScene(activeScene)}>REMOVE MARKER</button></div></div>
    <div className="song-arranger">
      <div className="section-launchers" aria-label="Song scenes">{project.songScenes.map((scene, index) => {
        const end = (project.songScenes[index + 1]?.start ?? project.songChain.length) - 1
        return <button key={`${scene.start}-${index}`} aria-pressed={activeScene === index} className={activeScene === index ? 'active' : ''} onClick={() => onJump(scene.start + 1)}><small>{String(index + 1).padStart(2, '0')}</small><strong>{scene.name}</strong><span>{scene.start + 1}–{end + 1}</span></button>
      })}</div>
      <div className="song-bars" ref={track}>{groups.map((cues, group) => <div className="song-phrase" key={group}><span className="phrase-label">BARS {group * 8 + 1}–{Math.min(project.songChain.length, group * 8 + 8)}</span>{cues.map((cue, offset) => {
        const index = group * 8 + offset
        return <button key={index} className={`song-bar ${bar === index + 1 ? 'active' : ''}`} onClick={() => onJump(index + 1)} title={`Bass patterns ${cue.bass.map((value) => value + 1).join('/')}; drum patterns ${cue.drums.map((value) => value + 1).join('/')}`}><span>{String(index + 1).padStart(2, '0')}</span><strong>{cue.bass[0] + 1}/{cue.bass[1] + 1}</strong><small>{cue.drums[0] + 1}/{cue.drums[1] + 1}</small></button>
      })}</div>)}</div>
    </div>
    <div className="arrangement-actions"><button onClick={() => onInsert(bar)} disabled={project.songChain.length >= 128}><Plus />INSERT AFTER</button><button onClick={() => onRemove(bar)} disabled={project.songChain.length <= 1}><Minus />REMOVE BAR</button><button className="capture-button" onClick={() => onCapture(bar)}>CAPTURE CURRENT <span>TO BAR {String(bar).padStart(2, '0')}</span></button></div>
  </section>
}

const emptyDeckPlayback: DeckPlaybackState = { loaded: false, playing: false, position: 0, duration: 0, channels: 0, sampleRate: 0 }
const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`
type DeckSignalState = 'ready' | 'muted' | 'solo-blocked' | 'xfade-cut' | 'gain-zero'
const deckSignalLabels: Record<DeckSignalState, string> = { ready: 'ROUTING READY', muted: 'MUTED', 'solo-blocked': 'BLOCKED BY SOLO', 'xfade-cut': 'CROSSFADER CUT', 'gain-zero': 'GAIN AT ZERO' }

function DeckUnit({ index, deck, state, signalState, update, onLoad, onPlay, onPause, onCue, onSeek, onJog, onUnload, onRestoreSound }: { index: number; deck: DeckState; state: DeckPlaybackState; signalState: DeckSignalState; update: (patch: Partial<DeckState>) => void; onLoad: (file: File) => void; onPlay: () => void; onPause: () => void; onCue: () => void; onSeek: (seconds: number) => void; onJog: (seconds: number) => void; onUnload: () => void; onRestoreSound: () => void }) {
  const input = useRef<HTMLInputElement>(null)
  const lastJog = useRef<number | null>(null)
  const letter = index === 0 ? 'A' : 'B'
  return <article className={`media-deck deck-${letter.toLowerCase()} ${state.playing ? 'is-playing' : ''}`}>
    <header><span>DECK {letter}</span><strong>{deck.name}</strong><i className={signalState !== 'ready' ? 'signal-warning' : ''}>{state.loaded ? `${deckSignalLabels[signalState]} · ${state.channels}CH / ${(state.sampleRate / 1000).toFixed(1)}K` : 'NO MEDIA'}</i></header>
    <div className="platter-zone"><div className="turntable-platter" role="slider" tabIndex={0} aria-label={`Deck ${letter} jog wheel`} aria-valuemin={0} aria-valuemax={Math.max(1, state.duration)} aria-valuenow={state.position} onKeyDown={(event) => { if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') { event.preventDefault(); onJog(-0.25) } else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') { event.preventDefault(); onJog(0.25) } }} onPointerDown={(event) => { lastJog.current = event.clientX; event.currentTarget.setPointerCapture(event.pointerId) }} onPointerMove={(event) => { if (lastJog.current === null) return; const delta = (event.clientX - lastJog.current) / 32; lastJog.current = event.clientX; onJog(delta) }} onPointerUp={(event) => { lastJog.current = null; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId) }} onPointerCancel={() => { lastJog.current = null }}><div className="vinyl-grooves"><span>{letter}</span></div><i className="tone-arm" /></div><label className="pitch-fader"><span>PITCH</span><input aria-label={`Deck ${letter} pitch`} type="range" min="-12" max="12" step="0.1" value={deck.pitch} onDoubleClick={() => update({ pitch: 0 })} onChange={(event) => update({ pitch: Number(event.target.value) })} /><output>{deck.pitch > 0 ? '+' : ''}{deck.pitch.toFixed(1)}</output></label></div>
    <div className="deck-screen"><span>{clock(state.position)}</span><div><i style={{ width: `${state.duration ? state.position / state.duration * 100 : 0}%` }} /></div><strong>-{clock(Math.max(0, state.duration - state.position))}</strong></div>
    <input className="deck-seek" aria-label={`Deck ${letter} position`} type="range" min="0" max={Math.max(0.01, state.duration)} step="0.01" value={Math.min(state.position, state.duration)} disabled={!state.loaded} onChange={(event) => onSeek(Number(event.target.value))} />
    <div className="deck-controls"><button onClick={onCue} disabled={!state.loaded}>CUE</button><button className="play-control" onClick={state.playing ? onPause : onPlay} disabled={!state.loaded}>{state.playing ? <Pause /> : <Play />}{state.playing ? 'PAUSE' : 'PLAY'}</button><button aria-pressed={deck.loop} className={deck.loop ? 'active' : ''} onClick={() => update({ loop: !deck.loop, loopStart: deck.loopStart || deck.cuePoint, loopEnd: deck.loopEnd > deck.loopStart ? deck.loopEnd : Math.min(state.duration, (deck.cuePoint || state.position) + 4) })} disabled={!state.loaded}>LOOP</button><button onClick={() => update({ cuePoint: state.position })} disabled={!state.loaded}>SET CUE</button><button aria-pressed={deck.muted} className={deck.muted ? 'active danger' : ''} onClick={() => update({ muted: !deck.muted })}>MUTE</button></div>
    <div className="deck-tone"><Knob compact label="GAIN" value={deck.gain} onChange={(gain) => update({ gain })} accent="silver" /><Knob compact bipolar label="FILTER" value={deck.filter} onChange={(filter) => update({ filter })} accent="acid" /><label><span>RATE</span><input aria-label={`Deck ${letter} playback rate`} type="range" min="0.5" max="1.5" step="0.01" value={deck.rate} onDoubleClick={() => update({ rate: 1 })} onChange={(event) => update({ rate: Number(event.target.value) })} /><output>{deck.rate.toFixed(2)}×</output></label></div>
    <div className="deck-file-actions"><button onClick={() => input.current?.click()}><Upload />LOAD AUDIO</button><button className={signalState !== 'ready' ? 'restore-needed' : ''} title="Reset deck controls, center the crossfader, unmute this deck, and clear stale solos" onClick={onRestoreSound}>{signalState === 'ready' ? 'DEFAULT' : 'RESTORE SOUND'}</button><button aria-label={`Unload deck ${letter}`} onClick={onUnload} disabled={!state.loaded}><Trash2 /></button></div>
    <input ref={input} hidden type="file" accept="audio/*" onChange={(event) => { const file = event.target.files?.[0]; if (file) onLoad(file); event.target.value = '' }} />
  </article>
}

type ResampleSource = 'master' | 'bass0' | 'bass1' | 'wave' | 'drums0' | 'drums1' | 'sampler' | 'deck0' | 'deck1'
const resampleSources: Array<{ id: ResampleSource; label: string }> = [
  { id: 'master', label: 'MASTER' }, { id: 'bass0', label: '303·1' }, { id: 'bass1', label: '303·2' }, { id: 'wave', label: 'WAVE' },
  { id: 'drums0', label: '808' }, { id: 'drums1', label: '909' }, { id: 'sampler', label: 'SAMPLER' }, { id: 'deck0', label: 'DECK A' }, { id: 'deck1', label: 'DECK B' },
]

function SamplerBay({ sampler, update, trigger, stop, load, unload, waveform, autoChop, duplicate, resample }: { sampler: SamplerState; update: (sampler: SamplerState) => void; trigger: (index: number, velocity?: number, pitchOffset?: number) => void; stop: (index: number) => void; load: (index: number, file: File) => void; unload: (index: number) => void; waveform: (index: number) => number[]; autoChop: (index: number, count: number) => void; duplicate: (index: number) => void; resample: (index: number, source: ResampleSource) => void }) {
  const file = useRef<HTMLInputElement>(null)
  const [stepEditor, setStepEditor] = useState(0)
  const [resampleSource, setResampleSource] = useState<ResampleSource>('master')
  const selected = sampler.selectedSlot
  const slot = sampler.slots[selected]
  const updateSlot = (patch: Partial<typeof slot>) => update({ ...sampler, slots: sampler.slots.map((item, index) => index === selected ? { ...item, ...patch } : item) })
  const cycleStep = (step: number) => { const steps = [...slot.steps]; steps[step] = ((steps[step] + 1) % 3) as DrumStep; setStepEditor(step); updateSlot({ steps }) }
  const clearStep = (step: number) => {
    setStepEditor(step)
    updateSlot({
      steps: slot.steps.map((value, index) => index === step ? 0 : value) as DrumStep[],
      stepVelocities: slot.stepVelocities.map((value, index) => index === step ? 100 : value),
      stepNudges: slot.stepNudges.map((value, index) => index === step ? 0 : value),
      stepProbabilities: slot.stepProbabilities.map((value, index) => index === step ? 100 : value),
      stepRatchets: slot.stepRatchets.map((value, index) => index === step ? 1 : value),
    })
  }
  const updateStepArray = (key: 'stepVelocities' | 'stepNudges' | 'stepProbabilities' | 'stepRatchets', value: number) => updateSlot({ [key]: slot[key].map((item, index) => index === stepEditor ? value : item) })
  const bankStart = sampler.activeBank * 8
  const bankSlots = sampler.slots.slice(bankStart, bankStart + 8)
  const wave = waveform(selected)
  return <section className="sampler-bay"><header><div><span>32-SLOT HIP-HOP SAMPLER</span><strong>CHOP / WARP / RESAMPLE MATRIX</strong></div><div className="machine-reset-actions"><button title="Clear triggers, accents, velocity, nudge, probability, and ratchets from this 16-step lane" onClick={() => update(wipeSamplerPattern(sampler))}>WIPE ALL</button><button title="Restore sampler and selected-pad processing; audio and patterns stay intact" onClick={() => update(restoreSamplerDefaults(sampler))}>DEFAULT</button></div><p>FOUR PAD BANKS · NON-DESTRUCTIVE SLICES · MPC-STYLE TIMING</p></header>
    <div className="sample-bank-toolbar"><span>PAD BANK</span>{['A', 'B', 'C', 'D'].map((bank, index) => <button key={bank} aria-pressed={sampler.activeBank === index} className={sampler.activeBank === index ? 'active' : ''} onClick={() => update({ ...sampler, activeBank: index, selectedSlot: index * 8 })}>{bank}</button>)}<i />{(['off', 'velocity', 'pitch'] as const).map((mode) => <button key={mode} aria-pressed={sampler.sixteenLevels === mode} className={sampler.sixteenLevels === mode ? 'active levels' : ''} onClick={() => update({ ...sampler, sixteenLevels: mode })}>{mode === 'off' ? 'LEVELS OFF' : `16 ${mode.toUpperCase()}`}</button>)}</div>
    <div className="sample-pads">{bankSlots.map((item, offset) => { const index = bankStart + offset; return <button key={index} aria-pressed={selected === index} className={`${selected === index ? 'selected' : ''} ${item.assetId ? 'loaded' : ''}`} onPointerDown={() => { update({ ...sampler, selectedSlot: index }); trigger(index) }} onPointerUp={() => item.mode === 'loop' && stop(index)} onPointerCancel={() => item.mode === 'loop' && stop(index)} onKeyDown={(event) => { if (!event.repeat && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); update({ ...sampler, selectedSlot: index }); trigger(index) } }} onKeyUp={(event) => { if (item.mode === 'loop' && (event.key === 'Enter' || event.key === ' ')) stop(index) }}><i /><small>{String.fromCharCode(65 + sampler.activeBank)}{offset + 1}</small><strong>{item.name}</strong><span>{item.assetId ? `${item.mode.toUpperCase()} · CHOKE ${item.chokeGroup || '—'}` : 'EMPTY · LOAD'}</span></button>})}</div>
    <div className="sample-editor"><div className="sample-identity"><span>SLOT {String(selected + 1).padStart(2, '0')}</span><strong>{slot.name}</strong><small>{slot.assetId ? 'MEDIA ONLINE' : 'AWAITING AUDIO'}</small></div><Knob compact label="LEVEL" value={slot.gain} onChange={(gain) => updateSlot({ gain })} accent="amber" /><Knob compact bipolar label="PITCH" value={slot.pitch} onChange={(pitch) => updateSlot({ pitch })} accent="silver" /><Knob compact label="FILTER" value={slot.filter} onChange={(filter) => updateSlot({ filter })} /><Knob compact label="ATTACK" value={slot.attack} onChange={(attack) => updateSlot({ attack })} accent="silver" /><Knob compact label="RELEASE" value={slot.release} onChange={(release) => updateSlot({ release })} accent="silver" /><label className="trim-control"><span>TRIM IN / OUT</span><input aria-label="Sample trim start" type="range" min="0" max="0.99" step="0.01" value={slot.trimStart} onChange={(event) => updateSlot({ trimStart: Math.min(Number(event.target.value), slot.trimEnd - .01) })} /><input aria-label="Sample trim end" type="range" min="0.01" max="1" step="0.01" value={slot.trimEnd} onChange={(event) => updateSlot({ trimEnd: Math.max(Number(event.target.value), slot.trimStart + .01) })} /><output>{Math.round(slot.trimStart * 100)}—{Math.round(slot.trimEnd * 100)}%</output></label><div className="sample-modes"><button aria-pressed={slot.mode === 'loop'} className={slot.mode === 'loop' ? 'active' : ''} onClick={() => updateSlot({ mode: slot.mode === 'loop' ? 'oneShot' : 'loop' })}>{slot.mode === 'loop' ? 'LOOP' : 'ONE SHOT'}</button><button aria-pressed={slot.reverse} className={slot.reverse ? 'active' : ''} onClick={() => updateSlot({ reverse: !slot.reverse })}>REVERSE</button><button aria-pressed={slot.normalize} className={slot.normalize ? 'active' : ''} onClick={() => updateSlot({ normalize: !slot.normalize })}>NORMALIZE</button><button aria-pressed={slot.warp} className={slot.warp ? 'active' : ''} onClick={() => updateSlot({ warp: !slot.warp })}>WARP</button></div><div className="sample-file-actions"><button onClick={() => file.current?.click()}><Upload />{slot.assetId ? 'REPLACE' : 'LOAD'}</button><button onClick={() => duplicate(selected)} disabled={!slot.assetId}>DUP</button><button aria-label={`Unload sample ${selected + 1}`} onClick={() => unload(selected)} disabled={!slot.assetId}><Trash2 /></button></div></div>
    <div className="chop-lab"><div className="chop-title"><span>CHOP LAB</span><strong>TRANSIENT SLICER</strong></div><div className="sample-waveform">{wave.length ? <svg viewBox={`0 0 ${wave.length} 50`} preserveAspectRatio="none">{wave.map((peak, index) => <line key={index} x1={index} x2={index} y1={25 - peak * 23} y2={25 + peak * 23} />)}<line className="trim-marker" x1={slot.trimStart * wave.length} x2={slot.trimStart * wave.length} y1="0" y2="50" /><line className="trim-marker" x1={slot.trimEnd * wave.length} x2={slot.trimEnd * wave.length} y1="0" y2="50" /></svg> : <span>LOAD OR RESAMPLE AUDIO TO SEE WAVEFORM</span>}</div><div className="chop-actions"><button disabled={!slot.assetId} onClick={() => autoChop(selected, 4)}>AUTO 4</button><button disabled={!slot.assetId} onClick={() => autoChop(selected, 8)}>AUTO 8</button><label>SOURCE BPM<input aria-label="Sample source BPM" type="number" min="40" max="240" value={slot.sourceBpm} onChange={(event) => updateSlot({ sourceBpm: Math.max(40, Math.min(240, Number(event.target.value))) })} /></label><label>CHOKE<select aria-label="Sample choke group" value={slot.chokeGroup} onChange={(event) => updateSlot({ chokeGroup: Number(event.target.value) })}>{[0, 1, 2, 3, 4].map((group) => <option key={group} value={group}>{group || 'OFF'}</option>)}</select></label></div></div>
    <div className="resample-strip"><span>RESAMPLE INPUT</span><select aria-label="Resample source" value={resampleSource} onChange={(event) => setResampleSource(event.target.value as ResampleSource)}>{resampleSources.map((source) => <option key={source.id} value={source.id}>{source.label}</option>)}</select><button onClick={() => resample(selected, resampleSource)}>PRINT 1 BAR TO SLOT {String(selected + 1).padStart(2, '0')}</button><small>Deck sources print their loop or full file</small></div>
    <div className="sample-sequencer"><span>TRIGGER LANE</span>{slot.steps.map((value, index) => <button key={index} aria-label={`Sample ${selected + 1} step ${index + 1}: ${value === 2 ? 'accent' : value ? 'hit' : 'off'}`} aria-pressed={Boolean(value)} className={`${value ? 'on' : ''} ${value === 2 ? 'accent' : ''} ${stepEditor === index ? 'editing' : ''}`} onContextMenu={(event) => { event.preventDefault(); clearStep(index) }} onClick={() => cycleStep(index)}><small>{index + 1}</small><i /><em>{slot.stepRatchets[index] > 1 ? `×${slot.stepRatchets[index]}` : ''}</em></button>)}</div>
    <div className="sample-groove-editor"><span>STEP {String(stepEditor + 1).padStart(2, '0')}</span><label>VELOCITY<input aria-label="Sample step velocity" type="range" min="1" max="127" value={slot.stepVelocities[stepEditor]} onChange={(event) => updateStepArray('stepVelocities', Number(event.target.value))} /><output>{slot.stepVelocities[stepEditor]}</output></label><label>NUDGE<input aria-label="Sample step nudge" type="range" min="-45" max="45" value={slot.stepNudges[stepEditor]} onChange={(event) => updateStepArray('stepNudges', Number(event.target.value))} /><output>{slot.stepNudges[stepEditor]}ms</output></label><label>CHANCE<input aria-label="Sample step probability" type="range" min="1" max="100" value={slot.stepProbabilities[stepEditor]} onChange={(event) => updateStepArray('stepProbabilities', Number(event.target.value))} /><output>{slot.stepProbabilities[stepEditor]}%</output></label><label>RATCHET<input aria-label="Sample step ratchet" type="range" min="1" max="4" value={slot.stepRatchets[stepEditor]} onChange={(event) => updateStepArray('stepRatchets', Number(event.target.value))} /><output>×{slot.stepRatchets[stepEditor]}</output></label></div>
    <div className="sampler-color"><span>LO-FI COLOR</span><Knob compact label="DRIVE" value={sampler.drive} onChange={(drive) => update({ ...sampler, drive })} accent="amber" /><Knob compact label="BITS" value={sampler.bitDepth} onChange={(bitDepth) => update({ ...sampler, bitDepth })} accent="silver" /><Knob compact label="RATE" value={sampler.sampleRate} onChange={(sampleRate) => update({ ...sampler, sampleRate })} accent="silver" /><Knob compact label="TEXTURE" value={sampler.texture} onChange={(texture) => update({ ...sampler, texture })} accent="amber" /><div className="note-repeat"><span>NOTE REPEAT</span>{([0, 2, 4, 8] as const).map((repeat) => <button key={repeat} aria-pressed={sampler.noteRepeat === repeat} className={sampler.noteRepeat === repeat ? 'active' : ''} onClick={() => update({ ...sampler, noteRepeat: repeat })}>{repeat ? `1/${repeat * 4}` : 'OFF'}</button>)}</div></div>
    <input ref={file} hidden type="file" accept="audio/*" onChange={(event) => { const selectedFile = event.target.files?.[0]; if (selectedFile) load(selected, selectedFile); event.target.value = '' }} />
  </section>
}

function MediaBay({ project, playback, updateDeck, restoreDeck, updateSampler, loadDeck, playDeck, pauseDeck, cueDeck, seekDeck, jogDeck, unloadDeck, loadSample, unloadSample, triggerSample, stopSample, sampleWaveform, autoChop, duplicateSample, resample }: { project: ProjectState; playback: [DeckPlaybackState, DeckPlaybackState]; updateDeck: (index: number, patch: Partial<DeckState>) => void; restoreDeck: (index: 0 | 1) => void; updateSampler: (sampler: SamplerState) => void; loadDeck: (index: number, file: File) => void; playDeck: (index: number) => void; pauseDeck: (index: number) => void; cueDeck: (index: number) => void; seekDeck: (index: number, seconds: number) => void; jogDeck: (index: number, seconds: number) => void; unloadDeck: (index: number) => void; loadSample: (index: number, file: File) => void; unloadSample: (index: number) => void; triggerSample: (index: number, velocity?: number, pitchOffset?: number) => void; stopSample: (index: number) => void; sampleWaveform: (index: number) => number[]; autoChop: (index: number, count: number) => void; duplicateSample: (index: number) => void; resample: (index: number, source: ResampleSource) => void }) {
  const signalState = (index: 0 | 1): DeckSignalState => {
    const deck = project.decks[index]
    if (deck.muted) return 'muted'
    if (deck.gain <= 0) return 'gain-zero'
    if (!isMixerChannelAudible(project, { kind: 'deck', index })) return 'solo-blocked'
    if ((index === 0 && project.crossfader >= 99) || (index === 1 && project.crossfader <= -99)) return 'xfade-cut'
    return 'ready'
  }
  return <section className="media-bay" id="media-bay"><header className="media-bay-header"><Disc3 /><div><span>MEDIA PERFORMANCE BAY</span><strong>TWIN DECKS + SAMPLER</strong></div><p>LOCAL AUDIO · JOG / CUE / LOOP · NON-DESTRUCTIVE</p></header><div className="twin-decks">{project.decks.map((deck, index) => <DeckUnit key={index} index={index} deck={deck} state={playback[index]} signalState={signalState(index as 0 | 1)} update={(patch) => updateDeck(index, patch)} onLoad={(file) => loadDeck(index, file)} onPlay={() => playDeck(index)} onPause={() => pauseDeck(index)} onCue={() => cueDeck(index)} onSeek={(seconds) => seekDeck(index, seconds)} onJog={(seconds) => jogDeck(index, seconds)} onUnload={() => unloadDeck(index)} onRestoreSound={() => restoreDeck(index as 0 | 1)} />)}</div><SamplerBay sampler={project.sampler} update={updateSampler} trigger={triggerSample} stop={stopSample} load={loadSample} unload={unloadSample} waveform={sampleWaveform} autoChop={autoChop} duplicate={duplicateSample} resample={resample} /></section>
}

const fxPadLabels = ['IMPACT', 'RISER', 'LASER', 'DUB SIREN', 'SUB DROP', 'NOISE HIT', 'VINYL STOP', 'TAPE STAB', 'AIR HORN', 'VOX CHOP', 'SCRATCH', 'BELL HIT']

function PerformanceDeck({ project, bar, update, triggerPad, launchScene, captureScene, markScene }: { project: ProjectState; bar: number; update: (patch: Partial<ProjectState>) => void; triggerPad: (index: number) => void; launchScene: (bar: number) => void; captureScene: (bar: number) => void; markScene: (bar: number) => void }) {
  const setRepeat = (division: 1 | 2 | 4 | 8) => update({ performance: { ...project.performance, beatRepeat: project.performance.beatRepeat && project.performance.beatRepeatDivision === division ? false : true, beatRepeatDivision: division } })
  const activeScene = project.songScenes.reduce((active, scene, index) => scene.start < bar ? index : active, 0)
  const sceneStart = project.songScenes[activeScene]?.start ?? 0
  const barHasMarker = project.songScenes.some((scene) => scene.start === bar - 1)
  return <section className="performance-deck" id="performance-deck">
    <Screw dark /><Screw dark /><Screw dark /><Screw dark />
    <header><div className="deck-mark"><span>LIVE</span><strong>PERFORMANCE LAB</strong></div><p>SCENES JUMP TO THEIR FIRST BAR · BEAT REPEAT · SYNTH FX</p><i>WAVE DESIGNER STAYS ON THE DIRECT BUS</i></header>
    <div className="scene-bank">
      <span className="deck-section-label">SONG SCENES</span>
      {project.songScenes.map((scene, index) => <button key={`${scene.start}-${index}`} aria-pressed={activeScene === index} className={activeScene === index ? 'active' : ''} onClick={() => launchScene(scene.start + 1)}><small>BAR {String(scene.start + 1).padStart(2, '0')}</small><strong>{scene.name}</strong></button>)}
      <div className="scene-tools"><p>Scenes are saved song markers. Launch jumps to their first bar; Capture writes the current 303/808/909 patterns to that bar.</p><button onClick={() => captureScene(sceneStart + 1)}>CAPTURE TO {project.songScenes[activeScene]?.name ?? 'SCENE'}</button><button disabled={barHasMarker} onClick={() => markScene(bar)}>MARK BAR {String(bar).padStart(2, '0')}</button></div>
    </div>
    <div className="fx-pads">
      <span className="deck-section-label">SYNTH FX PADS</span>
      {fxPadNames.map((name, index) => <button key={name} onClick={() => triggerPad(index)}><i /><span>{fxPadLabels[index]}</span><small>PAD {index + 1}</small></button>)}
    </div>
    <div className="repeat-bank">
      <span className="deck-section-label">BEAT REPEAT{!project.effectsEnabled ? ' · BYPASSED BY ALL ECHO FX OFF' : ''}</span>
      <div>{([1, 2, 4, 8] as const).map((division) => <button key={division} aria-pressed={project.performance.beatRepeat && project.performance.beatRepeatDivision === division} className={project.performance.beatRepeat && project.performance.beatRepeatDivision === division ? 'active' : ''} onClick={() => setRepeat(division)}>1/{division * 4}</button>)}</div>
      <Knob compact label="MIX" value={project.performance.beatRepeatMix} onChange={(beatRepeatMix) => update({ performance: { ...project.performance, beatRepeatMix } })} accent="amber" />
      <Knob compact label="DECAY" value={project.performance.beatRepeatDecay} onChange={(beatRepeatDecay) => update({ performance: { ...project.performance, beatRepeatDecay } })} accent="silver" />
    </div>
    <div className="crossfader-section">
      <div><span>DECK A +</span><strong>ACID</strong></div>
      <label><span>CROSSFADER</span><input aria-label="Performance crossfader" type="range" min="-100" max="100" value={project.crossfader} onChange={(event) => update({ crossfader: Number(event.target.value) })} /><output>{project.crossfader === 0 ? 'CENTER' : project.crossfader < 0 ? `A ${Math.abs(project.crossfader)}` : `B ${project.crossfader}`}</output></label>
      <div><span>DECK B +</span><strong>DRUMS</strong></div>
    </div>
  </section>
}

export default function App() {
  const [project, setProject] = useState<ProjectState>(() => {
    try { const saved = JSON.parse(localStorage.getItem('reborn338.autosave') || 'null') as Partial<ProjectState> | null; return saved?.version === 1 ? hydrateProject(saved) : createDemoProject('abyssal') } catch { return createDemoProject('abyssal') }
  })
  const [playing, setPlaying] = useState(false)
  const [recording, setRecording] = useState(false)
  const [currentStep, setCurrentStep] = useState(-1)
  const [bar, setBar] = useState(1)
  const [showProjects, setShowProjects] = useState(false)
  const [showHelp, setShowHelp] = useState(false)
  const [performanceView, setPerformanceView] = useState(false)
  const [keyboardTarget, setKeyboardTarget] = useState<KeyboardTarget>('bass-0')
  const [keyboardOctave, setKeyboardOctave] = useState(0)
  const [keyboardPressed, setKeyboardPressed] = useState<Set<string>>(() => new Set())
  const [savedProjects, setSavedProjects] = useState<ProjectSummary[]>([])
  const [selectedDemo, setSelectedDemo] = useState<DemoId>('abyssal')
  const [activeProjectId, setActiveProjectId] = useState<string | undefined>()
  const [toast, setToast] = useState('')
  const [meterLevel, setMeterLevel] = useState(0)
  const [waveform, setWaveform] = useState<number[]>([])
  const [gainReduction, setGainReduction] = useState(0)
  const [deckPlayback, setDeckPlayback] = useState<[DeckPlaybackState, DeckPlaybackState]>([emptyDeckPlayback, emptyDeckPlayback])
  const [exportProgress, setExportProgress] = useState<{ completed: number; total: number } | null>(null)
  const engineRef = useRef<GrooveEngine | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const history = useRef<ProjectState[]>([])
  const future = useRef<ProjectState[]>([])
  const projectRef = useRef(project)
  const recordingRef = useRef(recording)
  const barRef = useRef(bar)
  const seenDownbeat = useRef(false)

  projectRef.current = project
  recordingRef.current = recording
  barRef.current = bar

  const notify = useCallback((message: string) => {
    setToast(message)
    window.setTimeout(() => setToast(''), 2200)
  }, [])

  useEffect(() => {
    engineRef.current = new GrooveEngine((step, engineBar) => {
      setCurrentStep(step)
      if (step !== 0) return
      const nextBar = typeof engineBar === 'number' ? engineBar + 1 : seenDownbeat.current ? (barRef.current % Math.max(1, projectRef.current.songChain.length)) + 1 : barRef.current
      seenDownbeat.current = true
      setBar(nextBar)
      barRef.current = nextBar
      setProject((current) => {
        if (current.mode !== 'song') return current
        if (recordingRef.current) {
          const songChain = [...current.songChain]
          songChain[nextBar - 1] = { bass: [current.bass[0].bank * 8 + current.bass[0].pattern, current.bass[1].bank * 8 + current.bass[1].pattern], drums: [current.rhythms[0].bank * 8 + current.rhythms[0].pattern, current.rhythms[1].bank * 8 + current.rhythms[1].pattern] }
          return { ...current, songChain }
        }
        return applySongPosition(current, nextBar - 1)
      })
    })
    void restoreProjectAudioAssets(projectRef.current, engineRef.current).catch(() => undefined)
    return () => engineRef.current?.dispose()
  }, [])

  useEffect(() => {
    const timer = window.setInterval(() => {
      const engine = engineRef.current
      if (engine) setDeckPlayback([engine.getDeckState(0), engine.getDeckState(1)])
    }, 120)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    engineRef.current?.setProject(project)
    localStorage.setItem('reborn338.autosave', JSON.stringify(project))
  }, [project])

  useEffect(() => {
    const liveAudio = playing || deckPlayback[0].playing || deckPlayback[1].playing
    if (!liveAudio) { setMeterLevel(0); setWaveform([]); setGainReduction(0); return }
    let frame = 0
    const poll = () => {
      setMeterLevel(engineRef.current?.getOutputLevel() ?? 0)
      setWaveform(engineRef.current?.getWaveform() ?? [])
      setGainReduction(engineRef.current?.getGainReduction() ?? 0)
      frame = requestAnimationFrame(poll)
    }
    frame = requestAnimationFrame(poll)
    return () => cancelAnimationFrame(frame)
  }, [playing, deckPlayback[0].playing, deckPlayback[1].playing])

  const commit = useCallback((next: ProjectState | ((current: ProjectState) => ProjectState)) => {
    setProject((current) => {
      history.current.push(current)
      if (history.current.length > 40) history.current.shift()
      future.current = []
      return typeof next === 'function' ? next(current) : next
    })
  }, [])

  const update = useCallback((patch: Partial<ProjectState>) => commit((current) => ({ ...current, demoAutoMix: false, ...patch })), [commit])
  const updateBass = useCallback((index: number, voice: BassVoice) => commit((current) => ({ ...current, demoAutoMix: false, bass: current.bass.map((item, cursor) => cursor === index ? voice : item) as [BassVoice, BassVoice] })), [commit])
  const updateRhythm = useCallback((index: number, machine: RhythmMachineState) => commit((current) => ({ ...current, demoAutoMix: false, rhythms: current.rhythms.map((item, cursor) => cursor === index ? machine : item) as [RhythmMachineState, RhythmMachineState] })), [commit])
  const updateWaveDesigner = useCallback((waveDesigner: WaveDesignerState) => commit((current) => ({ ...current, demoAutoMix: false, waveDesigner })), [commit])
  const sendWaveToBass = useCallback((index: 0 | 1) => {
    commit((current) => ({
      ...current,
      bass: current.bass.map((voice, cursor) => cursor === index ? transferWaveToBass(voice, current.waveDesigner) : voice) as [BassVoice, BassVoice],
    }))
    setKeyboardTarget(`bass-${index}` as KeyboardTarget)
    notify(`WAVE PATCH LOADED INTO 303·${index + 1}`)
  }, [commit, notify])
  const updateDeck = useCallback((index: number, patch: Partial<DeckState>) => commit((current) => ({ ...current, decks: current.decks.map((deck, cursor) => cursor === index ? { ...deck, ...patch } : deck) as [DeckState, DeckState] })), [commit])
  const restoreDeckSound = useCallback((index: 0 | 1) => {
    commit((current) => ({
      ...current,
      master: Math.max(current.master, 0.72),
      crossfader: 0,
      bass: current.bass.map((voice) => ({ ...voice, solo: false })) as [BassVoice, BassVoice],
      rhythms: current.rhythms.map((machine) => ({ ...machine, solo: false, drums: Object.fromEntries(drumNames.map((name) => [name, { ...machine.drums[name], solo: false }])) as typeof machine.drums })) as [RhythmMachineState, RhythmMachineState],
      waveDesigner: { ...current.waveDesigner, solo: false },
      sampler: { ...current.sampler, solo: false },
      decks: current.decks.map((deck, cursor) => cursor === index ? restoreDeckDefaults(deck, index) : { ...deck, solo: false }) as [DeckState, DeckState],
    }))
    notify(`DECK ${index ? 'B' : 'A'} ROUTING RESTORED`)
  }, [commit, notify])
  const updateSampler = useCallback((sampler: SamplerState) => commit((current) => ({ ...current, sampler })), [commit])
  const seekDeckPlayback = useCallback((index: number, seconds: number) => {
    setDeckPlayback((current) => current.map((state, cursor) => cursor === index ? { ...state, position: Math.max(0, Math.min(state.duration, seconds)) } : state) as [DeckPlaybackState, DeckPlaybackState])
    void engineRef.current?.seekDeck(index, seconds)
  }, [])
  const jogDeckPlayback = useCallback((index: number, seconds: number) => {
    setDeckPlayback((current) => current.map((state, cursor) => cursor === index ? { ...state, position: Math.max(0, Math.min(state.duration, state.position + seconds)) } : state) as [DeckPlaybackState, DeckPlaybackState])
    void engineRef.current?.jogDeck(index, seconds)
  }, [])

  const togglePlay = useCallback(async () => {
    if (playing) {
      engineRef.current?.pause(); setPlaying(false)
    } else {
      seenDownbeat.current = false
      await engineRef.current?.start(); setPlaying(true)
    }
  }, [playing])

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      const editable = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement || (event.target instanceof HTMLElement && event.target.isContentEditable)
      if (event.code === 'Space' && !event.repeat && !editable && !(event.target instanceof HTMLButtonElement)) { event.preventDefault(); void togglePlay(); return }
      if (event.key === 'Escape') { setShowHelp(false); setShowProjects(false) }
      if (editable || event.repeat) return
      const tonal = keyboardTarget === 'bass-0' || keyboardTarget === 'bass-1' || keyboardTarget === 'wave'
      if (tonal && (event.code === 'BracketLeft' || event.code === 'BracketRight')) {
        event.preventDefault()
        setKeyboardOctave((value) => Math.max(-2, Math.min(5, value + (event.code === 'BracketLeft' ? -1 : 1))))
        return
      }
      let handled = false
      if (tonal) {
        const offset = tonalKeyOffsets[event.code]
        if (offset !== undefined) {
          const note = 36 + keyboardOctave * 12 + offset
          if (keyboardTarget === 'wave') void engineRef.current?.previewWave(note)
          else void engineRef.current?.previewBass(keyboardTarget === 'bass-0' ? 0 : 1, note)
          handled = true
        }
      } else {
        const index = triggerKeyCodes.indexOf(event.code)
        if (keyboardTarget.startsWith('drums') && index >= 0 && index < drumNames.length) {
          void engineRef.current?.previewDrum(drumNames[index], keyboardTarget === 'drums-0' ? 0 : 1)
          handled = true
        } else if (keyboardTarget === 'sampler') {
          const sampler = projectRef.current.sampler
          if (sampler.sixteenLevels === 'off' && index >= 0 && index < 8) {
            void engineRef.current?.triggerSample(sampler.activeBank * 8 + index)
            handled = true
          } else if (sampler.sixteenLevels !== 'off') {
            const level = levelKeyCodes.indexOf(event.code)
            if (level >= 0) {
              const velocity = sampler.sixteenLevels === 'velocity' ? (level + 1) / 16 * 1.27 : 1
              const pitchOffset = sampler.sixteenLevels === 'pitch' ? -12 + level / 15 * 24 : 0
              void engineRef.current?.triggerSample(sampler.selectedSlot, velocity, pitchOffset)
              handled = true
            }
          }
        } else if (keyboardTarget === 'fx' && index >= 0 && index < fxPadNames.length) {
          void engineRef.current?.previewFxPad(index)
          handled = true
        }
      }
      if (handled) {
        event.preventDefault()
        setKeyboardPressed((current) => new Set(current).add(event.code))
      }
    }
    const handleKeyUp = (event: KeyboardEvent) => {
      setKeyboardPressed((current) => { const next = new Set(current); next.delete(event.code); return next })
      if (keyboardTarget === 'sampler') {
        const sampler = projectRef.current.sampler
        const pad = triggerKeyCodes.indexOf(event.code)
        const index = sampler.sixteenLevels === 'off' ? sampler.activeBank * 8 + pad : sampler.selectedSlot
        if ((pad >= 0 || levelKeyCodes.includes(event.code)) && sampler.slots[index]?.mode === 'loop') engineRef.current?.stopSample(index)
      }
    }
    window.addEventListener('keydown', handleKey)
    window.addEventListener('keyup', handleKeyUp)
    return () => { window.removeEventListener('keydown', handleKey); window.removeEventListener('keyup', handleKeyUp) }
  }, [togglePlay, keyboardTarget, keyboardOctave])

  const undo = () => {
    const previous = history.current.pop(); if (!previous) return
    future.current.push(project); setProject(previous); notify('UNDONE')
  }
  const redo = () => {
    const next = future.current.pop(); if (!next) return
    history.current.push(project); setProject(next); notify('REDONE')
  }
  const openProjects = () => {
    setSavedProjects(listProjects())
    setShowProjects((visible) => !visible)
  }
  const storeProject = (asCopy = false) => {
    const id = asCopy || !activeProjectId ? crypto.randomUUID() : activeProjectId
    saveProject(project, id)
    const updated = listProjects()
    setSavedProjects(updated)
    setActiveProjectId(id)
    notify(asCopy ? 'PROJECT COPY SAVED' : 'PROJECT SAVED')
  }
  const restoreAudioFor = async (next: ProjectState) => {
    const engine = engineRef.current
    if (!engine) return
    project.decks.forEach((_, index) => engine.unloadDeck(index))
    project.sampler.slots.forEach((_, index) => engine.unloadSample(index))
    const result = await restoreProjectAudioAssets(next, engine)
    if (result.missing.length) notify(`${result.missing.length} AUDIO FILE${result.missing.length === 1 ? '' : 'S'} MISSING`)
  }
  const loadSession = (next: ProjectState, savedId?: string, message = 'SONG + SOUND SETTINGS LOADED') => {
    const engine = engineRef.current
    engine?.stop()
    engine?.setProject(next)
    engine?.setSongPosition(0)
    setPlaying(false)
    setRecording(false)
    setCurrentStep(-1)
    seenDownbeat.current = false
    setBar(1)
    barRef.current = 1
    commit(next)
    setActiveProjectId(savedId)
    setShowProjects(false)
    void restoreAudioFor(next)
    notify(message)
  }
  const jumpToBar = (targetBar: number) => {
    setBar(targetBar)
    barRef.current = targetBar
    engineRef.current?.setSongPosition(targetBar - 1)
    commit((current) => current.mode === 'song' ? applySongPosition(current, targetBar - 1) : current)
  }
  const captureBar = (targetBar: number) => {
    commit((current) => {
      const songChain = [...current.songChain]
      songChain[targetBar - 1] = { bass: [current.bass[0].bank * 8 + current.bass[0].pattern, current.bass[1].bank * 8 + current.bass[1].pattern], drums: [current.rhythms[0].bank * 8 + current.rhythms[0].pattern, current.rhythms[1].bank * 8 + current.rhythms[1].pattern] }
      return { ...current, songChain }
    })
    notify(`BAR ${String(targetBar).padStart(2, '0')} CAPTURED`)
  }
  const insertBar = (targetBar: number) => {
    const nextBar = targetBar + 1
    commit((current) => {
      if (current.songChain.length >= 128) return current
      const source = current.songChain[targetBar - 1]
      const songChain = [...current.songChain]
      songChain.splice(targetBar, 0, { bass: [...source.bass] as [number, number], drums: [...source.drums] as [number, number] })
      const songScenes = normalizeSongScenes(current.songScenes.map((scene) => scene.start >= targetBar ? { ...scene, start: scene.start + 1 } : scene), songChain.length)
      return { ...current, songChain, songScenes }
    })
    setBar(nextBar); barRef.current = nextBar; engineRef.current?.setSongPosition(nextBar - 1)
    notify(`BAR INSERTED AFTER ${String(targetBar).padStart(2, '0')}`)
  }
  const addScene = (targetBar: number) => commit((current) => {
    const start = targetBar - 1
    if (current.songScenes.some((scene) => scene.start === start)) return current
    return { ...current, songScenes: normalizeSongScenes([...current.songScenes, { name: `SCENE ${String(current.songScenes.length + 1).padStart(2, '0')}`, start }], current.songChain.length) }
  })
  const removeScene = (index: number) => commit((current) => ({ ...current, songScenes: current.songScenes.filter((_, cursor) => cursor !== index) }))
  const renameScene = (index: number, name: string) => commit((current) => ({ ...current, songScenes: current.songScenes.map((scene, cursor) => cursor === index ? { ...scene, name: name.toUpperCase().slice(0, 18) } : scene) }))
  const removeBar = (targetBar: number) => {
    if (project.songChain.length <= 1) return
    const nextBar = Math.min(targetBar, project.songChain.length - 1)
    commit((current) => {
      const removedIndex = targetBar - 1
      const songChain = current.songChain.filter((_, index) => index !== removedIndex)
      const shifted = current.songScenes.map((scene) => scene.start > removedIndex ? { ...scene, start: scene.start - 1 } : scene)
      return { ...current, songChain, songScenes: normalizeSongScenes(shifted, songChain.length) }
    })
    setBar(nextBar); barRef.current = nextBar; engineRef.current?.setSongPosition(nextBar - 1)
  }
  const loadDeckAudio = async (index: number, file: File) => {
    try {
      const previousId = project.decks[index].assetId
      const record = await saveAudioAsset({ id: previousId?.startsWith('builtin:') ? undefined : previousId ?? undefined, projectId: activeProjectId ?? 'autosave', kind: 'deck', name: file.name, mimeType: file.type, data: file })
      await engineRef.current?.loadDeck(index, file)
      updateDeck(index, { assetId: record.id, name: file.name, cuePoint: 0, loopStart: 0, loopEnd: 0 })
      notify(`DECK ${index ? 'B' : 'A'} MEDIA READY`)
    } catch { notify('DECK LOAD FAILED') }
  }
  const unloadDeckAudio = async (index: number) => {
    const id = project.decks[index].assetId
    engineRef.current?.unloadDeck(index)
    if (id && !id.startsWith('builtin:')) await deleteAudioAsset(id).catch(() => undefined)
    updateDeck(index, { assetId: null, name: `DECK ${index ? 'B' : 'A'}`, cuePoint: 0, loop: false, loopStart: 0, loopEnd: 0 })
  }
  const loadSampleAudio = async (index: number, file: File) => {
    try {
      const previous = project.sampler.slots[index]
      const shared = previous.assetId && project.sampler.slots.some((slot, cursor) => cursor !== index && slot.assetId === previous.assetId)
      const reusableId = previous.assetId?.startsWith('builtin:') ? undefined : previous.assetId ?? undefined
      const record = await saveAudioAsset({ id: shared ? undefined : reusableId, projectId: activeProjectId ?? 'autosave', kind: 'sample', name: file.name, mimeType: file.type, data: file })
      await engineRef.current?.loadSample(index, file)
      updateSampler({ ...project.sampler, slots: project.sampler.slots.map((slot, cursor) => cursor === index ? { ...slot, assetId: record.id, name: file.name } : slot) })
      notify(`SAMPLE ${String(index + 1).padStart(2, '0')} READY`)
    } catch { notify('SAMPLE LOAD FAILED') }
  }
  const unloadSampleAudio = async (index: number) => {
    const id = project.sampler.slots[index].assetId
    engineRef.current?.unloadSample(index)
    const shared = id && (project.sampler.slots.some((slot, cursor) => cursor !== index && slot.assetId === id) || project.decks.some((deck) => deck.assetId === id))
    if (id && !shared && !id.startsWith('builtin:')) await deleteAudioAsset(id).catch(() => undefined)
    updateSampler({ ...project.sampler, slots: project.sampler.slots.map((slot, cursor) => cursor === index ? { ...slot, assetId: null, name: `SAMPLE ${String(index + 1).padStart(2, '0')}` } : slot) })
  }
  const autoChopSample = (sourceIndex: number, count: number) => {
    const slices = engineRef.current?.detectSampleSlices(sourceIndex, count) ?? []
    if (slices.length !== count + 1) { notify('LOAD AUDIO BEFORE CHOPPING'); return }
    const bankStart = Math.floor(sourceIndex / 8) * 8
    commit((current) => {
      const source = current.sampler.slots[sourceIndex]
      const slots = current.sampler.slots.map((slot, index) => {
        const offset = index - bankStart
        if (offset < 0 || offset >= count) return slot
        return { ...source, name: `${source.name.replace(/ CHOP \d+$/, '')} CHOP ${offset + 1}`.slice(0, 22), trimStart: slices[offset], trimEnd: slices[offset + 1], mode: 'oneShot' as const, steps: slot.steps, stepVelocities: slot.stepVelocities, stepNudges: slot.stepNudges, stepProbabilities: slot.stepProbabilities, stepRatchets: slot.stepRatchets }
      })
      return { ...current, sampler: { ...current.sampler, slots, selectedSlot: bankStart } }
    })
    for (let offset = 0; offset < count; offset += 1) engineRef.current?.copySampleBuffer(sourceIndex, bankStart + offset)
    notify(`${count} TRANSIENT CHOPS MAPPED TO BANK ${String.fromCharCode(65 + Math.floor(sourceIndex / 8))}`)
  }
  const duplicateSample = (sourceIndex: number) => {
    const bankStart = Math.floor(sourceIndex / 8) * 8
    const target = Array.from({ length: 8 }, (_, offset) => bankStart + offset).find((index) => !project.sampler.slots[index].assetId && index !== sourceIndex)
    if (target === undefined) { notify('CURRENT PAD BANK IS FULL'); return }
    commit((current) => ({ ...current, sampler: { ...current.sampler, selectedSlot: target, slots: current.sampler.slots.map((slot, index) => index === target ? { ...current.sampler.slots[sourceIndex], name: `${current.sampler.slots[sourceIndex].name} COPY`.slice(0, 22), steps: slot.steps, stepVelocities: slot.stepVelocities, stepNudges: slot.stepNudges, stepProbabilities: slot.stepProbabilities, stepRatchets: slot.stepRatchets } : slot) } }))
    engineRef.current?.copySampleBuffer(sourceIndex, target)
    notify(`SAMPLE DUPLICATED TO ${String.fromCharCode(65 + Math.floor(target / 8))}${target % 8 + 1}`)
  }
  const resampleToSlot = async (slotIndex: number, source: ResampleSource) => {
    const engine = engineRef.current
    if (!engine) return
    notify(`PRINTING ${resampleSources.find((item) => item.id === source)?.label}…`)
    try {
      let blob: Blob | null
      if (source === 'deck0' || source === 'deck1') blob = engine.exportDeckWav(source === 'deck0' ? 0 : 1)
      else {
        const isolated = structuredClone(projectRef.current)
        isolated.mode = 'pattern'
        isolated.bass = isolated.bass.map((voice, index) => ({ ...voice, muted: source === 'master' ? voice.muted : source !== `bass${index}`, solo: source === 'master' ? voice.solo : false })) as [BassVoice, BassVoice]
        isolated.rhythms = isolated.rhythms.map((machine, index) => ({ ...machine, muted: source === 'master' ? machine.muted : source !== `drums${index}`, solo: source === 'master' ? machine.solo : false, drums: Object.fromEntries(drumNames.map((name) => [name, { ...machine.drums[name], solo: source === 'master' ? machine.drums[name].solo : false }])) as typeof machine.drums })) as [RhythmMachineState, RhythmMachineState]
        isolated.waveDesigner = { ...isolated.waveDesigner, muted: source === 'master' ? isolated.waveDesigner.muted : source !== 'wave', solo: source === 'master' ? isolated.waveDesigner.solo : false }
        isolated.sampler = { ...isolated.sampler, muted: source === 'master' ? isolated.sampler.muted : source !== 'sampler', solo: source === 'master' ? isolated.sampler.solo : false }
        isolated.decks = isolated.decks.map((deck) => ({ ...deck, muted: source === 'master' ? deck.muted : true, solo: source === 'master' ? deck.solo : false })) as [DeckState, DeckState]
        blob = await engine.exportWav(isolated, { bars: 1 })
      }
      if (!blob) throw new Error('Source is empty')
      const sourceLabel = resampleSources.find((item) => item.id === source)?.label ?? source
      const record = await saveAudioAsset({ projectId: activeProjectId ?? 'autosave', kind: 'sample', name: `PRINT ${sourceLabel}.wav`, mimeType: 'audio/wav', data: blob })
      await engine.loadSample(slotIndex, blob)
      commit((current) => ({ ...current, sampler: { ...current.sampler, slots: current.sampler.slots.map((slot, index) => index === slotIndex ? { ...slot, assetId: record.id, name: `PRINT ${sourceLabel}`.slice(0, 22), trimStart: 0, trimEnd: 1 } : slot) } }))
      notify(`${sourceLabel} PRINTED TO SLOT ${String(slotIndex + 1).padStart(2, '0')}`)
    } catch { notify('RESAMPLE FAILED · CHECK SOURCE AUDIO') }
  }
  const scrollToRack = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start', inline: 'start' })
  const openMediaBay = () => {
    if (!performanceView) { scrollToRack('media-bay'); return }
    setPerformanceView(false)
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => scrollToRack('media-bay')))
  }

  const exportAudio = async () => {
    if (exportProgress) return
    setExportProgress({ completed: 0, total: project.mode === 'song' ? project.songChain.length : 4 })
    notify(project.mode === 'song' ? `RENDERING ${project.songChain.length}-BAR SONG…` : 'RENDERING 4-BAR LOOP…')
    try {
      const blob = await engineRef.current?.exportWav(project, { onProgress: (completed, total) => setExportProgress({ completed, total }) })
      if (blob) saveBlob(blob, `${project.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.wav`)
      notify('WAV EXPORT READY')
    } catch { notify('AUDIO EXPORT FAILED') }
    finally { setExportProgress(null) }
  }

  const importProject = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; if (!file) return
    try {
      const imported = JSON.parse(await file.text()) as ProjectState
      if (imported.version !== 1 || !imported.bass) throw new Error('Invalid project')
      const next = hydrateProject(imported)
      loadSession(next, undefined, 'IMPORTED SONG + SETTINGS LOADED')
    } catch { notify('INVALID PROJECT FILE') }
    event.target.value = ''
  }

  return (
    <main className={`workstation-shell ${performanceView ? 'performance-view' : ''}`}>
      <div className="ambient-glow" />
      <header className="transport-panel">
        <div className="product-mark"><span>by DAWID.AI</span><strong>RE:BORN <em>338</em></strong><small>ACID PERFORMANCE WORKSTATION / WEB EDITION</small></div>
        <div className="mode-switch"><span>MODE</span><button aria-pressed={project.mode === 'pattern'} className={project.mode === 'pattern' ? 'active' : ''} onClick={() => update({ mode: 'pattern' })}>PATTERN</button><button aria-pressed={project.mode === 'song'} className={project.mode === 'song' ? 'active' : ''} onClick={() => update({ mode: 'song' })}>SONG</button></div>
        <div className="transport-controls">
          <IconButton label="Previous bar" onClick={() => jumpToBar(Math.max(1, bar - 1))}><SkipBack /></IconButton>
          <IconButton label="Stop" onClick={() => { engineRef.current?.stop(); setPlaying(false); setCurrentStep(-1); seenDownbeat.current = false }}><Square /></IconButton>
          <IconButton label={playing ? 'Pause' : 'Play'} active={playing} onClick={() => void togglePlay()}>{playing ? <Pause /> : <Play />}</IconButton>
          <IconButton label="Record song pattern changes" danger active={recording} onClick={() => { setRecording(!recording); if (!recording) update({ mode: 'song' }); notify(recording ? 'RECORD OFF' : 'SONG CAPTURE ARMED') }}><i className="record-dot" /></IconButton>
          <IconButton label="Next bar" onClick={() => jumpToBar(Math.min(project.songChain.length, bar + 1))}><SkipForward /></IconButton>
        </div>
        <div className="digital-cluster">
          <div className="digital-readout"><span>BAR</span><strong>{String(bar).padStart(3, '0')}</strong></div>
          <div className="digital-readout tempo"><span>TEMPO</span><strong>{project.tempo.toFixed(1)}</strong><small>BPM</small></div>
          <div className="tempo-buttons"><button onClick={() => update({ tempo: Math.max(60, project.tempo - 1) })}>−</button><button onClick={() => update({ tempo: Math.min(190, project.tempo + 1) })}>+</button></div>
          <Knob compact label="SHUFFLE" value={project.swing} onChange={(swing) => update({ swing })} accent="amber" />
        </div>
        <div className="global-actions">
          <IconButton label="Undo" onClick={undo}><Undo2 /></IconButton><IconButton label="Redo" onClick={redo}><Redo2 /></IconButton>
          <button className={`view-mode-button ${performanceView ? 'active' : ''}`} aria-pressed={performanceView} onClick={() => { setPerformanceView(!performanceView); notify(performanceView ? 'STUDIO VIEW' : 'PERFORMANCE VIEW') }}><Gauge /><span>{performanceView ? 'STUDIO' : 'LIVE'}</span></button>
          <button className="view-mode-button media-jump-button" onClick={openMediaBay}><Disc3 /><span>MEDIA</span></button>
          <IconButton label="Projects" active={showProjects} onClick={openProjects}><FolderOpen /></IconButton>
          <IconButton label="Help" active={showHelp} onClick={() => setShowHelp(!showHelp)}><CircleHelp /></IconButton>
        </div>
      </header>

      <div className="status-rail"><span><i className="status-light" /> AUDIO ENGINE READY</span><span>16 STEP / 44.1 KHZ</span><span>LOCAL DSP · QWERTY INPUT</span><span className="status-tip">SPACE TO START · SELECT A KEYBOARD TARGET, THEN PLAY</span></div>
      <ComputerKeyboard target={keyboardTarget} octave={keyboardOctave} pressed={keyboardPressed} sampler={project.sampler} onTarget={setKeyboardTarget} onOctave={setKeyboardOctave} />
      <nav className="rack-nav" aria-label="Rack navigation"><button onClick={() => { setKeyboardTarget('bass-0'); scrollToRack('bass-1') }}>303·1</button><button onClick={() => { setKeyboardTarget('bass-1'); scrollToRack('bass-2') }}>303·2</button><button onClick={() => { setKeyboardTarget('wave'); scrollToRack('wave-designer') }}>WAVE</button><button onClick={() => { setKeyboardTarget('drums-0'); scrollToRack('drum-808') }}>808</button><button onClick={() => { setKeyboardTarget('drums-1'); scrollToRack('drum-909') }}>909</button><button onClick={() => scrollToRack('performance-deck')}>LIVE</button><button onClick={() => { setKeyboardTarget('sampler'); scrollToRack('media-bay') }}>MEDIA</button><button onClick={() => scrollToRack('master-rack')}>MIX</button></nav>

      {project.mode === 'song' && <SongStrip project={project} bar={bar} onJump={jumpToBar} onCapture={captureBar} onInsert={insertBar} onRemove={removeBar} onAddScene={addScene} onRemoveScene={removeScene} onRenameScene={renameScene} />}

      <div className="workspace-grid">
        <div className="machines-column">
          <BassUnit index={0} voice={project.bass[0]} currentStep={currentStep} onChange={(voice) => updateBass(0, voice)} onPreview={(note) => engineRef.current?.previewBass(0, note)} />
          <BassUnit index={1} voice={project.bass[1]} currentStep={currentStep} onChange={(voice) => updateBass(1, voice)} onPreview={(note) => engineRef.current?.previewBass(1, note)} />
          <WaveDesigner voice={project.waveDesigner} currentStep={currentStep} onChange={updateWaveDesigner} onPreview={(note) => engineRef.current?.previewWave(note)} onSend={sendWaveToBass} />
          <DrumMachine machine={project.rhythms[0]} machineIndex={0} currentStep={currentStep} update={(machine) => updateRhythm(0, machine)} preview={(name) => engineRef.current?.previewDrum(name, 0)} />
          <DrumMachine machine={project.rhythms[1]} machineIndex={1} currentStep={currentStep} update={(machine) => updateRhythm(1, machine)} preview={(name) => engineRef.current?.previewDrum(name, 1)} />
          <PerformanceDeck project={project} bar={bar} update={update} triggerPad={(index) => engineRef.current?.previewFxPad(index)} launchScene={jumpToBar} captureScene={captureBar} markScene={addScene} />
          <MediaBay project={project} playback={deckPlayback} updateDeck={updateDeck} restoreDeck={restoreDeckSound} updateSampler={updateSampler} loadDeck={(index, file) => void loadDeckAudio(index, file)} playDeck={(index) => void engineRef.current?.playDeck(index)} pauseDeck={(index) => engineRef.current?.pauseDeck(index)} cueDeck={(index) => engineRef.current?.cueDeck(index)} seekDeck={seekDeckPlayback} jogDeck={jogDeckPlayback} unloadDeck={(index) => void unloadDeckAudio(index)} loadSample={(index, file) => void loadSampleAudio(index, file)} unloadSample={(index) => void unloadSampleAudio(index)} triggerSample={(index, velocity, pitchOffset) => void engineRef.current?.triggerSample(index, velocity, pitchOffset)} stopSample={(index) => engineRef.current?.stopSample(index)} sampleWaveform={(index) => engineRef.current?.getSampleWaveform(index) ?? []} autoChop={autoChopSample} duplicateSample={duplicateSample} resample={(index, source) => void resampleToSlot(index, source)} />
        </div>

        <aside className="master-rack" id="master-rack">
          <Screw dark /><Screw dark /><Screw dark /><Screw dark />
          <header><Radio /><div><span>OUTPUT SECTION</span><strong>MASTER BUS</strong></div></header>
          <section className="global-sound" aria-label="Global sound controls">
            <div className="global-sound-heading"><strong>GLOBAL SOUND</strong><span>One place to tame the full mix</span></div>
            <div className="global-sound-switches">
              <button className={project.effectsEnabled ? 'active' : ''} aria-pressed={project.effectsEnabled} title="Bypass stereo delay, reverb, and beat repeat immediately" onClick={() => update({ effectsEnabled: !project.effectsEnabled })}>ALL ECHO FX {project.effectsEnabled ? 'ON' : 'OFF'}</button>
              <button className={project.smoothOutput ? 'active' : ''} aria-pressed={project.smoothOutput} title="Enable master softening" onClick={() => update({ smoothOutput: !project.smoothOutput })}>SOFTEN {project.smoothOutput ? 'ON' : 'OFF'}</button>
              <button className={project.demoAutoMix ? 'active' : ''} aria-pressed={project.demoAutoMix} title="Let the authored demo change mix settings at song bars; manual sound edits turn this off" onClick={() => update({ demoAutoMix: !project.demoAutoMix })}>DEMO AUTO {project.demoAutoMix ? 'ON' : 'OFF'}</button>
            </div>
            <div className="global-sound-sliders">
              {([
                ['ECHO MIX', 'delayMix'], ['REVERB MIX', 'reverbMix'],
                ['HARSHNESS / SOFTEN', 'softenAmount'], ['BRIGHTNESS', 'filterCutoff'],
                ['DRIVE', 'masterDrive'], ['GLUE', 'compressor'],
              ] as const).map(([label, key]) => <label key={key}><span>{label}</span><input aria-label={`Global ${label.toLowerCase()}`} type="range" min="0" max="100" value={project[key]} onChange={(event) => update({ [key]: Number(event.target.value), demoAutoMix: false })} /><output>{project[key]}</output></label>)}
            </div>
            <p>All Echo FX bypasses delay, reverb, and Beat Repeat. Manual edits stay put; Demo Auto restores bar-by-bar tone changes.</p>
          </section>
          <div className="source-mixer">
            <div className="module-title"><Gauge /> EIGHT CHANNEL MIXER</div>
            <div className="channel-strips">
              <ChannelStrip label="303·1" level={project.bass[0].level} pan={project.bass[0].pan} delay={project.bass[0].delay} reverb={project.bass[0].reverb} eq={[project.bass[0].eqLow, project.bass[0].eqMid, project.bass[0].eqHigh]} muted={project.bass[0].muted} solo={project.bass[0].solo} onLevel={(level) => updateBass(0, { ...project.bass[0], level })} onPan={(pan) => updateBass(0, { ...project.bass[0], pan })} onDelay={(delay) => updateBass(0, { ...project.bass[0], delay })} onReverb={(reverb) => updateBass(0, { ...project.bass[0], reverb })} onEq={(band, value) => updateBass(0, { ...project.bass[0], [(['eqLow', 'eqMid', 'eqHigh'] as const)[band]]: value })} onMute={() => updateBass(0, { ...project.bass[0], muted: !project.bass[0].muted })} onSolo={() => updateBass(0, { ...project.bass[0], solo: !project.bass[0].solo })} />
              <ChannelStrip label="303·2" level={project.bass[1].level} pan={project.bass[1].pan} delay={project.bass[1].delay} reverb={project.bass[1].reverb} eq={[project.bass[1].eqLow, project.bass[1].eqMid, project.bass[1].eqHigh]} muted={project.bass[1].muted} solo={project.bass[1].solo} onLevel={(level) => updateBass(1, { ...project.bass[1], level })} onPan={(pan) => updateBass(1, { ...project.bass[1], pan })} onDelay={(delay) => updateBass(1, { ...project.bass[1], delay })} onReverb={(reverb) => updateBass(1, { ...project.bass[1], reverb })} onEq={(band, value) => updateBass(1, { ...project.bass[1], [(['eqLow', 'eqMid', 'eqHigh'] as const)[band]]: value })} onMute={() => updateBass(1, { ...project.bass[1], muted: !project.bass[1].muted })} onSolo={() => updateBass(1, { ...project.bass[1], solo: !project.bass[1].solo })} />
              <ChannelStrip label="808" level={project.rhythms[0].level} pan={project.rhythms[0].pan} delay={project.rhythms[0].delay} reverb={project.rhythms[0].reverb} eq={[project.rhythms[0].eqLow, project.rhythms[0].eqMid, project.rhythms[0].eqHigh]} muted={project.rhythms[0].muted} solo={project.rhythms[0].solo} onLevel={(level) => updateRhythm(0, { ...project.rhythms[0], level })} onPan={(pan) => updateRhythm(0, { ...project.rhythms[0], pan })} onDelay={(delay) => updateRhythm(0, { ...project.rhythms[0], delay })} onReverb={(reverb) => updateRhythm(0, { ...project.rhythms[0], reverb })} onEq={(band, value) => updateRhythm(0, { ...project.rhythms[0], [(['eqLow', 'eqMid', 'eqHigh'] as const)[band]]: value })} onMute={() => updateRhythm(0, { ...project.rhythms[0], muted: !project.rhythms[0].muted })} onSolo={() => updateRhythm(0, { ...project.rhythms[0], solo: !project.rhythms[0].solo })} />
              <ChannelStrip label="909" level={project.rhythms[1].level} pan={project.rhythms[1].pan} delay={project.rhythms[1].delay} reverb={project.rhythms[1].reverb} eq={[project.rhythms[1].eqLow, project.rhythms[1].eqMid, project.rhythms[1].eqHigh]} muted={project.rhythms[1].muted} solo={project.rhythms[1].solo} onLevel={(level) => updateRhythm(1, { ...project.rhythms[1], level })} onPan={(pan) => updateRhythm(1, { ...project.rhythms[1], pan })} onDelay={(delay) => updateRhythm(1, { ...project.rhythms[1], delay })} onReverb={(reverb) => updateRhythm(1, { ...project.rhythms[1], reverb })} onEq={(band, value) => updateRhythm(1, { ...project.rhythms[1], [(['eqLow', 'eqMid', 'eqHigh'] as const)[band]]: value })} onMute={() => updateRhythm(1, { ...project.rhythms[1], muted: !project.rhythms[1].muted })} onSolo={() => updateRhythm(1, { ...project.rhythms[1], solo: !project.rhythms[1].solo })} />
              <ChannelStrip label="WAVE" level={project.waveDesigner.level} pan={project.waveDesigner.pan} delay={project.waveDesigner.delay} reverb={project.waveDesigner.reverb} eq={[project.waveDesigner.eqLow, project.waveDesigner.eqMid, project.waveDesigner.eqHigh]} muted={project.waveDesigner.muted} solo={project.waveDesigner.solo} onLevel={(level) => updateWaveDesigner({ ...project.waveDesigner, level })} onPan={(pan) => updateWaveDesigner({ ...project.waveDesigner, pan })} onDelay={(delay) => updateWaveDesigner({ ...project.waveDesigner, delay })} onReverb={(reverb) => updateWaveDesigner({ ...project.waveDesigner, reverb })} onEq={(band, value) => updateWaveDesigner({ ...project.waveDesigner, [(['eqLow', 'eqMid', 'eqHigh'] as const)[band]]: value })} onMute={() => updateWaveDesigner({ ...project.waveDesigner, muted: !project.waveDesigner.muted })} onSolo={() => updateWaveDesigner({ ...project.waveDesigner, solo: !project.waveDesigner.solo })} />
              <ChannelStrip label="SAMP" level={project.sampler.level} pan={project.sampler.pan} delay={project.sampler.delay} reverb={project.sampler.reverb} eq={[project.sampler.eqLow, project.sampler.eqMid, project.sampler.eqHigh]} muted={project.sampler.muted} solo={project.sampler.solo} onLevel={(level) => updateSampler({ ...project.sampler, level })} onPan={(pan) => updateSampler({ ...project.sampler, pan })} onDelay={(delay) => updateSampler({ ...project.sampler, delay })} onReverb={(reverb) => updateSampler({ ...project.sampler, reverb })} onEq={(band, value) => updateSampler({ ...project.sampler, [(['eqLow', 'eqMid', 'eqHigh'] as const)[band]]: value })} onMute={() => updateSampler({ ...project.sampler, muted: !project.sampler.muted })} onSolo={() => updateSampler({ ...project.sampler, solo: !project.sampler.solo })} />
              {project.decks.map((deck, index) => <ChannelStrip key={index} label={`DECK ${index ? 'B' : 'A'}`} level={deck.gain} pan={deck.pan} delay={deck.delay} reverb={deck.reverb} eq={[deck.eqLow, deck.eqMid, deck.eqHigh]} muted={deck.muted} solo={deck.solo} onLevel={(gain) => updateDeck(index, { gain })} onPan={(pan) => updateDeck(index, { pan })} onDelay={(delay) => updateDeck(index, { delay })} onReverb={(reverb) => updateDeck(index, { reverb })} onEq={(band, value) => updateDeck(index, { [(['eqLow', 'eqMid', 'eqHigh'] as const)[band]]: value })} onMute={() => updateDeck(index, { muted: !deck.muted })} onSolo={() => updateDeck(index, { solo: !deck.solo })} />)}
            </div>
          </div>
          <Scope samples={waveform} />
          <div className="rack-module delay-module">
            <div className="module-title"><Waves /> STEREO DELAY</div>
            <Knob label="TIME" value={project.delayTime} onChange={(delayTime) => update({ delayTime })} accent="amber" />
            <Knob label="FEEDBACK" value={project.delayFeedback} onChange={(delayFeedback) => update({ delayFeedback })} accent="amber" />
          </div>
          <div className="rack-module reverb-module">
            <div className="module-title"><Waves /> ALGORITHM SPACE</div>
            <Knob label="TONE" value={project.reverbTone} onChange={(reverbTone) => update({ reverbTone })} accent="silver" />
          </div>
          <div className="rack-module">
            <div className="module-title"><Gauge /> BUS GLUE</div>
            <div className="gain-reduction"><span>LIVE GR</span>{Array.from({ length: 6 }, (_, i) => <i key={i} className={i < Math.ceil(gainReduction * 6) ? 'lit' : ''} />)}</div>
          </div>
          <div className="rack-module color-module">
            <div className="module-title"><Radio /> MASTER FILTER</div>
            <Knob compact label="Q" value={project.filterResonance} onChange={(filterResonance) => update({ filterResonance })} accent="acid" />
          </div>
          <div className="master-fader">
            <Meter level={meterLevel} />
            <label><span>MASTER</span><input aria-label="Master volume" type="range" min="0" max="1" step="0.01" value={project.master} onChange={(event) => update({ master: Number(event.target.value) })} /><output>{Math.round(project.master * 100)}</output></label>
          </div>
          <button className="export-button" disabled={Boolean(exportProgress)} onClick={() => void exportAudio()}><Download /> {exportProgress ? `RENDERING ${exportProgress.completed}/${exportProgress.total} BARS` : `EXPORT ${project.mode === 'song' ? `${project.songChain.length}-BAR SONG` : '4-BAR LOOP'} WAV`} <span>{exportProgress ? 'offline mixdown in progress · keep this tab open' : '44.1 kHz / 16 bit · effects tail included'}</span></button>
          <div className="headphone-mark"><Headphones /><span>ZERO INSTALL<br />BROWSER AUDIO</span></div>
        </aside>
      </div>

      <footer><span>RE:BORN 338 / BUILD 01.09</span><span>DESIGNED FOR CHROME · EDGE · FIREFOX</span><span>LOCAL-FIRST · NO UPLOADS</span></footer>

      {showProjects && <div className="popover projects-popover">
        <header><div><span>PROJECT VAULT</span><strong>LOCAL SESSIONS</strong></div><button aria-label="Close projects" onClick={() => setShowProjects(false)}>×</button></header>
        <label className="project-name"><span>PROJECT NAME</span><input value={project.name} maxLength={32} onChange={(event) => update({ name: event.target.value.toUpperCase() })} /></label>
        <button onClick={() => storeProject(false)}><Save /> SAVE CURRENT PROJECT</button>
        <button onClick={() => storeProject(true)}><Save /> SAVE AS NEW COPY</button>
        <div className="saved-list">
          {savedProjects.length === 0 && <span>NO NAMED PROJECTS YET</span>}
          {savedProjects.map((summary) => <div key={summary.id} className={activeProjectId === summary.id ? 'active' : ''}><button onClick={() => { const saved = loadProject(summary.id); if (saved) loadSession(hydrateProject(saved), summary.id) }}><strong>{summary.name}</strong><small>{new Date(summary.updatedAt).toLocaleDateString()}</small></button><button aria-label={`Delete ${summary.name}`} onClick={() => { deleteProject(summary.id); setSavedProjects(listProjects()); if (activeProjectId === summary.id) setActiveProjectId(undefined); notify('PROJECT DELETED') }}>×</button></div>)}
        </div>
        <button onClick={() => fileInput.current?.click()}><Upload /> IMPORT PROJECT</button>
        <button onClick={() => saveBlob(new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' }), `${project.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.rb338.json`)}><FileDown /> EXPORT PROJECT</button>
        <div className="demo-loader"><label htmlFor="demo-song-select">DEMO SONG</label><select id="demo-song-select" value={selectedDemo} onChange={(event) => setSelectedDemo(event.target.value as DemoId)}>{demoCatalog.map((demo) => <option key={demo.id} value={demo.id}>{demo.label}</option>)}</select><p>{demoCatalog.find((demo) => demo.id === selectedDemo)?.detail}</p><button className="reset-action" onClick={() => loadSession(createDemoProject(selectedDemo), undefined, 'DEMO SONG + ORIGINAL SETTINGS LOADED')}><RotateCcw /> LOAD SELECTED DEMO</button></div>
        <input ref={fileInput} hidden type="file" accept=".json,.rb338" onChange={(event) => void importProject(event)} />
        <small>Projects and autosaves stay on this device.</small>
      </div>}

      {showHelp && <div className="popover help-popover">
        <header><div><span>WORKSTATION GUIDE</span><strong>HOW RE:BORN WORKS</strong></div><button aria-label="Close help" onClick={() => setShowHelp(false)}>×</button></header>
        <div className="help-grid">
          <section><h3>1 · MAKE A PATTERN</h3><p>Select a 303 or drum pattern, then program its 16 steps. Left-click toggles/cycles; right-click fully clears one step. <b>Wipe All</b> clears the complete current pattern. <b>Default</b> restores machine sound/mix controls without erasing patterns.</p></section>
          <section><h3>2 · PLAY WITH KEYS</h3><p>Choose a module in Computer Keys. Use <kbd>Z</kbd>/<kbd>Q</kbd> rows for notes and <kbd>Q</kbd> onward for drums, pads, or FX. Use the octave −/+ buttons beside each keyboard; <kbd>[</kbd>/<kbd>]</kbd> also shift Computer Keys.</p></section>
          <section><h3>3 · BUILD THE SONG</h3><p>Song bars store which 303 and drum patterns play. Select a bar and use <b>Capture Current</b>. Insert After copies beside that bar, so the song is not limited to named sections or a fixed length.</p></section>
          <section><h3>4 · USE SCENES LIVE</h3><p>Scenes are persistent markers in the Song arrangement. Launching one jumps to its first bar. In Performance Lab, <b>Capture to Scene</b> writes the current patterns there; Mark Bar creates a new launch point.</p></section>
          <section><h3>5 · DESIGN & MIX</h3><p>Wave Designer is its own synth. <b>Load Into 303</b> copies its oscillator/tone into that 303 while keeping the acid sequence. <b>Smooth</b> reduces master saturation and gently tames harsh upper mids/highs; Raw keeps the brighter driven sound.</p></section>
          <section><h3>6 · SAMPLE & DJ</h3><p>Decks A/B start with playable loops. A red deck status identifies mute, Solo blocking, zero gain, or a crossfader cut; <b>Restore Sound</b> repairs that routing. Amen Break is ready for Auto 4/8 chopping and Warp.</p></section>
          <section><h3>7 · SAVE & EXPORT</h3><p>Autosave and named projects stay locally in this browser. Project export preserves settings and user-audio references on this device; WAV Export renders the full song or a four-bar pattern loop.</p></section>
          <section><h3>GLOBAL SOUND</h3><p>In Mix, All Echo FX OFF bypasses stereo delay, reverb, and Live Beat Repeat, including audible tails. The demo starts dry. Soften tames harsh upper mids and highs; Brightness, Drive, and Glue shape the full mix. Manual sound edits turn Demo Auto off so bar changes cannot undo them.</p></section>
          <section><h3>FAST START</h3><p>Press <kbd>Space</kbd> to hear the current song. In Projects, choose a demo and Load Selected Demo for a fresh complete song and sound setup. These are original tributes, not soundtrack recordings.</p></section>
        </div>
        <p className="browser-note">Audio wakes after your first click or key press, as required by modern browsers.</p>
      </div>}

      {toast && <div className="toast"><i />{toast}</div>}
    </main>
  )
}

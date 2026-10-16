import { Check, Eye, EyeOff, PanelRight, Play, Printer, Sparkles, Split, Square, Trash2, Unlink, X } from 'lucide-react'
import type { CSSProperties, ReactNode } from 'react'
import { studio } from '@reborn/studio-core'
import { engine } from '../audio/host'
import { separateStems, useIsmail } from '../audio/ismail'
import { resample } from '../audio/resample'
import { desktop } from '../platform/desktop'
import { recordParamMove } from '../state/record'
import { splitSelectedClip } from '../state/clipActions'
import { modifiers } from '../state/modifiers'
import { applyProposal, isPicked, rejectProposal, togglePick, usePreview } from '../state/proposals'
import { type Selection, dispatch, getState, select, setPrefs, setState, useStudio } from '../state/store'
import { launchScene } from './Build'
import { Knob, Slider, Toggle } from './Controls'

type Track = studio.Track

const pct = (v: number) => `${Math.round(v * 100)}%`
const db = (v: number) => (v <= -60 ? '−∞ dB' : `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`)

/** Macro mapping: name each macro and choose the parameters (and ranges) it drives. */
function MacroEditor({ track }: { track: studio.Track }) {
  const specs = studio.paramSpecs(track)
  const map = (index: number, patch: { name?: string; targets?: studio.MacroTarget[] }) => dispatch({ type: 'macro.map', params: { trackId: track.id, index, ...patch } }, { label: `Map ${track.name} macro ${index + 1}` })
  if (!track.macros.length) return null
  return (
    <Group title="Macros">
      <ul className="macro-map">
        {track.macros.map((macro, index) => (
          <li key={index}>
            <input type="text" defaultValue={macro.name} key={`${track.id}-${index}-${macro.name}`} aria-label={`Macro ${index + 1} name`} onKeyDown={(event) => event.stopPropagation()} onBlur={(event) => event.target.value !== macro.name && map(index, { name: event.target.value })} />
            <div className="macro-targets">
              {macro.targets.map((target) => {
                const spec = studio.findParamSpec(track, target.param)
                return (
                  <span key={target.param} className="chip">
                    {spec?.label ?? target.param} {spec ? `${studio.formatParam(spec, target.min)}–${studio.formatParam(spec, target.max)}` : ''}
                    <button type="button" aria-label={`Stop macro ${index + 1} driving ${spec?.label ?? target.param}`} onClick={() => map(index, { targets: macro.targets.filter((t) => t.param !== target.param) })}>
                      ×
                    </button>
                  </span>
                )
              })}
              {macro.targets.length < 8 && (
                <select
                  value=""
                  aria-label={`Add a parameter to macro ${index + 1}`}
                  onChange={(event) => event.target.value && map(index, { targets: [...macro.targets, { param: event.target.value, min: studio.findParamSpec(track, event.target.value)!.min, max: studio.findParamSpec(track, event.target.value)!.max }] })}
                >
                  <option value="">+ Add</option>
                  {specs.filter((spec) => !macro.targets.some((t) => t.param === spec.id)).map((spec) => (
                    <option key={spec.id} value={spec.id}>
                      {spec.label}
                    </option>
                  ))}
                </select>
              )}
            </div>
          </li>
        ))}
      </ul>
      <p className="muted small">Each macro sweeps its parameters across their ranges. The CLI and agents can set custom or inverted ranges with macro.map.</p>
    </Group>
  )
}

/** Resample: prints this source over the loop range (or the whole song) to a new audio track. */
function PrintButton({ onPrint }: { onPrint: () => void }) {
  const loop = useStudio((s) => s.transport.loop)
  const length = useStudio((s) => s.project.length)
  const [from, to] = loop ?? [0, length]
  return (
    <div className="insp-row">
      <button type="button" className="chip-btn" onClick={onPrint} title="Render this source to a new sample on an audio track. The source stays as it is.">
        <Printer size={12} />
        Print bars {from + 1}–{to} to audio
      </button>
    </div>
  )
}

/** Stem separation through Ismail (desktop only): stems land on new audio tracks; the source is unchanged. */
function SeparateButton({ assetId, clipId }: { assetId: string; clipId?: string }) {
  const busy = useIsmail((s) => s.busy)
  if (!desktop) return null
  return (
    <div className="insp-row">
      <button type="button" className="chip-btn" disabled={busy !== null} onClick={() => void separateStems(assetId, clipId)} title="Split into drums, bass, other, and vocals with Ismail (Demucs). Each stem gets a new audio track; the source stays as it is.">
        <Split size={12} />
        {busy === 'separate' ? 'Separating stems…' : 'Separate stems'}
      </button>
    </div>
  )
}

/** A knob for any track parameter, with ghost preview and Alt-to-lock on a selected step. */
export function ParamKnob({ track, param, label, size = 'sm' }: { track: Track; param: string; label?: string; size?: 'sm' | 'md' }) {
  const preview = usePreview()
  const selection = useStudio((s) => s.selection)
  const spec = studio.findParamSpec(track, param)
  if (!spec) return null
  const value = studio.getParam(track, param) ?? spec.default
  const ghostTrack = preview?.tracks.find((t) => t.id === track.id)
  const ghostValue = ghostTrack ? studio.getParam(ghostTrack, param) : undefined
  return (
    <Knob
      size={size}
      label={label ?? spec.label}
      midi={{ kind: 'param', trackId: track.id, param, label: `${track.name} ${spec.label}` }}
      value={studio.normalize(spec, value)}
      defaultValue={studio.normalize(spec, spec.default)}
      ghost={ghostValue !== undefined && Math.abs(ghostValue - value) > 1e-6 ? studio.normalize(spec, ghostValue) : null}
      format={(v) => studio.formatParam(spec, studio.denormalize(spec, v))}
      onChange={(v) => {
        const next = studio.denormalize(spec, v)
        if (modifiers.alt && selection.kind === 'step') {
          const clip = getState().project.clips.find((c) => c.id === selection.clipId)
          const pattern = clip?.patternId ? getState().project.patterns[clip.patternId] : undefined
          if (clip?.trackId === track.id && pattern?.kind === 'notes') {
            dispatch({ type: 'step.set', params: { patternId: pattern.id, index: selection.index, locks: { [param]: next } } }, { label: `Lock ${spec.label} on step ${selection.index + 1}`, key: `lock-${pattern.id}-${selection.index}-${param}` })
            return
          }
          if (clip?.trackId === track.id && pattern?.kind === 'drums' && selection.voice) {
            dispatch({ type: 'drum.step.set', params: { patternId: pattern.id, voice: selection.voice, index: selection.index, locks: { [param]: next } } }, { label: `Lock ${spec.label} on step ${selection.index + 1}`, key: `lock-${pattern.id}-${selection.index}-${param}` })
            return
          }
        }
        dispatch({ type: 'parameter.set', params: { trackId: track.id, param, value: next } }, { label: `${track.name} ${spec.label}`, key: `param-${track.id}-${param}` })
        recordParamMove(track.id, param, next)
      }}
    />
  )
}

function Seg<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: { value: T; label: string }[]; onChange: (value: T) => void }) {
  return (
    <div className="seg sm" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} className={value === o.value ? 'is-on' : ''} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="insp-group">
      <h3>{title}</h3>
      {children}
    </div>
  )
}

const WAVES = [
  { value: 'sine' as const, label: 'Sine' },
  { value: 'triangle' as const, label: 'Tri' },
  { value: 'sawtooth' as const, label: 'Saw' },
  { value: 'square' as const, label: 'Square' },
]

function DevicePanel({ track }: { track: Track }) {
  const device = track.device
  const update = (params: Record<string, unknown>) => dispatch({ type: 'device.update', params: { trackId: track.id, ...params } }, { label: `${track.name} device` })
  if (device.kind === 'acid') {
    return (
      <Group title="Acid Synth">
        <div className="insp-row">
          <Seg label="Oscillator" value={device.source} options={[{ value: 'classic', label: 'Classic' }, { value: 'designer', label: 'Designer' }]} onChange={(source) => update({ source })} />
          {device.source === 'classic' ? (
            <Seg label="Waveform" value={device.waveform} options={[{ value: 'sawtooth', label: 'Saw' }, { value: 'square', label: 'Square' }]} onChange={(waveform) => update({ waveform })} />
          ) : (
            <Seg label="Designer waveform" value={device.designerWaveform} options={WAVES} onChange={(designerWaveform) => update({ designerWaveform })} />
          )}
        </div>
        <div className="knob-grid">
          {['device.cutoff', 'device.resonance', 'device.envMod', 'device.decay', 'device.accent', 'device.drive', 'device.tune', 'device.level', ...(device.source === 'designer' ? ['device.spread'] : [])].map((p) => (
            <ParamKnob key={p} track={track} param={p} />
          ))}
        </div>
      </Group>
    )
  }
  if (device.kind === 'wave') {
    return (
      <Group title="Wave Synth">
        <Seg label="Waveform" value={device.waveform} options={WAVES} onChange={(waveform) => update({ waveform })} />
        <div className="knob-grid">
          {['device.cutoff', 'device.resonance', 'device.attack', 'device.release', 'device.spread', 'device.drive', 'device.tune', 'device.level'].map((p) => (
            <ParamKnob key={p} track={track} param={p} />
          ))}
        </div>
      </Group>
    )
  }
  if (device.kind === 'drum') {
    return (
      <Group title="Drum Machine">
        <div className="insp-row">
          <Seg label="Kit" value={device.kit} options={[{ value: '808', label: '808' }, { value: '909', label: '909' }]} onChange={(kit) => update({ kit })} />
          <ParamKnob track={track} param="device.level" />
        </div>
        <div className="voice-table">
          {studio.DRUM_VOICES.map((voice) => (
            <div key={voice} className={`voice-row${device.voices[voice].mute ? ' is-muted' : ''}`}>
              <button type="button" className="voice-name" onClick={() => void engine.previewDrum(track.id, voice)} title="Audition">
                {studio.DRUM_VOICE_LABELS[voice]}
              </button>
              {(['level', 'tone', 'decay', 'tune', 'pan'] as const).map((field) => (
                <ParamKnob key={field} track={track} param={`voice.${voice}.${field}`} label={field[0].toUpperCase() + field.slice(1)} />
              ))}
              <button type="button" className={`ms mute${device.voices[voice].mute ? ' is-on' : ''}`} aria-pressed={device.voices[voice].mute} aria-label={`Mute ${studio.DRUM_VOICE_LABELS[voice]}`} onClick={() => dispatch({ type: 'drum.voice.set', params: { trackId: track.id, voice, mute: !device.voices[voice].mute } }, { label: 'Mute drum voice' })}>
                M
              </button>
            </div>
          ))}
        </div>
      </Group>
    )
  }
  if (device.kind === 'sampler') {
    return (
      <Group title="Sampler">
        <div className="knob-grid">
          {['device.level', 'device.drive', 'device.crush'].map((p) => (
            <ParamKnob key={p} track={track} param={p} />
          ))}
        </div>
        <span className="field-label">Sixteen Levels</span>
        <Seg
          label="Sixteen Levels"
          value={device.sixteenLevels}
          options={[{ value: 'off', label: 'Off' }, { value: 'velocity', label: 'Velocity' }, { value: 'pitch', label: 'Pitch' }, { value: 'filter', label: 'Filter' }]}
          onChange={(sixteenLevels) => update({ sixteenLevels })}
        />
        <p className="muted small">Sixteen Levels plays pad 1’s sound on every pad with a graded velocity, pitch, or filter.</p>
      </Group>
    )
  }
  if (device.kind === 'deck') return <DeckPanel track={track} />
  return null
}

function DeckPanel({ track }: { track: Track }) {
  const assets = useStudio((s) => s.project.assets)
  if (track.device.kind !== 'deck') return null
  const device = track.device
  const set = (params: Record<string, unknown>, label: string) => dispatch({ type: 'deck.set', params: { trackId: track.id, ...params } }, { label, key: `deck-${track.id}-${label}` })
  return (
    <Group title="Deck">
      <select value={device.assetId ?? ''} aria-label="Deck audio" onChange={(event) => set({ assetId: event.target.value }, 'Load deck')}>
        <option value="">Choose audio…</option>
        {Object.values(assets).map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
      </select>
      <div className="insp-row">
        <button type="button" className="chip-btn" onClick={() => void engine.deckPlay(track.id)}>
          <Play size={12} />
          Play
        </button>
        <button type="button" className="chip-btn" onClick={() => engine.deckStop(track.id)}>
          <Square size={12} />
          Stop
        </button>
        <button type="button" className="chip-btn" onClick={() => engine.deckCue(track.id)}>
          Cue
        </button>
      </div>
      <div className="knob-grid">
        {['device.gain', 'device.pitch', 'device.filter'].map((p) => (
          <ParamKnob key={p} track={track} param={p} />
        ))}
      </div>
      <Toggle label="Loop" on={device.loop} onChange={(loop) => set({ loop }, 'Deck loop')} />
      {device.assetId && <SeparateButton assetId={device.assetId} />}
    </Group>
  )
}

function MixerPanel({ track }: { track: Track }) {
  const project = useStudio((s) => s.project)
  const preview = usePreview()
  const ghost = preview?.tracks.find((t) => t.id === track.id)
  const path = studio.traceTrack(project, track.id)
  return (
    <>
      <Group title="Mixer">
        <Slider midi={{ kind: 'param', trackId: track.id, param: 'mixer.volume', label: `${track.name} volume` }} label="Volume" value={track.mixer.volume} min={-60} max={6} step={0.5} ghost={ghost && ghost.mixer.volume !== track.mixer.volume ? ghost.mixer.volume : null} format={db} onChange={(volume) => { dispatch({ type: 'mixer.set', params: { trackId: track.id, volume } }, { label: `${track.name} volume`, key: `vol-${track.id}` }); recordParamMove(track.id, 'mixer.volume', volume) }} />
        <Slider midi={{ kind: 'param', trackId: track.id, param: 'mixer.pan', label: `${track.name} pan` }} label="Pan" value={track.mixer.pan} min={-1} max={1} format={(v) => (Math.abs(v) < 0.01 ? 'Center' : v < 0 ? `L${Math.round(-v * 100)}` : `R${Math.round(v * 100)}`)} onChange={(pan) => { dispatch({ type: 'mixer.set', params: { trackId: track.id, pan } }, { label: `Pan ${track.name}`, key: `pan-${track.id}` }); recordParamMove(track.id, 'mixer.pan', pan) }} />
        {project.returns.map((ret) => {
          const send = track.mixer.sends[ret.id] ?? { level: 0, tap: 'post' as const }
          const g = ghost?.mixer.sends[ret.id]
          return (
            <div key={ret.id} className="send-row">
              <Slider midi={{ kind: 'param', trackId: track.id, param: `send.${ret.id}`, label: `${track.name} ${ret.name} send` }} label={`${ret.name} send`} value={send.level} min={0} max={1} ghost={g && g.level !== send.level ? g.level : null} format={pct} onChange={(level) => { dispatch({ type: 'send.set', params: { trackId: track.id, returnId: ret.id, level } }, { label: `${track.name} send`, key: `send-${track.id}-${ret.id}` }); recordParamMove(track.id, `send.${ret.id}`, level) }} />
              <Seg label={`${ret.name} send tap`} value={send.tap} options={[{ value: 'pre', label: 'Pre-fader' }, { value: 'post', label: 'Post-fader' }]} onChange={(tap) => dispatch({ type: 'send.set', params: { trackId: track.id, returnId: ret.id, tap } }, { label: `${track.name} send ${tap}-fader` })} />
            </div>
          )
        })}
        <div className="insp-row">
          <Toggle label="Mute" tone="alert" on={track.mixer.mute} onChange={(mute) => dispatch({ type: 'mixer.set', params: { trackId: track.id, mute } }, { label: `${mute ? 'Mute' : 'Unmute'} ${track.name}` })} />
          <Toggle label="Solo" tone="mod" on={track.mixer.solo} onChange={(solo) => dispatch({ type: 'mixer.set', params: { trackId: track.id, solo } }, { label: `${solo ? 'Solo' : 'Unsolo'} ${track.name}` })} />
        </div>
      </Group>
      <Group title="Signal path">
        <p className={`path${path.audible ? '' : ' is-silent'}`}>
          {path.path.join(' → ')}
        </p>
        <p className="muted small">{path.reason}</p>
      </Group>
    </>
  )
}

function TrackPanel({ track }: { track: Track }) {
  return (
    <>
      <h2 className="insp-title" style={{ '--track': track.color } as CSSProperties}>
        {track.name}
        <small>{studio.DEVICE_NAMES[track.kind]}</small>
      </h2>
      <DevicePanel track={track} />
      <MixerPanel track={track} />
      <MacroEditor track={track} />
      <Group title="Track">
        <div className="insp-row">
          <input type="color" value={track.color} aria-label="Track color" onChange={(event) => dispatch({ type: 'track.update', params: { trackId: track.id, color: event.target.value } }, { label: 'Track color', key: `color-${track.id}` })} />
          <button type="button" className="chip-btn danger" onClick={() => dispatch({ type: 'track.remove', params: { trackId: track.id } }, { label: `Remove ${track.name}` }) && select({ kind: 'none' })}>
            <Trash2 size={12} />
            Remove track
          </button>
        </div>
        <p className="muted small">Removing a track is undoable with Ctrl+Z.</p>
        <PrintButton onPrint={() => void resample({ kind: 'track', trackId: track.id })} />
      </Group>
    </>
  )
}

function ClipPanel({ clipId }: { clipId: string }) {
  const project = useStudio((s) => s.project)
  const clip = project.clips.find((c) => c.id === clipId)
  if (!clip) return <p className="muted">The selected clip no longer exists.</p>
  const pattern = clip.patternId ? project.patterns[clip.patternId] : undefined
  const track = project.tracks.find((t) => t.id === clip.trackId)
  const links = clip.patternId ? studio.linkCount(project, clip.patternId) : 1
  const set = (params: Record<string, unknown>, label: string) => dispatch({ type: 'clip.set', params: { clipId: clip.id, ...params } }, { label, key: `clip-${clip.id}-${label}` })
  return (
    <>
      <h2 className="insp-title" style={{ '--track': track?.color } as CSSProperties}>
        {pattern?.name ?? (clip.assetId ? project.assets[clip.assetId]?.name : 'Clip')}
        <small>
          Clip on {track?.name} · {Number.isInteger(clip.start) && Number.isInteger(clip.length) ? `bars ${clip.start + 1}–${studio.clipEnd(clip)}` : `bar ${clip.start + 1}, ${clip.length} bars long`}
        </small>
      </h2>
      {pattern && (
        <label className="field">
          <span className="field-label">Pattern name</span>
          <input type="text" defaultValue={pattern.name} key={pattern.id} onKeyDown={(event) => event.stopPropagation()} onBlur={(event) => event.target.value !== pattern.name && dispatch({ type: 'pattern.update', params: { patternId: pattern.id, name: event.target.value } }, { label: 'Rename pattern' })} />
        </label>
      )}
      {pattern && (
        <div className={`link-state${links > 1 ? ' is-linked' : ''}`}>
          <p>{links > 1 ? `Linked: ${links} clips share this pattern. Editing notes changes all ${links}.` : 'Unique: only this clip uses the pattern.'}</p>
          {links > 1 && (
            <button type="button" className="chip-btn" onClick={() => dispatch({ type: 'clip.makeUnique', params: { clipId: clip.id } }, { label: `Make ${pattern.name} unique` })}>
              <Unlink size={12} />
              Make unique
            </button>
          )}
        </div>
      )}
      <Slider label="Start bar" value={clip.start + 1} min={1} max={Math.max(project.length + 1, clip.start + 2)} step={1} format={(v) => `${v}`} onChange={(v) => dispatch({ type: 'clip.move', params: { clipId: clip.id, start: v - 1 } }, { label: 'Move clip', key: `move-${clip.id}` })} />
      <Slider label="Length" value={clip.length} min={0.25} max={Math.max(32, clip.length)} step={0.25} format={(v) => `${v} bar${v === 1 ? '' : 's'}`} onChange={(length) => dispatch({ type: 'clip.resize', params: { clipId: clip.id, length } }, { label: 'Resize clip', key: `size-${clip.id}` })} />
      <Slider label="Gain" value={clip.gain} min={-24} max={12} step={0.5} format={db} onChange={(gain) => set({ gain }, 'Clip gain')} />
      {pattern?.kind === 'notes' && <Slider label="Transpose" value={clip.transpose} min={-24} max={24} step={1} format={(v) => `${v > 0 ? '+' : ''}${v} st`} onChange={(transpose) => set({ transpose }, 'Transpose clip')} />}
      <div className="insp-row">
        <Toggle label="Mute clip" tone="alert" on={clip.mute} onChange={(mute) => set({ mute }, mute ? 'Mute clip' : 'Unmute clip')} />
        <button type="button" className="chip-btn" onClick={splitSelectedClip} title="Split this clip at the playhead (Ctrl+E)">
          Split at playhead
        </button>
        <button type="button" className="chip-btn danger" onClick={() => dispatch({ type: 'clip.delete', params: { clipId: clip.id } }, { label: 'Delete clip' }) && select({ kind: 'none' })}>
          <Trash2 size={12} />
          Delete
        </button>
      </div>
      {clip.assetId && <SeparateButton assetId={clip.assetId} clipId={clip.id} />}
      <p className="muted small">Drag to move, Alt-drag to copy as a linked repeat, drag the right edge to resize. Ctrl+D duplicates.</p>
    </>
  )
}

function StepPanel({ selection }: { selection: Extract<Selection, { kind: 'step' }> }) {
  const project = useStudio((s) => s.project)
  const clip = project.clips.find((c) => c.id === selection.clipId)
  const pattern = clip?.patternId ? project.patterns[clip.patternId] : undefined
  const track = project.tracks.find((t) => t.id === clip?.trackId)
  if (!clip || !pattern || !track) return null
  const index = selection.index
  if (pattern.kind === 'notes') {
    const step = pattern.steps[index]
    if (!step) return null
    const set = (params: Record<string, unknown>, label: string) => dispatch({ type: 'step.set', params: { patternId: pattern.id, index, ...params } }, { label, key: `step-${pattern.id}-${index}-${label}` })
    return (
      <>
        <h2 className="insp-title" style={{ '--track': track.color } as CSSProperties}>
          Step {index + 1}
          <small>
            {pattern.name}
            {studio.linkCount(project, pattern.id) > 1 && ` · linked ×${studio.linkCount(project, pattern.id)}`}
          </small>
        </h2>
        <div className="insp-row">
          <Toggle label={step.on ? 'On' : 'Off'} tone="signal" on={step.on} onChange={(on) => set({ on }, 'Toggle step')} />
          <Toggle label="Accent" tone="mod" on={step.accent} onChange={(accent) => set({ accent }, 'Accent')} />
          <Toggle label="Slide" on={step.slide} onChange={(slide) => set({ slide }, 'Slide')} />
        </div>
        <Slider label="Note" value={step.note} min={12} max={108} step={1} format={studio.noteName} onChange={(note) => set({ note, on: true }, 'Note')} />
        <Slider label="Velocity" value={step.velocity} min={1} max={127} step={1} format={(v) => `${v}`} onChange={(velocity) => set({ velocity }, 'Velocity')} />
        <Slider label="Probability" value={step.probability} min={0} max={100} step={1} format={(v) => `${v}%`} onChange={(probability) => set({ probability }, 'Probability')} />
        <Slider label="Ratchet" value={step.ratchet} min={1} max={4} step={1} format={(v) => `×${v}`} onChange={(ratchet) => set({ ratchet }, 'Ratchet')} />
        <Slider label="Microtiming" value={step.micro} min={-0.5} max={0.5} step={0.01} format={(v) => `${v > 0 ? '+' : ''}${Math.round(v * 100)}% step`} onChange={(micro) => set({ micro }, 'Microtiming')} />
        <Locks locks={step.locks} track={track} onRemove={(param) => set({ locks: { [param]: null } }, 'Remove lock')} />
      </>
    )
  }
  if (pattern.kind === 'drums' && selection.voice) {
    const voice = selection.voice
    const hit = pattern.lanes[voice][index]
    if (!hit) return null
    const set = (params: Record<string, unknown>, label: string) => dispatch({ type: 'drum.step.set', params: { patternId: pattern.id, voice, index, ...params } }, { label, key: `drum-${pattern.id}-${voice}-${index}-${label}` })
    return (
      <>
        <h2 className="insp-title" style={{ '--track': track.color } as CSSProperties}>
          {studio.DRUM_VOICE_LABELS[voice]} step {index + 1}
          <small>{pattern.name}</small>
        </h2>
        <div className="insp-row">
          <Toggle label={hit.on ? 'On' : 'Off'} tone="signal" on={hit.on} onChange={(on) => set({ on }, 'Toggle hit')} />
          <Toggle label="Accent" tone="mod" on={hit.accent} onChange={(accent) => set({ accent }, 'Accent')} />
        </div>
        <Slider label="Velocity" value={hit.velocity} min={1} max={127} step={1} format={(v) => `${v}`} onChange={(velocity) => set({ velocity }, 'Velocity')} />
        <Slider label="Probability" value={hit.probability} min={0} max={100} step={1} format={(v) => `${v}%`} onChange={(probability) => set({ probability }, 'Probability')} />
        <Slider label="Ratchet" value={hit.ratchet} min={1} max={4} step={1} format={(v) => `×${v}`} onChange={(ratchet) => set({ ratchet }, 'Ratchet')} />
        <Slider label="Microtiming" value={hit.micro} min={-0.5} max={0.5} step={0.01} format={(v) => `${v > 0 ? '+' : ''}${Math.round(v * 100)}% step`} onChange={(micro) => set({ micro }, 'Microtiming')} />
        <Locks locks={hit.locks} track={track} onRemove={(param) => set({ locks: { [param]: null } }, 'Remove lock')} />
      </>
    )
  }
  return null
}

function Locks({ locks, track, onRemove }: { locks: Record<string, number>; track: Track; onRemove: (param: string) => void }) {
  const entries = Object.entries(locks)
  return (
    <Group title="Parameter locks">
      {entries.length ? (
        <ul className="lock-list">
          {entries.map(([param, value]) => {
            const spec = studio.findParamSpec(track, param)
            return (
              <li key={param}>
                <span>{spec?.label ?? param}</span>
                <strong>{spec ? studio.formatParam(spec, value) : value}</strong>
                <button type="button" className="icon-btn sm" aria-label={`Remove ${spec?.label ?? param} lock`} onClick={() => onRemove(param)}>
                  <X size={12} />
                </button>
              </li>
            )
          })}
        </ul>
      ) : (
        <p className="muted small">Hold Alt and turn any knob for this track to lock its value to this step.</p>
      )}
      <p className="precedence">
        device → automation → <b>step lock</b>
      </p>
    </Group>
  )
}

function SectionPanel({ sectionId }: { sectionId: string }) {
  const section = useStudio((s) => s.project.sections.find((x) => x.id === sectionId))
  if (!section) return null
  const insert = (at: number, bars: number) => {
    const results = dispatch({ type: 'time.insert', params: { at, bars, name: `New ${bars}` } }, { label: `Insert ${bars} bars at bar ${at + 1}` })
    const created = (results?.[0] as { sectionId: string | null } | undefined)?.sectionId
    if (created) select({ kind: 'section', sectionId: created })
  }
  return (
    <>
      <h2 className="insp-title" style={{ '--track': section.color } as CSSProperties}>
        {section.name}
        <small>
          Section · bars {section.start + 1}–{section.start + section.length}
        </small>
      </h2>
      <label className="field">
        <span className="field-label">Name</span>
        <input type="text" defaultValue={section.name} key={section.id} onKeyDown={(event) => event.stopPropagation()} onBlur={(event) => event.target.value !== section.name && dispatch({ type: 'section.update', params: { sectionId: section.id, name: event.target.value } }, { label: 'Rename section' })} />
      </label>
      <div className="insp-row">
        <input type="color" value={section.color} aria-label="Section color" onChange={(event) => dispatch({ type: 'section.update', params: { sectionId: section.id, color: event.target.value } }, { label: 'Section color', key: `seccolor-${section.id}` })} />
      </div>
      <Group title="Insert time">
        <div className="insp-row">
          <button type="button" className="chip-btn" onClick={() => insert(section.start, 8)}>
            8 bars before
          </button>
          <button type="button" className="chip-btn" onClick={() => insert(section.start + section.length, 8)}>
            8 bars after
          </button>
          <button type="button" className="chip-btn" onClick={() => insert(section.start + section.length, 4)}>
            4 bars after
          </button>
        </div>
        <p className="muted small">Later sections, clips, and automation move right. Clips crossing the insert point split instead of stretching.</p>
      </Group>
      <Group title="Remove">
        <div className="insp-row">
          <button type="button" className="chip-btn danger" onClick={() => dispatch({ type: 'time.delete', params: { at: section.start, bars: section.length } }, { label: `Delete ${section.name} bars` })}>
            Delete these bars
          </button>
          <button type="button" className="chip-btn" onClick={() => dispatch({ type: 'section.remove', params: { sectionId: section.id } }, { label: 'Remove section marker' }) && select({ kind: 'none' })}>
            Remove marker only
          </button>
        </div>
      </Group>
      <button type="button" className="chip-btn" onClick={() => engine.setLoop([section.start, section.start + section.length])}>
        Loop this section
      </button>
    </>
  )
}

function PadPanel({ trackId, pad }: { trackId: string; pad: number }) {
  const track = useStudio((s) => s.project.tracks.find((t) => t.id === trackId))
  if (!track || track.device.kind !== 'sampler') return null
  const state = track.device.pads[pad]
  const set = (params: Record<string, unknown>, label: string) => dispatch({ type: 'pad.set', params: { trackId, pad, ...params } }, { label, key: `pad-${trackId}-${pad}-${label}` })
  return (
    <>
      <h2 className="insp-title" style={{ '--track': track.color } as CSSProperties}>
        Pad {pad + 1}
        <small>{state.assetId ? state.name : 'Empty pad'}</small>
      </h2>
      <div className="knob-grid">
        {['pitch', 'gain', 'attack', 'release', 'filter'].map((field) => (
          <ParamKnob key={field} track={track} param={`pad.${pad}.${field}`} label={field[0].toUpperCase() + field.slice(1)} />
        ))}
      </div>
      <div className="insp-row">
        <Toggle label="Reverse" on={state.reverse} onChange={(reverse) => set({ reverse }, 'Reverse pad')} />
        <Seg label="Mode" value={state.mode} options={[{ value: 'oneShot', label: 'One shot' }, { value: 'loop', label: 'Loop' }]} onChange={(mode) => set({ mode }, 'Pad mode')} />
      </div>
      <Slider label="Choke group" value={state.choke ?? 0} min={0} max={8} step={1} format={(v) => (v ? `Group ${v}` : 'None')} onChange={(choke) => set({ choke }, 'Choke group')} />
      <Slider label="Region start" value={state.start} min={0} max={1} step={0.001} format={pct} onChange={(start) => set({ start: Math.min(start, state.end - 0.001) }, 'Pad start')} />
      <Slider label="Region end" value={state.end} min={0} max={1} step={0.001} format={pct} onChange={(end) => set({ end: Math.max(end, state.start + 0.001) }, 'Pad end')} />
    </>
  )
}

function SlicePanel({ trackId, index }: { trackId: string; index: number | null }) {
  const track = useStudio((s) => s.project.tracks.find((t) => t.id === trackId))
  const asset = useStudio((s) => (track?.device.kind === 'sampler' && track.device.source ? s.project.assets[track.device.source.assetId] : undefined))
  if (!track || track.device.kind !== 'sampler' || !track.device.source) return null
  const source = track.device.source
  if (index === null) {
    return (
      <>
        <h2 className="insp-title" style={{ '--track': track.color } as CSSProperties}>
          {asset?.name ?? 'Sample'}
          <small>Source · the original file is never modified</small>
        </h2>
        <dl className="facts">
          <dt>Length</dt>
          <dd>{asset ? `${asset.duration.toFixed(2)} s` : '—'}</dd>
          <dt>Tempo</dt>
          <dd>{source.bpm ? `${source.bpm} BPM (${Math.round(source.bpmConfidence * 100)}%)` : 'Unknown'}</dd>
          <dt>Slices</dt>
          <dd>
            {source.slices.length} ({source.sliceMode})
          </dd>
          <dt>Origin</dt>
          <dd>{asset?.origin.kind ?? '—'}</dd>
        </dl>
        <SeparateButton assetId={source.assetId} />
        <p className="muted small">Click a slice to audition and inspect it. Double-click the waveform to add a marker; Delete removes the selected marker.</p>
      </>
    )
  }
  const start = source.slices[index]
  const end = source.slices[index + 1] ?? 1
  const pad = track.device.pads.findIndex((p) => p.assetId === source.assetId && Math.abs(p.start - start) < 1e-6)
  const duration = asset?.duration ?? 0
  return (
    <>
      <h2 className="insp-title" style={{ '--track': track.color } as CSSProperties}>
        Slice {index + 1}
        <small>{asset?.name}</small>
      </h2>
      <dl className="facts">
        <dt>Start</dt>
        <dd>{(start * duration * 1000).toFixed(0)} ms</dd>
        <dt>Length</dt>
        <dd>{((end - start) * duration * 1000).toFixed(0)} ms</dd>
        <dt>Pad</dt>
        <dd>{pad >= 0 ? `Pad ${pad + 1}` : 'Not assigned'}</dd>
      </dl>
      {pad >= 0 && (
        <button type="button" className="chip-btn" onClick={() => select({ kind: 'pad', trackId, pad })}>
          Edit pad {pad + 1}
        </button>
      )}
    </>
  )
}

function ReturnPanel({ returnId }: { returnId: string }) {
  const ret = useStudio((s) => s.project.returns.find((r) => r.id === returnId))
  const project = useStudio((s) => s.project)
  if (!ret) return null
  const set = (params: Record<string, unknown>, label: string) => dispatch({ type: 'return.set', params: { returnId, ...params } }, { label, key: `ret-${returnId}-${label}` })
  const trace = studio.traceReturn(project, returnId)
  return (
    <>
      <h2 className="insp-title">
        {ret.name}
        <small>Return bus</small>
      </h2>
      <Slider label="Level" value={ret.level} min={-60} max={6} step={0.5} format={db} onChange={(level) => set({ level }, 'Return level')} />
      {ret.kind === 'delay' ? (
        <>
          <Slider label="Time" value={ret.time} min={0.125} max={2} step={0.125} format={(v) => `${v} beat${v === 1 ? '' : 's'}`} onChange={(time) => set({ time }, 'Delay time')} />
          <Slider label="Feedback" value={ret.feedback} min={0} max={0.95} step={0.01} format={pct} onChange={(feedback) => set({ feedback }, 'Delay feedback')} />
        </>
      ) : (
        <Slider label="Decay" value={ret.decay} min={0.2} max={12} step={0.1} format={(v) => `${v.toFixed(1)} s`} onChange={(decay) => set({ decay }, 'Reverb decay')} />
      )}
      <Slider label="Tone" value={ret.tone} min={0} max={1} format={pct} onChange={(tone) => set({ tone }, 'Return tone')} />
      <Toggle label="Mute return" tone="alert" on={ret.mute} onChange={(mute) => set({ mute }, mute ? 'Mute return' : 'Unmute return')} />
      <PrintButton onPrint={() => void resample({ kind: 'return', returnId: ret.id })} />
      <Group title="Fed by">
        <ul className="feed-list">
          {trace.sources
            .filter((s) => s.level > 0)
            .map((s) => (
              <li key={s.trackId} className={s.suspicious ? 'is-suspicious' : ''}>
                <button type="button" onClick={() => select({ kind: 'track', trackId: s.trackId })}>
                  {s.name}
                </button>
                <span>{s.reason}</span>
              </li>
            ))}
        </ul>
      </Group>
    </>
  )
}

function MasterPanel() {
  const master = useStudio((s) => s.project.master)
  const set = (params: Record<string, unknown>, label: string) => dispatch({ type: 'master.set', params }, { label, key: `master-${label}` })
  return (
    <>
      <h2 className="insp-title">
        Master
        <small>Soften → drive → compressor → volume → ceiling</small>
      </h2>
      <Slider label="Volume" value={master.volume} min={-60} max={6} step={0.5} format={db} onChange={(volume) => set({ volume }, 'Master volume')} />
      <Slider label="Ceiling" value={master.ceiling} min={-6} max={0} step={0.1} format={(v) => `${v.toFixed(1)} dBTP`} onChange={(ceiling) => set({ ceiling }, 'Ceiling')} />
      <Slider label="Compression" value={master.compress} min={0} max={1} format={pct} onChange={(compress) => set({ compress }, 'Compression')} />
      <Slider label="Drive" value={master.drive} min={0} max={1} format={pct} onChange={(drive) => set({ drive }, 'Drive')} />
      <Slider label="Soften" value={master.soften} min={0} max={1} format={pct} onChange={(soften) => set({ soften }, 'Soften')} />
      <Toggle label="FX Safe Bypass" tone="mod" on={master.fxSafeBypass} onChange={(fxSafeBypass) => set({ fxSafeBypass }, 'FX Safe Bypass')} />
    </>
  )
}

function ScenePanel({ sceneId }: { sceneId: string }) {
  const scene = useStudio((s) => s.project.scenes.find((x) => x.id === sceneId))
  if (!scene) return null
  return (
    <>
      <h2 className="insp-title">
        {scene.name}
        <small>Scene · {Object.values(scene.slots).filter(Boolean).length} tracks</small>
      </h2>
      <div className="insp-row">
        <button type="button" className="chip-btn" onClick={() => launchScene(scene.id)}>
          <Play size={12} />
          Launch
        </button>
        <button type="button" className="chip-btn danger" onClick={() => dispatch({ type: 'scene.remove', params: { sceneId } }, { label: 'Remove scene' }) && select({ kind: 'none' })}>
          <Trash2 size={12} />
          Remove
        </button>
      </div>
    </>
  )
}

function LanePanel({ trackId, param }: { trackId: string; param: string }) {
  const track = useStudio((s) => s.project.tracks.find((t) => t.id === trackId))
  const lane = useStudio((s) => s.project.automation.find((l) => l.trackId === trackId && l.param === param))
  if (!track) return null
  const spec = studio.findParamSpec(track, param)
  return (
    <>
      <h2 className="insp-title" style={{ '--track': track.color } as CSSProperties}>
        {spec?.label ?? param}
        <small>Automation on {track.name}</small>
      </h2>
      <dl className="facts">
        <dt>Points</dt>
        <dd>{lane?.points.length ?? 0}</dd>
        <dt>Base value</dt>
        <dd>{spec ? studio.formatParam(spec, studio.getParam(track, param) ?? spec.default) : '—'}</dd>
      </dl>
      <button type="button" className="chip-btn danger" onClick={() => dispatch({ type: 'automation.clear', params: { trackId, param } }, { label: 'Clear automation' })}>
        Clear automation
      </button>
      <p className="muted small">Clearing reveals the device value immediately. Arm record and turn a macro while playing to write automation.</p>
    </>
  )
}

function AudioDevicePanel() {
  const audio = useStudio((s) => s.prefs.audio)
  const projectRate = useStudio((s) => s.project.sampleRate)
  const set = (patch: Partial<typeof audio>) => setPrefs({ audio: { ...audio, ...patch } })
  return (
    <Group title="Audio device">
      <span className="field-label">Sample rate</span>
      <Seg
        label="Sample rate"
        value={audio.sampleRate === null ? 'project' : String(audio.sampleRate)}
        options={[{ value: 'project', label: `Project (${projectRate / 1000} kHz)` }, { value: '44100', label: '44.1 kHz' }, { value: '48000', label: '48 kHz' }]}
        onChange={(v) => set({ sampleRate: v === 'project' ? null : Number(v) })}
      />
      <span className="field-label">Latency</span>
      <Seg
        label="Latency"
        value={audio.latency}
        options={[{ value: 'interactive', label: 'Low' }, { value: 'balanced', label: 'Medium' }, { value: 'playback', label: 'Safe' }]}
        onChange={(latency) => set({ latency })}
      />
      <p className="muted small">Higher latency uses a larger buffer, which avoids crackles on busy projects. The device restarts when you change either setting{engine.latency ? `; output latency is now ${Math.round(engine.latency * 1000)} ms` : ''}.</p>
    </Group>
  )
}

function ProjectPanel() {
  const project = useStudio((s) => s.project)
  const density = useStudio((s) => s.prefs.density)
  const contrast = useStudio((s) => s.prefs.contrast)
  return (
    <>
      <h2 className="insp-title">
        {project.name}
        <small>Project · nothing selected</small>
      </h2>
      <label className="field">
        <span className="field-label">Name</span>
        <input type="text" defaultValue={project.name} key={project.id} onKeyDown={(event) => event.stopPropagation()} onBlur={(event) => event.target.value !== project.name && dispatch({ type: 'project.update', params: { name: event.target.value } }, { label: 'Rename project' })} />
      </label>
      <dl className="facts">
        <dt>Tempo</dt>
        <dd>{project.tempo} BPM</dd>
        <dt>Swing</dt>
        <dd>{pct(project.swing)}</dd>
        <dt>Length</dt>
        <dd>{project.length} bars</dd>
        <dt>Tracks</dt>
        <dd>{project.tracks.length}</dd>
        <dt>Revision</dt>
        <dd>{project.revision}</dd>
      </dl>
      <AudioDevicePanel />
      <Group title="Sections">
        <ul className="sec-list">
          {project.sections.map((s) => (
            <li key={s.id}>
              <button type="button" onClick={() => select({ kind: 'section', sectionId: s.id })} style={{ '--track': s.color } as CSSProperties}>
                <i />
                {s.name}
                <span>
                  {s.start + 1}–{s.start + s.length}
                </span>
              </button>
            </li>
          ))}
        </ul>
        <button type="button" className="chip-btn" onClick={() => dispatch({ type: 'section.add', params: { start: project.length, length: 8, name: 'New section' } }, { label: 'Add section' })}>
          Add section at the end
        </button>
      </Group>
      <Group title="Display">
        <Seg label="Density" value={density} options={[{ value: 'compact', label: 'Compact' }, { value: 'normal', label: 'Normal' }, { value: 'large', label: 'Large' }]} onChange={(d) => setPrefs({ density: d })} />
        <Seg label="Contrast" value={contrast} options={[{ value: 'normal', label: 'Standard' }, { value: 'high', label: 'High contrast' }]} onChange={(c) => setPrefs({ contrast: c })} />
      </Group>
    </>
  )
}

function Proposals() {
  const proposals = useStudio((s) => s.proposals)
  const preview = useStudio((s) => s.previewProposal)
  useStudio((s) => s.proposalPicks)
  const pending = proposals.filter((p) => p.status === 'pending')
  if (!pending.length) return null
  return (
    <>
      {pending.map((proposal) => {
        const picked = proposal.changes.filter((c) => isPicked(proposal.id, c.id)).length
        const previewing = preview === proposal.id
        return (
          <section key={proposal.id} className="proposal" aria-label="Agent proposal">
            <header>
              <Sparkles size={14} />
              <strong>{proposal.source === 'mcp' ? 'External agent' : 'Agent'} proposal</strong>
              <span className="pending-tag">Pending</span>
            </header>
            {proposal.request && <p className="proposal-request">“{proposal.request}”</p>}
            <p className="proposal-intent">{proposal.intent}</p>
            {proposal.evidence.length > 0 && (
              <ul className="evidence">
                {proposal.evidence.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            )}
            <ul className="changes">
              {proposal.changes.map((change) => {
                const on = isPicked(proposal.id, change.id)
                return (
                  <li key={change.id} className={on ? 'is-on' : ''}>
                    <label>
                      <input type="checkbox" checked={on} onChange={() => togglePick(proposal.id, change.id)} />
                      <span className="change-body">
                        <strong>{change.summary}</strong>
                        <span className="change-evidence">{change.detail}</span>
                      </span>
                    </label>
                  </li>
                )
              })}
            </ul>
            <div className="proposal-actions">
              <button type="button" className={`chip-btn${previewing ? ' is-on' : ''}`} aria-pressed={previewing} onClick={() => setState({ previewProposal: previewing ? null : proposal.id })}>
                {previewing ? <Eye size={12} /> : <EyeOff size={12} />}
                Preview
              </button>
              <button type="button" className="chip-btn primary" disabled={!picked} onClick={() => applyProposal(proposal.id)}>
                <Check size={12} />
                {picked === proposal.changes.length ? 'Apply all' : `Apply ${picked} selected`}
              </button>
              <button type="button" className="chip-btn" onClick={() => rejectProposal(proposal.id)}>
                <X size={12} />
                Reject
              </button>
            </div>
            {proposal.revision !== getState().project.revision && <p className="muted small">The project changed since this was proposed; changes apply to the current version.</p>}
          </section>
        )
      })}
    </>
  )
}

function History() {
  const past = useStudio((s) => s.past)
  const entries = past.slice(-8).reverse()
  if (!entries.length) return null
  return (
    <Group title="History">
      <ol className="history">
        {entries.map((entry, i) => (
          <li key={`${entry.at}-${i}`} className={entry.origin}>
            <span className="origin">{entry.origin === 'agent' ? 'Agent' : entry.origin === 'script' ? 'Script' : 'You'}</span>
            {entry.label}
          </li>
        ))}
      </ol>
    </Group>
  )
}

export function Inspector({ overlay, onClose }: { overlay: boolean; onClose: () => void }) {
  const selection = useStudio((s) => s.selection)
  const track = useStudio((s) => (selection.kind === 'track' ? s.project.tracks.find((t) => t.id === selection.trackId) : undefined))
  let body: ReactNode
  if (selection.kind === 'track') body = track ? <TrackPanel track={track} /> : null
  else if (selection.kind === 'clip') body = <ClipPanel clipId={selection.clipId} />
  else if (selection.kind === 'step') body = <StepPanel selection={selection} />
  else if (selection.kind === 'section') body = <SectionPanel sectionId={selection.sectionId} />
  else if (selection.kind === 'scene') body = <ScenePanel sceneId={selection.sceneId} />
  else if (selection.kind === 'slice') body = <SlicePanel trackId={selection.trackId} index={selection.index} />
  else if (selection.kind === 'pad') body = <PadPanel trackId={selection.trackId} pad={selection.pad} />
  else if (selection.kind === 'return') body = <ReturnPanel returnId={selection.returnId} />
  else if (selection.kind === 'master') body = <MasterPanel />
  else if (selection.kind === 'lane') body = <LanePanel trackId={selection.trackId} param={selection.param} />
  else body = <ProjectPanel />
  return (
    <aside className={`inspector${overlay ? ' is-overlay' : ''}`} aria-label="Inspector" data-region="inspector" tabIndex={-1}>
      <div className="panel-head">
        <span className="panel-title">Inspector</span>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close inspector" title="Close inspector">
          <PanelRight size={16} />
        </button>
      </div>
      <div className="insp-scroll">
        <Proposals />
        {body}
        <History />
      </div>
    </aside>
  )
}

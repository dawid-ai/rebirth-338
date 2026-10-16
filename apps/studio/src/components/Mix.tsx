import { type CSSProperties, useEffect, useState } from 'react'
import { studio } from '@reborn/studio-core'
import { engine } from '../audio/host'
import { usePreview } from '../state/proposals'
import { dispatch, select, useStudio } from '../state/store'
import { Knob, Toggle } from './Controls'

type Track = studio.Track
type ReturnBus = studio.ReturnBus

const dbFormat = (db: number) => (db <= -60 ? '−∞' : `${db > 0 ? '+' : ''}${db.toFixed(1)}`)

function useLevel(source: () => number): number {
  const [level, setLevel] = useState(0)
  const playing = useStudio((s) => s.transport.playing)
  useEffect(() => {
    if (!playing) {
      setLevel(0)
      return
    }
    let frame = 0
    const loop = () => {
      setLevel(Math.round(source() * 40) / 40)
      frame = requestAnimationFrame(loop)
    }
    frame = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(frame)
  }, [playing, source])
  return level
}

function StripMeter({ trackId }: { trackId: string | null }) {
  const level = useLevel(trackId ? () => engine.trackLevel(trackId) : () => engine.outputLevel())
  return (
    <span className="strip-meter" aria-hidden="true">
      <i style={{ transform: `scaleY(${level})` }} />
      <i style={{ transform: `scaleY(${Math.max(0, level - 0.03)})` }} />
    </span>
  )
}

function Fader({ label, value, ghost, onChange }: { label: string; value: number; ghost?: number; onChange: (db: number) => void }) {
  return (
    <div className="fader">
      <input type="range" className="vfader" min={-60} max={6} step={0.5} value={value} aria-label={`${label} volume`} aria-valuetext={`${dbFormat(value)} dB`} onChange={(event) => onChange(Number(event.target.value))} onKeyDown={(event) => event.stopPropagation()} onDoubleClick={() => onChange(0)} />
      <output>
        {dbFormat(value)}
        {ghost !== undefined && Math.abs(ghost - value) > 0.01 && <em className="ghost-value">→ {dbFormat(ghost)}</em>}
      </output>
    </div>
  )
}

function SendKnob({ track, ret, ghost }: { track: Track; ret: ReturnBus; ghost?: Track }) {
  const send = track.mixer.sends[ret.id] ?? { level: 0, tap: 'post' as const }
  const next = ghost?.mixer.sends[ret.id]
  const changed = next && (Math.abs(next.level - send.level) > 1e-4 || next.tap !== send.tap)
  return (
    <div className={`send${changed ? ' is-pending' : ''}`}>
      <Knob
        size="sm"
        label={ret.kind === 'delay' ? 'Delay' : 'Plate'}
        value={send.level}
        defaultValue={0}
        ghost={next && Math.abs(next.level - send.level) > 1e-4 ? next.level : null}
        onChange={(level) => dispatch({ type: 'send.set', params: { trackId: track.id, returnId: ret.id, level } }, { label: `${track.name} ${ret.name} send`, key: `send-${track.id}-${ret.id}` })}
      />
      <button
        type="button"
        className={`tap tap-${send.tap}`}
        onClick={() => dispatch({ type: 'send.set', params: { trackId: track.id, returnId: ret.id, tap: send.tap === 'pre' ? 'post' : 'pre' } }, { label: `${track.name} send ${send.tap === 'pre' ? 'post' : 'pre'}-fader` })}
        title={send.tap === 'pre' ? 'Pre-fader: ignores this track’s fader and mute.' : 'Post-fader: follows this track’s fader and mute.'}
        aria-label={`${ret.name} send tap: ${send.tap}-fader`}
      >
        {send.tap}
        {next && next.tap !== send.tap && <em className="ghost-value">→{next.tap}</em>}
      </button>
    </div>
  )
}

export function Mix() {
  const project = useStudio((s) => s.project)
  const selection = useStudio((s) => s.selection)
  const trace = useStudio((s) => s.selection.kind === 'return' ? s.selection.returnId : null)
  const preview = usePreview()
  const suspicious = new Set<string>()
  for (const ret of project.returns) for (const src of studio.traceReturn(project, ret.id).sources) if (src.suspicious) suspicious.add(src.trackId)
  const groups = project.tracks.filter((t) => t.kind === 'group')

  return (
    <div className="mix">
      <div className="mix-head">
        <span className="muted">Sends feed returns; returns feed master. Pre-fader sends ignore mute. Select any strip to see its full signal path.</span>
        <Toggle label="FX Safe Bypass" tone="mod" on={project.master.fxSafeBypass} onChange={(on) => dispatch({ type: 'master.set', params: { fxSafeBypass: on } }, { label: on ? 'Bypass returns' : 'Restore returns' })} title="Silence every return without changing any send" />
      </div>
      <div className="strips">
        {project.tracks.map((track) => {
          const ghost = preview?.tracks.find((t) => t.id === track.id)
          const selected = (selection.kind === 'track' && selection.trackId === track.id) || (selection.kind === 'clip' && project.clips.find((c) => c.id === selection.clipId)?.trackId === track.id)
          const pending = ghost && JSON.stringify(ghost.mixer) !== JSON.stringify(track.mixer)
          return (
            <div
              key={track.id}
              className={`strip${track.kind === 'group' ? ' group' : ''}${selected ? ' is-selected' : ''}${suspicious.has(track.id) && trace ? ' is-traced' : ''}${pending ? ' is-pending' : ''}${studio.isTrackAudible(project, track) ? '' : ' is-silent'}`}
              style={{ '--track': track.color } as CSSProperties}
              onClick={() => select({ kind: 'track', trackId: track.id })}
            >
              <div className="strip-name" title={track.name}>
                <i />
                <strong>{track.name}</strong>
              </div>
              <div className="strip-sends" onClick={(event) => event.stopPropagation()}>
                {project.returns.map((ret) => (
                  <SendKnob key={ret.id} track={track} ret={ret} ghost={ghost} />
                ))}
              </div>
              <div onClick={(event) => event.stopPropagation()}>
                <Knob
                  size="sm"
                  label="Pan"
                  value={(track.mixer.pan + 1) / 2}
                  format={(v) => (Math.abs(v - 0.5) < 0.01 ? 'C' : v < 0.5 ? `L${Math.round((0.5 - v) * 200)}` : `R${Math.round((v - 0.5) * 200)}`)}
                  onChange={(v) => dispatch({ type: 'mixer.set', params: { trackId: track.id, pan: Math.round((v * 2 - 1) * 100) / 100 } }, { label: `Pan ${track.name}`, key: `pan-${track.id}` })}
                />
              </div>
              <div className="strip-fader" onClick={(event) => event.stopPropagation()}>
                <StripMeter trackId={track.id} />
                <Fader label={track.name} value={track.mixer.volume} ghost={ghost?.mixer.volume} onChange={(volume) => dispatch({ type: 'mixer.set', params: { trackId: track.id, volume } }, { label: `${track.name} volume`, key: `vol-${track.id}` })} />
              </div>
              <div className="strip-ms" onClick={(event) => event.stopPropagation()}>
                <button type="button" className={`ms mute${track.mixer.mute ? ' is-on' : ''}`} aria-pressed={track.mixer.mute} aria-label={`Mute ${track.name}`} onClick={() => dispatch({ type: 'mixer.set', params: { trackId: track.id, mute: !track.mixer.mute } }, { label: `${track.mixer.mute ? 'Unmute' : 'Mute'} ${track.name}` })}>
                  M
                </button>
                <button type="button" className={`ms solo${track.mixer.solo ? ' is-on' : ''}`} aria-pressed={track.mixer.solo} aria-label={`Solo ${track.name}`} onClick={() => dispatch({ type: 'mixer.set', params: { trackId: track.id, solo: !track.mixer.solo } }, { label: `${track.mixer.solo ? 'Unsolo' : 'Solo'} ${track.name}` })}>
                  S
                </button>
              </div>
              <select
                className="strip-out"
                value={track.mixer.output}
                aria-label={`${track.name} output`}
                onClick={(event) => event.stopPropagation()}
                onChange={(event) => dispatch({ type: 'mixer.set', params: { trackId: track.id, output: event.target.value } }, { label: `Route ${track.name}` })}
              >
                <option value="master">Master</option>
                {groups
                  .filter((g) => g.id !== track.id)
                  .map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
              </select>
            </div>
          )
        })}

        <div className="strip-divider" aria-hidden="true">
          <span>Returns</span>
        </div>

        {project.returns.map((ret) => {
          const ghost = preview?.returns.find((r) => r.id === ret.id)
          return (
            <div key={ret.id} className={`strip return${selection.kind === 'return' && selection.returnId === ret.id ? ' is-selected' : ''}${ghost && JSON.stringify(ghost) !== JSON.stringify(ret) ? ' is-pending' : ''}`} onClick={() => select({ kind: 'return', returnId: ret.id })}>
              <div className="strip-name" title={ret.name}>
                <i />
                <strong>{ret.name}</strong>
              </div>
              <div className="strip-sends" onClick={(event) => event.stopPropagation()}>
                {ret.kind === 'delay' ? (
                  <Knob size="sm" label="Feedback" value={ret.feedback / 0.95} ghost={ghost?.kind === 'delay' && ghost.feedback !== ret.feedback ? ghost.feedback / 0.95 : null} format={(v) => `${Math.round(v * 95)}%`} onChange={(v) => dispatch({ type: 'return.set', params: { returnId: ret.id, feedback: Math.round(v * 95) / 100 } }, { label: 'Delay feedback', key: `ret-fb-${ret.id}` })} />
                ) : (
                  <Knob size="sm" label="Decay" value={ret.decay / 8} format={(v) => `${(v * 8).toFixed(1)}s`} onChange={(v) => dispatch({ type: 'return.set', params: { returnId: ret.id, decay: Math.max(0.2, Math.round(v * 80) / 10) } }, { label: 'Reverb decay', key: `ret-dec-${ret.id}` })} />
                )}
                <Knob size="sm" label="Tone" value={ret.tone} onChange={(tone) => dispatch({ type: 'return.set', params: { returnId: ret.id, tone } }, { label: `${ret.name} tone`, key: `ret-tone-${ret.id}` })} />
              </div>
              <div className="return-stat">
                <small>{ret.kind === 'delay' ? 'Time' : 'Decay'}</small>
                <strong>{ret.kind === 'delay' ? `${ret.time} beat${ret.time === 1 ? '' : 's'}` : `${ret.decay.toFixed(1)} s`}</strong>
              </div>
              <div className="strip-fader" onClick={(event) => event.stopPropagation()}>
                <Fader label={ret.name} value={ret.level} ghost={ghost?.level} onChange={(level) => dispatch({ type: 'return.set', params: { returnId: ret.id, level } }, { label: `${ret.name} level`, key: `ret-lvl-${ret.id}` })} />
              </div>
              <div className="strip-ms" onClick={(event) => event.stopPropagation()}>
                <button type="button" className={`ms mute${ret.mute ? ' is-on' : ''}`} aria-pressed={ret.mute} aria-label={`Mute ${ret.name}`} onClick={() => dispatch({ type: 'return.set', params: { returnId: ret.id, mute: !ret.mute } }, { label: `${ret.mute ? 'Unmute' : 'Mute'} ${ret.name}` })}>
                  M
                </button>
              </div>
            </div>
          )
        })}

        <div className={`strip master${selection.kind === 'master' ? ' is-selected' : ''}`} onClick={() => select({ kind: 'master' })}>
          <div className="strip-name">
            <i />
            <strong>Master</strong>
          </div>
          <div className="strip-sends" onClick={(event) => event.stopPropagation()}>
            <Knob size="sm" label="Comp" value={project.master.compress} onChange={(compress) => dispatch({ type: 'master.set', params: { compress } }, { label: 'Master compression', key: 'm-comp' })} />
            <Knob size="sm" label="Soften" value={project.master.soften} onChange={(soften) => dispatch({ type: 'master.set', params: { soften } }, { label: 'Master soften', key: 'm-soft' })} />
          </div>
          <div className="return-stat">
            <small>Ceiling</small>
            <strong>{project.master.ceiling.toFixed(1)} dBTP</strong>
          </div>
          <div className="strip-fader" onClick={(event) => event.stopPropagation()}>
            <StripMeter trackId={null} />
            <Fader label="Master" value={project.master.volume} onChange={(volume) => dispatch({ type: 'master.set', params: { volume } }, { label: 'Master volume', key: 'm-vol' })} />
          </div>
        </div>
      </div>
    </div>
  )
}

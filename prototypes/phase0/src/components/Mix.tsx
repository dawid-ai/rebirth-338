import { Route, TriangleAlert } from 'lucide-react'
import type { CSSProperties } from 'react'
import { useClock } from '../clock'
import {
  BANDS,
  BAND_LABELS,
  type BusId,
  type Project,
  type Track,
  analyzeSections,
  clipEnd,
  delayTailSeconds,
  isAudible,
  traceBus,
  updateDelay,
  updateReverb,
  updateSend,
  updateTrack,
} from '../model'
import { useStudio } from '../studio'
import { Knob, Toggle } from './Controls'

const dbFormat = (db: number) => (db <= -60 ? '−∞' : `${db > 0 ? '+' : ''}${db.toFixed(1)}`)

function StripMeter({ project, track }: { project: Project; track: Track }) {
  const level = useClock((position, playing) => {
    if (!playing || !isAudible(project, track)) return 0
    const active = project.clips.some((c) => c.trackId === track.id && c.start <= position && clipEnd(c) > position)
    if (!active) return 0
    const beat = (position * 4) % 1
    return Math.round(Math.max(0, (0.6 + track.volume / 30) * (1 - beat * 0.55)) * 40) / 40
  })
  return (
    <span className="strip-meter" aria-hidden="true">
      <i style={{ transform: `scaleY(${level})` }} />
      <i style={{ transform: `scaleY(${Math.max(0, level - 0.04)})` }} />
    </span>
  )
}

function Fader({ label, value, ghost, onChange }: { label: string; value: number; ghost?: number; onChange: (db: number) => void }) {
  return (
    <div className="fader">
      <input
        type="range"
        className="vfader"
        min={-60}
        max={6}
        step={0.5}
        value={value}
        aria-label={`${label} volume`}
        aria-valuetext={`${dbFormat(value)} dB`}
        onChange={(event) => onChange(Number(event.target.value))}
        onKeyDown={(event) => event.stopPropagation()}
        onDoubleClick={() => onChange(0)}
      />
      <output>
        {dbFormat(value)}
        {ghost !== undefined && ghost !== value && <em className="ghost-value">→ {dbFormat(ghost)}</em>}
      </output>
    </div>
  )
}

function SendControl({ track, bus, ghost }: { track: Track; bus: BusId; ghost?: Track }) {
  const studio = useStudio()
  const send = track.sends[bus]
  const next = ghost?.sends[bus]
  const name = bus === 'delay' ? 'Delay' : 'Plate'
  return (
    <div className={`send${next && (next.level !== send.level || next.tap !== send.tap) ? ' is-pending' : ''}`}>
      <Knob
        size="sm"
        label={name}
        value={send.level}
        defaultValue={0}
        ghost={next && next.level !== send.level ? next.level : null}
        onChange={(level) => studio.commit(`Set ${track.name} ${name.toLowerCase()} send`, (p) => updateSend(p, track.id, bus, { level }), { key: `send-${track.id}-${bus}` })}
      />
      <button
        type="button"
        className={`tap tap-${send.tap}`}
        onClick={() => studio.commit(`${track.name} ${name.toLowerCase()} send ${send.tap === 'pre' ? 'post' : 'pre'}-fader`, (p) => updateSend(p, track.id, bus, { tap: send.tap === 'pre' ? 'post' : 'pre' }))}
        title={send.tap === 'pre' ? 'Pre-fader: the send ignores this track’s fader and mute.' : 'Post-fader: the send follows this track’s fader and mute.'}
        aria-label={`${name} send tap: ${send.tap}-fader`}
      >
        {send.tap}
        {next && next.tap !== send.tap && <em className="ghost-value">→{next.tap}</em>}
      </button>
    </div>
  )
}

export function Mix() {
  const studio = useStudio()
  const { project, preview, selection, proposal } = studio
  const traced = new Set<string>()
  if (studio.trace) for (const bus of studio.trace) for (const row of traceBus(project, bus).rows) if (row.suspicious) traced.add(row.trackId)
  const pendingTracks = new Set(proposal?.changes.filter((c) => studio.picks.has(c.id)).map((c) => c.focus.trackId ?? '') ?? [])
  const pendingBuses = new Set(proposal?.changes.filter((c) => studio.picks.has(c.id)).map((c) => c.focus.bus ?? '') ?? [])
  const { delay, reverb } = project.returns
  const ghostDelay = preview?.returns.delay

  return (
    <div className="mix">
      <div className="mix-head">
        <span className="muted">Sends feed returns. Returns feed Master. Pre-fader sends ignore mute.</span>
        <Toggle
          label="FX Safe Bypass"
          tone="mod"
          on={project.fxSafeBypass}
          onChange={(on) => studio.commit(on ? 'Bypass returns' : 'Restore returns', (p) => ({ ...p, fxSafeBypass: on }))}
          title="Silence both returns without changing any send values"
        />
      </div>
      <div className="strips">
        {project.tracks.map((track) => {
          const ghost = preview?.tracks.find((t) => t.id === track.id)
          const selected = selection.kind === 'track' && selection.trackId === track.id
          return (
            <div
              key={track.id}
              className={`strip${selected ? ' is-selected' : ''}${traced.has(track.id) ? ' is-traced' : ''}${pendingTracks.has(track.id) ? ' is-pending' : ''}${isAudible(project, track) ? '' : ' is-silent'}`}
              style={{ '--track': track.color } as CSSProperties}
              onClick={() => studio.select({ kind: 'track', trackId: track.id })}
            >
              <div className="strip-name">
                <i />
                <strong>{track.name}</strong>
              </div>
              <div className="strip-sends" onClick={(event) => event.stopPropagation()}>
                <SendControl track={track} bus="delay" ghost={ghost} />
                <SendControl track={track} bus="reverb" ghost={ghost} />
              </div>
              <div onClick={(event) => event.stopPropagation()}>
                <Knob
                  size="sm"
                  label="Pan"
                  value={(track.pan + 1) / 2}
                  format={(v) => (Math.abs(v - 0.5) < 0.01 ? 'C' : v < 0.5 ? `L${Math.round((0.5 - v) * 200)}` : `R${Math.round((v - 0.5) * 200)}`)}
                  onChange={(v) => studio.commit(`Pan ${track.name}`, (p) => updateTrack(p, track.id, { pan: v * 2 - 1 }), { key: `pan-${track.id}` })}
                />
              </div>
              <div className="strip-fader" onClick={(event) => event.stopPropagation()}>
                <StripMeter project={project} track={track} />
                <Fader label={track.name} value={track.volume} ghost={ghost?.volume} onChange={(volume) => studio.commit(`Set ${track.name} volume`, (p) => updateTrack(p, track.id, { volume }), { key: `vol-${track.id}` })} />
              </div>
              <div className="strip-ms" onClick={(event) => event.stopPropagation()}>
                <button type="button" className={`ms mute${track.mute ? ' is-on' : ''}`} aria-pressed={track.mute} aria-label={`Mute ${track.name}`} onClick={() => studio.commit(`${track.mute ? 'Unmute' : 'Mute'} ${track.name}`, (p) => updateTrack(p, track.id, { mute: !track.mute }))}>
                  M
                </button>
                <button type="button" className={`ms solo${track.solo ? ' is-on' : ''}`} aria-pressed={track.solo} aria-label={`Solo ${track.name}`} onClick={() => studio.commit(`${track.solo ? 'Unsolo' : 'Solo'} ${track.name}`, (p) => updateTrack(p, track.id, { solo: !track.solo }))}>
                  S
                </button>
              </div>
            </div>
          )
        })}

        <div className="strip-divider" aria-hidden="true">
          <span>Returns</span>
        </div>

        <div
          className={`strip return${selection.kind === 'return' && selection.bus === 'delay' ? ' is-selected' : ''}${pendingBuses.has('delay') ? ' is-pending' : ''}${studio.trace?.includes('delay') ? ' is-traced-bus' : ''}`}
          onClick={() => studio.select({ kind: 'return', bus: 'delay' })}
        >
          <div className="strip-name">
            <i />
            <strong>{delay.name}</strong>
          </div>
          <div className="strip-sends" onClick={(event) => event.stopPropagation()}>
            <Knob
              size="sm"
              label="Feedback"
              value={delay.feedback}
              ghost={ghostDelay && ghostDelay.feedback !== delay.feedback ? ghostDelay.feedback : null}
              onChange={(feedback) => studio.commit('Set delay feedback', (p) => updateDelay(p, { feedback: Math.min(0.95, feedback) }), { key: 'delay-fb' })}
            />
            <div className="return-stat">
              <small>Time</small>
              <strong>{delay.beats === 0.75 ? '3/16' : `${delay.beats} beat`}</strong>
            </div>
          </div>
          <div className="return-stat tail">
            <small>Tail</small>
            <strong>
              {delayTailSeconds(project).toFixed(1)} s{preview && <em className="ghost-value"> → {delayTailSeconds(preview).toFixed(1)} s</em>}
            </strong>
          </div>
          <div className="strip-fader" onClick={(event) => event.stopPropagation()}>
            <Fader label={delay.name} value={delay.level} onChange={(level) => studio.commit('Set delay return level', (p) => updateDelay(p, { level }), { key: 'delay-level' })} />
          </div>
          <div className="strip-ms" onClick={(event) => event.stopPropagation()}>
            <button type="button" className={`ms mute${delay.mute ? ' is-on' : ''}`} aria-pressed={delay.mute} aria-label={`Mute ${delay.name}`} onClick={() => studio.commit(`${delay.mute ? 'Unmute' : 'Mute'} ${delay.name}`, (p) => updateDelay(p, { mute: !delay.mute }))}>
              M
            </button>
          </div>
        </div>

        <div
          className={`strip return${selection.kind === 'return' && selection.bus === 'reverb' ? ' is-selected' : ''}${pendingBuses.has('reverb') ? ' is-pending' : ''}${studio.trace?.includes('reverb') ? ' is-traced-bus' : ''}`}
          onClick={() => studio.select({ kind: 'return', bus: 'reverb' })}
        >
          <div className="strip-name">
            <i />
            <strong>{reverb.name}</strong>
          </div>
          <div className="strip-sends" onClick={(event) => event.stopPropagation()}>
            <Knob
              size="sm"
              label="Decay"
              value={reverb.decay / 8}
              format={(v) => `${(v * 8).toFixed(1)}s`}
              onChange={(v) => studio.commit('Set plate decay', (p) => updateReverb(p, { decay: Math.max(0.2, v * 8) }), { key: 'rev-decay' })}
            />
          </div>
          <div className="return-stat tail" />
          <div className="strip-fader" onClick={(event) => event.stopPropagation()}>
            <Fader label={reverb.name} value={reverb.level} onChange={(level) => studio.commit('Set plate return level', (p) => updateReverb(p, { level }), { key: 'rev-level' })} />
          </div>
          <div className="strip-ms" onClick={(event) => event.stopPropagation()}>
            <button type="button" className={`ms mute${reverb.mute ? ' is-on' : ''}`} aria-pressed={reverb.mute} aria-label={`Mute ${reverb.name}`} onClick={() => studio.commit(`${reverb.mute ? 'Unmute' : 'Mute'} ${reverb.name}`, (p) => updateReverb(p, { mute: !reverb.mute }))}>
              M
            </button>
          </div>
        </div>

        <div className="strip master">
          <div className="strip-name">
            <i />
            <strong>Master</strong>
          </div>
          <div className="return-stat">
            <small>Ceiling</small>
            <strong>−0.3 dBTP</strong>
          </div>
          <div className="strip-fader">
            <Fader label="Master" value={0} onChange={() => undefined} />
          </div>
        </div>
      </div>
    </div>
  )
}

function heat(value: number) {
  return `color-mix(in oklab, var(--field-3) ${Math.round((1 - value) * 100)}%, var(--heat) ${Math.round(value * 100)}%)`
}

export function MixDock() {
  const studio = useStudio()
  const { project, preview } = studio
  const reports = analyzeSections(project)
  const after = preview ? analyzeSections(preview) : null
  const traces = (studio.trace ?? []).map((bus) => traceBus(project, bus))

  return (
    <div className="mix-dock">
      <div className="analyzer">
        <div className="editor-bar">
          <strong className="panel-title">Analyzer by section</strong>
          <span className="muted">{preview ? 'Showing current → previewed proposal' : 'Simulated readback; Phase 4 measures rendered audio'}</span>
        </div>
        <table className="an-table">
          <thead>
            <tr>
              <th scope="col">Section</th>
              {BANDS.map((band) => (
                <th key={band} scope="col">
                  {BAND_LABELS[band]}
                </th>
              ))}
              <th scope="col">Peak</th>
              <th scope="col">Crest</th>
              <th scope="col">Flags</th>
            </tr>
          </thead>
          <tbody>
            {reports.map((report, i) => {
              const next = after?.[i]
              return (
                <tr key={report.sectionId}>
                  <th scope="row">{report.name}</th>
                  {BANDS.map((band) => {
                    const value = report.bands[band]
                    const changed = next && Math.abs(next.bands[band] - value) > 0.005
                    return (
                      <td key={band} className="heat" style={{ background: heat(changed ? next.bands[band] : value) }} title={`${BAND_LABELS[band]}: ${value.toFixed(2)}${changed ? ` → ${next.bands[band].toFixed(2)}` : ''}`}>
                        {changed ? <em className="ghost-value">{next.bands[band].toFixed(2)}</em> : value.toFixed(2)}
                      </td>
                    )
                  })}
                  <td className="num">{Number.isFinite(report.peak) ? `${report.peak.toFixed(1)}` : '—'}</td>
                  <td className="num">{Number.isFinite(report.peak) ? `${(report.peak - report.rms).toFixed(1)}` : '—'}</td>
                  <td className="flags">
                    {(next ?? report).warnings.map((w) => (
                      <span key={w} className={`flag${report.warnings.includes(w) ? '' : ' new'}`}>
                        <TriangleAlert size={10} />
                        {w}
                      </span>
                    ))}
                    {next && report.warnings.filter((w) => !next.warnings.includes(w)).map((w) => (
                      <span key={w} className="flag cleared">
                        {w}
                      </span>
                    ))}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div className="tracer">
        <div className="editor-bar">
          <strong className="panel-title">Signal trace</strong>
          <button
            type="button"
            className={`chip-btn${studio.trace ? ' is-on' : ''}`}
            onClick={() => studio.setTrace(studio.trace ? null : ['delay', 'reverb'])}
          >
            <Route size={12} />
            {studio.trace ? 'Close trace' : 'Why can I hear echo?'}
          </button>
        </div>
        {!studio.trace && <p className="muted trace-intro">Trace every path into the Delay and Plate returns, including muted tracks with pre-fader sends.</p>}
        {traces.map((trace) => (
          <div key={trace.bus} className="trace-bus">
            <div className={`trace-ret${trace.audible ? '' : ' is-off'}`}>
              <strong>{trace.name}</strong>
              <span>{trace.reason}</span>
              {trace.bus === 'delay' && <span className="num">Tail {delayTailSeconds(project).toFixed(1)} s</span>}
            </div>
            <ul>
              {trace.rows
                .filter((row) => row.level > 0)
                .sort((a, b) => Number(b.suspicious) - Number(a.suspicious) || b.level - a.level)
                .map((row) => (
                  <li key={row.trackId} className={`${row.suspicious ? 'is-suspicious' : ''}${row.feeds ? '' : ' is-dead'}`}>
                    <button
                      type="button"
                      onClick={() => {
                        studio.select({ kind: 'track', trackId: row.trackId })
                        if (row.suspicious) studio.markTask('echo')
                      }}
                    >
                      <strong>{row.trackName}</strong>
                      <span>{row.reason}</span>
                      {row.suspicious && <em>Likely source</em>}
                    </button>
                  </li>
                ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  )
}

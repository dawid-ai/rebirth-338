import { Activity, Route, TriangleAlert } from 'lucide-react'
import { useState } from 'react'
import { BAND_NAMES } from '@reborn/analysis'
import { studio } from '@reborn/studio-core'
import { runAnalysis, useAnalysis } from '../audio/analysis'
import { runDeep, useDeep } from '../audio/deep'
import { desktop } from '../platform/desktop'
import { dispatch, select, toast, useStudio } from '../state/store'

const BAND_LABELS: Record<string, string> = { sub: 'Sub', bass: 'Bass', lowMid: 'Low-mid', mid: 'Mid', harsh: 'Harsh', air: 'Air' }

function heat(share: number) {
  const v = Math.max(0, Math.min(1, share * 3))
  return `color-mix(in oklab, var(--field-3) ${Math.round((1 - v) * 100)}%, var(--heat) ${Math.round(v * 100)}%)`
}

export function MixDock() {
  const project = useStudio((s) => s.project)
  const report = useAnalysis()
  const [tracing, setTracing] = useState(true)
  const [busy, setBusy] = useState(false)
  const stale = report && report.revision !== project.revision
  const traces = project.returns.map((ret) => studio.traceReturn(project, ret.id))
  const deep = useDeep((d) => d.result)
  const deepRunning = useDeep((d) => d.running)

  return (
    <div className="mix-dock">
      <div className="analyzer">
        <div className="editor-bar">
          <strong className="panel-title">Analyzer</strong>
          <button
            type="button"
            className="chip-btn"
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              try {
                await runAnalysis()
              } catch (error) {
                toast(`Analysis failed: ${error instanceof Error ? error.message : String(error)}`, 'error')
              } finally {
                setBusy(false)
              }
            }}
          >
            <Activity size={12} />
            {busy ? 'Rendering…' : report ? 'Analyze again' : 'Analyze mix'}
          </button>
          {report && (
            <span className={`muted${stale ? ' stale' : ''}`}>
              {stale ? 'The project changed since this measurement. ' : ''}Whole song: {report.whole.loudnessLufs.toFixed(1)} LUFS · true peak {report.whole.truePeakDb.toFixed(1)} dBTP · tail {report.tailSeconds.toFixed(1)} s
            </span>
          )}
          {!report && <span className="muted">Renders the song offline and measures each section. Nothing changes in the project.</span>}
          {desktop && (
            <>
              <button type="button" className="chip-btn" disabled={deepRunning} onClick={() => void runDeep('analyze')} title="Measure with the Python analysis sidecar. With Ismail installed, it also reports sections, key, and chords.">
                Deep analysis
              </button>
              <button type="button" className="chip-btn" disabled={deepRunning} onClick={() => void runDeep('compare')} title="Compare loudness and tonal balance with a reference WAV">
                Compare with reference…
              </button>
            </>
          )}
        </div>
        {deep && (
          <div className={`deep-result${deep.revision !== project.revision ? ' is-stale' : ''}`}>
            <strong>{deep.kind === 'compare' ? 'Reference comparison' : 'Deep analysis'}</strong>
            <span className="muted">via {deep.backend} sidecar</span>
            <span className="num">
              {Object.entries(deep.summary)
                .filter(([, v]) => v !== null)
                .map(([k, v]) => `${k} ${v}`)
                .join(' · ')}
            </span>
            {deep.findings.length > 0 && (
              <ul>
                {deep.findings.slice(0, 6).map((f, i) => (
                  <li key={i}>{f.message}</li>
                ))}
              </ul>
            )}
            {deep.sections.length > 0 && (
              <span className="muted">
                {deep.sections.map((s) => `${s.name} ${s.lufs ?? '—'} LUFS`).join(' · ')}
              </span>
            )}
            {deep.reports.length > 0 && (
              <div className="deep-reports">
                {deep.reports.map((report) => (
                  <details key={report.name} className="deep-report">
                    <summary>Ismail · {report.name}</summary>
                    <pre>{report.text}</pre>
                  </details>
                ))}
              </div>
            )}
            {deep.reportErrors.length > 0 && <span className="muted">Not available this time: {deep.reportErrors.join('; ')}</span>}
          </div>
        )}
        {report && (
          <table className="an-table">
            <thead>
              <tr>
                <th scope="col">Section</th>
                {BAND_NAMES.map((band) => (
                  <th key={band} scope="col">
                    {BAND_LABELS[band]}
                  </th>
                ))}
                <th scope="col">LUFS</th>
                <th scope="col" title="Integrated RMS level">RMS</th>
                <th scope="col">Peak</th>
                <th scope="col">Crest</th>
                <th scope="col">Corr</th>
                <th scope="col" title="Left/right level difference">Bal</th>
                <th scope="col" title="Largest DC offset of either channel">DC</th>
                <th scope="col">Flags</th>
              </tr>
            </thead>
            <tbody>
              {report.sections.map((section) => (
                <tr key={section.id}>
                  <th scope="row">{section.name}</th>
                  {BAND_NAMES.map((band) => (
                    <td key={band} className="heat" style={{ background: heat(section.bands[band].share) }} title={`${BAND_LABELS[band]}: ${section.bands[band].db.toFixed(1)} dB, ${Math.round(section.bands[band].share * 100)}% of energy`}>
                      {Math.round(section.bands[band].share * 100)}%
                    </td>
                  ))}
                  <td className="num">{Number.isFinite(section.loudnessLufs) ? section.loudnessLufs.toFixed(1) : '—'}</td>
                  <td className="num">{Number.isFinite(section.rmsDb) ? section.rmsDb.toFixed(1) : '—'}</td>
                  <td className="num">{Number.isFinite(section.truePeakDb) ? section.truePeakDb.toFixed(1) : '—'}</td>
                  <td className="num">{Number.isFinite(section.crestDb) ? section.crestDb.toFixed(1) : '—'}</td>
                  <td className="num">{section.correlation.toFixed(2)}</td>
                  <td className="num" title={section.balanceDb > 0 ? 'Left is louder' : section.balanceDb < 0 ? 'Right is louder' : 'Centered'}>
                    {Math.abs(section.balanceDb) < 0.05 ? 'C' : `${section.balanceDb > 0 ? 'L' : 'R'} ${Math.abs(section.balanceDb).toFixed(1)}`}
                  </td>
                  <td className="num">{Math.max(...section.dcOffset.map(Math.abs)).toFixed(4)}</td>
                  <td className="flags">
                    {section.warnings.map((w) => (
                      <span key={w.code} className="flag" title={w.message}>
                        <TriangleAlert size={10} />
                        {w.code.replace('_', ' ')}
                      </span>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="tracer">
        <div className="editor-bar">
          <strong className="panel-title">Signal trace</strong>
          <button type="button" className={`chip-btn${tracing ? ' is-on' : ''}`} onClick={() => setTracing(!tracing)}>
            <Route size={12} />
            {tracing ? 'Hide trace' : 'Why can I hear echo?'}
          </button>
        </div>
        {tracing &&
          traces.map((trace) => (
            <div key={trace.returnId} className="trace-bus">
              <div className={`trace-ret${trace.audible ? '' : ' is-off'}`}>
                <strong>{trace.name}</strong>
                <span>{trace.reason}</span>
              </div>
              <ul>
                {trace.sources
                  .filter((row) => row.level > 0)
                  .sort((a, b) => Number(b.suspicious) - Number(a.suspicious) || b.level - a.level)
                  .map((row) => (
                    <li key={row.trackId} className={`${row.suspicious ? 'is-suspicious' : ''}${row.feeds ? '' : ' is-dead'}`}>
                      <button type="button" onClick={() => select({ kind: 'track', trackId: row.trackId })}>
                        <strong>{row.name}</strong>
                        <span>{row.reason}</span>
                        {row.suspicious && <em>Likely source</em>}
                      </button>
                      {row.suspicious && (
                        <button type="button" className="chip-btn fix" onClick={() => dispatch({ type: 'send.set', params: { trackId: row.trackId, returnId: trace.returnId, tap: 'post' } }, { label: `Make ${row.name}’s send post-fader` })}>
                          Make post-fader
                        </button>
                      )}
                    </li>
                  ))}
                {!trace.sources.some((row) => row.level > 0) && <li className="muted">No track sends to {trace.name}.</li>}
              </ul>
            </div>
          ))}
      </div>
    </div>
  )
}

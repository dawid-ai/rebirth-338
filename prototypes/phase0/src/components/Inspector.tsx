import { Check, Eye, EyeOff, PanelRight, Sparkles, Unlink, X } from 'lucide-react'
import type { CSSProperties } from 'react'
import {
  type Project,
  type Track,
  clipById,
  clipEnd,
  delayTailSeconds,
  insertTime,
  linkCount,
  makeUnique,
  setNoteStep,
  trackById,
  updateDelay,
  updateReverb,
  updateSection,
  updateSend,
  updateTrack,
} from '../model'
import { type Studio, useStudio } from '../studio'
import { Field, Slider, Toggle } from './Controls'
import { noteName } from './Dock'

const pct = (v: number) => `${Math.round(v * 100)}%`
const db = (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`

function ProposalCard() {
  const studio = useStudio()
  const { proposal } = studio
  if (!proposal) return null
  const count = studio.picks.size
  return (
    <section className="proposal" aria-label="Agent proposal">
      <header>
        <Sparkles size={14} />
        <strong>Agent proposal</strong>
        <span className="pending-tag">Pending</span>
      </header>
      <p className="proposal-request">“{proposal.request}”</p>
      <p className="proposal-intent">{proposal.intent}</p>
      <ul className="changes">
        {proposal.changes.map((change) => {
          const on = studio.picks.has(change.id)
          return (
            <li key={change.id} className={on ? 'is-on' : ''}>
              <label>
                <input type="checkbox" checked={on} onChange={() => studio.togglePick(change.id)} />
                <span className="change-body">
                  <strong>{change.summary}</strong>
                  <span className="change-target">{change.target}</span>
                  <span className="change-diff">
                    <s>{change.before}</s> → <b>{change.after}</b>
                  </span>
                  <span className="change-evidence">{change.evidence}</span>
                </span>
              </label>
            </li>
          )
        })}
      </ul>
      <div className="proposal-actions">
        <button type="button" className={`chip-btn${studio.previewOn ? ' is-on' : ''}`} onClick={() => studio.setPreviewOn(!studio.previewOn)} aria-pressed={studio.previewOn}>
          {studio.previewOn ? <Eye size={12} /> : <EyeOff size={12} />}
          Preview
        </button>
        <button type="button" className="chip-btn primary" disabled={!count} onClick={studio.applyProposal}>
          <Check size={12} />
          {count === proposal.changes.length ? 'Apply all' : `Apply ${count} selected`}
        </button>
        <button type="button" className="chip-btn" onClick={studio.rejectProposal}>
          <X size={12} />
          Reject
        </button>
      </div>
      <p className="muted small">Applying is one undoable step, labeled as an agent edit in history.</p>
    </section>
  )
}

function TrackPanel({ track, project, studio }: { track: Track; project: Project; studio: Studio }) {
  const ghost = studio.preview?.tracks.find((t) => t.id === track.id)
  const clips = project.clips.filter((c) => c.trackId === track.id)
  return (
    <>
      <h2 style={{ '--track': track.color } as CSSProperties} className="insp-title track">
        {track.name}
        <small>{track.device}</small>
      </h2>
      <Slider label="Volume" value={track.volume} min={-60} max={6} step={0.5} ghost={ghost?.volume ?? null} format={db} onChange={(volume) => studio.commit(`Set ${track.name} volume`, (p) => updateTrack(p, track.id, { volume }), { key: `vol-${track.id}` })} />
      <Slider label="Pan" value={track.pan} min={-1} max={1} format={(v) => (Math.abs(v) < 0.01 ? 'Center' : v < 0 ? `L${Math.round(-v * 100)}` : `R${Math.round(v * 100)}`)} onChange={(pan) => studio.commit(`Pan ${track.name}`, (p) => updateTrack(p, track.id, { pan }), { key: `pan-${track.id}` })} />
      <div className="insp-group">
        <h3>Sends</h3>
        {(['delay', 'reverb'] as const).map((bus) => (
          <div key={bus} className="send-row">
            <Slider
              label={project.returns[bus].name}
              value={track.sends[bus].level}
              min={0}
              max={1}
              ghost={ghost?.sends[bus].level ?? null}
              format={pct}
              onChange={(level) => studio.commit(`Set ${track.name} send`, (p) => updateSend(p, track.id, bus, { level }), { key: `send-${track.id}-${bus}` })}
            />
            <div className="seg sm" role="radiogroup" aria-label={`${project.returns[bus].name} send tap`}>
              {(['pre', 'post'] as const).map((tap) => (
                <button
                  key={tap}
                  type="button"
                  role="radio"
                  aria-checked={track.sends[bus].tap === tap}
                  className={`${track.sends[bus].tap === tap ? 'is-on' : ''}${ghost && ghost.sends[bus].tap === tap && track.sends[bus].tap !== tap ? ' is-ghost' : ''}`}
                  onClick={() => studio.commit(`${track.name} send ${tap}-fader`, (p) => updateSend(p, track.id, bus, { tap }))}
                >
                  {tap === 'pre' ? 'Pre-fader' : 'Post-fader'}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="insp-row">
        <Toggle label="Mute" tone="alert" on={track.mute} onChange={(mute) => studio.commit(`${mute ? 'Mute' : 'Unmute'} ${track.name}`, (p) => updateTrack(p, track.id, { mute }))} />
        <Toggle label="Solo" tone="mod" on={track.solo} onChange={(solo) => studio.commit(`${solo ? 'Solo' : 'Unsolo'} ${track.name}`, (p) => updateTrack(p, track.id, { solo }))} />
      </div>
      <dl className="facts">
        <dt>Output</dt>
        <dd>Master</dd>
        <dt>Clips</dt>
        <dd>{clips.length}</dd>
      </dl>
    </>
  )
}

function ClipPanel({ clipId, studio }: { clipId: string; studio: Studio }) {
  const { project } = studio
  const clip = clipById(project, clipId)
  if (!clip) return <p className="muted">The selected clip no longer exists.</p>
  const pattern = project.patterns[clip.patternId]
  const track = trackById(project, clip.trackId)
  const links = linkCount(project, clip.patternId)
  return (
    <>
      <h2 className="insp-title" style={{ '--track': track?.color } as CSSProperties}>
        {pattern?.name}
        <small>
          Clip on {track?.name} · bars {clip.start + 1}–{clipEnd(clip)}
        </small>
      </h2>
      <div className={`link-state${links > 1 ? ' is-linked' : ''}`}>
        {links > 1 ? (
          <>
            <p>
              Linked: {links} clips share this pattern. Editing notes here changes all {links}.
            </p>
            <button
              type="button"
              className="chip-btn"
              onClick={() => {
                const result = makeUnique(project, clip.id)
                studio.commit(`Make ${pattern?.name} unique`, () => result.project)
                studio.markTask('unique')
              }}
            >
              <Unlink size={12} />
              Make unique
            </button>
          </>
        ) : (
          <p>Unique: only this clip uses the pattern.</p>
        )}
      </div>
      <dl className="facts">
        <dt>Start</dt>
        <dd>Bar {clip.start + 1}</dd>
        <dt>Length</dt>
        <dd>{clip.length} bars</dd>
        <dt>Pattern</dt>
        <dd>{pattern ? `${pattern.length} steps, loops` : '—'}</dd>
        <dt>Offset</dt>
        <dd>{clip.offset} bars</dd>
      </dl>
      <p className="muted small">Drag the clip to move it; drag its right edge to resize. Ctrl+D duplicates it as a linked repeat. Delete removes it.</p>
    </>
  )
}

function StepPanel({ clipId, index, studio }: { clipId: string; index: number; studio: Studio }) {
  const { project } = studio
  const clip = clipById(project, clipId)
  const pattern = clip ? project.patterns[clip.patternId] : undefined
  if (!clip || pattern?.kind !== 'notes') return null
  const step = pattern.steps[index]
  if (!step) return null
  const set = (label: string, patch: Parameters<typeof setNoteStep>[3]) => studio.commit(label, (p) => setNoteStep(p, pattern.id, index, patch), { key: `step-${pattern.id}-${index}-${label}` })
  return (
    <>
      <h2 className="insp-title">
        Step {index + 1}
        <small>
          {pattern.name}
          {linkCount(project, pattern.id) > 1 && ` · linked ×${linkCount(project, pattern.id)}`}
        </small>
      </h2>
      <div className="insp-row">
        <Toggle label={step.on ? 'On' : 'Off'} tone="signal" on={step.on} onChange={(on) => set('Toggle step', { on })} />
        <Toggle label="Accent" tone="mod" on={step.accent} onChange={(accent) => set('Toggle accent', { accent })} />
        <Toggle label="Slide" tone="select" on={step.slide} onChange={(slide) => set('Toggle slide', { slide })} />
      </div>
      <Slider label="Note" value={step.note} min={24} max={72} step={1} format={noteName} onChange={(note) => set('Set note', { note, on: true })} />
      <Slider label="Velocity" value={step.velocity} min={1} max={127} step={1} format={(v) => `${v}`} onChange={(velocity) => set('Set velocity', { velocity })} />
      <Slider label="Probability" value={step.probability} min={0} max={100} step={1} format={(v) => `${v}%`} onChange={(probability) => set('Set probability', { probability })} />
      <Slider label="Ratchet" value={step.ratchet} min={1} max={4} step={1} format={(v) => `×${v}`} onChange={(ratchet) => set('Set ratchet', { ratchet })} />
      <div className="insp-group">
        <h3>Parameter locks</h3>
        <p className="muted small">Hold Alt while turning a macro to lock it to this step. Locks win over clip and arrangement automation.</p>
        <p className="precedence">device → clip auto → arrangement auto → <b>step lock</b></p>
      </div>
      <p className="muted small">Arrow keys move between steps.</p>
    </>
  )
}

function SectionPanel({ sectionId, studio }: { sectionId: string; studio: Studio }) {
  const { project } = studio
  const section = project.sections.find((s) => s.id === sectionId)
  if (!section) return null
  const insert = (at: number) => {
    const next = insertTime(project, at, 8, 'New 8')
    studio.commit(`Insert 8 bars at bar ${at + 1}`, () => next)
    studio.markTask('insert')
    const created = next.sections.find((s) => s.start === at && !project.sections.some((old) => old.id === s.id))
    if (created) studio.select({ kind: 'section', sectionId: created.id })
  }
  return (
    <>
      <h2 className="insp-title" style={{ '--track': section.color } as CSSProperties}>
        {section.name}
        <small>
          Section · bars {section.start + 1}–{section.start + section.length}
        </small>
      </h2>
      <Field label="Name">
        <input
          type="text"
          value={section.name}
          onKeyDown={(event) => event.stopPropagation()}
          onChange={(event) => studio.commit('Rename section', (p) => updateSection(p, section.id, { name: event.target.value }), { key: `name-${section.id}` })}
        />
      </Field>
      <div className="insp-group">
        <h3>Insert time</h3>
        <div className="insp-row">
          <button type="button" className="chip-btn" onClick={() => insert(section.start)}>
            8 bars before
          </button>
          <button type="button" className="chip-btn" onClick={() => insert(section.start + section.length)}>
            8 bars after
          </button>
        </div>
        <p className="muted small">Later sections and clips move right. Clips that cross the insert point split instead of stretching.</p>
      </div>
    </>
  )
}

function ReturnPanel({ bus, studio }: { bus: 'delay' | 'reverb'; studio: Studio }) {
  const { project, preview } = studio
  if (bus === 'delay') {
    const delay = project.returns.delay
    return (
      <>
        <h2 className="insp-title">
          {delay.name}
          <small>Return bus · 3/16 ping-pong</small>
        </h2>
        <Slider label="Feedback" value={delay.feedback} min={0} max={0.95} ghost={preview?.returns.delay.feedback ?? null} format={pct} onChange={(feedback) => studio.commit('Set delay feedback', (p) => updateDelay(p, { feedback }), { key: 'delay-fb' })} />
        <Slider label="Return level" value={delay.level} min={-60} max={6} step={0.5} format={db} onChange={(level) => studio.commit('Set delay return level', (p) => updateDelay(p, { level }), { key: 'delay-level' })} />
        <dl className="facts">
          <dt>Tail</dt>
          <dd>{delayTailSeconds(project).toFixed(1)} s</dd>
        </dl>
      </>
    )
  }
  const reverb = project.returns.reverb
  return (
    <>
      <h2 className="insp-title">
        {reverb.name}
        <small>Return bus</small>
      </h2>
      <Slider label="Decay" value={reverb.decay} min={0.2} max={8} step={0.1} format={(v) => `${v.toFixed(1)} s`} onChange={(decay) => studio.commit('Set plate decay', (p) => updateReverb(p, { decay }), { key: 'rev-decay' })} />
      <Slider label="Return level" value={reverb.level} min={-60} max={6} step={0.5} format={db} onChange={(level) => studio.commit('Set plate return level', (p) => updateReverb(p, { level }), { key: 'rev-level' })} />
    </>
  )
}

function SamplePanel({ slice, studio }: { slice: number | null; studio: Studio }) {
  const sample = studio.project.sample
  if (!sample) return <p className="muted">Drop a break on the Sampler track to start chopping.</p>
  const seconds = (sample.bars * 4 * 60) / sample.bpm
  if (slice === null || slice >= sample.slices.length) {
    return (
      <>
        <h2 className="insp-title">
          {sample.name}
          <small>Source · original file is never modified</small>
        </h2>
        <dl className="facts">
          <dt>Length</dt>
          <dd>{seconds.toFixed(2)} s · {sample.bars} bars</dd>
          <dt>Tempo</dt>
          <dd>{sample.bpm} BPM ({pct(sample.bpmConfidence)} confidence)</dd>
          <dt>Slices</dt>
          <dd>{sample.slices.length}</dd>
        </dl>
        <p className="muted small">Click a slice to inspect it. Double-click the waveform to add a marker. Delete removes the selected marker.</p>
      </>
    )
  }
  const start = sample.slices[slice]
  const end = sample.slices[slice + 1] ?? 1
  const pad = sample.pads.indexOf(slice)
  return (
    <>
      <h2 className="insp-title">
        Slice {slice + 1}
        <small>{sample.name}</small>
      </h2>
      <dl className="facts">
        <dt>Start</dt>
        <dd>{(start * seconds * 1000).toFixed(0)} ms</dd>
        <dt>Length</dt>
        <dd>{((end - start) * seconds * 1000).toFixed(0)} ms</dd>
        <dt>Pad</dt>
        <dd>{pad >= 0 ? `Pad ${pad + 1}` : 'Not assigned'}</dd>
        <dt>Pitch</dt>
        <dd>0 st</dd>
        <dt>Choke</dt>
        <dd>None</dd>
      </dl>
      <p className="muted small">Pitch, reverse, normalize, and choke groups apply to several slices at once in Phase 4.</p>
    </>
  )
}

function ProjectPanel({ studio }: { studio: Studio }) {
  const { project } = studio
  return (
    <>
      <h2 className="insp-title">
        {project.name}
        <small>Project · nothing selected</small>
      </h2>
      <dl className="facts">
        <dt>Tempo</dt>
        <dd>{project.tempo} BPM</dd>
        <dt>Swing</dt>
        <dd>{pct(project.swing)} global</dd>
        <dt>Length</dt>
        <dd>{project.length} bars</dd>
        <dt>Tracks</dt>
        <dd>{project.tracks.length}</dd>
      </dl>
      <div className="insp-group">
        <h3>Sections</h3>
        <ul className="sec-list">
          {project.sections.map((s) => (
            <li key={s.id}>
              <button type="button" onClick={() => studio.select({ kind: 'section', sectionId: s.id })} style={{ '--track': s.color } as CSSProperties}>
                <i />
                {s.name}
                <span>
                  {s.start + 1}–{s.start + s.length}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </>
  )
}

function HistoryPanel({ studio }: { studio: Studio }) {
  const entries = studio.past.slice(-6).reverse()
  if (!entries.length) return null
  return (
    <div className="insp-group history">
      <h3>History</h3>
      <ol>
        {entries.map((entry, i) => (
          <li key={`${entry.at}-${i}`} className={entry.origin}>
            <span className="origin">{entry.origin === 'agent' ? 'Agent' : 'You'}</span>
            {entry.label}
          </li>
        ))}
      </ol>
    </div>
  )
}

interface InspectorProps {
  overlay: boolean
  onClose: () => void
}

export function Inspector({ overlay, onClose }: InspectorProps) {
  const studio = useStudio()
  const { project, selection } = studio
  let body
  if (selection.kind === 'track') {
    const track = trackById(project, selection.trackId)
    body = track ? <TrackPanel track={track} project={project} studio={studio} /> : null
  } else if (selection.kind === 'clip') body = <ClipPanel clipId={selection.clipId} studio={studio} />
  else if (selection.kind === 'step') body = <StepPanel clipId={selection.clipId} index={selection.index} studio={studio} />
  else if (selection.kind === 'section') body = <SectionPanel sectionId={selection.sectionId} studio={studio} />
  else if (selection.kind === 'return') body = <ReturnPanel bus={selection.bus} studio={studio} />
  else if (selection.kind === 'sample') body = <SamplePanel slice={selection.slice} studio={studio} />
  else body = <ProjectPanel studio={studio} />

  return (
    <aside className={`inspector${overlay ? ' is-overlay' : ''}`} aria-label="Inspector">
      <div className="panel-head">
        <span className="panel-title">Inspector</span>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close inspector" title="Close inspector">
          <PanelRight size={16} />
        </button>
      </div>
      <div className="insp-scroll">
        <ProposalCard />
        {body}
        <HistoryPanel studio={studio} />
      </div>
    </aside>
  )
}

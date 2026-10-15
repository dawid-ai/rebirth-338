import { Check, Circle, ListChecks, PanelLeft, PanelRight } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { clock, useClock } from './clock'
import { Arrange } from './components/Arrange'
import { Browser } from './components/Browser'
import { Dock, PAD_KEYS } from './components/Dock'
import { Inspector } from './components/Inspector'
import { Mix } from './components/Mix'
import { Palette } from './components/Palette'
import { Transport } from './components/Transport'
import { type Clip, type PadHit, clipById, clipEnd, createClip, deleteClip, duplicateClip, moveClip, resizeClip, setNoteStep, updatePattern } from './model'
import { type Studio, StudioContext, TASKS, type View, useStudio, useStudioState } from './studio'

const VIEWS: { id: View; label: string }[] = [
  { id: 'arrange', label: 'Arrange' },
  { id: 'build', label: 'Build' },
  { id: 'mix', label: 'Mix' },
  { id: 'perform', label: 'Perform' },
]

function useWindowWidth() {
  const [width, setWidth] = useState(() => window.innerWidth)
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return width
}

function padsActive(studio: Studio) {
  const { project, selection, keysToPads } = studio
  if (!keysToPads || !project.sample || studio.view === 'mix') return false
  if (selection.kind === 'sample') return true
  if (selection.kind === 'track') return project.tracks.find((t) => t.id === selection.trackId)?.kind === 'sampler'
  if (selection.kind === 'clip') {
    const clip = clipById(project, selection.clipId)
    return clip ? project.patterns[clip.patternId]?.kind === 'pads' : false
  }
  return false
}

function isTyping(target: EventTarget | null) {
  return target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
}

function neighborClip(clips: Clip[], current: Clip, direction: -1 | 1) {
  const sameTrack = clips.filter((c) => c.trackId === current.trackId).sort((a, b) => a.start - b.start)
  return sameTrack[sameTrack.indexOf(current) + direction]
}

function RecordingStatus({ startBar }: { startBar: number | null }) {
  const bar = useClock((position) => (startBar === null ? 0 : Math.min(4, Math.floor(position - startBar) + 1)))
  if (startBar === null) return null
  return (
    <span className="status-rec">
      <Circle size={9} fill="currentColor" />
      Recording pads · bar {bar} of 4
    </span>
  )
}

function Placeholder({ view }: { view: View }) {
  const studio = useStudio()
  return (
    <div className="placeholder">
      <h2>{view === 'build' ? 'Build' : 'Perform'}</h2>
      <p>
        {view === 'build'
          ? 'The clip launcher (tracks × scenes) is outside Phase 0. The three Phase 0 prototypes cover Arrange, sampling, and Mix.'
          : 'The stage layout with scene triggers, macros, and crossfader is outside Phase 0 and lands in Phase 7.'}
      </p>
      <div className="placeholder-scenes">
        {studio.project.sections.map((s) => (
          <span key={s.id} style={{ borderColor: s.color }}>
            {s.name}
          </span>
        ))}
      </div>
    </div>
  )
}

export default function App() {
  const studio = useStudioState()
  const width = useWindowWidth()
  const wide = width >= 1180
  const [browserOpen, setBrowserOpen] = useState(() => window.innerWidth >= 1680)
  const [inspectorOpen, setInspectorOpen] = useState(() => window.innerWidth >= 1180)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [tasksOpen, setTasksOpen] = useState(false)
  const [recordStart, setRecordStart] = useState<number | null>(null)
  const studioRef = useRef(studio)
  studioRef.current = studio
  const session = useRef<{ start: number; hits: PadHit[] } | null>(null)

  const toggleBrowser = () => {
    if (!wide && !browserOpen) setInspectorOpen(false)
    setBrowserOpen(!browserOpen)
  }
  const toggleInspector = () => {
    if (!wide && !inspectorOpen) setBrowserOpen(false)
    setInspectorOpen(!inspectorOpen)
  }

  // Keeps the visual clock in step with tempo, length, and loop range.
  const { project, selection, loopOn } = studio
  useEffect(() => {
    let loop: [number, number] | null = null
    if (loopOn) {
      const section = selection.kind === 'section' ? project.sections.find((s) => s.id === selection.sectionId) : null
      loop = section ? [section.start, section.start + section.length] : [0, project.length]
    }
    clock.configure({ tempo: project.tempo, loop, length: project.length })
  }, [loopOn, project.length, project.sections, project.tempo, selection])

  // Pad recording: arming plus playback opens a four-bar take. The take
  // becomes one undoable clip on the Sampler track.
  useEffect(() => {
    const finish = () => {
      const take = session.current
      session.current = null
      setRecordStart(null)
      const s = studioRef.current
      s.setRecordArmed(false)
      if (!take || !take.hits.length) return
      const sampler = s.project.tracks.find((t) => t.kind === 'sampler')
      if (!sampler) return
      const created = createClip(s.project, sampler.id, take.start, 4)
      const clip = clipById(created.project, created.clipId)!
      const next = updatePattern(created.project, clip.patternId, (pattern) => (pattern.kind === 'pads' ? { ...pattern, name: 'Pad take', hits: take.hits } : pattern))
      s.commit('Record pad performance', () => next)
      s.select({ kind: 'clip', clipId: created.clipId })
      if (s.project.sample) s.markTask('pads')
    }
    return clock.subscribe(() => {
      const s = studioRef.current
      const position = clock.get()
      const playing = clock.isPlaying()
      if (!session.current && s.recordArmed && playing) {
        session.current = { start: Math.floor(position), hits: [] }
        setRecordStart(Math.floor(position))
        return
      }
      const take = session.current
      if (take && (!playing || position >= take.start + 4 || position < take.start)) finish()
    })
  }, [])

  useEffect(() => {
    const take = session.current
    if (!take || !studio.lastPad) return
    const step = Math.min(63, Math.max(0, Math.round((clock.get() - take.start) * 16)))
    if (!take.hits.some((h) => h.step === step && h.pad === studio.lastPad!.pad)) take.hits.push({ step, pad: studio.lastPad.pad, velocity: 100 })
  }, [studio.lastPad])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const s = studioRef.current
      const mod = event.ctrlKey || event.metaKey
      const key = event.key.toLowerCase()
      if (mod && key === 'k') {
        event.preventDefault()
        setPaletteOpen((open) => !open)
        return
      }
      if (isTyping(event.target)) return
      if (mod && key === 'z') {
        event.preventDefault()
        if (event.shiftKey) s.redo()
        else s.undo()
        return
      }
      if (mod && key === 'y') {
        event.preventDefault()
        s.redo()
        return
      }
      const sel = s.selection
      const clip = sel.kind === 'clip' || sel.kind === 'step' ? clipById(s.project, sel.clipId) : undefined
      if (mod && key === 'd' && clip) {
        event.preventDefault()
        const result = duplicateClip(s.project, clip.id)
        s.commit('Duplicate clip', () => result.project)
        s.select({ kind: 'clip', clipId: result.clipId })
        return
      }
      if (mod || (event.altKey && !clip)) return
      if (event.code === 'Space') {
        event.preventDefault()
        if (clock.isPlaying()) clock.pause()
        else clock.play()
        return
      }
      if (padsActive(s) && PAD_KEYS.includes(key) && !event.repeat) {
        event.preventDefault()
        s.triggerPad(PAD_KEYS.indexOf(key))
        return
      }
      if (['1', '2', '3', '4'].includes(key)) {
        s.setView(VIEWS[Number(key) - 1].id)
        return
      }
      if (key === 'r') s.setRecordArmed(!s.recordArmed)
      else if (event.key === 'Home') clock.seek(0)
      else if (event.key === 'Escape') {
        s.select({ kind: 'none' })
        s.setTrace(null)
      } else if (event.key === 'Delete' || event.key === 'Backspace') {
        if (sel.kind === 'clip' && clip) {
          s.commit('Delete clip', (p) => deleteClip(p, clip.id))
          s.select({ kind: 'none' })
        } else if (sel.kind === 'step' && clip) {
          s.commit('Clear step', (p) => setNoteStep(p, clip.patternId, sel.index, { on: false }))
        } else if (sel.kind === 'sample' && sel.slice !== null && s.project.sample && s.project.sample.slices.length > 1) {
          const index = sel.slice
          s.commit('Remove slice marker', (p) => {
            if (!p.sample) return p
            const slices = p.sample.slices.filter((_, i) => i !== index)
            const pads = p.sample.pads.map((slice) => (slice === null || slice === index ? null : slice > index ? slice - 1 : slice))
            return { ...p, sample: { ...p.sample, slices, pads } }
          })
          s.select({ kind: 'sample', slice: null })
        } else return
      } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        const direction = event.key === 'ArrowLeft' ? -1 : 1
        if (sel.kind === 'step' && clip) {
          const pattern = s.project.patterns[clip.patternId]
          s.select({ kind: 'step', clipId: clip.id, index: (sel.index + direction + pattern.length) % pattern.length })
        } else if (sel.kind === 'clip' && clip) {
          if (event.altKey) s.commit('Nudge clip', (p) => moveClip(p, clip.id, clip.start + direction), { key: `move-${clip.id}` })
          else if (event.shiftKey) s.commit('Resize clip', (p) => resizeClip(p, clip.id, clip.length + direction), { key: `size-${clip.id}` })
          else {
            const next = neighborClip(s.project.clips, clip, direction)
            if (next) s.select({ kind: 'clip', clipId: next.id })
          }
        } else return
      } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        if (sel.kind !== 'clip' || !clip) return
        const tracks = s.project.tracks
        const row = tracks.findIndex((t) => t.id === clip.trackId) + (event.key === 'ArrowUp' ? -1 : 1)
        const target = tracks[row]
        if (!target) return
        const candidates = s.project.clips.filter((c) => c.trackId === target.id)
        const next = candidates.find((c) => c.start <= clip.start && clipEnd(c) > clip.start) ?? candidates.sort((a, b) => Math.abs(a.start - clip.start) - Math.abs(b.start - clip.start))[0]
        if (next) s.select({ kind: 'clip', clipId: next.id })
        else s.select({ kind: 'track', trackId: target.id })
      } else return
      event.preventDefault()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const browserDocked = browserOpen && wide
  const inspectorDocked = inspectorOpen && wide
  const lastEdit = studio.past[studio.past.length - 1]

  return (
    <StudioContext.Provider value={studio}>
      <div
        className="app"
        style={{
          gridTemplateColumns: `${browserDocked ? 'clamp(264px, 20vw, 320px)' : '44px'} minmax(0, 1fr) ${inspectorDocked ? 'clamp(300px, 24vw, 360px)' : '0px'}`,
        }}
      >
        <Transport onOpenPalette={() => setPaletteOpen(true)} />
        <Browser open={browserOpen} overlay={!wide} onToggle={toggleBrowser} />
        <main className="workspace">
          <div className="view-bar">
            <div className="view-tabs" role="tablist" aria-label="Views">
              {VIEWS.map((view, i) => (
                <button key={view.id} type="button" role="tab" aria-selected={studio.view === view.id} className={studio.view === view.id ? 'is-on' : ''} onClick={() => studio.setView(view.id)}>
                  {view.label}
                  <kbd>{i + 1}</kbd>
                </button>
              ))}
            </div>
            <div className="view-bar-right">
              {padsActive(studio) && <span className="mode-pill">Keys → pads</span>}
              {studio.proposal && (
                <span className="mode-pill pending">
                  Proposal pending · {studio.picks.size}/{studio.proposal.changes.length} selected
                </span>
              )}
              {!wide && (
                <button type="button" className="icon-btn" onClick={toggleBrowser} aria-label="Toggle browser">
                  <PanelLeft size={16} />
                </button>
              )}
              {!inspectorOpen && (
                <button type="button" className="icon-btn" onClick={toggleInspector} aria-label="Open inspector" title="Open inspector">
                  <PanelRight size={16} />
                </button>
              )}
            </div>
          </div>
          <div className="canvas">
            {studio.view === 'arrange' && <Arrange />}
            {studio.view === 'mix' && <Mix />}
            {(studio.view === 'build' || studio.view === 'perform') && <Placeholder view={studio.view} />}
          </div>
          <Dock />
        </main>
        {inspectorOpen && <Inspector overlay={!wide} onClose={toggleInspector} />}
        {!wide && browserOpen && <div className="scrim" onClick={toggleBrowser} />}
        <footer className="status">
          <span className="status-proto">Prototype · no audio output</span>
          <RecordingStatus startBar={recordStart} />
          {studio.recordArmed && recordStart === null && <span className="status-armed">Record armed · press Space</span>}
          <span className="status-last">
            {lastEdit ? (
              <>
                <b className={lastEdit.origin}>{lastEdit.origin === 'agent' ? 'Agent' : 'You'}</b> {lastEdit.label}
              </>
            ) : (
              'No edits yet'
            )}
          </span>
          <span className="status-spacer" />
          <button type="button" className={`status-tasks${tasksOpen ? ' is-on' : ''}`} onClick={() => setTasksOpen(!tasksOpen)} aria-expanded={tasksOpen}>
            <ListChecks size={13} />
            Phase 0 tasks {studio.tasks.size}/{TASKS.length}
          </button>
        </footer>
        {tasksOpen && (
          <div className="tasks" role="dialog" aria-label="Phase 0 validation tasks">
            <h2>Validation tasks</h2>
            <ol>
              {TASKS.map((task) => (
                <li key={task.id} className={studio.tasks.has(task.id) ? 'is-done' : ''}>
                  <span className="task-check">{studio.tasks.has(task.id) && <Check size={12} />}</span>
                  <div>
                    <strong>{task.label}</strong>
                    <small>{task.hint}</small>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        )}
        {paletteOpen && <Palette onClose={() => setPaletteOpen(false)} />}
      </div>
    </StudioContext.Provider>
  )
}

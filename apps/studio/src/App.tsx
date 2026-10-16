import { ListChecks, PanelLeft, PanelRight } from 'lucide-react'
import { type DragEvent, Suspense, lazy, useEffect, useState, useSyncExternalStore } from 'react'
import { studio } from '@reborn/studio-core'
import { engine, importAudioFile, togglePlay } from './audio/host'
import { NOTE_KEYS, PAD_KEYS, recordHit } from './audio/recorder'
import { Arrange } from './components/Arrange'
import { Browser } from './components/Browser'
import { commitSceneRecording } from './components/Build'
import { Dock } from './components/Dock'
import { ONBOARDING, completeOnboarding } from './components/onboarding'
import { Inspector } from './components/Inspector'
import { Transport } from './components/Transport'
import { desktop } from './platform/desktop'
import { clearImportNotice, importNotice, importProjectFile, newProject, onImportNotice, openProject, saveProject } from './state/persistence'
import { type View, dispatch, getState, redo, select, selectedTrackId, setPrefs, setState, setView, subscribe, toast, undo, useStudio } from './state/store'
import { installLearnPicker, startMidi } from './midi/host'
import { playFromSelection, splitSelectedClip } from './state/clipActions'
import { MidiLearnBar } from './components/MidiLearnBar'

// Views and panels that are not needed for the first paint load on demand.
const Build = lazy(() => import('./components/Build').then((m) => ({ default: m.Build })))
const Mix = lazy(() => import('./components/Mix').then((m) => ({ default: m.Mix })))
const Perform = lazy(() => import('./components/Perform').then((m) => ({ default: m.Perform })))
const AgentPanel = lazy(() => import('./components/AgentPanel').then((m) => ({ default: m.AgentPanel })))
const Palette = lazy(() => import('./components/Palette').then((m) => ({ default: m.Palette })))
const Help = lazy(() => import('./components/Help').then((m) => ({ default: m.Help })))

const VIEWS: { id: View; label: string }[] = [
  { id: 'arrange', label: 'Arrange' },
  { id: 'build', label: 'Build' },
  { id: 'mix', label: 'Mix' },
  { id: 'perform', label: 'Perform' },
]

function isTyping(target: EventTarget | null) {
  return target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
}

function comboOf(event: KeyboardEvent): string {
  const key = event.key === ' ' ? 'Space' : event.key.length === 1 ? event.key.toUpperCase() : event.key
  return [event.ctrlKey || event.metaKey ? 'Ctrl' : '', event.shiftKey && (event.key.length > 1 || event.ctrlKey || event.metaKey) ? 'Shift' : '', event.altKey ? 'Alt' : '', key].filter(Boolean).join('+')
}

let octave = 3
const heldNotes = new Set<string>()

function playNote(note: number) {
  const s = getState()
  const trackId = selectedTrackId(s)
  const track = s.project.tracks.find((t) => t.id === trackId)
  if (!track) return
  if (track.kind === 'acid' || track.kind === 'wave') {
    void engine.previewNote(track.id, note)
    recordHit({ trackId: track.id, note, velocity: 100 })
  }
}

function useImportNotice() {
  return useSyncExternalStore(onImportNotice, importNotice)
}

function ImportNotice() {
  const notice = useImportNotice()
  if (!notice) return null
  return (
    <div className="modal-backdrop" onPointerDown={clearImportNotice}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Import report" onPointerDown={(event) => event.stopPropagation()}>
        <header>
          <h2>{notice.title}</h2>
        </header>
        <div className="modal-body">
          <ul className="report">
            {notice.notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
          {notice.approximations.length > 0 && (
            <>
              <h3>Not reproduced exactly</h3>
              <ul className="report warn">
                {notice.approximations.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            </>
          )}
          <p className="muted small">The original file is unchanged. Save to write a new .reborn project.</p>
        </div>
        <footer>
          <button type="button" className="chip-btn primary" onClick={clearImportNotice}>
            Continue
          </button>
        </footer>
      </div>
    </div>
  )
}

function useWidth() {
  const [width, setWidth] = useState(() => window.innerWidth)
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return width
}

function Toasts() {
  const toasts = useStudio((s) => s.toasts)
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.tone}`}>
          {t.text}
        </div>
      ))}
    </div>
  )
}

function StatusBar() {
  const last = useStudio((s) => s.past[s.past.length - 1])
  const recording = useStudio((s) => s.recording)
  const playing = useStudio((s) => s.transport.playing)
  const done = useStudio((s) => s.prefs.onboardingDone.length)
  const [clients, setClients] = useState(0)
  useEffect(() => {
    if (!desktop) return
    const bridge = desktop
    const timer = setInterval(() => void bridge.apiClients().then(setClients).catch(() => undefined), 3000)
    return () => clearInterval(timer)
  }, [])
  return (
    <footer className="status">
      <span className="status-proto">{desktop ? 'Desktop' : 'Browser'} · {engine.sampleRate / 1000} kHz</span>
      {recording && <span className="status-rec">{playing ? 'Recording' : 'Record armed · press Space'}</span>}
      <span className="status-last">
        {last ? (
          <>
            <b className={last.origin}>{last.origin === 'agent' ? 'Agent' : last.origin === 'script' ? 'Script' : 'You'}</b> {last.label}
          </>
        ) : (
          'No edits yet'
        )}
      </span>
      <span className="status-spacer" />
      {desktop && <span className="status-clients" title="Programs connected through the local API (CLI, MCP)">{clients ? `${clients} API client${clients === 1 ? '' : 's'}` : 'API idle'}</span>}
      <button type="button" className="status-tasks" onClick={() => setState({ helpOpen: true })}>
        <ListChecks size={13} />
        {done < ONBOARDING.length ? `First beat ${done}/${ONBOARDING.length}` : 'Help'}
      </button>
    </footer>
  )
}

export default function App() {
  const view = useStudio((s) => s.view)
  const prefs = useStudio((s) => s.prefs)
  const paletteOpen = useStudio((s) => s.paletteOpen)
  const agentOpen = useStudio((s) => s.agentOpen)
  const helpOpen = useStudio((s) => s.helpOpen)
  const width = useWidth()
  const wide = width >= 1180
  const [dragging, setDragging] = useState(false)

  useEffect(() => {
    document.documentElement.dataset.density = prefs.density
    document.documentElement.dataset.contrast = prefs.contrast
  }, [prefs.density, prefs.contrast])

  // Onboarding progress follows real actions.
  useEffect(() => {
    let last = getState()
    return subscribe(() => {
      const s = getState()
      if (s.transport.playing && !last.transport.playing) completeOnboarding('play')
      if (s.past !== last.past && s.past.length) {
        const label = s.past[s.past.length - 1].label
        if (/step|note|accent|slide/i.test(label)) completeOnboarding('step')
        if (/Create clip/.test(label)) completeOnboarding('clip')
        if (/chop|Load .* into|Slice/i.test(label)) completeOnboarding('chop')
      }
      if (s.view === 'mix' && last.view !== 'mix') completeOnboarding('mix')
      if (s.jobs.some((j) => j.label.startsWith('Rendering') && j.status === 'done')) completeOnboarding('export')
      if (!s.transport.playing && last.transport.playing && last.recording) commitSceneRecording()
      last = s
    })
  }, [])

  // Desktop menu commands.
  useEffect(() => {
    if (!desktop) return
    return desktop.onMenuCommand(({ command, path, template }) => {
      if (command === 'new') newProject(template)
      else if (command === 'open-path' && path) void openProject(path)
      else if (command === 'save') void saveProject(false)
      else if (command === 'save-as') void saveProject(true)
      else if (command === 'export-wav') document.querySelector<HTMLButtonElement>('.t-btn[title^="Export"]')?.click()
      else if (command === 'pack') {
        void (async () => {
          const s = getState()
          if (!s.document.path || s.document.savedRevision !== s.project.revision) {
            if (!(await saveProject(false))) return
          }
          if (getState().document.path) await desktop!.packProject(getState().document.path!)
        })()
      } else if (command === 'undo' || command === 'redo') {
        if (isTyping(document.activeElement)) document.execCommand(command)
        else if (command === 'undo') undo()
        else redo()
      }
    })
  }, [])

  useEffect(() => {
    if (!desktop) return
    return desktop.onJobUpdate((update) => {
      if (update.kind !== 'pack') return
      if (update.status === 'done') toast(`Packed ${update.outputPath ?? 'project'}`, 'success')
      else if (update.status === 'failed') toast(`Pack failed: ${update.message ?? ''}`, 'error')
    })
  }, [])

  // MIDI: learned controls drive parameters and transport; other notes play
  // and record the selected instrument.
  useEffect(() => {
    const stop = startMidi({
      onNote: (note, velocity) => {
        const s = getState()
        const track = s.project.tracks.find((t) => t.id === selectedTrackId(s))
        if (track?.kind === 'sampler') {
          const pad = (note - 36 + 160) % 16
          void engine.triggerPad(track.id, pad, velocity)
          recordHit({ trackId: track.id, pad, velocity })
        } else if (track?.kind === 'drum') {
          const voice = studio.DRUM_VOICES[(note - 36 + 100) % studio.DRUM_VOICES.length]
          void engine.previewDrum(track.id, voice, velocity)
        } else playNote(note)
      },
      onRecordToggle: () => {
        const recording = !getState().recording
        setState({ recording })
        if (!recording) commitSceneRecording()
      },
    })
    const unpick = installLearnPicker()
    return () => {
      stop()
      unpick()
    }
  }, [])

  useEffect(() => {
    const onKeyUp = (event: KeyboardEvent) => heldNotes.delete(event.key.toLowerCase())
    const onKeyDown = (event: KeyboardEvent) => {
      const s = getState()
      const combo = comboOf(event)
      const shortcuts = s.prefs.shortcuts
      const is = (action: string) => shortcuts[action] === combo
      if (is('palette')) {
        event.preventDefault()
        setState({ paletteOpen: !s.paletteOpen })
        return
      }
      if (event.key === 'F1') {
        event.preventDefault()
        setState({ helpOpen: !s.helpOpen })
        return
      }
      if (isTyping(event.target)) return
      if (event.key === 'F6') {
        event.preventDefault()
        const regions = [...document.querySelectorAll<HTMLElement>('[data-region]')]
        const current = regions.findIndex((r) => r.contains(document.activeElement))
        const next = regions[(current + (event.shiftKey ? -1 : 1) + regions.length) % regions.length]
        next?.focus()
        return
      }
      if (is('undo')) return void (event.preventDefault(), undo())
      if (is('redo') || combo === 'Ctrl+Y') return void (event.preventDefault(), redo())
      if (is('save')) return void (event.preventDefault(), saveProject(false))
      const sel = s.selection
      const clip = sel.kind === 'clip' || sel.kind === 'step' ? s.project.clips.find((c) => c.id === sel.clipId) : undefined
      if (is('duplicate') && clip) {
        event.preventDefault()
        const results = dispatch({ type: 'clip.duplicate', params: { clipId: clip.id } }, { label: 'Duplicate clip' })
        const copy = (results?.[0] as { clipId: string } | undefined)?.clipId
        if (copy) select({ kind: 'clip', clipId: copy })
        return
      }
      if (is('split')) return void (event.preventDefault(), splitSelectedClip())
      if (event.ctrlKey || event.metaKey) return
      if (is('play.selection')) return void (event.preventDefault(), playFromSelection())
      if (is('play')) {
        event.preventDefault()
        void togglePlay()
        return
      }
      const track = s.project.tracks.find((t) => t.id === selectedTrackId(s))
      const key = event.key.toLowerCase()
      // Live playing: pads on samplers, notes on synths.
      if (s.prefs.keysToPads && !event.altKey && !event.repeat && track?.kind === 'sampler' && PAD_KEYS.includes(key)) {
        event.preventDefault()
        const pad = PAD_KEYS.indexOf(key)
        void engine.triggerPad(track.id, pad)
        recordHit({ trackId: track.id, pad, velocity: 100 })
        return
      }
      if (s.prefs.keysToPads && !event.altKey && (track?.kind === 'acid' || track?.kind === 'wave') && sel.kind !== 'step') {
        if (is('octave.down')) return void (octave = Math.max(0, octave - 1), toast(`Keyboard octave C${octave}`))
        if (is('octave.up')) return void (octave = Math.min(7, octave + 1), toast(`Keyboard octave C${octave}`))
        if (key in NOTE_KEYS && !heldNotes.has(key)) {
          event.preventDefault()
          heldNotes.add(key)
          playNote((octave + 1) * 12 + NOTE_KEYS[key])
          return
        }
      }
      const viewKey = (['arrange', 'build', 'mix', 'perform'] as View[]).find((v) => is(`view.${v}`))
      if (viewKey) return setView(viewKey)
      if (is('record')) {
        const recording = !s.recording
        setState({ recording })
        if (!recording) commitSceneRecording()
        return
      }
      if (is('help')) return setState({ helpOpen: true })
      if (is('loop')) {
        const section = sel.kind === 'section' ? s.project.sections.find((x) => x.id === sel.sectionId) : null
        engine.setLoop(s.transport.loop ? null : section ? [section.start, section.start + section.length] : [0, s.project.length])
        return
      }
      if (event.key === 'Home') return engine.seek(0)
      if (event.key === 'Escape') return select({ kind: 'none' })
      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault()
        if (sel.kind === 'clip' && clip) {
          dispatch({ type: 'clip.delete', params: { clipId: clip.id } }, { label: 'Delete clip' })
          select({ kind: 'none' })
        } else if (sel.kind === 'step' && clip?.patternId) {
          const pattern = s.project.patterns[clip.patternId]
          if (pattern?.kind === 'notes') dispatch({ type: 'step.set', params: { patternId: pattern.id, index: sel.index, on: false } }, { label: 'Clear step' })
          else if (pattern?.kind === 'drums' && sel.voice) dispatch({ type: 'drum.step.set', params: { patternId: pattern.id, voice: sel.voice, index: sel.index, on: false } }, { label: 'Clear hit' })
        } else if (sel.kind === 'slice' && sel.index !== null && sel.index > 0) {
          const t = s.project.tracks.find((x) => x.id === sel.trackId)
          if (t?.device.kind === 'sampler' && t.device.source) {
            const slices = t.device.source.slices.filter((_, i) => i !== sel.index)
            dispatch({ type: 'sample.slice', params: { trackId: t.id, slices, mode: 'manual' } }, { label: 'Remove slice marker' })
            select({ kind: 'slice', trackId: t.id, index: null })
          }
        } else if (sel.kind === 'section') {
          dispatch({ type: 'section.remove', params: { sectionId: sel.sectionId } }, { label: 'Remove section marker' })
          select({ kind: 'none' })
        }
        return
      }
      if (event.key.startsWith('Arrow')) {
        const dir = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1
        const horizontal = event.key === 'ArrowLeft' || event.key === 'ArrowRight'
        if (sel.kind === 'step' && clip?.patternId && horizontal) {
          const pattern = s.project.patterns[clip.patternId]
          event.preventDefault()
          select({ ...sel, index: (sel.index + dir + pattern.length) % pattern.length })
          return
        }
        if (sel.kind === 'clip' && clip) {
          event.preventDefault()
          if (horizontal && event.altKey) dispatch({ type: 'clip.move', params: { clipId: clip.id, start: Math.max(0, clip.start + dir) } }, { label: 'Nudge clip', key: `nudge-${clip.id}` })
          else if (horizontal && event.shiftKey) dispatch({ type: 'clip.resize', params: { clipId: clip.id, length: Math.max(0.25, clip.length + dir) } }, { label: 'Resize clip', key: `size-${clip.id}` })
          else if (horizontal) {
            const row = s.project.clips.filter((c) => c.trackId === clip.trackId).sort((a, b) => a.start - b.start)
            const next = row[row.indexOf(clip) + dir]
            if (next) select({ kind: 'clip', clipId: next.id })
          } else {
            const index = s.project.tracks.findIndex((t) => t.id === clip.trackId) + dir
            const target = s.project.tracks[index]
            if (!target) return
            const candidates = s.project.clips.filter((c) => c.trackId === target.id).sort((a, b) => Math.abs(a.start - clip.start) - Math.abs(b.start - clip.start))
            if (candidates[0]) select({ kind: 'clip', clipId: candidates[0].id })
            else select({ kind: 'track', trackId: target.id })
          }
          return
        }
        if (sel.kind === 'track' && !horizontal) {
          event.preventDefault()
          const index = s.project.tracks.findIndex((t) => t.id === sel.trackId) + dir
          const target = s.project.tracks[index]
          if (target) select({ kind: 'track', trackId: target.id })
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [])

  const onDrop = async (event: DragEvent<HTMLDivElement>) => {
    setDragging(false)
    if (event.defaultPrevented) return
    const files = [...event.dataTransfer.files]
    if (!files.length) return
    event.preventDefault()
    const project = files.find((f) => /\.(json|rb338)$/i.test(f.name))
    if (project) return void importProjectFile(project)
    for (const file of files) await importAudioFile(file)
    toast(`Imported ${files.length} file${files.length === 1 ? '' : 's'} into the project. Drag them from Samples onto a lane.`, 'success')
  }

  const browserDocked = prefs.browserOpen && wide
  const inspectorDocked = prefs.inspectorOpen && wide
  return (
    <div
      className={`app${agentOpen ? ' with-agent' : ''}${dragging ? ' is-dragging' : ''}`}
      style={{ gridTemplateColumns: `${browserDocked ? 'clamp(260px, 19vw, 320px)' : '44px'} minmax(0, 1fr) ${inspectorDocked ? 'clamp(300px, 24vw, 360px)' : '0px'}` }}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes('Files')) {
          event.preventDefault()
          setDragging(true)
        }
      }}
      onDragLeave={(event) => event.currentTarget === event.target && setDragging(false)}
      onDrop={(event) => void onDrop(event)}
    >
      <Transport />
      <Browser open={prefs.browserOpen} overlay={!wide} onToggle={() => setPrefs({ browserOpen: !prefs.browserOpen, ...(!wide && !prefs.browserOpen ? { inspectorOpen: false } : {}) })} />
      <main className="workspace" data-region="workspace" tabIndex={-1}>
        <div className="view-bar">
          <div className="view-tabs" role="tablist" aria-label="Views">
            {VIEWS.map((v, i) => (
              <button key={v.id} type="button" role="tab" aria-selected={view === v.id} className={view === v.id ? 'is-on' : ''} onClick={() => setView(v.id)}>
                {v.label}
                <kbd>{i + 1}</kbd>
              </button>
            ))}
          </div>
          <div className="view-bar-right">
            {!prefs.inspectorOpen && (
              <button type="button" className="icon-btn" onClick={() => setPrefs({ inspectorOpen: true, ...(!wide ? { browserOpen: false } : {}) })} aria-label="Open inspector" title="Open inspector">
                <PanelRight size={16} />
              </button>
            )}
            {!wide && (
              <button type="button" className="icon-btn" onClick={() => setPrefs({ browserOpen: !prefs.browserOpen })} aria-label="Toggle browser">
                <PanelLeft size={16} />
              </button>
            )}
          </div>
        </div>
        <div className="canvas">
          <Suspense fallback={<div className="view-loading">Loading…</div>}>
            {view === 'arrange' && <Arrange />}
            {view === 'build' && <Build />}
            {view === 'mix' && <Mix />}
            {view === 'perform' && <Perform />}
          </Suspense>
        </div>
        {view !== 'perform' && <Dock />}
      </main>
      {prefs.inspectorOpen && <Inspector overlay={!wide} onClose={() => setPrefs({ inspectorOpen: false })} />}
      {!wide && (prefs.browserOpen || prefs.inspectorOpen) && <div className="scrim" onClick={() => setPrefs({ browserOpen: false, inspectorOpen: false })} />}
      <StatusBar />
      <Suspense fallback={null}>
        {agentOpen && <AgentPanel />}
        {paletteOpen && <Palette onClose={() => setState({ paletteOpen: false })} />}
        {helpOpen && <Help />}
      </Suspense>
      <ImportNotice />
      <MidiLearnBar />
      <Toasts />
      {dragging && <div className="drop-overlay">Drop audio to import it, or a project file to open it</div>}
    </div>
  )
}

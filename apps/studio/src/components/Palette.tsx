import { CornerDownLeft, Search, Sparkles } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { studio } from '@reborn/studio-core'
import { ask } from '../agent/agent'
import { runAnalysis } from '../audio/analysis'
import { exportAudio } from '../audio/export'
import { engine, togglePlay } from '../audio/host'
import { newProject, openProject, saveProject } from '../state/persistence'
import { type View, dispatch, getState, redo, select, setPrefs, setState, setView, undo } from '../state/store'
import { desktop } from '../platform/desktop'
import { addTrack } from './AddTrackMenu'

interface Action {
  id: string
  label: string
  hint?: string
  run: () => void
}

function actions(): Action[] {
  const s = getState()
  const list: Action[] = [
    ...(['arrange', 'build', 'mix', 'perform'] as View[]).map((view, i) => ({ id: `view-${view}`, label: `Go to ${view[0].toUpperCase()}${view.slice(1)}`, hint: String(i + 1), run: () => setView(view) })),
    { id: 'play', label: s.transport.playing ? 'Pause' : 'Play', hint: 'Space', run: () => void togglePlay() },
    { id: 'stop', label: 'Stop and return to start', run: () => engine.stop() },
    { id: 'record', label: s.recording ? 'Disarm recording' : 'Arm recording', hint: 'R', run: () => setState({ recording: !s.recording }) },
    { id: 'undo', label: 'Undo', hint: 'Ctrl Z', run: undo },
    { id: 'redo', label: 'Redo', hint: 'Ctrl Shift Z', run: redo },
    { id: 'insert', label: `Insert 8 bars at bar ${Math.floor(engine.position()) + 1}`, run: () => dispatch({ type: 'time.insert', params: { at: Math.floor(engine.position()), bars: 8, name: 'New 8' } }, { label: 'Insert 8 bars' }) },
    { id: 'delete-time', label: `Delete 4 bars at bar ${Math.floor(engine.position()) + 1}`, run: () => dispatch({ type: 'time.delete', params: { at: Math.floor(engine.position()), bars: 4 } }, { label: 'Delete 4 bars' }) },
    ...(['acid', 'wave', 'drum', 'sampler', 'audio', 'deck', 'group'] as studio.TrackKind[]).map((kind) => ({ id: `add-${kind}`, label: `Add ${studio.DEVICE_NAMES[kind]} track`, run: () => addTrack(kind) })),
    { id: 'analyze', label: 'Analyze the mix', run: () => { setView('mix'); void runAnalysis() } },
    { id: 'trace', label: 'Why can I hear echo? (signal trace)', run: () => { setView('mix'); select({ kind: 'return', returnId: s.project.returns[0]?.id ?? 'delay' }) } },
    { id: 'bypass', label: s.project.master.fxSafeBypass ? 'Turn off FX Safe Bypass' : 'Turn on FX Safe Bypass', run: () => dispatch({ type: 'master.set', params: { fxSafeBypass: !s.project.master.fxSafeBypass } }, { label: 'FX Safe Bypass' }) },
    { id: 'export', label: 'Export WAV (16-bit)', run: () => void exportAudio({ kind: 'mix', bitDepth: 16, range: 'song' }) },
    { id: 'stems', label: 'Export stems (24-bit)', run: () => void exportAudio({ kind: 'stems', bitDepth: 24, range: 'song' }) },
    { id: 'new', label: 'New project', run: newProject },
    { id: 'save', label: desktop ? 'Save project' : 'Download project file', hint: 'Ctrl S', run: () => void saveProject(false) },
    ...(desktop ? [{ id: 'open', label: 'Open project folder…', run: () => void openProject() }] : []),
    { id: 'density', label: `Density: ${s.prefs.density === 'compact' ? 'normal' : s.prefs.density === 'normal' ? 'large' : 'compact'}`, run: () => setPrefs({ density: s.prefs.density === 'compact' ? 'normal' : s.prefs.density === 'normal' ? 'large' : 'compact' }) },
    { id: 'contrast', label: s.prefs.contrast === 'high' ? 'Standard contrast' : 'High contrast', run: () => setPrefs({ contrast: s.prefs.contrast === 'high' ? 'normal' : 'high' }) },
    { id: 'help', label: 'Help and shortcuts', hint: 'F1', run: () => setState({ helpOpen: true }) },
  ]
  const sel = s.selection
  if (sel.kind === 'clip') {
    list.push({ id: 'unique', label: 'Make selected clip unique', run: () => dispatch({ type: 'clip.makeUnique', params: { clipId: sel.clipId } }, { label: 'Make unique' }) })
    list.push({ id: 'dup', label: 'Duplicate selected clip', hint: 'Ctrl D', run: () => dispatch({ type: 'clip.duplicate', params: { clipId: sel.clipId } }, { label: 'Duplicate clip' }) })
  }
  return list
}

export function Palette({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => inputRef.current?.focus(), [])
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    const all = actions()
    return q ? all.filter((a) => a.label.toLowerCase().includes(q)) : all
  }, [query])
  const items = [...matches.map((a) => ({ kind: 'action' as const, action: a })), ...(query.trim() ? [{ kind: 'agent' as const, text: query.trim() }] : [])]
  const run = (index: number) => {
    const item = items[index]
    if (!item) return
    onClose()
    if (item.kind === 'action') item.action.run()
    else {
      setState({ agentOpen: true })
      void ask(item.text)
    }
  }
  return (
    <div className="palette-backdrop" onPointerDown={onClose}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette" onPointerDown={(event) => event.stopPropagation()}>
        <div className="palette-input">
          <Search size={16} />
          <input
            ref={inputRef}
            value={query}
            placeholder="Type a command, or ask the agent…"
            aria-label="Command or agent request"
            onChange={(event) => {
              setQuery(event.target.value)
              setActive(0)
            }}
            onKeyDown={(event) => {
              event.stopPropagation()
              if (event.key === 'Escape') onClose()
              else if (event.key === 'ArrowDown') setActive((a) => Math.min(items.length - 1, a + 1))
              else if (event.key === 'ArrowUp') setActive((a) => Math.max(0, a - 1))
              else if (event.key === 'Enter') run(active)
              else return
              event.preventDefault()
            }}
          />
          <kbd>Esc</kbd>
        </div>
        <ul className="palette-list" role="listbox">
          {items.map((item, i) => (
            <li key={item.kind === 'action' ? item.action.id : 'agent'} role="option" aria-selected={i === active} className={`${i === active ? 'is-active' : ''} ${item.kind}`} onPointerEnter={() => setActive(i)} onClick={() => run(i)}>
              {item.kind === 'action' ? (
                <>
                  <span>{item.action.label}</span>
                  {item.action.hint && <kbd>{item.action.hint}</kbd>}
                </>
              ) : (
                <>
                  <Sparkles size={14} />
                  <span>
                    Ask the agent: <b>{item.text}</b>
                  </span>
                  <CornerDownLeft size={13} />
                </>
              )}
            </li>
          ))}
        </ul>
        <footer className="palette-foot">Everything here runs the same undoable commands as the mouse, the CLI, and the agent.</footer>
      </div>
    </div>
  )
}

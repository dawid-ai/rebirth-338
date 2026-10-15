import { CornerDownLeft, Search, Sparkles } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { clipById, makeUnique } from '../model'
import { type Studio, type View, useStudio } from '../studio'

interface Command {
  id: string
  label: string
  hint?: string
  run: (studio: Studio) => void
}

const VIEWS: { id: View; label: string; key: string }[] = [
  { id: 'arrange', label: 'Arrange', key: '1' },
  { id: 'build', label: 'Build', key: '2' },
  { id: 'mix', label: 'Mix', key: '3' },
  { id: 'perform', label: 'Perform', key: '4' },
]

function commands(studio: Studio): Command[] {
  const list: Command[] = VIEWS.map((v) => ({ id: `view-${v.id}`, label: `Go to ${v.label}`, hint: v.key, run: (s) => s.setView(v.id) }))
  list.push({
    id: 'trace',
    label: 'Trace echo sources',
    hint: 'Mix',
    run: (s) => {
      s.setView('mix')
      s.setTrace(['delay', 'reverb'])
    },
  })
  list.push({
    id: 'bypass',
    label: studio.project.fxSafeBypass ? 'Turn off FX Safe Bypass' : 'Turn on FX Safe Bypass',
    run: (s) => s.commit('Toggle FX Safe Bypass', (p) => ({ ...p, fxSafeBypass: !p.fxSafeBypass })),
  })
  const sel = studio.selection
  if (sel.kind === 'clip' || sel.kind === 'step') {
    const clip = clipById(studio.project, sel.clipId)
    if (clip) {
      list.push({
        id: 'unique',
        label: 'Make selected clip unique',
        run: (s) => {
          const result = makeUnique(s.project, clip.id)
          s.commit('Make clip unique', () => result.project)
          s.markTask('unique')
        },
      })
    }
  }
  return list
}

const SUGGESTIONS = ['Why is there echo in the drop?', 'Clean up the delay wash in the drop']

export function Palette({ onClose }: { onClose: () => void }) {
  const studio = useStudio()
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const logRef = useRef<HTMLDivElement>(null)

  useEffect(() => inputRef.current?.focus(), [])
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [studio.messages.length, studio.agentBusy])

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    const all = commands(studio)
    return q ? all.filter((c) => c.label.toLowerCase().includes(q)) : all
  }, [query, studio])

  const items = [...matches.map((c) => ({ kind: 'command' as const, command: c })), ...(query.trim() ? [{ kind: 'agent' as const, text: query.trim() }] : SUGGESTIONS.map((text) => ({ kind: 'agent' as const, text })))]

  const run = (index: number) => {
    const item = items[index]
    if (!item) return
    if (item.kind === 'command') {
      item.command.run(studio)
      onClose()
    } else {
      studio.askAgent(item.text)
      setQuery('')
      setActive(0)
    }
  }

  return (
    <div className="palette-backdrop" onPointerDown={onClose}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette and agent" onPointerDown={(event) => event.stopPropagation()}>
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
            <li key={item.kind === 'command' ? item.command.id : `agent-${item.text}`} role="option" aria-selected={i === active} className={`${i === active ? 'is-active' : ''} ${item.kind}`} onPointerEnter={() => setActive(i)} onClick={() => run(i)}>
              {item.kind === 'command' ? (
                <>
                  <span>{item.command.label}</span>
                  {item.command.hint && <kbd>{item.command.hint}</kbd>}
                </>
              ) : (
                <>
                  <Sparkles size={14} />
                  <span>
                    Ask agent: <b>{item.text}</b>
                  </span>
                  <CornerDownLeft size={13} />
                </>
              )}
            </li>
          ))}
        </ul>
        {(studio.messages.length > 0 || studio.agentBusy) && (
          <div className="agent-log" ref={logRef} aria-live="polite">
            {studio.messages.map((m, i) => (
              <p key={i} className={m.role}>
                <span>{m.role === 'agent' ? 'Agent' : 'You'}</span>
                {m.text}
              </p>
            ))}
            {studio.agentBusy && (
              <p className="agent thinking">
                <span>Agent</span>Reading the project and tracing both returns…
              </p>
            )}
          </div>
        )}
        <footer className="palette-foot">
          The agent uses the same undoable commands as you. Nothing changes until you apply a proposal. Prototype: the agent response is scripted.
        </footer>
      </div>
    </div>
  )
}

import { Check, Search, X } from 'lucide-react'
import { useState } from 'react'
import { DEFAULT_SHORTCUTS, getState, setPrefs, setState, useStudio } from '../state/store'

// Help: contextual tips for the current view, a first-run checklist, a
// searchable guide, and the shortcut map (remappable).

export const ONBOARDING = [
  { id: 'play', label: 'Press Space to hear the starter beat' },
  { id: 'step', label: 'Click the Acid clip and change a step in the dock' },
  { id: 'clip', label: 'Double-click an empty lane to create a clip' },
  { id: 'chop', label: 'Drag a break from Samples onto the Sampler lane' },
  { id: 'mix', label: 'Open Mix (3) and analyze the mix' },
  { id: 'export', label: 'Export a WAV' },
]

export function completeOnboarding(id: string) {
  const done = getState().prefs.onboardingDone
  if (!done.includes(id)) setPrefs({ onboardingDone: [...done, id] })
}

const GUIDE: { title: string; body: string; tags: string }[] = [
  { title: 'The layout', body: 'The transport stays on top and the song stays visible. Selecting anything (a track, clip, step, section, pad, or channel) changes the inspector on the right and the editor in the dock below. Views change only the center: Arrange (1), Build (2), Mix (3), Perform (4).', tags: 'shell inspector dock views' },
  { title: 'Patterns and clips', body: 'A pattern stores notes or hits. A clip places a pattern on the timeline. Repeats share their pattern (linked) until you use Make unique. Patterns can be 1–64 steps with their own step size, so polymeters are possible.', tags: 'clip pattern linked unique length' },
  { title: 'Arranging', body: 'Drag clips to move them (Shift for quarter bars, Alt to copy as a linked repeat), drag the right edge to resize, and double-click an empty lane to create one. Hover a section boundary and click +8 to insert eight bars; later material moves right and nothing is appended to the end.', tags: 'arrange insert time sections move resize' },
  { title: 'Automation and locks', body: 'Open a track’s lanes with the arrow in its header and add a lane for any parameter. Click to add points, drag to move, Alt-click to remove. With record armed, turning macros while playing writes automation. Select a step and hold Alt while turning a knob to lock a value to that step. Locks win over automation, which wins over the device value.', tags: 'automation lock lanes record macros' },
  { title: 'Sampling', body: 'Drop a break on a Sampler lane. Tempo, key, and transients are detected with a confidence score you can correct. Choose Transient, Equal, Beat, or Bar slicing, drag markers, and send slices to pads. Arm record, press Space, and play pads with M , . / J K L ; U I O P 7 8 9 0 to record a take into a new clip.', tags: 'sampler chop slice pads record break' },
  { title: 'Mixing and diagnostics', body: 'Every track has EQ, a DJ filter, and drive inserts, a fader and pan, and sends to the shared Delay and Plate returns. Pre-fader sends ignore mute — the usual reason echo is still audible. The signal trace in Mix lists every path into each return. Analyze renders the song and measures loudness, true peak, and band balance per section.', tags: 'mix send return trace echo analyze loudness' },
  { title: 'The agent', body: 'The agent reads the project, measures before judging the mix, and proposes changes. Proposals appear in the inspector with ghost values on the controls they touch. Preview, then apply all, apply some, or reject. Applying is one undo step labeled Agent.', tags: 'agent proposal claude preview' },
  { title: 'CLI and MCP', body: 'With the desktop app running, the reborn command can read and edit the open project (for example, reborn pattern write 808.kick "X...X...X...X..."). reborn mcp connects external agents; their edits arrive as proposals unless you allow direct edits.', tags: 'cli mcp api reborn command' },
  { title: 'Saving', body: 'The desktop edition saves .reborn folders with their audio, never rewriting unchanged samples, and Pack Project makes one shareable file. Unsaved work is recovered after a crash. The browser edition autosaves locally and downloads project files.', tags: 'save open pack recover' },
]

const VIEW_TIPS: Record<string, string> = {
  arrange: 'Arrange: tracks run down, time runs across. Select a clip to edit it in the dock; select a section to insert or delete time.',
  build: 'Build: pick a pattern per track in each scene column, then launch scenes. They start on the next bar. Arm record to write launches into the arrangement.',
  mix: 'Mix: select a strip to see its full signal path in the inspector. Use Analyze for measurements and the trace to find unexpected echo.',
  perform: 'Perform: big targets for playing live. With record armed, every move here becomes automation.',
}

function ShortcutRow({ action, keys }: { action: string; keys: string }) {
  const [listening, setListening] = useState(false)
  return (
    <li>
      <span>{action.replace('.', ' ')}</span>
      <button
        type="button"
        className={`kbd-btn${listening ? ' is-on' : ''}`}
        onClick={() => setListening(true)}
        onKeyDown={(event) => {
          if (!listening) return
          event.preventDefault()
          event.stopPropagation()
          if (event.key === 'Escape') return setListening(false)
          const combo = [event.ctrlKey || event.metaKey ? 'Ctrl' : '', event.shiftKey && event.key.length > 1 ? 'Shift' : '', event.altKey ? 'Alt' : '', event.key === ' ' ? 'Space' : event.key.length === 1 ? event.key.toUpperCase() : event.key].filter(Boolean).join('+')
          setPrefs({ shortcuts: { ...getState().prefs.shortcuts, [action]: combo } })
          setListening(false)
        }}
        onBlur={() => setListening(false)}
        aria-label={`Shortcut for ${action}: ${keys}. Activate, then press a new key.`}
      >
        {listening ? 'Press a key…' : keys}
      </button>
    </li>
  )
}

export function Help() {
  const view = useStudio((s) => s.view)
  const done = useStudio((s) => s.prefs.onboardingDone)
  const shortcuts = useStudio((s) => s.prefs.shortcuts)
  const [query, setQuery] = useState('')
  const results = GUIDE.filter((g) => !query || `${g.title} ${g.body} ${g.tags}`.toLowerCase().includes(query.toLowerCase()))
  return (
    <div className="modal-backdrop" onPointerDown={() => setState({ helpOpen: false })}>
      <div className="modal help" role="dialog" aria-modal="true" aria-label="Help" onPointerDown={(event) => event.stopPropagation()}>
        <header>
          <h2>Help</h2>
          <button type="button" className="icon-btn" onClick={() => setState({ helpOpen: false })} aria-label="Close help">
            <X size={16} />
          </button>
        </header>
        <div className="help-body">
          <section>
            <p className="tip">{VIEW_TIPS[view]}</p>
            <h3>First beat</h3>
            <ol className="checklist">
              {ONBOARDING.map((task) => (
                <li key={task.id} className={done.includes(task.id) ? 'is-done' : ''}>
                  <span className="task-check">{done.includes(task.id) && <Check size={12} />}</span>
                  {task.label}
                </li>
              ))}
            </ol>
          </section>
          <section>
            <label className="help-search">
              <Search size={14} />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search the guide" aria-label="Search the guide" onKeyDown={(event) => event.stopPropagation()} />
            </label>
            <div className="guide">
              {results.map((g) => (
                <article key={g.title}>
                  <h4>{g.title}</h4>
                  <p>{g.body}</p>
                </article>
              ))}
              {!results.length && <p className="muted">No guide entries match.</p>}
            </div>
          </section>
          <section>
            <h3>Shortcuts</h3>
            <ul className="shortcut-list">
              {Object.entries(shortcuts).map(([action, keys]) => (
                <ShortcutRow key={action} action={action} keys={keys} />
              ))}
            </ul>
            <button type="button" className="chip-btn" onClick={() => setPrefs({ shortcuts: DEFAULT_SHORTCUTS })}>
              Reset shortcuts
            </button>
            <p className="muted small">Arrow keys move the selection; Alt+arrows nudge a clip, Shift+arrows resize it. F6 and Shift+F6 move between regions; Tab moves between controls. Computer keys play the selected instrument; pads use M , . / J K L ; U I O P 7 8 9 0.</p>
          </section>
        </div>
      </div>
    </div>
  )
}

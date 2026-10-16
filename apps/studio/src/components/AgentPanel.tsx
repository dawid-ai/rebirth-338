import { KeyRound, Send, ShieldCheck, Sparkles, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { AgentProvider } from '@reborn/studio-core'
import { ask, loadAgentSettings, updateAgentSettings, useAgent } from '../agent/agent'
import { desktop } from '../platform/desktop'
import { setState } from '../state/store'

const PROVIDERS: { id: AgentProvider; label: string; note: string }[] = [
  { id: 'claude-cli', label: 'Claude CLI', note: 'Uses your installed Claude Code login; it reaches RE:BORN through MCP.' },
  { id: 'anthropic', label: 'Claude API', note: 'Uses your Anthropic API key, stored in the OS credential store.' },
  { id: 'openai-compatible', label: 'Local or compatible', note: 'Ollama, LM Studio, or any OpenAI-compatible server.' },
]

function Settings() {
  const settings = useAgent((s) => s.settings)
  const [key, setKey] = useState('')
  if (!settings) return null
  const provider = PROVIDERS.find((p) => p.id === settings.provider)!
  const cloud = settings.provider !== 'openai-compatible' || !/^https?:\/\/(localhost|127\.0\.0\.1)/i.test(settings.baseUrl)
  return (
    <div className="agent-settings">
      <div className="seg sm" role="radiogroup" aria-label="Agent provider">
        {PROVIDERS.map((p) => (
          <button key={p.id} type="button" role="radio" aria-checked={settings.provider === p.id} className={settings.provider === p.id ? 'is-on' : ''} onClick={() => void updateAgentSettings({ provider: p.id, model: p.id === 'anthropic' ? 'claude-sonnet-5-5' : p.id === 'openai-compatible' ? 'llama3.1' : '' })}>
            {p.label}
          </button>
        ))}
      </div>
      <p className="muted small">{provider.note}</p>
      {settings.provider === 'claude-cli' && !settings.cliAvailable && <p className="warn small">The claude command was not found on this computer.</p>}
      {settings.provider !== 'claude-cli' && (
        <label className="field">
          <span className="field-label">Model</span>
          <input type="text" defaultValue={settings.model} key={settings.provider} onKeyDown={(event) => event.stopPropagation()} onBlur={(event) => void updateAgentSettings({ model: event.target.value.trim() })} />
        </label>
      )}
      {settings.provider === 'openai-compatible' && (
        <label className="field">
          <span className="field-label">Server URL</span>
          <input type="text" defaultValue={settings.baseUrl} onKeyDown={(event) => event.stopPropagation()} onBlur={(event) => void updateAgentSettings({ baseUrl: event.target.value.trim() })} />
        </label>
      )}
      {settings.provider !== 'claude-cli' && (
        <div className="key-row">
          <KeyRound size={13} />
          <input type="password" placeholder={settings.hasKey ? 'Key stored — type to replace' : 'API key'} value={key} onChange={(event) => setKey(event.target.value)} onKeyDown={(event) => event.stopPropagation()} aria-label="API key" />
          <button type="button" className="chip-btn" disabled={!key} onClick={() => void updateAgentSettings({ apiKey: key }).then(() => setKey(''))}>
            Save key
          </button>
          {settings.hasKey && (
            <button type="button" className="chip-btn" onClick={() => void updateAgentSettings({ apiKey: null })}>
              Forget
            </button>
          )}
        </div>
      )}
      <label className="check">
        <input type="checkbox" checked={settings.shareMeasurements} onChange={(event) => void updateAgentSettings({ shareMeasurements: event.target.checked })} />
        Share measurements (loudness, band energy, warnings) with {cloud ? 'this cloud provider' : 'this local server'}
      </label>
      <label className="check">
        <input type="checkbox" checked={settings.directEdits} onChange={(event) => void updateAgentSettings({ directEdits: event.target.checked })} />
        Let the agent edit directly instead of proposing (each edit is still one undo step)
      </label>
      <p className="disclosure">
        <ShieldCheck size={12} />
        {cloud ? 'Sent to the provider: track names, patterns, mixer settings' : 'Stays on this computer'}
        {cloud && settings.shareMeasurements ? ', and measurement numbers' : ''}. Raw audio never leaves this computer.
      </p>
    </div>
  )
}

export function AgentPanel() {
  const lines = useAgent((s) => s.lines)
  const busy = useAgent((s) => s.busy)
  const [draft, setDraft] = useState('')
  const [showSettings, setShowSettings] = useState(false)
  const log = useRef<HTMLDivElement>(null)
  useEffect(() => {
    void loadAgentSettings()
  }, [])
  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight })
  }, [lines.length, busy])
  return (
    <aside className="agent-panel" aria-label="Agent">
      <header>
        <Sparkles size={15} />
        <strong>Agent</strong>
        {desktop && (
          <button type="button" className={`chip-btn${showSettings ? ' is-on' : ''}`} onClick={() => setShowSettings(!showSettings)}>
            Settings
          </button>
        )}
        <button type="button" className="icon-btn" aria-label="Close agent" onClick={() => setState({ agentOpen: false })}>
          <X size={16} />
        </button>
      </header>
      {showSettings && <Settings />}
      <div className="agent-log" ref={log} aria-live="polite">
        {!lines.length && (
          <div className="agent-empty">
            <p>Ask for help with the song. The agent reads the project, measures the mix before judging it, and proposes changes you review on the timeline and mixer.</p>
            {['Why is there echo in the drop?', 'Make the drop hit harder without clipping', 'Write a 16-step acid line in A minor on Acid 1', 'Add an 8-bar breakdown before the last section'].map((example) => (
              <button key={example} type="button" className="chip-btn" onClick={() => void ask(example)}>
                {example}
              </button>
            ))}
          </div>
        )}
        {lines.map((line, i) => (
          <p key={i} className={line.role}>
            <span>{line.role === 'agent' ? 'Agent' : line.role === 'user' ? 'You' : '·'}</span>
            {line.text}
          </p>
        ))}
        {busy && (
          <p className="agent thinking">
            <span>Agent</span>Working…
          </p>
        )}
      </div>
      <form
        className="agent-input"
        onSubmit={(event) => {
          event.preventDefault()
          void ask(draft)
          setDraft('')
        }}
      >
        <textarea value={draft} rows={2} placeholder="Ask the agent…" aria-label="Message the agent" onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => {
          event.stopPropagation()
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            void ask(draft)
            setDraft('')
          }
        }} />
        <button type="submit" className="icon-btn" disabled={busy || !draft.trim()} aria-label="Send">
          <Send size={16} />
        </button>
      </form>
    </aside>
  )
}

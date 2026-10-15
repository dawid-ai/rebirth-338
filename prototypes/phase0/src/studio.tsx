import { createContext, useCallback, useContext, useMemo, useReducer, useRef, useState } from 'react'
import { demoProject } from './demo'
import { type BusId, type Origin, type Project, type Proposal, applyChanges, clipById, proposeEchoCleanup } from './model'

export type View = 'arrange' | 'build' | 'mix' | 'perform'

export type Selection =
  | { kind: 'none' }
  | { kind: 'track'; trackId: string }
  | { kind: 'clip'; clipId: string }
  | { kind: 'step'; clipId: string; index: number }
  | { kind: 'section'; sectionId: string }
  | { kind: 'sample'; slice: number | null }
  | { kind: 'return'; bus: BusId }

export type TaskId = 'pattern' | 'insert' | 'unique' | 'echo' | 'pads' | 'agent'

export const TASKS: { id: TaskId; label: string; hint: string }[] = [
  { id: 'pattern', label: 'Create and edit a bass pattern without scrolling', hint: 'Double-click an empty spot on an Acid lane, then click steps in the dock.' },
  { id: 'insert', label: 'Insert eight bars between two sections', hint: 'Select a section in the ruler and use Insert 8 bars, or hover a section boundary.' },
  { id: 'unique', label: 'Make one repeated clip unique', hint: 'Select a clip with a link badge and use Make unique.' },
  { id: 'echo', label: 'Find the source of audible echo', hint: 'Open Mix (3), then use Why can I hear echo? in the dock.' },
  { id: 'pads', label: 'Chop a break and record a four-bar pad performance', hint: 'Drag a break onto Sampler, press R to arm, Space to play, then play pads (M , . / J K L ; …).' },
  { id: 'agent', label: 'Preview and partially accept an agent change', hint: 'Press Ctrl+K, ask about the echo, then apply only some changes.' },
]

export interface HistoryEntry {
  label: string
  origin: Origin
  before: Project
  after: Project
  at: number
  key?: string
}

export interface AgentMessage {
  role: 'user' | 'agent'
  text: string
}

interface CommitOptions {
  origin?: Origin
  key?: string
}

interface HistoryState {
  project: Project
  past: HistoryEntry[]
  future: HistoryEntry[]
}

type HistoryAction =
  | { type: 'commit'; label: string; change: (p: Project) => Project; options: CommitOptions; at: number }
  | { type: 'undo' }
  | { type: 'redo' }

function historyReducer(state: HistoryState, action: HistoryAction): HistoryState {
  if (action.type === 'undo') {
    const last = state.past[state.past.length - 1]
    if (!last) return state
    return { project: last.before, past: state.past.slice(0, -1), future: [...state.future, last] }
  }
  if (action.type === 'redo') {
    const next = state.future[state.future.length - 1]
    if (!next) return state
    return { project: next.after, past: [...state.past, { ...next, key: undefined }], future: state.future.slice(0, -1) }
  }
  const before = state.project
  const after = action.change(before)
  if (after === before) return state
  const last = state.past[state.past.length - 1]
  const { key, origin = 'manual' } = action.options
  if (key && last?.key === key && action.at - last.at < 1200) {
    return { project: after, past: [...state.past.slice(0, -1), { ...last, after, at: action.at }], future: [] }
  }
  return { project: after, past: [...state.past.slice(-99), { label: action.label, origin, before, after, at: action.at, key }], future: [] }
}

export function useStudioState() {
  const [history, dispatch] = useReducer(historyReducer, undefined, () => ({ project: demoProject(), past: [], future: [] }))
  const { project, past, future } = history
  const [view, setView] = useState<View>('arrange')
  const [selection, setSelection] = useState<Selection>({ kind: 'none' })
  const [tasks, setTasks] = useState<Set<TaskId>>(() => new Set())
  const [proposal, setProposal] = useState<Proposal | null>(null)
  const [picks, setPicks] = useState<Set<string>>(() => new Set())
  const [previewOn, setPreviewOn] = useState(false)
  const [agentBusy, setAgentBusy] = useState(false)
  const [messages, setMessages] = useState<AgentMessage[]>([])
  const [recordArmed, setRecordArmed] = useState(false)
  const [loopOn, setLoopOn] = useState(false)
  const [keysToPads, setKeysToPads] = useState(true)
  const [lastPad, setLastPad] = useState<{ pad: number; at: number } | null>(null)
  const [trace, setTrace] = useState<BusId[] | null>(null)
  const projectRef = useRef(project)
  projectRef.current = project

  const commit = useCallback((label: string, change: (p: Project) => Project, options: CommitOptions = {}) => {
    dispatch({ type: 'commit', label, change, options, at: Date.now() })
  }, [])
  const undo = useCallback(() => dispatch({ type: 'undo' }), [])
  const redo = useCallback(() => dispatch({ type: 'redo' }), [])

  const markTask = useCallback((id: TaskId) => {
    setTasks((current) => (current.has(id) ? current : new Set(current).add(id)))
  }, [])

  const select = useCallback((next: Selection) => setSelection(next), [])

  const askAgent = useCallback((request: string) => {
    setMessages((m) => [...m, { role: 'user', text: request }])
    setAgentBusy(true)
    window.setTimeout(() => {
      setAgentBusy(false)
      if (!/echo|delay|smear|drop|mix|mud|reverb|tail|wash/i.test(request)) {
        setMessages((m) => [
          ...m,
          { role: 'agent', text: 'This prototype only scripts the mix diagnosis. Try “Why is there echo in the drop?”' },
        ])
        return
      }
      const next = proposeEchoCleanup(projectRef.current, request)
      if (!next) {
        setMessages((m) => [...m, { role: 'agent', text: 'I traced both returns and found no unintended echo. No changes proposed.' }])
        return
      }
      setMessages((m) => [...m, { role: 'agent', text: `${next.intent} ${next.changes.length} changes are pending your review.` }])
      setProposal(next)
      setPicks(new Set(next.changes.map((c) => c.id)))
      setPreviewOn(true)
      setView('mix')
    }, 900)
  }, [])

  const togglePick = useCallback((id: string) => {
    setPicks((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const applyProposal = useCallback(() => {
    if (!proposal || picks.size === 0) return
    const chosen = proposal.changes.filter((c) => picks.has(c.id))
    commit(`Agent: ${chosen.map((c) => c.summary.toLowerCase()).join('; ')}`, (p) => applyChanges(p, proposal, picks), { origin: 'agent' })
    if (picks.size < proposal.changes.length) markTask('agent')
    setMessages((m) => [
      ...m,
      { role: 'agent', text: `Applied ${chosen.length} of ${proposal.changes.length} changes as one undoable step.` },
    ])
    setProposal(null)
    setPreviewOn(false)
  }, [commit, markTask, picks, proposal])

  const rejectProposal = useCallback(() => {
    setMessages((m) => [...m, { role: 'agent', text: 'Proposal rejected. Nothing changed.' }])
    setProposal(null)
    setPreviewOn(false)
  }, [])

  const triggerPad = useCallback((pad: number) => setLastPad({ pad, at: performance.now() }), [])

  const preview = useMemo(
    () => (proposal && previewOn ? applyChanges(project, proposal, picks) : null),
    [picks, previewOn, project, proposal],
  )

  return {
    project,
    preview,
    commit,
    undo,
    redo,
    past,
    future,
    view,
    setView,
    selection,
    select,
    tasks,
    markTask,
    proposal,
    picks,
    togglePick,
    previewOn,
    setPreviewOn,
    applyProposal,
    rejectProposal,
    agentBusy,
    messages,
    askAgent,
    recordArmed,
    setRecordArmed,
    loopOn,
    setLoopOn,
    keysToPads,
    setKeysToPads,
    lastPad,
    triggerPad,
    trace,
    setTrace,
  }
}

export type Studio = ReturnType<typeof useStudioState>

export const StudioContext = createContext<Studio | null>(null)

export function useStudio() {
  const studio = useContext(StudioContext)
  if (!studio) throw new Error('useStudio needs a StudioContext provider.')
  return studio
}

// Resolves the track the current selection belongs to.
export function selectedTrackId(project: Project, selection: Selection): string | null {
  if (selection.kind === 'track') return selection.trackId
  if (selection.kind === 'clip' || selection.kind === 'step') return clipById(project, selection.clipId)?.trackId ?? null
  if (selection.kind === 'sample') return project.tracks.find((t) => t.kind === 'sampler')?.id ?? null
  return null
}

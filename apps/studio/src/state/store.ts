import { useSyncExternalStore } from 'react'
import { studio } from '@reborn/studio-core'
import type { TransportSnapshot } from '@reborn/audio-engine/studio'
import type { MidiProfiles, MidiTarget } from '../midi/midi'

type StudioProject = studio.StudioProject
type Command = studio.Command
type Origin = studio.Origin

// One store for the studio. Every project edit goes through `dispatch`,
// which runs the shared command registry, records undo history with its
// origin, and notifies the audio engine through a subscription.

export type View = 'arrange' | 'build' | 'mix' | 'perform'

export type Selection =
  | { kind: 'none' }
  | { kind: 'track'; trackId: string }
  | { kind: 'clip'; clipId: string }
  | { kind: 'step'; clipId: string; index: number; voice?: studio.DrumVoiceName }
  | { kind: 'section'; sectionId: string }
  | { kind: 'scene'; sceneId: string }
  | { kind: 'slice'; trackId: string; index: number | null }
  | { kind: 'pad'; trackId: string; pad: number }
  | { kind: 'return'; returnId: string }
  | { kind: 'master' }
  | { kind: 'lane'; trackId: string; param: string }

export interface HistoryEntry {
  label: string
  origin: Origin
  before: StudioProject
  after: StudioProject
  at: number
  key?: string
}

export interface ProposalChange {
  id: string
  summary: string
  detail: string
  commands: Command[]
}

export interface Proposal {
  id: string
  source: 'agent' | 'mcp'
  request: string
  intent: string
  evidence: string[]
  changes: ProposalChange[]
  status: 'pending' | 'applied' | 'partial' | 'rejected'
  createdAt: number
  /** Revision the proposal was built against. */
  revision: number
}

export interface Prefs {
  density: 'compact' | 'normal' | 'large'
  contrast: 'normal' | 'high'
  browserOpen: boolean
  inspectorOpen: boolean
  dockHeights: Record<string, number>
  keysToPads: boolean
  metronome: boolean
  shortcuts: Record<string, string>
  onboardingDone: string[]
  midiProfiles: MidiProfiles
  /** Audio device: sample rate (null follows the project) and latency. */
  audio: { sampleRate: number | null; latency: 'interactive' | 'balanced' | 'playback' }
}

export interface Toast {
  id: number
  text: string
  tone: 'info' | 'error' | 'success'
}

export interface Job {
  id: string
  label: string
  completed: number
  total: number
  status: 'running' | 'done' | 'failed' | 'cancelled'
  message?: string
  cancel?: () => void
}

export interface DocumentState {
  path: string | null
  savedRevision: number | null
}

export interface StudioState {
  project: StudioProject
  past: HistoryEntry[]
  future: HistoryEntry[]
  selection: Selection
  view: View
  prefs: Prefs
  proposals: Proposal[]
  previewProposal: string | null
  proposalPicks: Record<string, boolean>
  transport: TransportSnapshot
  toasts: Toast[]
  jobs: Job[]
  document: DocumentState
  recording: boolean
  paletteOpen: boolean
  agentOpen: boolean
  helpOpen: boolean
  /** Connected MIDI input names; null until MIDI access is granted. */
  midiInputs: string[] | null
  /** MIDI learn mode: the control picked on screen, waiting for a MIDI move. Null when off. */
  midiLearn: { target: MidiTarget | null } | null
}

export const DEFAULT_SHORTCUTS: Record<string, string> = {
  play: 'Space',
  record: 'R',
  palette: 'Ctrl+K',
  undo: 'Ctrl+Z',
  redo: 'Ctrl+Shift+Z',
  duplicate: 'Ctrl+D',
  delete: 'Delete',
  'view.arrange': '1',
  'view.build': '2',
  'view.mix': '3',
  'view.perform': '4',
  'octave.down': 'Z',
  'octave.up': 'X',
  save: 'Ctrl+S',
  help: 'F1',
  'region.next': 'F6',
  loop: 'L',
  split: 'Ctrl+E',
  'play.selection': 'Enter',
}

const PREFS_KEY = 'reborn.studio.prefs'

function loadPrefs(): Prefs {
  const defaults: Prefs = {
    density: 'normal',
    contrast: 'normal',
    browserOpen: typeof window !== 'undefined' ? window.innerWidth >= 1680 : true,
    inspectorOpen: true,
    dockHeights: {},
    keysToPads: true,
    metronome: false,
    shortcuts: DEFAULT_SHORTCUTS,
    onboardingDone: [],
    midiProfiles: {},
    audio: { sampleRate: null, latency: 'interactive' },
  }
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS_KEY) ?? 'null') as Partial<Prefs> | null
    return saved ? { ...defaults, ...saved, shortcuts: { ...DEFAULT_SHORTCUTS, ...(saved.shortcuts ?? {}) } } : defaults
  } catch {
    return defaults
  }
}

let state: StudioState = {
  project: studio.createDefaultStudioProject('New Beat'),
  past: [],
  future: [],
  selection: { kind: 'none' },
  view: 'arrange',
  prefs: loadPrefs(),
  proposals: [],
  previewProposal: null,
  proposalPicks: {},
  transport: { playing: false, bar: 0, loop: null, launchedSceneId: null, queuedSceneId: null },
  toasts: [],
  jobs: [],
  document: { path: null, savedRevision: 0 },
  recording: false,
  paletteOpen: false,
  agentOpen: false,
  helpOpen: false,
  midiInputs: null,
  midiLearn: null,
}

const listeners = new Set<() => void>()

export const getState = () => state

export function setState(update: Partial<StudioState> | ((current: StudioState) => Partial<StudioState>)): void {
  const patch = typeof update === 'function' ? update(state) : update
  state = { ...state, ...patch }
  if ('prefs' in patch) {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(state.prefs))
    } catch {
      // Private mode or storage disabled; prefs stay in memory.
    }
  }
  for (const listener of listeners) listener()
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Subscribes a component to a slice of state. Selectors must return stable values. */
export function useStudio<T>(selector: (s: StudioState) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state), () => selector(state))
}

let toastId = 0
export function toast(text: string, tone: Toast['tone'] = 'info'): void {
  const id = (toastId += 1)
  setState((s) => ({ toasts: [...s.toasts.slice(-3), { id, text, tone }] }))
  setTimeout(() => setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), tone === 'error' ? 6000 : 3200)
}

export interface DispatchOptions {
  label?: string
  origin?: Origin
  /** Consecutive dispatches with the same key within a second merge into one undo step. */
  key?: string
  /** Report errors as toasts instead of throwing. Defaults to true. */
  quiet?: boolean
}

/** Runs commands atomically, records undo, and returns command results. */
export function dispatch(commands: Command | Command[], options: DispatchOptions = {}): unknown[] | null {
  const list = Array.isArray(commands) ? commands : [commands]
  const before = state.project
  try {
    const outcome = studio.executeBatch(before, list, { origin: options.origin ?? 'manual', label: options.label })
    if (!outcome.changed) return outcome.results
    const now = Date.now()
    const label = options.label ?? describe(list)
    setState((s) => {
      const last = s.past[s.past.length - 1]
      const merge = options.key && last?.key === options.key && now - last.at < 1000
      const past = merge ? [...s.past.slice(0, -1), { ...last, after: outcome.project, at: now }] : [...s.past.slice(-199), { label, origin: options.origin ?? 'manual', before, after: outcome.project, at: now, key: options.key }]
      return { project: outcome.project, past, future: [] }
    })
    return outcome.results
  } catch (error) {
    if (options.quiet === false) throw error
    toast(error instanceof Error ? error.message : String(error), 'error')
    return null
  }
}

/** Replaces the whole project (open, new, import). Clears history. */
export function loadProject(project: StudioProject, document: DocumentState): void {
  setState({ project, past: [], future: [], selection: { kind: 'none' }, document, proposals: [], previewProposal: null })
}

export function undo(): void {
  const entry = state.past[state.past.length - 1]
  if (!entry) return
  setState((s) => ({ project: { ...entry.before, revision: s.project.revision + 1 }, past: s.past.slice(0, -1), future: [...s.future, entry] }))
  toast(`Undid ${entry.label}`)
}

export function redo(): void {
  const entry = state.future[state.future.length - 1]
  if (!entry) return
  setState((s) => ({ project: { ...entry.after, revision: s.project.revision + 1 }, future: s.future.slice(0, -1), past: [...s.past, { ...entry, key: undefined }] }))
  toast(`Redid ${entry.label}`)
}

export function select(selection: Selection): void {
  setState({ selection })
}

export function setView(view: View): void {
  setState({ view })
}

export function setPrefs(patch: Partial<Prefs>): void {
  setState((s) => ({ prefs: { ...s.prefs, ...patch } }))
}

export function upsertJob(job: Job): void {
  setState((s) => ({ jobs: [...s.jobs.filter((j) => j.id !== job.id), job] }))
  if (job.status !== 'running') setTimeout(() => setState((s) => ({ jobs: s.jobs.filter((j) => j.id !== job.id) })), 4000)
}

const LABELS: Record<string, string> = {
  'clip.create': 'Create clip',
  'clip.move': 'Move clip',
  'clip.resize': 'Resize clip',
  'clip.duplicate': 'Duplicate clip',
  'clip.delete': 'Delete clip',
  'clip.makeUnique': 'Make clip unique',
  'time.insert': 'Insert time',
  'time.delete': 'Delete time',
  'step.set': 'Edit step',
  'drum.step.set': 'Edit drum step',
  'parameter.set': 'Change parameter',
  'mixer.set': 'Change mixer',
  'send.set': 'Change send',
}

function describe(commands: Command[]): string {
  if (commands.length === 1) return LABELS[commands[0].type] ?? commands[0].type
  return `${commands.length} edits`
}

/** Selected track ID implied by the current selection. */
export function selectedTrackId(s: StudioState): string | null {
  const sel = s.selection
  if (sel.kind === 'track' || sel.kind === 'slice' || sel.kind === 'pad' || sel.kind === 'lane') return sel.trackId
  if (sel.kind === 'clip' || sel.kind === 'step') return s.project.clips.find((c) => c.id === sel.clipId)?.trackId ?? null
  return null
}

export function isEdited(s: StudioState): boolean {
  return s.document.savedRevision !== s.project.revision
}

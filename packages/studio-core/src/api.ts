import type { Command } from './studio/commands'

// Contract for the desktop's local service. The Electron main process serves
// it on 127.0.0.1; the `reborn` CLI and MCP server are thin clients.
//
// Discovery: the running desktop writes `<userData>/api.json` (an
// `ApiDiscovery`), readable only by the current user. Clients authenticate
// with `Authorization: Bearer <token>`. The read token can call GET routes
// and read-only commands; the write token can call everything.
//
// Routes (all JSON):
//   GET  /v1/status                → ApiStatus
//   GET  /v1/commands              → CommandInfo[]
//   POST /v1/execute               ExecuteRequest → ExecuteResponse
//   POST /v1/runtime               RuntimeRequest → RuntimeResponse
//   GET  /v1/jobs/:id              → JobState
//   GET  /v1/events                → text/event-stream of ApiEvent
//
// The server rejects requests whose Host is not 127.0.0.1:<port> or
// localhost:<port>, and any request carrying a browser Origin header, so web
// pages cannot reach it through DNS rebinding.
//
// Commands sent with origin "agent" become a pending proposal the user
// reviews in the app, unless the user enabled direct agent edits. Scripts
// (origin "script", the CLI default) apply immediately and appear in undo
// history like manual edits.

export const API_VERSION = 1
export const API_DISCOVERY_FILE = 'api.json'

export interface ApiDiscovery {
  version: number
  port: number
  pid: number
  readToken: string
  writeToken: string
  startedAt: string
}

export interface ApiStatus {
  app: string
  version: string
  api: number
  project: { name: string; revision: number; path: string | null; bars: number; tempo: number } | null
  transport: { playing: boolean; bar: number }
  clients: number
  directAgentEdits: boolean
}

export interface CommandInfo {
  type: string
  summary: string
  mutates: boolean
  schema: Record<string, unknown>
}

export interface ExecuteRequest {
  commands: Command[]
  origin?: 'script' | 'agent'
  label?: string
  /** Fails with 409 when the project revision moved on. */
  expectedRevision?: number
  /** For agents: why these changes are proposed. Shown in the review card. */
  intent?: string
}

export interface ExecuteResponse {
  revision: number
  results: unknown[]
  changed: boolean
  /** Set when the batch became a pending proposal instead of applying. */
  proposalId?: string
  status: 'applied' | 'proposed' | 'read'
}

export type RuntimeAction =
  | 'transport.play'
  | 'transport.stop'
  | 'transport.seek'
  | 'scene.launch'
  | 'history.undo'
  | 'history.redo'
  | 'project.save'
  | 'render.mix'
  | 'render.stems'
  | 'analysis.run'
  | 'proposal.list'
  | 'proposal.status'

export interface RuntimeRequest {
  action: RuntimeAction
  params?: Record<string, unknown>
}

export interface RuntimeResponse {
  result?: unknown
  /** Long work (renders, analysis) returns a job to poll or watch. */
  jobId?: string
}

export interface JobState {
  id: string
  kind: string
  status: 'running' | 'done' | 'failed' | 'cancelled'
  completed: number
  total: number
  message?: string
  result?: unknown
}

export type ApiEvent =
  | { type: 'project'; revision: number; origin: string; label: string }
  | { type: 'job'; job: JobState }
  | { type: 'transport'; playing: boolean; bar: number }
  | { type: 'proposal'; id: string; status: 'pending' | 'applied' | 'partial' | 'rejected' }

export interface ApiErrorBody {
  error: { code: 'unauthorized' | 'forbidden' | 'invalid' | 'not_found' | 'conflict' | 'unavailable' | 'internal'; message: string }
}

import type { ProjectState } from './model'
import type { StudioProject } from './studio/model'
import type { ApiEvent } from './api'
import type { ProjectAssetKind, ProjectDocument } from './project-file'

// Contract between the desktop main process and the renderer. The preload
// script exposes exactly this surface as `window.reborn`; nothing else from
// Node or Electron reaches the page.

export interface DesktopAssetPayload {
  id: string
  kind: ProjectAssetKind
  name: string
  mimeType: string
  data: ArrayBuffer
}

export interface OpenedProject {
  path: string
  document: ProjectDocument
  assets: DesktopAssetPayload[]
  missing: string[]
}

export interface SaveProjectRequest {
  path: string | null
  saveAs: boolean
  /** v1 workstation project. */
  project?: ProjectState
  /** v2 studio project. */
  studio?: StudioProject
  assets: DesktopAssetPayload[]
}

export interface SaveProjectResult {
  path: string
  savedAt: string
  writtenAssets: number
  reusedAssets: number
}

export interface RecentProject {
  path: string
  name: string
  openedAt: string
}

export interface RecoveryState {
  project?: ProjectState
  studio?: StudioProject
  path: string | null
  savedAt: string
}

export type MenuCommand = 'new' | 'open-path' | 'save' | 'save-as' | 'pack' | 'export-wav' | 'undo' | 'redo'

export interface MenuEvent {
  command: MenuCommand
  /** Set for `open-path`: main already chose the project to open. */
  path?: string
}

export type JobStatus = 'running' | 'done' | 'failed' | 'cancelled'

export interface JobUpdate {
  id: string
  kind: 'pack'
  status: JobStatus
  completed: number
  total: number
  message?: string
  outputPath?: string
}

export type LogLevel = 'info' | 'warn' | 'error'

export type AgentProvider = 'claude-cli' | 'anthropic' | 'openai-compatible'

export interface AgentSettings {
  provider: AgentProvider
  model: string
  /** Base URL for OpenAI-compatible servers such as Ollama or LM Studio. */
  baseUrl: string
  /** True when an API key is stored in the OS credential store. */
  hasKey: boolean
  /** Agent edits apply directly instead of waiting for review. Off by default. */
  directEdits: boolean
  /** Allow compact measurements (never raw audio) in cloud requests. */
  shareMeasurements: boolean
  /** Whether the `claude` executable was found on PATH. */
  cliAvailable: boolean
}

export type AgentContent =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }

export interface AgentMessage {
  role: 'user' | 'assistant'
  content: AgentContent[]
}

export interface AgentToolSpec {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

export interface AgentCompleteRequest {
  system: string
  messages: AgentMessage[]
  tools: AgentToolSpec[]
  maxTokens?: number
}

export interface AgentCompleteResponse {
  content: AgentContent[]
  stopReason: string
}

/** A local-API request the main process forwards to the renderer, which owns the project. */
export interface ApiRpcRequest {
  id: string
  route: 'status' | 'execute' | 'runtime'
  body: unknown
}

export interface ApiRpcResponse {
  id: string
  status: number
  body: unknown
}

export interface DesktopBridge {
  platform: 'desktop'
  getVersion(): Promise<string>
  openProject(path?: string): Promise<OpenedProject | null>
  saveProject(request: SaveProjectRequest): Promise<SaveProjectResult | null>
  listRecent(): Promise<RecentProject[]>
  packProject(path: string): Promise<{ jobId: string } | null>
  cancelJob(id: string): Promise<void>
  saveWav(data: ArrayBuffer, suggestedName: string): Promise<string | null>
  writeRecovery(state: { project?: ProjectState; studio?: StudioProject; path: string | null }): void
  takeRecovery(): Promise<RecoveryState | null>
  setDocumentState(state: { title: string; edited: boolean }): void
  log(level: LogLevel, message: string): void
  onMenuCommand(listener: (event: MenuEvent) => void): () => void
  onJobUpdate(listener: (update: JobUpdate) => void): () => void
  getAgentSettings(): Promise<AgentSettings>
  setAgentSettings(patch: Partial<Omit<AgentSettings, 'hasKey' | 'cliAvailable'>> & { apiKey?: string | null }): Promise<AgentSettings>
  agentComplete(request: AgentCompleteRequest): Promise<AgentCompleteResponse>
  /** Runs the Claude CLI with the RE:BORN MCP server attached and returns its final answer. */
  agentRunCli(prompt: string): Promise<{ text: string }>
  onApiRequest(listener: (request: ApiRpcRequest) => void): () => void
  respondApi(response: ApiRpcResponse): void
  /** Publishes a local-API event (project revision, proposal status) to connected clients. */
  emitApiEvent(event: ApiEvent): void
  /** Number of local API clients seen recently, for the status bar. */
  apiClients(): Promise<number>
}

/** IPC channel names. Kept in one place so main and preload cannot drift. */
export const IPC = {
  openProject: 'project:open',
  saveProject: 'project:save',
  listRecent: 'recent:list',
  packProject: 'job:pack',
  cancelJob: 'job:cancel',
  jobUpdate: 'job:update',
  saveWav: 'wav:save',
  writeRecovery: 'recovery:write',
  takeRecovery: 'recovery:take',
  documentState: 'window:document-state',
  log: 'log:write',
  menu: 'menu:command',
  version: 'app:version',
  agentSettings: 'agent:settings',
  agentSetSettings: 'agent:set-settings',
  agentComplete: 'agent:complete',
  agentRunCli: 'agent:run-cli',
  apiRequest: 'api:request',
  apiResponse: 'api:response',
  apiClients: 'api:clients',
  apiEvent: 'api:event',
} as const

import type { ProjectState } from './model'
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
  project: ProjectState
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
  project: ProjectState
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

export interface DesktopBridge {
  platform: 'desktop'
  getVersion(): Promise<string>
  openProject(path?: string): Promise<OpenedProject | null>
  saveProject(request: SaveProjectRequest): Promise<SaveProjectResult | null>
  listRecent(): Promise<RecentProject[]>
  packProject(path: string): Promise<{ jobId: string } | null>
  cancelJob(id: string): Promise<void>
  saveWav(data: ArrayBuffer, suggestedName: string): Promise<string | null>
  writeRecovery(state: { project: ProjectState; path: string | null }): void
  takeRecovery(): Promise<RecoveryState | null>
  setDocumentState(state: { title: string; edited: boolean }): void
  log(level: LogLevel, message: string): void
  onMenuCommand(listener: (event: MenuEvent) => void): () => void
  onJobUpdate(listener: (update: JobUpdate) => void): () => void
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
} as const

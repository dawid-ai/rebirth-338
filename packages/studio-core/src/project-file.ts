import { hydrateProject, type ProjectState } from './model'

// On-disk project format shared by the web and desktop editions. A desktop
// project is a `My Beat.reborn/` directory whose `project.json` holds a
// `ProjectDocument`; audio lives beside it in `assets/`.

export const PROJECT_FORMAT = 'reborn-project'
export const PROJECT_FORMAT_VERSION = 1
export const PROJECT_DIRECTORY_EXTENSION = '.reborn'
export const PACKED_PROJECT_EXTENSION = '.rebornpack'
export const PROJECT_FILE = 'project.json'
export const ASSET_DIRECTORY = 'assets'

export type ProjectAssetKind = 'deck' | 'sample'

export interface ProjectAssetEntry {
  id: string
  kind: ProjectAssetKind
  name: string
  mimeType: string
  file: string
  bytes: number
  sha256: string
}

export interface ProjectDocument {
  format: typeof PROJECT_FORMAT
  formatVersion: number
  savedAt: string
  app: { name: string; version: string }
  project: ProjectState
  assets: ProjectAssetEntry[]
}

export class ProjectFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProjectFormatError'
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** Validates a v1 project payload and fills in fields added after it was saved. */
export function migrateProject(candidate: unknown): ProjectState {
  if (!isRecord(candidate) || candidate.version !== 1 || !Array.isArray(candidate.bass)) {
    throw new ProjectFormatError('This is not a valid RE:BORN project.')
  }
  return hydrateProject(candidate as Partial<ProjectState>)
}

export function serializeProject(project: ProjectState): string {
  return JSON.stringify(project, null, 2)
}

/** Parses a raw v1 project export without hydrating it. */
export function parseProject(json: string): ProjectState {
  const value = JSON.parse(json) as ProjectState
  if (!value || value.version !== 1 || !Array.isArray(value.bass)) {
    throw new ProjectFormatError('This is not a valid ReBirth 338 project file.')
  }
  return value
}

export function createProjectDocument(project: ProjectState, assets: ProjectAssetEntry[], options: { savedAt?: string; appVersion?: string } = {}): ProjectDocument {
  return {
    format: PROJECT_FORMAT,
    formatVersion: PROJECT_FORMAT_VERSION,
    savedAt: options.savedAt ?? new Date().toISOString(),
    app: { name: 'RE:BORN', version: options.appVersion ?? '2.0.0-dev' },
    project,
    assets: [...assets].sort((a, b) => a.id.localeCompare(b.id)),
  }
}

/**
 * Reads either a `project.json` document or a raw v1 project export
 * (`.rb338.json`), so older exports open in the desktop edition.
 */
export function readProjectDocument(json: string): ProjectDocument {
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch {
    throw new ProjectFormatError('The project file is not valid JSON.')
  }
  if (isRecord(value) && value.format === PROJECT_FORMAT) {
    if (typeof value.formatVersion !== 'number' || value.formatVersion > PROJECT_FORMAT_VERSION) {
      throw new ProjectFormatError('This project was saved by a newer version of RE:BORN.')
    }
    const assets = Array.isArray(value.assets) ? value.assets.filter(isAssetEntry) : []
    return {
      format: PROJECT_FORMAT,
      formatVersion: value.formatVersion,
      savedAt: typeof value.savedAt === 'string' ? value.savedAt : new Date(0).toISOString(),
      app: isRecord(value.app) ? { name: String(value.app.name ?? 'RE:BORN'), version: String(value.app.version ?? 'unknown') } : { name: 'RE:BORN', version: 'unknown' },
      project: migrateProject(value.project),
      assets,
    }
  }
  return createProjectDocument(migrateProject(value), [], { savedAt: new Date(0).toISOString(), appVersion: '1.x' })
}

function isAssetEntry(value: unknown): value is ProjectAssetEntry {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    (value.kind === 'deck' || value.kind === 'sample') &&
    typeof value.file === 'string' &&
    !value.file.includes('..') &&
    typeof value.sha256 === 'string'
  )
}

const EXTENSIONS: Record<string, string> = {
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/wave': '.wav',
  'audio/mpeg': '.mp3',
  'audio/ogg': '.ogg',
  'audio/flac': '.flac',
  'audio/aac': '.aac',
  'audio/mp4': '.m4a',
  'audio/webm': '.webm',
}

/** Stable, filesystem-safe file name for an asset inside `assets/`. */
export function assetFileName(asset: { id: string; name: string; mimeType: string }): string {
  const fromName = /\.[a-z0-9]{2,5}$/i.exec(asset.name)?.[0]?.toLowerCase()
  const extension = fromName ?? EXTENSIONS[asset.mimeType.toLowerCase()] ?? '.bin'
  const safeId = asset.id.replace(/[^a-z0-9_-]+/gi, '-').slice(0, 80) || 'asset'
  return `${safeId}${extension}`
}

/** File-system-safe default name for a new project directory. */
export function projectDirectoryName(projectName: string): string {
  const base = projectName.trim().replace(/[<>:"/\\|?*]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Untitled'
  return `${base}${PROJECT_DIRECTORY_EXTENSION}`
}

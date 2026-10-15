import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import {
  ASSET_DIRECTORY,
  PACKED_PROJECT_EXTENSION,
  PROJECT_DIRECTORY_EXTENSION,
  PROJECT_FILE,
  type DesktopAssetPayload,
  type OpenedProject,
  type ProjectAssetEntry,
  type ProjectState,
  assetFileName,
  createProjectDocument,
  readProjectDocument,
} from '@reborn/studio-core'
import { type ZipSource, extractZip, writeZip } from './zip'

export const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')

/** Writes `data` beside `target` and renames it into place. */
export async function writeAtomic(target: string, data: string | Uint8Array): Promise<void> {
  const temporary = `${target}.${process.pid}.${Date.now().toString(36)}.tmp`
  await writeFile(temporary, data)
  try {
    await rename(temporary, target)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

async function readExistingManifest(directory: string): Promise<Map<string, ProjectAssetEntry>> {
  try {
    const document = readProjectDocument(await readFile(join(directory, PROJECT_FILE), 'utf8'))
    return new Map(document.assets.map((asset) => [asset.id, asset]))
  } catch {
    return new Map()
  }
}

export interface WriteResult {
  savedAt: string
  writtenAssets: number
  reusedAssets: number
}

/**
 * Saves a project directory. Audio files whose checksum already matches the
 * previous manifest are left untouched, so routine saves never rewrite large
 * samples. Files no longer referenced are kept; nothing in the folder is
 * deleted on save.
 */
export async function writeProjectDirectory(directory: string, project: ProjectState, assets: DesktopAssetPayload[], appVersion: string): Promise<WriteResult> {
  const assetDirectory = join(directory, ASSET_DIRECTORY)
  await mkdir(assetDirectory, { recursive: true })
  const previous = await readExistingManifest(directory)
  const entries: ProjectAssetEntry[] = []
  let writtenAssets = 0
  let reusedAssets = 0
  for (const asset of assets) {
    const bytes = new Uint8Array(asset.data)
    const checksum = sha256(bytes)
    const file = `${ASSET_DIRECTORY}/${assetFileName(asset)}`
    const target = join(directory, file)
    const known = previous.get(asset.id)
    const unchanged = known?.sha256 === checksum && known.file === file && existsSync(target) && (await stat(target)).size === bytes.length
    if (unchanged) reusedAssets += 1
    else {
      await writeAtomic(target, bytes)
      writtenAssets += 1
    }
    entries.push({ id: asset.id, kind: asset.kind, name: asset.name, mimeType: asset.mimeType, file, bytes: bytes.length, sha256: checksum })
  }
  const document = createProjectDocument(project, entries, { appVersion })
  await writeAtomic(join(directory, PROJECT_FILE), `${JSON.stringify(document, null, 2)}\n`)
  return { savedAt: document.savedAt, writtenAssets, reusedAssets }
}

/** Opens a `.reborn` directory, a `project.json` inside one, or a raw v1 export. */
export async function readProjectPath(path: string): Promise<OpenedProject> {
  const info = await stat(path)
  const directory = info.isDirectory() ? path : basename(path) === PROJECT_FILE ? dirname(path) : null
  if (!directory) {
    const document = readProjectDocument(await readFile(path, 'utf8'))
    return { path, document, assets: [], missing: [] }
  }
  const document = readProjectDocument(await readFile(join(directory, PROJECT_FILE), 'utf8'))
  const assets: DesktopAssetPayload[] = []
  const missing: string[] = []
  for (const entry of document.assets) {
    try {
      const bytes = await readFile(join(directory, entry.file))
      if (sha256(bytes) !== entry.sha256) {
        missing.push(entry.name)
        continue
      }
      const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
      assets.push({ id: entry.id, kind: entry.kind, name: entry.name, mimeType: entry.mimeType, data })
    } catch {
      missing.push(entry.name)
    }
  }
  return { path: directory, document, assets, missing }
}

/** Lists every file in a project directory for packing, skipping temp files. */
export async function projectFiles(directory: string, prefix = ''): Promise<ZipSource[]> {
  const sources: ZipSource[] = []
  for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) sources.push(...(await projectFiles(directory, relative)))
    else if (!entry.name.endsWith('.tmp') && !entry.name.endsWith('.partial')) sources.push({ name: relative, file: join(directory, relative) })
  }
  return sources.sort((a, b) => (a.name === PROJECT_FILE ? -1 : b.name === PROJECT_FILE ? 1 : a.name.localeCompare(b.name)))
}

export async function packProjectDirectory(directory: string, output: string, options: Parameters<typeof writeZip>[2] = {}): Promise<void> {
  if (!existsSync(join(directory, PROJECT_FILE))) throw new Error('Save the project before packing it.')
  await writeZip(output, await projectFiles(directory), options)
}

/** Picks `<name>.reborn`, `<name> 2.reborn`, … next to `near` without overwriting. */
export function freeDirectoryName(parent: string, name: string): string {
  let candidate = join(parent, `${name}${PROJECT_DIRECTORY_EXTENSION}`)
  for (let n = 2; existsSync(candidate); n += 1) candidate = join(parent, `${name} ${n}${PROJECT_DIRECTORY_EXTENSION}`)
  return candidate
}

/** Unpacks a `.rebornpack` beside itself and returns the new directory. */
export async function unpackProject(archive: string): Promise<string> {
  const target = freeDirectoryName(dirname(archive), basename(archive, extname(archive) || PACKED_PROJECT_EXTENSION))
  try {
    await extractZip(archive, target)
  } catch (error) {
    await rm(target, { recursive: true, force: true })
    throw error
  }
  return target
}

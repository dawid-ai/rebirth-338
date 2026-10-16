import { type DesktopAssetPayload, type OpenedProject, readProjectDocument, studio } from '@reborn/studio-core'
import { ensureAssets } from '../audio/host'
import { getAsset, putAsset } from '../platform/assetStore'
import { desktop } from '../platform/desktop'
import { getState, isEdited, loadProject, setState, subscribe, toast } from './store'

type StudioProject = studio.StudioProject

const AUTOSAVE_KEY = 'reborn.studio.autosave'

export interface ImportNotice {
  title: string
  notes: string[]
  approximations: string[]
}

let notice: ImportNotice | null = null
const noticeListeners = new Set<() => void>()
export const importNotice = () => notice
export function onImportNotice(listener: () => void) {
  noticeListeners.add(listener)
  return () => {
    noticeListeners.delete(listener)
  }
}
export function clearImportNotice() {
  notice = null
  for (const l of noticeListeners) l()
}
function showNotice(next: ImportNotice) {
  notice = next
  for (const l of noticeListeners) l()
}

/** Restores the last session (browser autosave or desktop crash recovery). */
export async function restoreSession(): Promise<void> {
  if (desktop) {
    const recovered = await desktop.takeRecovery()
    if (recovered?.studio) {
      loadProject(studio.migrateStudioProject(recovered.studio), { path: recovered.path, savedRevision: null })
      toast('Recovered unsaved changes from your last session', 'success')
      return
    }
  }
  try {
    const saved = localStorage.getItem(AUTOSAVE_KEY)
    if (saved) loadProject(studio.migrateStudioProject(JSON.parse(saved)), { path: null, savedRevision: null })
  } catch {
    // A damaged autosave is ignored; the default project stays.
  }
}

let autosaveTimer = 0
let lastSaved: StudioProject | null = null
let lastTitle = ''

export function startAutosave(): void {
  subscribe(() => {
    const s = getState()
    // The window title follows every change, including a save that only
    // updates the document's saved revision.
    const title = `${s.project.name || 'Untitled'}|${isEdited(s)}`
    if (title !== lastTitle) {
      lastTitle = title
      desktop?.setDocumentState({ title: s.project.name || 'Untitled', edited: isEdited(s) })
    }
    if (s.project === lastSaved) return
    lastSaved = s.project
    window.clearTimeout(autosaveTimer)
    autosaveTimer = window.setTimeout(() => {
      const project = getState().project
      try {
        localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(project))
      } catch {
        // Storage full; the desktop recovery file still covers crashes.
      }
      desktop?.writeRecovery({ studio: project, path: getState().document.path })
    }, 1200)
  })
}

async function collectAssets(project: StudioProject): Promise<DesktopAssetPayload[]> {
  const payloads: DesktopAssetPayload[] = []
  for (const asset of Object.values(project.assets)) {
    if (asset.id.startsWith('builtin:')) continue
    const stored = await getAsset(asset.id)
    if (!stored) continue
    payloads.push({ id: asset.id, kind: 'sample', name: asset.name, mimeType: asset.mimeType, data: await stored.data.arrayBuffer() })
  }
  return payloads
}

export async function saveProject(saveAs = false): Promise<boolean> {
  const s = getState()
  if (!desktop) {
    downloadProject()
    return true
  }
  try {
    const project = s.project
    const result = await desktop.saveProject({ path: s.document.path, saveAs, studio: project, assets: await collectAssets(project) })
    if (!result) return false
    setState({ document: { path: result.path, savedRevision: project.revision } })
    toast(result.writtenAssets ? `Saved · ${result.writtenAssets} audio file${result.writtenAssets === 1 ? '' : 's'} written` : 'Saved', 'success')
    return true
  } catch (error) {
    desktop.log('error', `Save failed: ${String(error)}`)
    toast(`Save failed: ${error instanceof Error ? error.message : String(error)}`, 'error')
    return false
  }
}

async function adoptOpened(opened: OpenedProject): Promise<void> {
  for (const asset of opened.assets) await putAsset({ id: asset.id, name: asset.name, mimeType: asset.mimeType, data: new Blob([asset.data], { type: asset.mimeType }) })
  const { document } = opened
  if (document.studio) {
    loadProject(document.studio, { path: opened.path, savedRevision: document.studio.revision })
  } else if (document.project) {
    const { project, report } = studio.importV1Project(document.project)
    loadProject(project, { path: null, savedRevision: null })
    showNotice({ title: `Imported “${document.project.name}” from RE:BORN 338`, notes: report.notes, approximations: report.approximations })
  }
  void ensureAssets(getState().project)
  if (opened.missing.length) toast(`${opened.missing.length} audio file${opened.missing.length === 1 ? ' is' : 's are'} missing or damaged`, 'error')
}

export async function openProject(path?: string): Promise<void> {
  if (!desktop) return
  try {
    const opened = await desktop.openProject(path)
    if (opened) await adoptOpened(opened)
  } catch (error) {
    desktop.log('error', `Open failed: ${String(error)}`)
    toast(`Could not open the project: ${error instanceof Error ? error.message : String(error)}`, 'error')
  }
}

/** Browser import of a v2 JSON project or a v1 .rb338.json export. */
export async function importProjectFile(file: File): Promise<void> {
  try {
    const document = readProjectDocument(await file.text())
    await adoptOpened({ path: file.name, document, assets: [], missing: [] })
    setState({ document: { path: null, savedRevision: null } })
  } catch (error) {
    toast(`${file.name} is not a RE:BORN project: ${error instanceof Error ? error.message : String(error)}`, 'error')
  }
}

export function downloadProject(): void {
  const { project } = getState()
  const url = URL.createObjectURL(new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `${project.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase() || 'project'}.reborn.json`
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
  setState((s) => ({ document: { ...s.document, savedRevision: s.project.revision } }))
}

export function newProject(): void {
  const project = studio.createDefaultStudioProject('New Beat')
  loadProject(project, { path: null, savedRevision: project.revision })
}

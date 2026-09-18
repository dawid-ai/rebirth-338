import type { GrooveEngine } from '../audio/engine'
import type { ProjectState } from '../model'

export type AudioAssetKind = 'deck' | 'sample'

export interface AudioAssetRecord {
  id: string
  projectId: string
  kind: AudioAssetKind
  name: string
  mimeType: string
  data: Blob
  createdAt: string
  updatedAt: string
}

export type AudioAssetSummary = Omit<AudioAssetRecord, 'data'> & { bytes: number }

export interface AudioAssetBundle {
  version: 1
  assets: Array<Omit<AudioAssetRecord, 'data'> & { dataBase64: string }>
}

const DB_NAME = 'reborn338-audio'
const STORE = 'assets'
const DB_VERSION = 1
const memoryFallback = new Map<string, AudioAssetRecord>()

const makeId = () => globalThis.crypto?.randomUUID?.() ?? `audio-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`

async function openDatabase(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return null
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const database = request.result
      const store = database.objectStoreNames.contains(STORE)
        ? request.transaction!.objectStore(STORE)
        : database.createObjectStore(STORE, { keyPath: 'id' })
      if (!store.indexNames.contains('projectId')) store.createIndex('projectId', 'projectId', { unique: false })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Unable to open the audio asset database.'))
  })
}

async function transact<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const database = await openDatabase()
  if (!database) throw new Error('IndexedDB is unavailable.')
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE, mode)
    const request = run(transaction.objectStore(STORE))
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Audio asset transaction failed.'))
    transaction.oncomplete = () => database.close()
  })
}

export async function saveAudioAsset(input: {
  id?: string
  projectId: string
  kind: AudioAssetKind
  name: string
  mimeType?: string
  data: Blob | ArrayBuffer
}): Promise<AudioAssetRecord> {
  const id = input.id ?? makeId()
  const previous = await loadAudioAsset(id)
  const now = new Date().toISOString()
  const data = input.data instanceof Blob ? input.data : new Blob([input.data], { type: input.mimeType ?? 'audio/*' })
  const record: AudioAssetRecord = {
    id,
    projectId: input.projectId,
    kind: input.kind,
    name: input.name,
    mimeType: input.mimeType ?? (data.type || 'audio/*'),
    data,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
  }
  if (typeof indexedDB === 'undefined') {
    memoryFallback.set(id, record)
    return record
  }
  await transact('readwrite', (store) => store.put(record))
  return record
}

export async function loadAudioAsset(id: string): Promise<AudioAssetRecord | null> {
  if (typeof indexedDB === 'undefined') return memoryFallback.get(id) ?? null
  return (await transact<AudioAssetRecord | undefined>('readonly', (store) => store.get(id))) ?? null
}

export async function deleteAudioAsset(id: string): Promise<void> {
  if (typeof indexedDB === 'undefined') {
    memoryFallback.delete(id)
    return
  }
  await transact('readwrite', (store) => store.delete(id))
}

export async function listAudioAssets(projectId?: string): Promise<AudioAssetSummary[]> {
  let records: AudioAssetRecord[]
  if (typeof indexedDB === 'undefined') {
    records = [...memoryFallback.values()]
  } else {
    records = await transact<AudioAssetRecord[]>('readonly', (store) => projectId
      ? store.index('projectId').getAll(projectId)
      : store.getAll())
  }
  return records
    .filter((record) => !projectId || record.projectId === projectId)
    .map(({ data, ...record }) => ({ ...record, bytes: data.size }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export async function deleteProjectAudioAssets(projectId: string): Promise<void> {
  const assets = await listAudioAssets(projectId)
  await Promise.all(assets.map(({ id }) => deleteAudioAsset(id)))
}

export async function exportAudioAssetBundle(ids: string[]): Promise<AudioAssetBundle> {
  const assets = (await Promise.all([...new Set(ids)].map(loadAudioAsset))).filter((asset): asset is AudioAssetRecord => Boolean(asset))
  return {
    version: 1,
    assets: await Promise.all(assets.map(async ({ data, ...asset }) => ({
      ...asset,
      dataBase64: arrayBufferToBase64(await data.arrayBuffer()),
    }))),
  }
}

export async function importAudioAssetBundle(bundle: AudioAssetBundle): Promise<AudioAssetRecord[]> {
  if (bundle.version !== 1 || !Array.isArray(bundle.assets)) throw new Error('Invalid ReBorn audio asset bundle.')
  return Promise.all(bundle.assets.map(({ dataBase64, ...asset }) => saveAudioAsset({
    ...asset,
    data: base64ToArrayBuffer(dataBase64),
  })))
}

export function arrayBufferToBase64(data: ArrayBuffer): string {
  const bytes = new Uint8Array(data)
  let binary = ''
  const chunk = 0x8000
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, Math.min(bytes.length, index + chunk)))
  }
  return btoa(binary)
}

export function base64ToArrayBuffer(value: string): ArrayBuffer {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes.buffer
}

export function collectProjectAudioAssetIds(project: ProjectState): string[] {
  return [...new Set([
    ...project.decks.map((deck) => deck.assetId),
    ...project.sampler.slots.map((slot) => slot.assetId),
  ].filter((id): id is string => typeof id === 'string' && !id.startsWith('builtin:')))]
}

async function loadProjectAudio(id: string): Promise<Blob | null> {
  if (id.startsWith('builtin:')) {
    const filename = id.slice('builtin:'.length)
    if (!/^[a-z0-9_-]+\.ogg$/i.test(filename)) return null
    const response = await fetch(`${import.meta.env.BASE_URL}audio/starter/${filename}`)
    return response.ok ? response.blob() : null
  }
  return (await loadAudioAsset(id))?.data ?? null
}

/** Decode every persisted deck/sample asset into an engine after project hydration. */
export async function restoreProjectAudioAssets(project: ProjectState, engine: GrooveEngine): Promise<{ decks: number; samples: number; missing: string[] }> {
  let decks = 0
  let samples = 0
  const missing: string[] = []
  for (let index = 0; index < project.decks.length; index += 1) {
    const id = project.decks[index].assetId
    if (!id) continue
    const audio = await loadProjectAudio(id)
    if (!audio) { missing.push(id); continue }
    await engine.loadDeck(index, audio)
    decks += 1
  }
  for (let index = 0; index < project.sampler.slots.length; index += 1) {
    const id = project.sampler.slots[index].assetId
    if (!id) continue
    const audio = await loadProjectAudio(id)
    if (!audio) { missing.push(id); continue }
    await engine.loadSample(index, audio)
    samples += 1
  }
  return { decks, samples, missing }
}

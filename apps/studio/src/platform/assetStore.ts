// Audio bytes for studio assets, kept in IndexedDB so projects reopen with
// their samples in the browser. The desktop edition also caches here and
// writes the same bytes into the project folder on save.

const DB_NAME = 'reborn-studio'
const STORE = 'assets'
const memory = new Map<string, StoredAsset>()

export interface StoredAsset {
  id: string
  name: string
  mimeType: string
  data: Blob
}

function open(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null)
  return new Promise((resolve) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: 'id' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => resolve(null)
  })
}

async function run<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  const db = await open()
  if (!db) return undefined
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode)
    const request = action(tx.objectStore(STORE))
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
    tx.oncomplete = () => db.close()
  })
}

export async function putAsset(asset: StoredAsset): Promise<void> {
  memory.set(asset.id, asset)
  await run('readwrite', (store) => store.put(asset)).catch(() => undefined)
}

export async function getAsset(id: string): Promise<StoredAsset | null> {
  const cached = memory.get(id)
  if (cached) return cached
  const stored = await run<StoredAsset | undefined>('readonly', (store) => store.get(id)).catch(() => undefined)
  if (stored) memory.set(id, stored)
  return stored ?? null
}

/** Bundled starter audio is addressed as `builtin:<file>`. */
export async function fetchAssetBytes(id: string): Promise<Blob | null> {
  if (id.startsWith('builtin:')) {
    const file = id.slice('builtin:'.length)
    if (!/^[a-z0-9_-]+\.(ogg|wav|mp3)$/i.test(file)) return null
    const response = await fetch(`${import.meta.env.BASE_URL}audio/starter/${file}`)
    return response.ok ? response.blob() : null
  }
  return (await getAsset(id))?.data ?? null
}

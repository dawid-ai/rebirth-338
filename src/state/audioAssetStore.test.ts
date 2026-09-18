import { afterEach, describe, expect, it } from 'vitest'
import {
  arrayBufferToBase64,
  base64ToArrayBuffer,
  collectProjectAudioAssetIds,
  deleteAudioAsset,
  exportAudioAssetBundle,
  importAudioAssetBundle,
  listAudioAssets,
  loadAudioAsset,
  saveAudioAsset,
} from './audioAssetStore'
import { createDefaultProject } from '../model'

const ids: string[] = []
afterEach(async () => Promise.all(ids.splice(0).map(deleteAudioAsset)))

describe('audio asset persistence', () => {
  it('stores binary assets with project metadata', async () => {
    const saved = await saveAudioAsset({ projectId: 'project-a', kind: 'sample', name: 'Vocal', mimeType: 'audio/wav', data: new Uint8Array([1, 2, 3, 4]).buffer })
    ids.push(saved.id)
    expect((await loadAudioAsset(saved.id))?.data.size).toBe(4)
    expect(await listAudioAssets('project-a')).toEqual([expect.objectContaining({ id: saved.id, kind: 'sample', bytes: 4 })])
  })

  it('round-trips portable base64 bundles', async () => {
    const saved = await saveAudioAsset({ projectId: 'project-b', kind: 'deck', name: 'Track', data: new Uint8Array([8, 13, 21]).buffer })
    ids.push(saved.id)
    const bundle = await exportAudioAssetBundle([saved.id])
    await deleteAudioAsset(saved.id)
    const [restored] = await importAudioAssetBundle(bundle)
    ids.push(restored.id)
    expect([...new Uint8Array(await restored.data.arrayBuffer())]).toEqual([8, 13, 21])
  })

  it('encodes arbitrary binary without corruption', () => {
    const source = new Uint8Array(Array.from({ length: 1024 }, (_, index) => index % 251)).buffer
    expect(new Uint8Array(base64ToArrayBuffer(arrayBufferToBase64(source)))).toEqual(new Uint8Array(source))
  })

  it('collects deduplicated deck and sampler asset references', () => {
    const project = createDefaultProject()
    project.decks[0].assetId = 'shared'
    project.sampler.slots[0].assetId = 'shared'
    project.sampler.slots[1].assetId = 'unique'
    expect(collectProjectAudioAssetIds(project)).toEqual(['shared', 'unique'])
  })
})

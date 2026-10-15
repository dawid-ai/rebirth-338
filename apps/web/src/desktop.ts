import type { DesktopAssetPayload, DesktopBridge, OpenedProject, ProjectState } from '@reborn/studio-core'
import { collectProjectAudioAssetIds, loadAudioAsset, saveAudioAsset, type AudioAssetRecord } from './state/audioAssetStore'

declare global {
  interface Window {
    reborn?: DesktopBridge
  }
}

/** The desktop bridge, or null in the browser edition. */
export const desktop: DesktopBridge | null = typeof window !== 'undefined' ? (window.reborn ?? null) : null

/** Reads the project's user audio from the browser store for a native save. */
export async function collectDesktopAssets(project: ProjectState): Promise<DesktopAssetPayload[]> {
  const records = (await Promise.all(collectProjectAudioAssetIds(project).map(loadAudioAsset))).filter((record): record is AudioAssetRecord => record !== null)
  return Promise.all(records.map(async (record) => ({
    id: record.id,
    kind: record.kind,
    name: record.name,
    mimeType: record.mimeType,
    data: await record.data.arrayBuffer(),
  })))
}

/**
 * Copies audio from an opened project folder into the browser store, keeping
 * asset IDs, so the engine's existing restore path can decode it.
 */
export async function importDesktopAssets(opened: OpenedProject): Promise<void> {
  await Promise.all(opened.assets.map((asset) => saveAudioAsset({
    id: asset.id,
    projectId: `desktop:${opened.path}`,
    kind: asset.kind,
    name: asset.name,
    mimeType: asset.mimeType,
    data: asset.data,
  })))
}

export function isEditableTarget(element: Element | null): boolean {
  return element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || (element instanceof HTMLElement && element.isContentEditable)
}

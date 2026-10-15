import { type LibrarySample, importSample } from '../break'
import type { Studio } from '../studio'

export const SAMPLE_MIME = 'application/x-reborn-sample'

export function importBreak(studio: Studio, item: LibrarySample) {
  const sample = importSample(item)
  studio.commit(`Import ${item.file}`, (p) => ({ ...p, sample }))
  studio.select({ kind: 'sample', slice: null })
  studio.setView('arrange')
}

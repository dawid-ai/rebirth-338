import { createDefaultProject, type ProjectState } from '../model'
import { createDubstepDemoProject } from './dubstepDemo'
import { createBloodRaveProject, createMatrixBreakProject } from './tributeDemos'

export const demoCatalog = [
  { id: 'abyssal', label: 'ABYSSAL SIGNAL / DUBSTEP', detail: '48 bars · original C-minor dubstep arrangement' },
  { id: 'matrix', label: 'MATRIX BREAK / BIG BEAT', detail: '32 bars · original Propellerheads / Spybreak!-inspired tribute' },
  { id: 'blood', label: 'BLOOD RAVE / ACID TECHNO', detail: '40 bars · original Blade blood-rave-inspired tribute' },
] as const

export type DemoId = typeof demoCatalog[number]['id']

/** A new complete session each time; edits to the current song never alter a demo preset. */
export function createDemoProject(id: DemoId): ProjectState {
  const base = createDefaultProject()
  if (id === 'matrix') return createMatrixBreakProject(base)
  if (id === 'blood') return createBloodRaveProject(base)
  return createDubstepDemoProject(base)
}

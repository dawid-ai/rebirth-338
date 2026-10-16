import { studio } from '@reborn/studio-core'
import { type Proposal, dispatch, getState, setState, toast, useStudio } from './store'

type StudioProject = studio.StudioProject

// Agent proposals are batches of commands the user reviews. Previewing runs
// the picked commands on a copy of the project so the UI can draw ghost
// values; applying runs them through `dispatch` as one undoable agent step.

export function addProposal(proposal: Omit<Proposal, 'status' | 'createdAt' | 'revision'>): Proposal {
  const full: Proposal = { ...proposal, status: 'pending', createdAt: Date.now(), revision: getState().project.revision }
  setState((s) => ({
    proposals: [...s.proposals.filter((p) => p.status === 'pending' || Date.now() - p.createdAt < 600_000).slice(-19), full],
    previewProposal: full.id,
    proposalPicks: { ...s.proposalPicks, ...Object.fromEntries(full.changes.map((c) => [`${full.id}:${c.id}`, true])) },
  }))
  return full
}

export const isPicked = (proposalId: string, changeId: string) => getState().proposalPicks[`${proposalId}:${changeId}`] !== false

export function togglePick(proposalId: string, changeId: string): void {
  const key = `${proposalId}:${changeId}`
  setState((s) => ({ proposalPicks: { ...s.proposalPicks, [key]: s.proposalPicks[key] === false } }))
}

let cache: { project: StudioProject; proposal: Proposal; picks: Record<string, boolean>; result: StudioProject | null } | null = null

/** The project as it would be with the previewed proposal's picked changes. */
export function previewProject(): StudioProject | null {
  const s = getState()
  const proposal = s.proposals.find((p) => p.id === s.previewProposal && p.status === 'pending')
  if (!proposal) return null
  if (cache && cache.project === s.project && cache.proposal === proposal && cache.picks === s.proposalPicks) return cache.result
  let result: StudioProject | null = null
  try {
    const commands = proposal.changes.filter((c) => isPicked(proposal.id, c.id)).flatMap((c) => c.commands)
    result = commands.length ? studio.executeBatch(s.project, commands, { origin: 'agent' }).project : null
  } catch {
    result = null
  }
  cache = { project: s.project, proposal, picks: s.proposalPicks, result }
  return result
}

export function usePreview(): StudioProject | null {
  useStudio((s) => s.previewProposal)
  useStudio((s) => s.proposalPicks)
  useStudio((s) => s.project)
  useStudio((s) => s.proposals)
  return previewProject()
}

export function applyProposal(id: string): void {
  const s = getState()
  const proposal = s.proposals.find((p) => p.id === id)
  if (!proposal || proposal.status !== 'pending') return
  const picked = proposal.changes.filter((c) => isPicked(id, c.id))
  if (!picked.length) return
  const results = dispatch(picked.flatMap((c) => c.commands), { origin: 'agent', label: `Agent: ${proposal.intent}` })
  if (!results) return
  const status = picked.length === proposal.changes.length ? 'applied' : 'partial'
  setState((st) => ({ proposals: st.proposals.map((p) => (p.id === id ? { ...p, status } : p)), previewProposal: st.previewProposal === id ? null : st.previewProposal }))
  toast(`Applied ${picked.length} of ${proposal.changes.length} changes as one undo step`, 'success')
  onProposalResolved(id, status)
}

export function rejectProposal(id: string): void {
  setState((st) => ({ proposals: st.proposals.map((p) => (p.id === id ? { ...p, status: 'rejected' } : p)), previewProposal: st.previewProposal === id ? null : st.previewProposal }))
  onProposalResolved(id, 'rejected')
}

const resolvedListeners = new Set<(id: string, status: Proposal['status']) => void>()
export function onResolved(listener: (id: string, status: Proposal['status']) => void) {
  resolvedListeners.add(listener)
  return () => {
    resolvedListeners.delete(listener)
  }
}
function onProposalResolved(id: string, status: Proposal['status']) {
  for (const listener of resolvedListeners) listener(id, status)
}

// Bounded undo/redo stack. The v1 workstation records whole project
// snapshots; v2 commands record through the same stack so manual, scripted,
// and agent edits share one history.

export type EditOrigin = 'manual' | 'script' | 'agent'

export interface HistoryEntry<T> {
  state: T
  label: string
  origin: EditOrigin
}

export class History<T> {
  private past: HistoryEntry<T>[] = []
  private future: HistoryEntry<T>[] = []

  constructor(private readonly limit = 40) {}

  /** Records `current` as the state to return to on undo. */
  record(current: T, label = 'Edit', origin: EditOrigin = 'manual'): void {
    this.past.push({ state: current, label, origin })
    if (this.past.length > this.limit) this.past.shift()
    this.future = []
  }

  undo(current: T): T | undefined {
    const entry = this.past.pop()
    if (!entry) return undefined
    this.future.push({ ...entry, state: current })
    return entry.state
  }

  redo(current: T): T | undefined {
    const entry = this.future.pop()
    if (!entry) return undefined
    this.past.push({ ...entry, state: current })
    return entry.state
  }

  clear(): void {
    this.past = []
    this.future = []
  }

  get canUndo(): boolean {
    return this.past.length > 0
  }

  get canRedo(): boolean {
    return this.future.length > 0
  }

  get lastEntry(): Omit<HistoryEntry<T>, 'state'> | undefined {
    const entry = this.past[this.past.length - 1]
    return entry && { label: entry.label, origin: entry.origin }
  }
}

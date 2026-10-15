import { randomUUID } from 'node:crypto'
import type { JobUpdate } from '@reborn/studio-core'

// Background jobs run in the main process, stream progress to the renderer,
// and can be cancelled. A failing job reports its error; it never throws into
// the caller, so playback and editing continue.

type Work = (context: { signal: AbortSignal; progress: (completed: number, total: number) => void }) => Promise<string | undefined>

export class JobRunner {
  private readonly running = new Map<string, AbortController>()

  constructor(
    private readonly emit: (update: JobUpdate) => void,
    private readonly log: (message: string) => void,
  ) {}

  start(kind: JobUpdate['kind'], work: Work): string {
    const id = randomUUID()
    const controller = new AbortController()
    this.running.set(id, controller)
    let last: JobUpdate = { id, kind, status: 'running', completed: 0, total: 1 }
    this.emit(last)
    let lastEmit = 0
    const progress = (completed: number, total: number) => {
      last = { ...last, completed, total }
      const now = Date.now()
      if (now - lastEmit > 100 || completed >= total) {
        lastEmit = now
        this.emit(last)
      }
    }
    void work({ signal: controller.signal, progress })
      .then((outputPath) => {
        this.emit({ ...last, status: 'done', completed: last.total, outputPath })
        this.log(`Job ${kind} ${id} finished${outputPath ? `: ${outputPath}` : ''}.`)
      })
      .catch((error: unknown) => {
        const cancelled = controller.signal.aborted
        this.emit({ ...last, status: cancelled ? 'cancelled' : 'failed', message: cancelled ? 'Cancelled.' : error instanceof Error ? error.message : String(error) })
        this.log(`Job ${kind} ${id} ${cancelled ? 'cancelled' : `failed: ${String(error)}`}.`)
      })
      .finally(() => this.running.delete(id))
    return id
  }

  cancel(id: string): void {
    this.running.get(id)?.abort()
  }

  cancelAll(): void {
    for (const controller of this.running.values()) controller.abort()
  }
}

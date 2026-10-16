import { spawnSync } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { SidecarError, SidecarSupervisor, ensureEnvironment, findPython, type SidecarStatus } from './sidecar'

// Optional deep analysis through the Python sidecar ("Ismail bridge"). It
// starts on first use, never touches the project, and a crash or timeout
// only fails the request in progress.

export interface DeepStatus {
  status: SidecarStatus | 'not-started'
  backend: string | null
  python: string | null
  message: string | null
}

export interface DeepAnalysisOptions {
  /** Folder that holds python/ismail-bridge. */
  sidecarDir: string
  /** Per-user folder for the venv and temporary renders. */
  dataDir: string
  log: (line: string) => void
  onProgress: (completed: number, total: number, message: string) => void
}

export class DeepAnalysis {
  private supervisor: SidecarSupervisor | null = null
  private starting: Promise<SidecarSupervisor> | null = null
  private python: string | null = null
  private message: string | null = null
  private controller: AbortController | null = null

  constructor(private readonly options: DeepAnalysisOptions) {}

  status(): DeepStatus {
    return {
      status: this.supervisor?.status ?? 'not-started',
      backend: (this.supervisor?.info?.backend as string | undefined) ?? null,
      python: this.python,
      message: this.message,
    }
  }

  /** Process ID of the running sidecar, for tests that simulate a crash. */
  get pid(): number | undefined {
    return this.supervisor?.pid
  }

  private async ensure(): Promise<SidecarSupervisor> {
    if (this.supervisor && this.supervisor.status !== 'unavailable') return this.supervisor
    this.starting ??= (async () => {
      const found = findPython()
      if (!found) throw new SidecarError('unavailable', 'Python 3 was not found. Install Python 3.10 or later to use deep analysis.')
      let python = found.executable
      const numpy = spawnSync(python, ['-c', 'import numpy'], { windowsHide: true })
      if (numpy.status !== 0) {
        this.options.onProgress(0, 1, 'Setting up the analysis environment…')
        python = (await ensureEnvironment({ baseDir: join(this.options.dataDir, 'python'), python, onProgress: (line) => this.options.log(`[sidecar setup] ${line}`) })).python
      }
      this.python = python
      const supervisor = new SidecarSupervisor({
        python,
        cwd: this.options.sidecarDir,
        onLog: (line) => this.options.log(`[sidecar] ${line}`),
        onStatus: (status) => this.options.log(`[sidecar] status ${status}`),
        requestTimeoutMs: 300_000,
      })
      await supervisor.start()
      this.supervisor = supervisor
      return supervisor
    })()
    try {
      return await this.starting
    } catch (error) {
      this.message = error instanceof Error ? error.message : String(error)
      throw error
    } finally {
      this.starting = null
    }
  }

  private async withWav<T>(wav: Uint8Array, work: (path: string, signal: AbortSignal) => Promise<T>): Promise<T> {
    const directory = join(this.options.dataDir, 'renders')
    await mkdir(directory, { recursive: true })
    const path = join(directory, `analysis-${randomUUID()}.wav`)
    await writeFile(path, wav)
    this.controller?.abort()
    const controller = new AbortController()
    this.controller = controller
    try {
      return await work(path, controller.signal)
    } finally {
      if (this.controller === controller) this.controller = null
      await rm(path, { force: true })
    }
  }

  async analyze(wav: Uint8Array, sections: { id: string; start: number; end: number }[]): Promise<unknown> {
    const sidecar = await this.ensure()
    return this.withWav(wav, (path, signal) => sidecar.request('analyze', { path, sections }, { signal, onProgress: (p) => this.options.onProgress(p.completed, p.total, p.message ?? 'Analyzing') }))
  }

  async compare(wav: Uint8Array, reference: string): Promise<unknown> {
    const sidecar = await this.ensure()
    return this.withWav(wav, (path, signal) => sidecar.request('compare', { path, reference }, { signal, onProgress: (p) => this.options.onProgress(p.completed, p.total, p.message ?? 'Comparing') }))
  }

  cancel(): void {
    this.controller?.abort()
  }

  async stop(): Promise<void> {
    this.cancel()
    await this.supervisor?.stop()
    this.supervisor = null
  }
}

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { IsmailGenerateRequest, IsmailPresets, IsmailSound, IsmailStatus, IsmailStem } from '@reborn/studio-core'
import { SidecarError, SidecarSupervisor, ensureEnvironment, findPython, installIsmail, venvPython, type SidecarStatus } from './sidecar'

// Optional deep analysis and Ismail tools through the Python sidecar. It
// starts on first use and never touches the project: it reads WAV files the
// studio renders and writes new sounds and stems to a scratch folder, which
// the studio imports as assets. A crash or timeout only fails the request in
// progress.

export interface DeepStatus {
  status: SidecarStatus | 'not-started'
  backend: string | null
  python: string | null
  message: string | null
}

export interface Tempo {
  bpm: number
  beatsPerBar: number
}

export interface DeepAnalysisOptions {
  /** Folder that holds python/ismail-bridge. */
  sidecarDir: string
  /** Per-user folder for the venv, Ismail's workspace, and temporary renders. */
  dataDir: string
  log: (line: string) => void
  onProgress: (completed: number, total: number, message: string) => void
  /** Ismail install progress, one pip line at a time. */
  onInstall?: (line: string) => void
}

// Stem separation runs Demucs on the CPU when there is no GPU; a long song can take many minutes.
const SEPARATE_TIMEOUT_MS = 60 * 60_000

export class DeepAnalysis {
  private supervisor: SidecarSupervisor | null = null
  private starting: Promise<SidecarSupervisor> | null = null
  private installing: Promise<IsmailStatus> | null = null
  private python: string | null = null
  private message: string | null = null
  private controller: AbortController | null = null

  constructor(private readonly options: DeepAnalysisOptions) {}

  private get pythonDir(): string {
    return join(this.options.dataDir, 'python')
  }

  private get venv(): string {
    return venvPython(join(this.pythonDir, 'venv'))
  }

  private get scratchDir(): string {
    return join(this.options.dataDir, 'ismail', 'out')
  }

  status(): DeepStatus {
    return {
      status: this.supervisor?.status ?? 'not-started',
      backend: (this.supervisor?.info?.backend as string | undefined) ?? null,
      python: this.python,
      message: this.message,
    }
  }

  /** Whether Ismail and its separation extra are installed in the app's environment. */
  ismailStatus(): IsmailStatus {
    const base = { installing: this.installing !== null, message: this.message }
    if (!existsSync(this.venv)) return { ...base, installed: false, separation: false, version: null }
    const probe = spawnSync(this.venv, ['-c', "import importlib.util as u, importlib.metadata as m; i = u.find_spec('ismail'); print(m.version('ismail') if i else '', bool(i and u.find_spec('demucs')))"], { encoding: 'utf8', windowsHide: true, timeout: 20_000 })
    const [version = '', separation = 'False'] = (probe.stdout ?? '').trim().split(/\s+/)
    return { ...base, installed: probe.status === 0 && version !== '', separation: separation === 'True', version: version || null }
  }

  /** Process ID of the running sidecar, for tests that simulate a crash. */
  get pid(): number | undefined {
    return this.supervisor?.pid
  }

  private async ensure(): Promise<SidecarSupervisor> {
    if (this.supervisor && this.supervisor.status !== 'unavailable') return this.supervisor
    this.starting ??= (async () => {
      let python: string
      // The app's own environment wins: it is where Ismail gets installed.
      if (existsSync(this.venv)) python = this.venv
      else {
        const found = findPython()
        if (!found) throw new SidecarError('unavailable', 'Python 3 was not found. Install Python 3.10 or later to use deep analysis.')
        python = found.executable
        const numpy = spawnSync(python, ['-c', 'import numpy'], { windowsHide: true })
        if (numpy.status !== 0) {
          this.options.onProgress(0, 1, 'Setting up the analysis environment…')
          python = (await ensureEnvironment({ baseDir: this.pythonDir, python, onProgress: (line) => this.options.log(`[sidecar setup] ${line}`) })).python
        }
      }
      this.python = python
      const supervisor = new SidecarSupervisor({
        python,
        cwd: this.options.sidecarDir,
        // Model downloads (Demucs weights) stay in the app's folder instead of the shared user caches.
        env: {
          REBORN_SIDECAR_WORKSPACE: join(this.options.dataDir, 'ismail', 'workspace'),
          HF_HOME: join(this.options.dataDir, 'ismail', 'models'),
          TORCH_HOME: join(this.options.dataDir, 'ismail', 'models', 'torch'),
          HF_HUB_DISABLE_TELEMETRY: '1',
        },
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

  /** Installs Ismail into the app's Python environment, then restarts the sidecar on it. */
  installIsmail(separation: boolean): Promise<IsmailStatus> {
    this.installing ??= (async () => {
      const report = (line: string) => {
        this.options.log(`[ismail setup] ${line}`)
        this.options.onInstall?.(line)
      }
      try {
        const base = existsSync(this.venv) ? this.venv : findPython()?.executable
        if (!base) throw new SidecarError('unavailable', 'Python 3 was not found. Install Python 3.10 or later, then try again.')
        await this.stop()
        await installIsmail({ baseDir: this.pythonDir, python: base, separation, onProgress: report })
        this.message = null
      } catch (error) {
        this.message = error instanceof Error ? error.message : String(error)
        throw error
      } finally {
        this.installing = null
      }
      return this.ismailStatus()
    })()
    return this.installing
  }

  private begin(): AbortController {
    this.controller?.abort()
    const controller = new AbortController()
    this.controller = controller
    return controller
  }

  private end(controller: AbortController): void {
    if (this.controller === controller) this.controller = null
  }

  private async withWav<T>(wav: Uint8Array, work: (path: string, signal: AbortSignal) => Promise<T>): Promise<T> {
    const directory = join(this.options.dataDir, 'renders')
    await mkdir(directory, { recursive: true })
    const path = join(directory, `analysis-${randomUUID()}.wav`)
    await writeFile(path, wav)
    const controller = this.begin()
    try {
      return await work(path, controller.signal)
    } finally {
      this.end(controller)
      await rm(path, { force: true })
    }
  }

  async analyze(wav: Uint8Array, sections: { id: string; start: number; end: number }[], tempo?: Tempo): Promise<unknown> {
    const sidecar = await this.ensure()
    return this.withWav(wav, (path, signal) => sidecar.request('analyze', { path, sections, ...(tempo && { tempo }) }, { signal, onProgress: (p) => this.options.onProgress(p.completed, p.total, p.message ?? 'Analyzing') }))
  }

  async compare(wav: Uint8Array, reference: string, tempo?: Tempo): Promise<unknown> {
    const sidecar = await this.ensure()
    return this.withWav(wav, (path, signal) => sidecar.request('compare', { path, reference, ...(tempo && { tempo }) }, { signal, onProgress: (p) => this.options.onProgress(p.completed, p.total, p.message ?? 'Comparing') }))
  }

  async presets(): Promise<IsmailPresets> {
    const sidecar = await this.ensure()
    return sidecar.request<IsmailPresets>('presets')
  }

  async generate(request: IsmailGenerateRequest): Promise<IsmailSound> {
    const sidecar = await this.ensure()
    const controller = this.begin()
    try {
      const result = await sidecar.request<{ path: string; name: string; summary: string; description: string }>(
        'generate',
        { ...request, outDir: this.scratchDir },
        { signal: controller.signal, onProgress: (p) => this.options.onProgress(p.completed, p.total, p.message ?? 'Generating') },
      )
      try {
        return { name: result.name, summary: result.summary, description: result.description, wav: new Uint8Array(await readFile(result.path)) }
      } finally {
        await rm(result.path, { force: true })
      }
    } finally {
      this.end(controller)
    }
  }

  async separate(wav: Uint8Array): Promise<IsmailStem[]> {
    const sidecar = await this.ensure()
    return this.withWav(wav, async (path, signal) => {
      // Demucs cannot stop part-way, so a cancel stops the sidecar; the next request starts a fresh one.
      const onAbort = () => void this.stop()
      signal.addEventListener('abort', onAbort, { once: true })
      try {
        const result = await sidecar.request<{ stems: { name: string; path: string }[] }>(
          'separate',
          { path, outDir: this.scratchDir },
          { signal, timeoutMs: SEPARATE_TIMEOUT_MS, onProgress: (p) => this.options.onProgress(p.completed, p.total, p.message ?? 'Separating stems') },
        )
        try {
          return await Promise.all(result.stems.map(async (stem) => ({ name: stem.name, wav: new Uint8Array(await readFile(stem.path)) })))
        } finally {
          if (result.stems[0]) await rm(dirname(result.stems[0].path), { recursive: true, force: true })
        }
      } finally {
        signal.removeEventListener('abort', onAbort)
      }
    })
  }

  cancel(): void {
    this.controller?.abort()
  }

  async stop(): Promise<void> {
    const supervisor = this.supervisor
    this.supervisor = null
    await supervisor?.stop()
  }
}

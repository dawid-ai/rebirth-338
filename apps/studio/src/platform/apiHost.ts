import { type ApiRpcRequest, type ExecuteRequest, type RuntimeRequest, studio } from '@reborn/studio-core'
import { encodeWav, renderStems, renderStudio } from '@reborn/audio-engine/studio'
import { loadAgentSettings } from '../agent/agent'
import { runAnalysis, summarizeReport } from '../audio/analysis'
import { engine } from '../audio/host'
import { openProject, saveProject } from '../state/persistence'
import { addProposal, onResolved } from '../state/proposals'
import { dispatch, getState, isEdited, redo, subscribe, undo } from '../state/store'
import { launchScene } from '../components/Build'
import { desktop } from './desktop'

// Serves the desktop's local API. The main process owns the HTTP listener
// and authentication; requests arrive here because the project lives in the
// renderer. Scripts apply directly; agents create proposals unless the user
// enabled direct edits.

type Reply = { status: number; body: unknown }

const error = (status: number, code: string, message: string): Reply => ({ status, body: { error: { code, message } } })

// Jobs the server started, so it can cancel them and see their progress.
const jobs = new Map<string, AbortController>()

function jobControl(params: Record<string, unknown>, kind: string): { signal: AbortSignal; onProgress: (completed: number, total: number) => void; done: () => void } {
  const jobId = typeof params.jobId === 'string' ? params.jobId : null
  const controller = new AbortController()
  if (jobId) jobs.set(jobId, controller)
  let last = 0
  return {
    signal: controller.signal,
    onProgress: (completed, total) => {
      const now = Date.now()
      if (!jobId || !desktop || (now - last < 250 && completed < total)) return
      last = now
      desktop.emitApiEvent({ type: 'job', job: { id: jobId, kind, status: 'running', completed, total } })
    },
    done: () => {
      if (jobId) jobs.delete(jobId)
    },
  }
}

async function handle(request: ApiRpcRequest): Promise<Reply> {
  const s = getState()
  if (request.route === 'status') {
    const agent = await loadAgentSettings().catch(() => null)
    return {
      status: 200,
      body: {
        project: { name: s.project.name, revision: s.project.revision, path: s.document.path, bars: s.project.length, tempo: s.project.tempo },
        transport: { playing: s.transport.playing, bar: Math.floor(engine.position()) + 1 },
        directAgentEdits: agent?.directEdits ?? false,
      },
    }
  }
  if (request.route === 'execute') {
    const body = request.body as ExecuteRequest
    const commands = body.commands ?? []
    const mutating = commands.some((c) => studio.COMMANDS.get(c.type)?.mutates)
    try {
      if (!mutating) {
        const outcome = studio.executeBatch(s.project, commands)
        return { status: 200, body: { revision: s.project.revision, results: outcome.results, changed: false, status: 'read' } }
      }
      if (body.expectedRevision !== undefined && body.expectedRevision !== s.project.revision) return error(409, 'conflict', `The project changed (revision ${s.project.revision}, expected ${body.expectedRevision}). Read it again and retry.`)
      const dryRun = studio.executeBatch(s.project, commands, { origin: body.origin === 'agent' ? 'agent' : 'script' })
      const agent = body.origin === 'agent' ? await loadAgentSettings().catch(() => null) : null
      if (body.origin === 'agent' && !agent?.directEdits) {
        const proposal = addProposal({
          id: studio.newId('prp'),
          source: 'mcp',
          request: '',
          intent: body.intent || body.label || 'Changes from an external agent',
          evidence: [],
          changes: commands.map((command, i) => ({ id: `c${i + 1}`, summary: describeCommand(command), detail: JSON.stringify(command.params ?? {}), commands: [command] })),
        })
        return { status: 202, body: { revision: s.project.revision, results: dryRun.results, changed: false, status: 'proposed', proposalId: proposal.id } }
      }
      const results = dispatch(commands, { origin: body.origin === 'agent' ? 'agent' : 'script', label: body.label ?? (body.origin === 'agent' ? 'Agent edit' : 'Script edit'), quiet: false })
      return { status: 200, body: { revision: getState().project.revision, results, changed: true, status: 'applied' } }
    } catch (failure) {
      const code = failure instanceof studio.StudioError ? failure.code : 'internal'
      return error(code === 'conflict' ? 409 : code === 'not_found' ? 404 : code === 'invalid' ? 400 : 500, code, failure instanceof Error ? failure.message : String(failure))
    }
  }
  const runtime = request.body as RuntimeRequest
  const params = runtime.params ?? {}
  switch (runtime.action) {
    case 'transport.play':
      await engine.play()
      return { status: 200, body: { result: { playing: true } } }
    case 'transport.stop':
      engine.stop()
      return { status: 200, body: { result: { playing: false } } }
    case 'transport.seek': {
      const bar = Number(params.bar)
      if (!Number.isFinite(bar) || bar < 1) return error(400, 'invalid', 'transport.seek needs bar ≥ 1.')
      engine.seek(bar - 1)
      return { status: 200, body: { result: { bar } } }
    }
    case 'scene.launch': {
      const scene = s.project.scenes.find((x) => x.id === params.sceneId || x.name.toLowerCase() === String(params.sceneId ?? params.name ?? '').toLowerCase())
      if (!scene) return error(404, 'not_found', 'No such scene.')
      launchScene(scene.id)
      return { status: 200, body: { result: { sceneId: scene.id } } }
    }
    case 'history.undo':
      undo()
      return { status: 200, body: { result: { revision: getState().project.revision } } }
    case 'history.redo':
      redo()
      return { status: 200, body: { result: { revision: getState().project.revision } } }
    case 'project.save': {
      const ok = await saveProject(false)
      return ok ? { status: 200, body: { result: { path: getState().document.path } } } : error(409, 'conflict', 'The project was not saved. Choose a folder in the app first.')
    }
    case 'analysis.run': {
      const from = typeof params.from === 'number' ? params.from - 1 : undefined
      const to = typeof params.to === 'number' ? params.to : undefined
      const job = jobControl(params, 'analysis')
      try {
        const report = await runAnalysis({ from, to }, job.signal, job.onProgress)
        return { status: 200, body: { result: summarizeReport(report) } }
      } finally {
        job.done()
      }
    }
    case 'render.mix': {
      const job = jobControl(params, 'render')
      try {
        const rendered = await renderStudio(s.project, engine.assetBuffers(), { signal: job.signal, onProgress: job.onProgress })
        const wav = encodeWav(rendered.channels, rendered.sampleRate, params.bitDepth === 24 ? 24 : 16)
        return { status: 200, body: { result: { files: [{ name: `${slug(s.project.name)}.wav`, data: wav }] } } }
      } finally {
        job.done()
      }
    }
    case 'render.stems': {
      const job = jobControl(params, 'render')
      try {
        const stems = await renderStems(s.project, engine.assetBuffers(), { signal: job.signal, onProgress: job.onProgress })
        return { status: 200, body: { result: { files: stems.map((stem) => ({ name: `${slug(s.project.name)}-${slug(stem.name)}.wav`, data: encodeWav(stem.render.channels, stem.render.sampleRate, 24) })) } } }
      } finally {
        job.done()
      }
    }
    case 'job.cancel': {
      const controller = jobs.get(String(params.jobId))
      controller?.abort()
      return { status: 200, body: { result: { cancelled: Boolean(controller) } } }
    }
    case 'project.open': {
      if (typeof params.path !== 'string' || !params.path) return error(400, 'invalid', 'project.open needs a path.')
      // Never drop the user's unsaved work on a script's behalf.
      if (isEdited(s) && params.discardChanges !== true) return error(409, 'conflict', 'The open project has unsaved changes. Save it first, or pass discardChanges: true to drop them.')
      const before = s.project.id
      await openProject(params.path)
      const opened = getState()
      return opened.project.id !== before || opened.document.path === params.path ? { status: 200, body: { result: { name: opened.project.name, path: opened.document.path, revision: opened.project.revision } } } : error(404, 'not_found', `Could not open ${params.path}.`)
    }
    case 'proposal.list':
      return { status: 200, body: { result: s.proposals.map((p) => ({ id: p.id, intent: p.intent, status: p.status, changes: p.changes.length, source: p.source })) } }
    case 'proposal.status': {
      const proposal = s.proposals.find((p) => p.id === params.proposalId)
      return proposal ? { status: 200, body: { result: { id: proposal.id, status: proposal.status } } } : error(404, 'not_found', 'No such proposal.')
    }
    default:
      return error(400, 'invalid', `Unknown runtime action ${String(runtime.action)}.`)
  }
}

const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'export'

function describeCommand(command: studio.Command): string {
  const p = command.params ?? {}
  const target = p.trackId ?? p.clipId ?? p.patternId ?? p.returnId ?? ''
  return `${command.type}${target ? ` · ${String(target)}` : ''}`
}

export function startApiHost(): void {
  if (!desktop) return
  const bridge = desktop
  bridge.onApiRequest((request) => {
    handle(request)
      .then((reply) => bridge.respondApi({ id: request.id, ...reply }))
      .catch((failure) => bridge.respondApi({ id: request.id, status: 500, body: { error: { code: 'internal', message: failure instanceof Error ? failure.message : String(failure) } } }))
  })
  let lastRevision = getState().project.revision
  subscribe(() => {
    const s = getState()
    if (s.project.revision === lastRevision) return
    lastRevision = s.project.revision
    const entry = s.past[s.past.length - 1]
    bridge.emitApiEvent({ type: 'project', revision: s.project.revision, origin: entry?.origin ?? 'manual', label: entry?.label ?? '' })
  })
  onResolved((id, status) => bridge.emitApiEvent({ type: 'proposal', id, status }))
  let lastPlaying = getState().transport.playing
  subscribe(() => {
    const { transport } = getState()
    if (transport.playing === lastPlaying) return
    lastPlaying = transport.playing
    bridge.emitApiEvent({ type: 'transport', playing: transport.playing, bar: Math.floor(engine.position()) + 1 })
  })
}

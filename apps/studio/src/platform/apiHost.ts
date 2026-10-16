import { type ApiRpcRequest, type ExecuteRequest, type RuntimeRequest, studio } from '@reborn/studio-core'
import { encodeWav, renderStems, renderStudio } from '@reborn/audio-engine/studio'
import { loadAgentSettings } from '../agent/agent'
import { runAnalysis, summarizeReport } from '../audio/analysis'
import { engine } from '../audio/host'
import { saveProject } from '../state/persistence'
import { addProposal, onResolved } from '../state/proposals'
import { dispatch, getState, redo, subscribe, undo } from '../state/store'
import { launchScene } from '../components/Build'
import { desktop } from './desktop'

// Serves the desktop's local API. The main process owns the HTTP listener
// and authentication; requests arrive here because the project lives in the
// renderer. Scripts apply directly; agents create proposals unless the user
// enabled direct edits.

type Reply = { status: number; body: unknown }

const error = (status: number, code: string, message: string): Reply => ({ status, body: { error: { code, message } } })

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
      const report = await runAnalysis({ from, to })
      return { status: 200, body: { result: summarizeReport(report) } }
    }
    case 'render.mix': {
      const rendered = await renderStudio(s.project, engine.assetBuffers())
      const wav = encodeWav(rendered.channels, rendered.sampleRate, params.bitDepth === 24 ? 24 : 16)
      return { status: 200, body: { result: { files: [{ name: `${slug(s.project.name)}.wav`, data: wav }] } } }
    }
    case 'render.stems': {
      const stems = await renderStems(s.project, engine.assetBuffers())
      return { status: 200, body: { result: { files: stems.map((stem) => ({ name: `${slug(s.project.name)}-${slug(stem.name)}.wav`, data: encodeWav(stem.render.channels, stem.render.sampleRate, 24) })) } } }
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
}

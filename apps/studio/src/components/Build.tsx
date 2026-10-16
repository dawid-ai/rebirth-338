import { CircleStop, Play, Plus } from 'lucide-react'
import type { CSSProperties } from 'react'
import { studio } from '@reborn/studio-core'
import { engine, usePlayhead } from '../audio/host'
import { dispatch, getState, select, setState, toast, useStudio } from '../state/store'

// Build view: tracks are rows, scenes are columns. Launching a scene starts
// its column at the next bar. With record armed, launches are written into
// the arrangement.

interface RecordedLaunch {
  sceneId: string
  start: number
}

let recorded: RecordedLaunch[] = []
let recordStart = 0

export function launchScene(sceneId: string) {
  const s = getState()
  const scene = s.project.scenes.find((x) => x.id === sceneId)
  if (!scene) return
  const at = Math.floor(engine.position()) + (s.transport.playing ? 1 : 0)
  engine.launchScene(scene.id, scene.slots)
  if (s.recording) {
    if (!recorded.length) recordStart = at
    recorded.push({ sceneId, start: at })
  }
}

/** Writes recorded scene launches into the arrangement when recording stops. */
export function commitSceneRecording() {
  if (!recorded.length) return
  const end = Math.max(Math.ceil(engine.position()), recorded[recorded.length - 1].start + 1)
  const launches = recorded.map((launch, index) => ({ sceneId: launch.sceneId, start: launch.start, length: (recorded[index + 1]?.start ?? end) - launch.start })).filter((l) => l.length > 0)
  recorded = []
  if (!launches.length) return
  dispatch({ type: 'scene.record', params: { launches } }, { label: `Record ${launches.length} scene launch${launches.length === 1 ? '' : 'es'}` })
  toast(`Recorded scenes into bars ${recordStart + 1}–${end}`, 'success')
}

function Cell({ track, scene }: { track: studio.Track; scene: studio.Scene }) {
  const patternId = scene.slots[track.id]
  const pattern = useStudio((s) => (patternId ? s.project.patterns[patternId] : undefined))
  const patterns = useStudio((s) => s.project.patterns)
  const options = Object.values(patterns).filter((p) => p.kind === studio.patternKindFor(track.kind))
  if (!studio.patternKindFor(track.kind)) return <div className="scene-cell is-na" />
  return (
    <div className={`scene-cell${pattern ? ' has-pattern' : ''}`} style={{ '--track': track.color } as CSSProperties}>
      <select
        value={patternId ?? ''}
        aria-label={`${track.name} pattern in ${scene.name}`}
        onChange={(event) => dispatch({ type: 'scene.set', params: { sceneId: scene.id, trackId: track.id, patternId: event.target.value } }, { label: 'Change scene slot' })}
      >
        <option value="">—</option>
        {options.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      {pattern && (
        <button
          type="button"
          className="cell-edit"
          onClick={() => {
            const clip = getState().project.clips.find((c) => c.patternId === pattern.id)
            if (clip) select({ kind: 'clip', clipId: clip.id })
            else toast('Place this pattern in the arrangement to edit it in the dock.')
          }}
          title="Edit this pattern"
        >
          Edit
        </button>
      )}
    </div>
  )
}

export function Build() {
  const tracks = useStudio((s) => s.project.tracks)
  const scenes = useStudio((s) => s.project.scenes)
  const launched = useStudio((s) => s.transport.launchedSceneId)
  const queued = useStudio((s) => s.transport.queuedSceneId)
  const recording = useStudio((s) => s.recording)
  const beat = usePlayhead((bar) => Math.floor((bar % 1) * 4))
  return (
    <div className="build">
      <div className="build-head">
        <p className="muted">Scenes launch at the next bar. {recording ? 'Recording: launches will be written into the arrangement.' : 'Arm record (R) to write launches into the arrangement.'}</p>
        <button type="button" className="chip-btn" onClick={() => engine.returnToArrangement()}>
          <CircleStop size={13} />
          Back to arrangement
        </button>
        <button type="button" className="chip-btn" onClick={() => dispatch({ type: 'scene.add', params: {} }, { label: 'Add scene' })}>
          <Plus size={13} />
          Scene
        </button>
      </div>
      <div className="scene-grid" style={{ gridTemplateColumns: `160px repeat(${scenes.length}, minmax(140px, 1fr))` }}>
        <div className="scene-corner">
          <span className="beat-dots" aria-hidden="true">
            {[0, 1, 2, 3].map((b) => (
              <i key={b} className={b === beat ? 'on' : undefined} />
            ))}
          </span>
        </div>
        {scenes.map((scene) => (
          <div key={scene.id} className={`scene-head${launched === scene.id ? ' is-playing' : ''}${queued === scene.id ? ' is-queued' : ''}`}>
            <button type="button" className="launch" onClick={() => launchScene(scene.id)} aria-label={`Launch ${scene.name}`} title="Launch at the next bar">
              <Play size={14} />
            </button>
            <input
              defaultValue={scene.name}
              aria-label="Scene name"
              onKeyDown={(event) => event.stopPropagation()}
              onBlur={(event) => event.target.value !== scene.name && dispatch({ type: 'scene.set', params: { sceneId: scene.id, name: event.target.value } }, { label: 'Rename scene' })}
              onFocus={() => select({ kind: 'scene', sceneId: scene.id })}
            />
          </div>
        ))}
        {tracks.map((track) => (
          <div key={track.id} style={{ display: 'contents' }}>
            <div className="scene-track" style={{ '--track': track.color } as CSSProperties} onClick={() => select({ kind: 'track', trackId: track.id })}>
              <i />
              {track.name}
            </div>
            {scenes.map((scene) => (
              <Cell key={scene.id} track={track} scene={scene} />
            ))}
          </div>
        ))}
      </div>
      {!scenes.length && <p className="empty-note">No scenes yet. Add one, pick a pattern per track, then launch it.</p>}
      <button type="button" className="sr-only" onClick={() => setState({ recording: !recording })}>
        Toggle recording
      </button>
    </div>
  )
}

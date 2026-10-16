import { AudioWaveform, Disc3, Drum, FileUp, Folder, FolderOpen, Layers, Package, PanelLeft, Piano, Plus, Save, Sparkles, Waves } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { createDemoProject, demoCatalog, studio, type RecentProject } from '@reborn/studio-core'
import { engine, ensureAssets, importAudioFile } from '../audio/host'
import { desktop } from '../platform/desktop'
import { importProjectFile, newProject, openProject, saveProject } from '../state/persistence'
import { dispatch, getState, loadProject, selectedTrackId, setPrefs, toast, useStudio } from '../state/store'
import { addTrack } from './AddTrackMenu'
import { IsmailPanel } from './IsmailPanel'
import { loadIntoSampler } from './SampleEditors'

const STARTER = [
  { file: 'loop_amen.ogg', label: 'Amen break', note: 'Classic breakbeat loop' },
  { file: 'loop_breakbeat.ogg', label: 'Breakbeat', note: 'Dusty drum loop' },
  { file: 'loop_compus.ogg', label: 'Compus', note: 'Percussion loop' },
  { file: 'bd_808.ogg', label: '808 kick', note: 'One shot' },
  { file: 'sn_dub.ogg', label: 'Dub snare', note: 'One shot' },
  { file: 'hat_zan.ogg', label: 'Hat', note: 'One shot' },
  { file: 'perc_snap.ogg', label: 'Snap', note: 'One shot' },
  { file: 'bass_hit_c.ogg', label: 'Bass hit C', note: 'One shot' },
  { file: 'ambi_piano.ogg', label: 'Ambient piano', note: 'Texture' },
  { file: 'vinyl_scratch.ogg', label: 'Scratch', note: 'FX' },
  { file: 'vinyl_backspin.ogg', label: 'Backspin', note: 'FX' },
]

export const ASSET_MIME = 'application/x-reborn-asset'

function registerBuiltin(file: string): string {
  const id = `builtin:${file}`
  if (!getState().project.assets[id]) {
    dispatch({ type: 'asset.add', params: { asset: { id, name: file, mimeType: 'audio/ogg', bytes: 0, duration: 0, channels: 2, sampleRate: 44100, origin: { kind: 'builtin', source: file, createdAt: new Date().toISOString() } } } }, { label: `Add ${file}` })
  }
  return id
}

async function placeAsset(assetId: string) {
  await ensureAssets(getState().project)
  const s = getState()
  const trackId = selectedTrackId(s)
  const track = s.project.tracks.find((t) => t.id === trackId) ?? s.project.tracks.find((t) => t.kind === 'sampler')
  if (!track) return toast('Add a Sampler or Audio track first.')
  if (track.kind === 'sampler') await loadIntoSampler(track.id, assetId)
  else if (track.kind === 'audio') {
    const asset = getState().project.assets[assetId]
    const bars = asset?.duration ? Math.max(0.25, Math.round((asset.duration / studio.barSeconds(s.project)) * 4) / 4) : 4
    dispatch({ type: 'clip.create', params: { trackId: track.id, start: Math.floor(engine.position()), length: bars, assetId } }, { label: `Place ${asset?.name}` })
  } else if (track.kind === 'deck') dispatch({ type: 'deck.set', params: { trackId: track.id, assetId } }, { label: 'Load deck' })
  else toast(`Select a Sampler, Audio, or Deck track to load audio. ${track.name} plays patterns.`)
}

function Samples() {
  const assets = useStudio((s) => s.project.assets)
  const input = useRef<HTMLInputElement>(null)
  const user = Object.values(assets).filter((a) => !a.id.startsWith('builtin:'))
  return (
    <div className="browser-list">
      <p className="browser-note">Drag onto a Sampler, Audio, or Deck lane, or double-click to load into the selected track.</p>
      <button type="button" className="chip-btn" onClick={() => input.current?.click()}>
        <FileUp size={13} />
        Import audio files
      </button>
      <input
        ref={input}
        type="file"
        accept="audio/*,.wav,.mp3,.ogg,.flac,.aif,.aiff,.m4a"
        multiple
        hidden
        onChange={async (event) => {
          for (const file of [...(event.target.files ?? [])]) await importAudioFile(file)
          event.target.value = ''
        }}
      />
      {user.length > 0 && <h4>In this project</h4>}
      {user.map((asset) => (
        <div key={asset.id} className="browser-item sample" draggable onDragStart={(event) => event.dataTransfer.setData(ASSET_MIME, asset.id)} onDoubleClick={() => void placeAsset(asset.id)} tabIndex={0} onKeyDown={(event) => event.key === 'Enter' && void placeAsset(asset.id)} title={`${asset.origin.kind === 'resample' ? 'Resampled' : 'Imported'} · ${asset.duration.toFixed(2)} s`}>
          <AudioWaveform size={18} />
          <div>
            <strong>{asset.name}</strong>
            <small>
              {asset.duration ? `${asset.duration.toFixed(2)} s` : 'Loading'} · {asset.origin.kind}
            </small>
          </div>
        </div>
      ))}
      <h4>Starter sounds</h4>
      {STARTER.map((item) => (
        <div
          key={item.file}
          className="browser-item sample"
          draggable
          onDragStart={(event) => event.dataTransfer.setData(ASSET_MIME, registerBuiltin(item.file))}
          onDoubleClick={() => void placeAsset(registerBuiltin(item.file))}
          tabIndex={0}
          onKeyDown={(event) => event.key === 'Enter' && void placeAsset(registerBuiltin(item.file))}
        >
          <AudioWaveform size={18} />
          <div>
            <strong>{item.label}</strong>
            <small>{item.note}</small>
          </div>
        </div>
      ))}
    </div>
  )
}

const DEVICES: { kind: studio.TrackKind; icon: typeof Piano; note: string }[] = [
  { kind: 'acid', icon: Piano, note: 'Two-pole squelch bass' },
  { kind: 'wave', icon: Waves, note: 'Pads and leads' },
  { kind: 'drum', icon: Drum, note: '808 and 909 voices' },
  { kind: 'sampler', icon: AudioWaveform, note: 'Chops on 16 pads' },
  { kind: 'audio', icon: AudioWaveform, note: 'Audio and stems' },
  { kind: 'deck', icon: Disc3, note: 'Live DJ playback' },
  { kind: 'group', icon: Layers, note: 'Bus several tracks' },
]

function Devices() {
  return (
    <div className="browser-list">
      <p className="browser-note">Click to add a track with a fresh device.</p>
      {DEVICES.map(({ kind, icon: Icon, note }) => (
        <button key={kind} type="button" className="browser-item" onClick={() => addTrack(kind)}>
          <Icon size={18} />
          <div>
            <strong>{studio.DEVICE_NAMES[kind]}</strong>
            <small>{note}</small>
          </div>
          <Plus size={13} />
        </button>
      ))}
    </div>
  )
}

function Projects() {
  const [recent, setRecent] = useState<RecentProject[]>([])
  const path = useStudio((s) => s.document.path)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (desktop) void desktop.listRecent().then(setRecent)
  }, [path])
  return (
    <div className="browser-list">
      <div className="browser-actions">
        <button type="button" className="chip-btn" onClick={() => newProject()}>
          <Plus size={13} />
          New
        </button>
        {desktop ? (
          <>
            <button type="button" className="chip-btn" onClick={() => void openProject()}>
              <FolderOpen size={13} />
              Open…
            </button>
            <button type="button" className="chip-btn" onClick={() => void saveProject(false)}>
              <Save size={13} />
              Save
            </button>
            <button type="button" className="chip-btn" onClick={() => void saveProject(true)}>
              Save as…
            </button>
            <button
              type="button"
              className="chip-btn"
              onClick={async () => {
                if (!getState().document.path || getState().document.savedRevision !== getState().project.revision) {
                  if (!(await saveProject(false))) return
                }
                const target = getState().document.path
                if (target) await desktop!.packProject(target)
              }}
            >
              <Package size={13} />
              Pack…
            </button>
          </>
        ) : (
          <>
            <button type="button" className="chip-btn" onClick={() => input.current?.click()}>
              <FolderOpen size={13} />
              Import project…
            </button>
            <button type="button" className="chip-btn" onClick={() => void saveProject(false)}>
              <Save size={13} />
              Download
            </button>
          </>
        )}
      </div>
      <input ref={input} type="file" accept=".json,.rb338" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void importProjectFile(file); event.target.value = '' }} />
      {desktop && recent.length > 0 && <h4>Recent</h4>}
      {recent.map((item) => (
        <button key={item.path} type="button" className="browser-item" onClick={() => void openProject(item.path)} title={item.path}>
          <Folder size={18} />
          <div>
            <strong>{item.name}</strong>
            <small>{item.path}</small>
          </div>
        </button>
      ))}
      <h4>Start from a template</h4>
      {studio.TEMPLATES.map((template) => (
        <button key={template.id} type="button" className="browser-item" onClick={() => newProject(template.id)}>
          <Plus size={18} />
          <div>
            <strong>{template.label}</strong>
            <small>{template.detail}</small>
          </div>
        </button>
      ))}
      <h4>Demo songs</h4>
      {demoCatalog.map((demo) => (
        <button
          key={demo.id}
          type="button"
          className="browser-item"
          onClick={() => {
            const { project, report } = studio.importV1Project(createDemoProject(demo.id))
            loadProject(project, { path: null, savedRevision: null })
            void ensureAssets(project)
            toast(report.notes[report.notes.length - 1] ?? 'Demo loaded', 'success')
          }}
        >
          <Layers size={18} />
          <div>
            <strong>{demo.label}</strong>
            <small>{demo.detail}</small>
          </div>
        </button>
      ))}
    </div>
  )
}

type Tab = 'samples' | 'devices' | 'projects' | 'generate'

const TAB_ICONS = { samples: AudioWaveform, devices: Piano, projects: Folder, generate: Sparkles } as const

export function Browser({ open, overlay, onToggle }: { open: boolean; overlay: boolean; onToggle: () => void }) {
  const [tab, setTab] = useState<Tab>('samples')
  const show = (next: Tab) => {
    setTab(next)
    if (!open) onToggle()
  }
  if (!open) {
    return (
      <nav className="browser is-rail" aria-label="Browser" data-region="browser" tabIndex={-1}>
        <button type="button" className="icon-btn" onClick={onToggle} title="Open browser" aria-label="Open browser">
          <PanelLeft size={16} />
        </button>
        <button type="button" className="icon-btn" onClick={() => show('samples')} title="Samples" aria-label="Samples">
          <AudioWaveform size={16} />
        </button>
        <button type="button" className="icon-btn" onClick={() => show('devices')} title="Devices" aria-label="Devices">
          <Piano size={16} />
        </button>
        <button type="button" className="icon-btn" onClick={() => show('projects')} title="Projects" aria-label="Projects">
          <Folder size={16} />
        </button>
        <button type="button" className="icon-btn" onClick={() => show('generate')} title="Generate sounds with Ismail" aria-label="Generate">
          <Sparkles size={16} />
        </button>
      </nav>
    )
  }
  return (
    <nav className={`browser${overlay ? ' is-overlay' : ''}`} aria-label="Browser" data-region="browser" tabIndex={-1}>
      <div className="panel-head">
        <div className="tabs" role="tablist">
          {(['samples', 'devices', 'projects', 'generate'] as Tab[]).map((name) => {
            const label = name[0].toUpperCase() + name.slice(1)
            const Icon = TAB_ICONS[name]
            // Inactive tabs show only their icon so four fit; the name stays as the accessible label.
            return (
              <button key={name} type="button" role="tab" aria-selected={tab === name} aria-label={label} title={label} className={tab === name ? 'is-on' : ''} onClick={() => setTab(name)}>
                <Icon size={14} aria-hidden="true" />
                {tab === name && <span>{label}</span>}
              </button>
            )
          })}
        </div>
        <button type="button" className="icon-btn" onClick={() => { onToggle(); setPrefs({ browserOpen: false }) }} title="Collapse browser" aria-label="Collapse browser">
          <PanelLeft size={16} />
        </button>
      </div>
      {tab === 'samples' && <Samples />}
      {tab === 'devices' && <Devices />}
      {tab === 'projects' && <Projects />}
      {tab === 'generate' && <IsmailPanel />}
    </nav>
  )
}

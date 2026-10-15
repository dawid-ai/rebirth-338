import { AudioWaveform, Drum, Folder, PanelLeft, Piano, Waves } from 'lucide-react'
import { useState } from 'react'
import { LIBRARY, breakPeaks } from '../break'
import { useStudio } from '../studio'
import { SAMPLE_MIME, importBreak } from './actions'

type Tab = 'samples' | 'devices' | 'projects'

const DEVICES = [
  { name: 'Acid Synth', note: 'Two-pole squelch bass', icon: Piano },
  { name: 'Wave Synth', note: 'Wavetable pads and leads', icon: Waves },
  { name: 'Drum Machine', note: '808 and 909 voices', icon: Drum },
  { name: 'Sampler', note: 'Chops, pads, and 16 Levels', icon: AudioWaveform },
]

function MiniWave({ seed }: { seed: number }) {
  const peaks = breakPeaks(seed, 64)
  return (
    <svg className="mini-wave" viewBox="0 0 64 16" preserveAspectRatio="none" aria-hidden="true">
      {peaks.map((peak, i) => (
        <rect key={i} x={i} y={8 - peak * 7} width={0.7} height={Math.max(0.6, peak * 14)} />
      ))}
    </svg>
  )
}

interface BrowserProps {
  open: boolean
  overlay: boolean
  onToggle: () => void
}

export function Browser({ open, overlay, onToggle }: BrowserProps) {
  const studio = useStudio()
  const [tab, setTab] = useState<Tab>('samples')

  if (!open) {
    return (
      <nav className="browser is-rail" aria-label="Browser">
        <button type="button" className="icon-btn" onClick={onToggle} title="Open browser" aria-label="Open browser">
          <PanelLeft size={16} />
        </button>
        <button type="button" className="icon-btn" onClick={() => { setTab('samples'); onToggle() }} title="Samples" aria-label="Samples">
          <AudioWaveform size={16} />
        </button>
        <button type="button" className="icon-btn" onClick={() => { setTab('devices'); onToggle() }} title="Devices" aria-label="Devices">
          <Piano size={16} />
        </button>
        <button type="button" className="icon-btn" onClick={() => { setTab('projects'); onToggle() }} title="Projects" aria-label="Projects">
          <Folder size={16} />
        </button>
      </nav>
    )
  }

  return (
    <nav className={`browser${overlay ? ' is-overlay' : ''}`} aria-label="Browser">
      <div className="panel-head">
        <div className="tabs" role="tablist">
          {(['samples', 'devices', 'projects'] as Tab[]).map((name) => (
            <button key={name} type="button" role="tab" aria-selected={tab === name} className={tab === name ? 'is-on' : ''} onClick={() => setTab(name)}>
              {name[0].toUpperCase() + name.slice(1)}
            </button>
          ))}
        </div>
        <button type="button" className="icon-btn" onClick={onToggle} title="Collapse browser" aria-label="Collapse browser">
          <PanelLeft size={16} />
        </button>
      </div>

      {tab === 'samples' && (
        <div className="browser-list">
          <p className="browser-note">Drag a break onto the Sampler track, or double-click it.</p>
          {LIBRARY.map((item) => (
            <div
              key={item.file}
              className={`browser-item sample${studio.project.sample?.name === item.file ? ' is-loaded' : ''}`}
              draggable
              tabIndex={0}
              onDragStart={(event) => {
                event.dataTransfer.setData(SAMPLE_MIME, item.file)
                event.dataTransfer.effectAllowed = 'copy'
              }}
              onDoubleClick={() => importBreak(studio, item)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') importBreak(studio, item)
              }}
              title="Double-click or press Enter to load into Sampler"
            >
              <MiniWave seed={item.seed} />
              <div>
                <strong>{item.file}</strong>
                <small>
                  {item.bpm} BPM · {item.feel}
                </small>
              </div>
            </div>
          ))}
        </div>
      )}

      {tab === 'devices' && (
        <div className="browser-list">
          <p className="browser-note">Adding tracks from the browser lands in Phase 2.</p>
          {DEVICES.map(({ name, note, icon: Icon }) => (
            <div key={name} className="browser-item">
              <Icon size={18} />
              <div>
                <strong>{name}</strong>
                <small>{note}</small>
              </div>
            </div>
          ))}
        </div>
      )}

      {tab === 'projects' && (
        <div className="browser-list">
          <div className="browser-item is-loaded">
            <Folder size={18} />
            <div>
              <strong>Night Shift.reborn</strong>
              <small>Open · {studio.project.length} bars</small>
            </div>
          </div>
          <p className="browser-note">Opening and saving .reborn folders lands in Phase 1.</p>
        </div>
      )}
    </nav>
  )
}

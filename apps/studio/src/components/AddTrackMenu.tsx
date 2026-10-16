import { AudioWaveform, Disc3, Drum, Layers, Piano, Plus, Waves } from 'lucide-react'
import { useState } from 'react'
import { studio } from '@reborn/studio-core'
import { dispatch, select } from '../state/store'

const KINDS: { kind: studio.TrackKind; icon: typeof Piano; note: string }[] = [
  { kind: 'acid', icon: Piano, note: 'Squelchy two-pole bass' },
  { kind: 'wave', icon: Waves, note: 'Pads and leads' },
  { kind: 'drum', icon: Drum, note: '808 or 909 voices' },
  { kind: 'sampler', icon: AudioWaveform, note: 'Chops on 16 pads' },
  { kind: 'audio', icon: AudioWaveform, note: 'Recorded audio and stems' },
  { kind: 'deck', icon: Disc3, note: 'Live DJ playback' },
  { kind: 'group', icon: Layers, note: 'Bus for several tracks' },
]

export function addTrack(kind: studio.TrackKind) {
  const results = dispatch({ type: 'track.add', params: { kind } }, { label: `Add ${studio.DEVICE_NAMES[kind]}` })
  const trackId = (results?.[0] as { trackId: string } | undefined)?.trackId
  if (trackId) select({ kind: 'track', trackId })
}

export function AddTrackMenu() {
  const [open, setOpen] = useState(false)
  return (
    <div className="add-track">
      <button type="button" className="chip-btn" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Plus size={13} />
        Add track
      </button>
      {open && (
        <div className="menu" role="menu">
          {KINDS.map(({ kind, icon: Icon, note }) => (
            <button
              key={kind}
              type="button"
              role="menuitem"
              onClick={() => {
                addTrack(kind)
                setOpen(false)
              }}
            >
              <Icon size={15} />
              <span>
                <strong>{studio.DEVICE_NAMES[kind]}</strong>
                <small>{note}</small>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

import { ArrowRight, Upload } from 'lucide-react'
import { type PointerEvent as ReactPointerEvent, useMemo, useRef, useState } from 'react'
import { estimateKey, estimateTempo, sliceByBeats, sliceByTransients, sliceEqual } from '@reborn/analysis'
import { studio } from '@reborn/studio-core'
import { engine, importAudioFile } from '../audio/host'
import { mono, peaks } from '../audio/peaks'
import { PAD_KEYS, PAD_ORDER, recordHit } from '../audio/recorder'
import { dispatch, getState, select, useStudio } from '../state/store'

type Track = studio.Track
type Clip = studio.Clip

const analysisCache = new Map<string, { bpm: number; bpmConfidence: number; key: string | null; keyConfidence: number; transients: number[] }>()

function analyzeSource(assetId: string, buffer: AudioBuffer) {
  const cached = analysisCache.get(assetId)
  if (cached) return cached
  const signal = mono(buffer)
  const tempo = estimateTempo(signal, buffer.sampleRate, { min: 70, max: 180 })
  const key = estimateKey(signal, buffer.sampleRate)
  const transients = sliceByTransients(signal, buffer.sampleRate, { maxSlices: 16 })
  const result = { bpm: Math.round(tempo.bpm * 10) / 10, bpmConfidence: tempo.confidence, key: key.key, keyConfidence: key.confidence, transients }
  analysisCache.set(assetId, result)
  return result
}

export function PadGrid({ track }: { track: Track }) {
  const [flash, setFlash] = useState<{ pad: number; at: number } | null>(null)
  const selection = useStudio((s) => s.selection)
  if (track.device.kind !== 'sampler') return null
  const device = track.device
  const hit = (pad: number) => {
    void engine.triggerPad(track.id, pad)
    recordHit({ trackId: track.id, pad, velocity: 100 })
    setFlash({ pad, at: performance.now() })
    select({ kind: 'pad', trackId: track.id, pad })
  }
  return (
    <div className="pad-grid" role="group" aria-label={`${track.name} pads`}>
      {PAD_ORDER.map((pad) => {
        const state = device.pads[pad]
        const sliceIndex = device.source ? device.source.slices.findIndex((s, i) => state.assetId === device.source!.assetId && Math.abs(s - state.start) < 1e-6 && i >= 0) : -1
        const selected = selection.kind === 'pad' && selection.trackId === track.id && selection.pad === pad
        return (
          <button key={pad} type="button" className={`pad${state.assetId ? '' : ' is-empty'}${selected ? ' is-selected' : ''}`} onPointerDown={() => hit(pad)} aria-label={`Pad ${pad + 1}${state.assetId ? `, ${state.name}` : ', empty'}`}>
            {flash?.pad === pad && <i key={flash.at} className="pad-flash" />}
            <kbd>{PAD_KEYS[pad].toUpperCase()}</kbd>
            <span>{state.assetId ? (sliceIndex >= 0 ? `S${sliceIndex + 1}` : state.name.slice(0, 8)) : '—'}</span>
          </button>
        )
      })}
    </div>
  )
}

function FilePicker({ onPick, label }: { onPick: (file: File) => void; label: string }) {
  const input = useRef<HTMLInputElement>(null)
  return (
    <>
      <button type="button" className="chip-btn" onClick={() => input.current?.click()}>
        <Upload size={13} />
        {label}
      </button>
      <input
        ref={input}
        type="file"
        accept="audio/*,.wav,.mp3,.ogg,.flac,.aif,.aiff,.m4a"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0]
          if (file) onPick(file)
          event.target.value = ''
        }}
      />
    </>
  )
}

export async function loadIntoSampler(trackId: string, assetId: string) {
  const buffer = engine.buffer(assetId)
  const name = getState().project.assets[assetId]?.name ?? 'sample'
  if (!buffer) {
    dispatch({ type: 'sample.slice', params: { trackId, assetId, slices: [0], mode: 'manual', assignPads: true } }, { label: `Load ${name}` })
    return
  }
  const analysis = analyzeSource(assetId, buffer)
  const bars = analysis.bpm > 0 ? Math.max(0.25, Math.round(((buffer.duration * analysis.bpm) / 240) * 4) / 4) : null
  dispatch(
    { type: 'sample.slice', params: { trackId, assetId, slices: analysis.transients, mode: 'transient', bpm: analysis.bpm || undefined, bpmConfidence: analysis.bpmConfidence, ...(bars !== null && { bars }), assignPads: true } },
    { label: `Load and chop ${name}` },
  )
  select({ kind: 'slice', trackId, index: null })
}

export function ChopEditor({ track }: { track: Track }) {
  const selection = useStudio((s) => s.selection)
  const asset = useStudio((s) => (track.device.kind === 'sampler' && track.device.source ? s.project.assets[track.device.source.assetId] : undefined))
  const svgRef = useRef<SVGSVGElement>(null)
  const drag = useRef<number | null>(null)
  const device = track.device.kind === 'sampler' ? track.device : null
  const source = device?.source ?? null
  const buffer = source ? engine.buffer(source.assetId) : undefined
  const columns = useMemo(() => (buffer ? peaks(buffer, 600) : []), [buffer])
  const analysis = buffer && source ? analyzeSource(source.assetId, buffer) : null
  const selectedSlice = selection.kind === 'slice' && selection.trackId === track.id ? selection.index : null
  if (!device) return null

  if (!source) {
    return (
      <div className="editor chop-editor">
        <div className="chop-empty">
          <p>Drop a break or loop on the {track.name} lane, drag one from the browser, or choose a file. RE:BORN detects its tempo and transients and chops it across the 16 pads.</p>
          <FilePicker
            label="Choose audio file"
            onPick={async (file) => {
              const id = await importAudioFile(file)
              if (id) await loadIntoSampler(track.id, id)
            }}
          />
        </div>
      </div>
    )
  }

  const reslice = (mode: 'transient' | 'equal' | 'beat' | 'bar', count = 16) => {
    if (!buffer) return
    const bpm = source.bpm ?? analysis?.bpm ?? 0
    const slices = mode === 'transient' ? (analysis?.transients ?? [0]) : mode === 'equal' ? sliceEqual(count) : sliceByBeats(bpm, buffer.duration, mode === 'beat' ? 1 : 4)
    dispatch({ type: 'sample.slice', params: { trackId: track.id, slices, mode } }, { label: `Slice by ${mode}` })
  }
  const toFraction = (clientX: number) => {
    const rect = svgRef.current!.getBoundingClientRect()
    return Math.max(0, Math.min(0.999, (clientX - rect.left) / rect.width))
  }
  const sliceAt = (x: number) => {
    let index = 0
    source.slices.forEach((s, i) => {
      if (s <= x) index = i
    })
    return index
  }
  const onMarkerDown = (event: ReactPointerEvent<SVGRectElement>, index: number) => {
    event.stopPropagation()
    ;(event.currentTarget as Element).setPointerCapture(event.pointerId)
    drag.current = index
    select({ kind: 'slice', trackId: track.id, index })
  }
  const grid = source.bars ? Array.from({ length: Math.round(source.bars * 4) }, (_, i) => i / (source.bars! * 4)) : []

  return (
    <div className="editor chop-editor">
      <div className="editor-bar">
        <div className="analysis">
          <strong className="file">{asset?.name ?? 'Sample'}</strong>
          {analysis && (
            <>
              <label className="bpm-fix" title="Detected tempo. Type to correct it; beat and bar slicing use this value.">
                <input
                  type="number"
                  min={40}
                  max={240}
                  step={0.1}
                  value={source.bpm ?? analysis.bpm}
                  aria-label="Sample tempo in BPM"
                  onKeyDown={(event) => event.stopPropagation()}
                  onChange={(event) => {
                    const bpm = Number(event.target.value)
                    if (bpm >= 40 && bpm <= 240 && buffer) dispatch({ type: 'sample.slice', params: { trackId: track.id, slices: source.slices, bpm, bpmConfidence: 1, bars: Math.round(((buffer.duration * bpm) / 240) * 4) / 4 } }, { label: 'Correct tempo', key: `bpm-${track.id}` })
                  }}
                />
                BPM <em className={analysis.bpmConfidence < 0.5 && source.bpmConfidence < 1 ? 'low' : undefined}>{source.bpmConfidence >= 1 ? 'set' : `${Math.round(analysis.bpmConfidence * 100)}%`}</em>
              </label>
              <span title="Detected key and confidence">{analysis.key ? <>{analysis.key} <em className={analysis.keyConfidence < 0.5 ? 'low' : undefined}>{Math.round(analysis.keyConfidence * 100)}%</em></> : 'Key: unclear'}</span>
              <span>
                {buffer ? `${buffer.duration.toFixed(2)} s` : ''} · {source.slices.length} slices
              </span>
            </>
          )}
        </div>
        <div className="seg" role="radiogroup" aria-label="Slice mode">
          {(['transient', 'equal', 'beat', 'bar'] as const).map((mode) => (
            <button key={mode} type="button" role="radio" aria-checked={source.sliceMode === mode} className={source.sliceMode === mode ? 'is-on' : ''} onClick={() => reslice(mode)}>
              {mode === 'transient' ? 'Transient' : mode === 'equal' ? 'Equal 16' : mode === 'beat' ? 'Beat' : 'Bar'}
            </button>
          ))}
        </div>
        <button type="button" className="chip-btn" onClick={() => dispatch({ type: 'sample.slice', params: { trackId: track.id, slices: source.slices, assignPads: true } }, { label: 'Distribute slices to pads' })} title="Assign slice N to pad N">
          Slices <ArrowRight size={12} /> pads
        </button>
        <FilePicker
          label="Replace"
          onPick={async (file) => {
            const id = await importAudioFile(file)
            if (id) await loadIntoSampler(track.id, id)
          }}
        />
      </div>
      <div className="chop-split">
        <div className="bone wave-wrap">
          {!buffer ? (
            <p className="loading-note">Decoding audio…</p>
          ) : (
            <svg
              ref={svgRef}
              className="wave"
              viewBox="0 0 1000 140"
              preserveAspectRatio="none"
              onPointerMove={(event) => {
                const index = drag.current
                if (index === null) return
                const lower = index > 0 ? source.slices[index - 1] + 0.003 : 0
                const upper = index < source.slices.length - 1 ? source.slices[index + 1] - 0.003 : 0.997
                if (index === 0) return
                const x = Math.max(lower, Math.min(upper, toFraction(event.clientX)))
                dispatch({ type: 'sample.slice', params: { trackId: track.id, slices: source.slices.map((s, i) => (i === index ? x : s)), mode: 'manual' } }, { label: 'Move slice marker', key: `slice-${track.id}-${index}` })
              }}
              onPointerUp={() => (drag.current = null)}
              onPointerDown={(event) => {
                const index = sliceAt(toFraction(event.clientX))
                select({ kind: 'slice', trackId: track.id, index })
                void engine.audition(source.assetId, source.slices[index], source.slices[index + 1] ?? 1)
              }}
              onDoubleClick={(event) => {
                const x = toFraction(event.clientX)
                const slices = [...source.slices, x].sort((a, b) => a - b)
                dispatch({ type: 'sample.slice', params: { trackId: track.id, slices, mode: 'manual' } }, { label: 'Add slice marker' })
                select({ kind: 'slice', trackId: track.id, index: slices.indexOf(x) })
              }}
              role="img"
              aria-label={`Waveform with ${source.slices.length} slices. Click a slice to audition it, double-click to add a marker, drag a marker to move it.`}
            >
              {grid.map((x, i) => (
                <line key={i} className={i % 4 === 0 ? 'wgrid bar' : 'wgrid'} x1={x * 1000} x2={x * 1000} y1={0} y2={140} />
              ))}
              {selectedSlice !== null && <rect className="slice-sel" x={source.slices[selectedSlice] * 1000} width={((source.slices[selectedSlice + 1] ?? 1) - source.slices[selectedSlice]) * 1000} y={0} height={140} />}
              {columns.map((c, i) => (
                <rect key={i} className="peak" x={(i / columns.length) * 1000} width={1000 / columns.length - 0.3} y={70 - c.max * 66} height={Math.max(0.8, (c.max - c.min) * 66)} />
              ))}
              {source.slices.map((start, i) => (
                <g key={`m${i}`} className={`marker${i === selectedSlice ? ' is-selected' : ''}`}>
                  <line x1={start * 1000} x2={start * 1000} y1={0} y2={140} />
                  <rect x={start * 1000 - 1} y={0} width={20} height={14} onPointerDown={(event) => onMarkerDown(event, i)} />
                  <text x={start * 1000 + 3} y={10}>
                    {i + 1}
                  </text>
                </g>
              ))}
            </svg>
          )}
        </div>
        <PadGrid track={track} />
      </div>
    </div>
  )
}

export function AudioClipEditor({ clip }: { clip: Clip }) {
  const project = useStudio((s) => s.project)
  const asset = clip.assetId ? project.assets[clip.assetId] : undefined
  const buffer = clip.assetId ? engine.buffer(clip.assetId) : undefined
  const barSeconds = studio.barSeconds(project)
  const columns = useMemo(() => (buffer ? peaks(buffer, 600) : []), [buffer])
  const svgRef = useRef<SVGSVGElement>(null)
  const drag = useRef<'start' | 'end' | 'fadeIn' | 'fadeOut' | null>(null)
  if (!asset) return <p className="dock-empty">This clip’s audio is missing.</p>
  const duration = buffer?.duration ?? asset.duration ?? 1
  const startFrac = Math.min(1, (clip.offset * barSeconds) / duration)
  const endFrac = Math.min(1, ((clip.offset + clip.length) * barSeconds) / duration)
  const fadeInFrac = (clip.fadeIn * barSeconds) / duration
  const fadeOutFrac = (clip.fadeOut * barSeconds) / duration
  const bars = (frac: number) => Math.max(0, Math.round(((frac * duration) / barSeconds) * 64) / 64)
  const set = (params: Record<string, number>, label: string) => dispatch({ type: 'clip.set', params: { clipId: clip.id, ...params } }, { label, key: `audio-${clip.id}-${label}` })
  return (
    <div className="editor audio-editor">
      <div className="editor-bar">
        <strong className="file">{asset.name}</strong>
        <span className="muted">
          {duration.toFixed(2)} s · plays {(clip.length * barSeconds).toFixed(2)} s from {(clip.offset * barSeconds).toFixed(2)} s
        </span>
        <label className="inline-slider">
          Gain
          <input type="range" min={-24} max={12} step={0.5} value={clip.gain} aria-label="Clip gain" onChange={(event) => set({ gain: Number(event.target.value) }, 'Clip gain')} onKeyDown={(event) => event.stopPropagation()} />
          <output>{clip.gain > 0 ? '+' : ''}{clip.gain.toFixed(1)} dB</output>
        </label>
        <button type="button" className="chip-btn" onClick={() => dispatch({ type: 'clip.resize', params: { clipId: clip.id, length: Math.max(0.0625, bars(1 - startFrac)) } }, { label: 'Fit clip to audio' })}>
          Fit to audio
        </button>
        <button
          type="button"
          className="chip-btn"
          onClick={() => {
            const at = Math.round(engine.position() * 16) / 16
            dispatch({ type: 'clip.split', params: { clipId: clip.id, at } }, { label: 'Split clip' })
          }}
          title="Split at the playhead"
        >
          Split at playhead
        </button>
      </div>
      <div className="bone wave-wrap audio-wave">
        <svg
          ref={svgRef}
          className="wave"
          viewBox="0 0 1000 140"
          preserveAspectRatio="none"
          onPointerMove={(event) => {
            if (!drag.current || !svgRef.current) return
            const rect = svgRef.current.getBoundingClientRect()
            const x = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width))
            if (drag.current === 'start') {
              const offset = bars(Math.min(x, endFrac - 0.005))
              set({ offset }, 'Trim start')
              dispatch({ type: 'clip.resize', params: { clipId: clip.id, length: Math.max(0.0625, clip.offset + clip.length - offset) } }, { label: 'Trim start', key: `audio-${clip.id}-Trim start` })
            } else if (drag.current === 'end') {
              dispatch({ type: 'clip.resize', params: { clipId: clip.id, length: Math.max(0.0625, bars(Math.max(x, startFrac + 0.005)) - clip.offset) } }, { label: 'Trim end', key: `audio-${clip.id}-trim-end` })
            } else if (drag.current === 'fadeIn') set({ fadeIn: bars(Math.max(0, x - startFrac)) }, 'Fade in')
            else set({ fadeOut: bars(Math.max(0, endFrac - x)) }, 'Fade out')
          }}
          onPointerUp={() => (drag.current = null)}
          role="img"
          aria-label="Audio clip waveform. Drag the edges to trim and the top handles to fade."
        >
          <rect className="clip-region" x={startFrac * 1000} width={(endFrac - startFrac) * 1000} y={0} height={140} />
          {columns.map((c, i) => (
            <rect key={i} className="peak" x={(i / columns.length) * 1000} width={1000 / columns.length - 0.3} y={70 - c.max * 66} height={Math.max(0.8, (c.max - c.min) * 66)} />
          ))}
          <polyline className="fade-line" points={`${startFrac * 1000},140 ${(startFrac + fadeInFrac) * 1000},4 ${(endFrac - fadeOutFrac) * 1000},4 ${endFrac * 1000},140`} />
          {(['start', 'end'] as const).map((edge) => (
            <rect key={edge} className="trim-handle" x={(edge === 'start' ? startFrac : endFrac) * 1000 - 4} y={0} width={8} height={140} onPointerDown={(event) => { event.stopPropagation(); (event.currentTarget as Element).setPointerCapture(event.pointerId); drag.current = edge }} />
          ))}
          <circle className="fade-handle" cx={(startFrac + fadeInFrac) * 1000} cy={6} r={6} onPointerDown={(event) => { (event.currentTarget as Element).setPointerCapture(event.pointerId); drag.current = 'fadeIn' }} />
          <circle className="fade-handle" cx={(endFrac - fadeOutFrac) * 1000} cy={6} r={6} onPointerDown={(event) => { (event.currentTarget as Element).setPointerCapture(event.pointerId); drag.current = 'fadeOut' }} />
        </svg>
      </div>
    </div>
  )
}

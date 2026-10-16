import { ChevronDown, ChevronRight, Link2, Minus, Plus } from 'lucide-react'
import { type CSSProperties, type DragEvent, type PointerEvent as ReactPointerEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { studio } from '@reborn/studio-core'
import { engine, importAudioFile, usePlayhead } from '../audio/host'
import { peaks } from '../audio/peaks'
import { dispatch, getState, select, useStudio } from '../state/store'
import { AddTrackMenu } from './AddTrackMenu'

type Clip = studio.Clip
type Track = studio.Track
type Pattern = studio.Pattern

const HEAD_W = 184
const ROW_H = 58
const LANE_H = 46

export function ClipContent({ pattern, clip, assetId }: { pattern?: Pattern; clip: Pick<Clip, 'length' | 'offset'>; assetId?: string | null }) {
  if (assetId) return <AudioClipContent assetId={assetId} clip={clip} />
  if (!pattern) return null
  const division = pattern.division || 16
  const total = Math.ceil(clip.length * division)
  const marks: { x: number; y: number; accent: boolean }[] = []
  const offsetSteps = Math.round(clip.offset * division)
  const cap = Math.min(total, 512)
  for (let s = 0; s < cap; s += 1) {
    const index = (s + offsetSteps) % pattern.length
    if (pattern.kind === 'notes') {
      const step = pattern.steps[index]
      if (step?.on) marks.push({ x: s, y: 18 - ((step.note % 24) / 24) * 16, accent: step.accent })
    } else if (pattern.kind === 'drums') {
      studio.DRUM_VOICES.slice(0, 5).forEach((voice, row) => {
        const hit = pattern.lanes[voice][index]
        if (hit?.on) marks.push({ x: s, y: 1 + row * 4, accent: hit.accent })
      })
    } else {
      for (const hit of pattern.hits) if (hit.step === index) marks.push({ x: s, y: 2 + (hit.pad / 16) * 17, accent: hit.velocity > 110 })
    }
  }
  return (
    <svg className="clip-content" viewBox={`0 0 ${Math.max(1, cap)} 22`} preserveAspectRatio="none" aria-hidden="true">
      {marks.map((m, i) => (
        <rect key={i} x={m.x + 0.1} y={m.y} width={0.8} height={m.accent ? 3 : 2} className={m.accent ? 'accent' : undefined} />
      ))}
    </svg>
  )
}

function AudioClipContent({ assetId, clip }: { assetId: string; clip: Pick<Clip, 'length' | 'offset'> }) {
  const tempo = useStudio((s) => s.project.tempo)
  const loaded = useStudio((s) => s.project.assets[assetId]?.duration ?? 0)
  const buffer = engine.buffer(assetId)
  const columns = useMemo(() => {
    if (!buffer || !loaded) return []
    const bar = (60 / tempo) * 4
    const from = (clip.offset * bar) / buffer.duration
    const to = from + (clip.length * bar) / buffer.duration
    return peaks(buffer, 160, Math.min(1, from), Math.min(1, to))
  }, [buffer, clip.length, clip.offset, loaded, tempo])
  return (
    <svg className="clip-content wave" viewBox="0 0 160 22" preserveAspectRatio="none" aria-hidden="true">
      {columns.map((c, i) => (
        <rect key={i} x={i} y={11 - c.max * 10} width={0.8} height={Math.max(0.4, (c.max - c.min) * 10)} />
      ))}
    </svg>
  )
}

function TrackMeter({ trackId }: { trackId: string }) {
  const [level, setLevel] = useState(0)
  const playing = useStudio((s) => s.transport.playing)
  useEffect(() => {
    if (!playing) {
      setLevel(0)
      return
    }
    let frame = 0
    const loop = () => {
      setLevel(Math.round(engine.trackLevel(trackId) * 40) / 40)
      frame = requestAnimationFrame(loop)
    }
    frame = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(frame)
  }, [playing, trackId])
  return (
    <span className="meter" aria-hidden="true">
      <i style={{ transform: `scaleY(${level})` }} />
    </span>
  )
}

function Playhead({ ppb }: { ppb: number }) {
  const bar = usePlayhead((b) => b)
  return <div className="playhead" style={{ transform: `translateX(${HEAD_W + bar * ppb}px)` }} aria-hidden="true" />
}

interface Drag {
  clipId: string
  mode: 'move' | 'resize'
  x: number
  y: number
  start: number
  length: number
  trackIndex: number
  copy: boolean
  moved: boolean
  key: string
}

function LaneView({ track, param, width, ppb }: { track: Track; param: string; width: number; ppb: number }) {
  const lane = useStudio((s) => s.project.automation.find((l) => l.trackId === track.id && l.param === param))
  const spec = studio.findParamSpec(track, param)
  const selected = useStudio((s) => s.selection.kind === 'lane' && s.selection.trackId === track.id && s.selection.param === param)
  const drag = useRef<{ index: number } | null>(null)
  if (!spec) return null
  const y = (value: number) => LANE_H - 4 - studio.normalize(spec, value) * (LANE_H - 8)
  const toValue = (py: number) => studio.denormalize(spec, (LANE_H - 4 - py) / (LANE_H - 8))
  const points = lane?.points ?? []
  const base = studio.getParam(track, param) ?? spec.default
  const path = points.length
    ? points
        .map((p, i) => {
          const prev = points[i - 1]
          const x = p.bar * ppb
          if (!prev) return `M 0 ${y(p.value)} L ${x} ${y(p.value)}`
          return prev.curve === 'hold' ? `L ${x} ${y(prev.value)} L ${x} ${y(p.value)}` : `L ${x} ${y(p.value)}`
        })
        .join(' ') + ` L ${width} ${y(points[points.length - 1].value)}`
    : `M 0 ${y(base)} L ${width} ${y(base)}`
  const write = (next: studio.AutomationPoint[]) => {
    if (!next.length) dispatch({ type: 'automation.clear', params: { trackId: track.id, param } }, { label: `Clear ${spec.label} automation` })
    else dispatch([{ type: 'automation.clear', params: { trackId: track.id, param } }, { type: 'automation.write', params: { trackId: track.id, param, points: next } }], { label: `Edit ${spec.label} automation`, key: `lane-${track.id}-${param}` })
  }
  return (
    <div className={`auto-lane${selected ? ' is-selected' : ''}`} style={{ height: LANE_H }}>
      <div className="auto-head" onClick={() => select({ kind: 'lane', trackId: track.id, param })}>
        <span>{spec.label}</span>
        <small>{points.length ? `${points.length} points` : studio.formatParam(spec, base)}</small>
      </div>
      <svg
        className="auto-svg"
        width={width}
        height={LANE_H}
        onPointerDown={(event) => {
          select({ kind: 'lane', trackId: track.id, param })
          const rect = event.currentTarget.getBoundingClientRect()
          const bar = Math.max(0, Math.round(((event.clientX - rect.left) / ppb) * 16) / 16)
          const value = toValue(event.clientY - rect.top)
          const hit = points.findIndex((p) => Math.abs(p.bar * ppb - (event.clientX - rect.left)) < 6 && Math.abs(y(p.value) - (event.clientY - rect.top)) < 8)
          if (event.button === 2 || event.altKey) {
            if (hit >= 0) write(points.filter((_, i) => i !== hit))
            event.preventDefault()
            return
          }
          event.currentTarget.setPointerCapture(event.pointerId)
          if (hit >= 0) drag.current = { index: hit }
          else {
            const next = [...points, { bar, value, curve: 'linear' as const }].sort((a, b) => a.bar - b.bar)
            write(next)
            drag.current = { index: next.findIndex((p) => p.bar === bar && p.value === value) }
          }
        }}
        onPointerMove={(event) => {
          if (!drag.current) return
          const rect = event.currentTarget.getBoundingClientRect()
          const bar = Math.max(0, Math.round(((event.clientX - rect.left) / ppb) * 16) / 16)
          const value = toValue(event.clientY - rect.top)
          const current = getState().project.automation.find((l) => l.trackId === track.id && l.param === param)?.points ?? []
          const next = current.map((p, i) => (i === drag.current!.index ? { ...p, bar, value } : p))
          write(next)
        }}
        onPointerUp={() => (drag.current = null)}
        onContextMenu={(event) => event.preventDefault()}
        role="img"
        aria-label={`${spec.label} automation with ${points.length} points. Click to add, drag to move, Alt-click to remove.`}
      >
        <path d={path} className="auto-path" />
        {points.map((p, i) => (
          <circle key={i} cx={p.bar * ppb} cy={y(p.value)} r={3.5} className="auto-point" />
        ))}
      </svg>
    </div>
  )
}

function AddLane({ track, existing, onAdd }: { track: Track; existing: string[]; onAdd: (param: string) => void }) {
  const returns = useStudio((s) => s.project.returns)
  const specs = studio.paramSpecs(track, returns).filter((s) => !existing.includes(s.id))
  return (
    <select className="lane-picker" value="" onChange={(event) => event.target.value && onAdd(event.target.value)} aria-label={`Add automation lane to ${track.name}`}>
      <option value="">+ Automation lane…</option>
      {specs.map((spec) => (
        <option key={spec.id} value={spec.id}>
          {spec.label}
        </option>
      ))}
    </select>
  )
}

export function Arrange() {
  const project = useStudio((s) => s.project)
  const selection = useStudio((s) => s.selection)
  const loop = useStudio((s) => s.transport.loop)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(900)
  const [zoom, setZoom] = useState<number | 'fit'>('fit')
  const [scroll, setScroll] = useState(0)
  const [expanded, setExpanded] = useState<Record<string, string[]>>({})
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const drag = useRef<Drag | null>(null)
  const playingBar = usePlayhead((b) => Math.floor(b))
  const playing = useStudio((s) => s.transport.playing)

  useLayoutEffect(() => {
    const element = scrollRef.current
    if (!element) return
    const observer = new ResizeObserver(() => setWidth(element.clientWidth))
    observer.observe(element)
    setWidth(element.clientWidth)
    return () => observer.disconnect()
  }, [])

  const fit = Math.max(12, Math.floor((width - HEAD_W - 16) / Math.max(4, project.length)))
  const ppb = zoom === 'fit' ? fit : zoom
  const laneWidth = Math.max(project.length + 4, 8) * ppb
  const selectedClipId = selection.kind === 'clip' || selection.kind === 'step' ? selection.clipId : null
  const selectedPattern = selectedClipId ? project.clips.find((c) => c.id === selectedClipId)?.patternId : null
  const tracks = project.tracks

  // Keep lanes that already have automation visible.
  useEffect(() => {
    setExpanded((current) => {
      let changed = false
      const next = { ...current }
      for (const lane of project.automation) {
        if (next[lane.trackId] && !next[lane.trackId].includes(lane.param)) {
          next[lane.trackId] = [...next[lane.trackId], lane.param]
          changed = true
        }
      }
      return changed ? next : current
    })
  }, [project.automation])

  useEffect(() => {
    if (!selectedClipId || !scrollRef.current) return
    const clip = project.clips.find((c) => c.id === selectedClipId)
    if (!clip) return
    const el = scrollRef.current
    const left = clip.start * ppb
    const right = studio.clipEnd(clip) * ppb + HEAD_W
    if (left < el.scrollLeft) el.scrollLeft = Math.max(0, left - 16)
    else if (right > el.scrollLeft + el.clientWidth) el.scrollLeft = right - el.clientWidth + 16
  }, [selectedClipId, ppb, project.clips])

  const insertAt = (at: number) => {
    const results = dispatch({ type: 'time.insert', params: { at, bars: 8, name: 'New 8' } }, { label: `Insert 8 bars at bar ${at + 1}` })
    const sectionId = (results?.[0] as { sectionId: string | null } | undefined)?.sectionId
    if (sectionId) select({ kind: 'section', sectionId })
  }

  const onClipDown = (event: ReactPointerEvent<HTMLElement>, clip: Clip, mode: Drag['mode']) => {
    event.stopPropagation()
    if (event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { clipId: clip.id, mode, x: event.clientX, y: event.clientY, start: clip.start, length: clip.length, trackIndex: tracks.findIndex((t) => t.id === clip.trackId), copy: event.altKey && mode === 'move', moved: false, key: `${mode}-${clip.id}-${Date.now()}` }
    if (!(selection.kind === 'step' && selection.clipId === clip.id)) select({ kind: 'clip', clipId: clip.id })
  }
  const onClipMove = (event: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current
    if (!d) return
    const grid = event.shiftKey ? 0.25 : 1
    const delta = Math.round((event.clientX - d.x) / ppb / grid) * grid
    const rowDelta = d.mode === 'move' ? Math.round((event.clientY - d.y) / ROW_H) : 0
    if (!d.moved && delta === 0 && rowDelta === 0) return
    if (d.copy && !d.moved) {
      const results = dispatch({ type: 'clip.duplicate', params: { clipId: d.clipId, start: d.start } }, { label: 'Duplicate clip', key: d.key })
      const copyId = (results?.[0] as { clipId: string } | undefined)?.clipId
      if (copyId) {
        d.clipId = copyId
        select({ kind: 'clip', clipId: copyId })
      }
    }
    d.moved = true
    if (d.mode === 'move') {
      const target = tracks[Math.max(0, Math.min(tracks.length - 1, d.trackIndex + rowDelta))]
      const source = tracks[d.trackIndex]
      const trackId = target && target.kind === source.kind ? target.id : undefined
      dispatch({ type: 'clip.move', params: { clipId: d.clipId, start: Math.max(0, d.start + delta), ...(trackId && { trackId }) } }, { label: 'Move clip', key: d.key })
    } else {
      dispatch({ type: 'clip.resize', params: { clipId: d.clipId, length: Math.max(grid, d.length + delta) } }, { label: 'Resize clip', key: d.key })
    }
  }

  const onDrop = async (event: DragEvent<HTMLDivElement>, track: Track) => {
    event.preventDefault()
    setDropTarget(null)
    const file = [...event.dataTransfer.files].find((f) => f.type.startsWith('audio') || /\.(wav|mp3|ogg|flac|aiff?|m4a)$/i.test(f.name))
    const libraryId = event.dataTransfer.getData('application/x-reborn-asset')
    const rect = event.currentTarget.getBoundingClientRect()
    const bar = Math.max(0, Math.floor((event.clientX - rect.left) / ppb))
    const assetId = libraryId || (file ? await importAudioFile(file) : null)
    if (!assetId) return
    const { project: current } = getState()
    const asset = current.assets[assetId]
    if (track.kind === 'audio') {
      const bars = asset?.duration ? Math.max(0.25, Math.round((asset.duration / studio.barSeconds(current)) * 4) / 4) : 4
      dispatch({ type: 'clip.create', params: { trackId: track.id, start: bar, length: bars, assetId } }, { label: `Place ${asset?.name ?? 'audio'}` })
    } else if (track.kind === 'sampler') {
      dispatch({ type: 'sample.slice', params: { trackId: track.id, assetId, slices: [0], mode: 'manual', assignPads: true } }, { label: `Load ${asset?.name ?? 'sample'} into ${track.name}` })
      select({ kind: 'slice', trackId: track.id, index: null })
    } else if (track.kind === 'deck') {
      dispatch({ type: 'deck.set', params: { trackId: track.id, assetId } }, { label: `Load ${asset?.name ?? 'audio'} into ${track.name}` })
    }
  }

  const boundaries = [...new Set(project.sections.map((s) => s.start).filter((b) => b > 0).concat(project.sections.length ? [Math.max(...project.sections.map((s) => s.start + s.length))] : []))]

  return (
    <div className="arrange" style={{ '--ppb': `${ppb}px`, '--head': `${HEAD_W}px` } as CSSProperties}>
      <div className="arrange-scroll" ref={scrollRef} onScroll={(event) => setScroll(event.currentTarget.scrollLeft)}>
        <div className="arr-canvas" style={{ width: HEAD_W + laneWidth }}>
          <div className="ruler-row">
            <div className="corner">
              <span>Zoom</span>
              <button type="button" className="icon-btn sm" aria-label="Zoom out" onClick={() => setZoom(Math.max(6, ppb - 8))}>
                <Minus size={13} />
              </button>
              <button type="button" className="icon-btn sm" aria-label="Zoom in" onClick={() => setZoom(Math.min(160, ppb + 8))}>
                <Plus size={13} />
              </button>
              <button type="button" className={`fit-btn${zoom === 'fit' ? ' is-on' : ''}`} onClick={() => setZoom('fit')}>
                Fit
              </button>
            </div>
            <div className="ruler" style={{ width: laneWidth }}>
              <div className="sections">
                {project.sections.map((section) => (
                  <button
                    key={section.id}
                    type="button"
                    className={`section-tag${selection.kind === 'section' && selection.sectionId === section.id ? ' is-selected' : ''}`}
                    style={{ left: section.start * ppb, width: section.length * ppb, '--sec': section.color } as CSSProperties}
                    onClick={() => select({ kind: 'section', sectionId: section.id })}
                    title={`${section.name}: bars ${section.start + 1}–${section.start + section.length}`}
                  >
                    <span>{section.name}</span>
                    <small>{section.length}</small>
                  </button>
                ))}
                {boundaries.map((bar) => (
                  <button key={`b-${bar}`} type="button" className="insert-btn" style={{ left: bar * ppb }} onClick={() => insertAt(bar)} title={`Insert 8 empty bars at bar ${bar + 1}. Later clips move right.`} aria-label={`Insert 8 bars at bar ${bar + 1}`}>
                    <Plus size={11} />8
                  </button>
                ))}
              </div>
              <div
                className="bars"
                onPointerDown={(event) => {
                  const rect = event.currentTarget.getBoundingClientRect()
                  engine.seek(Math.max(0, Math.floor((event.clientX - rect.left) / ppb)))
                }}
                title="Click to move the playhead"
              >
                {loop && <i className="loop-range" style={{ left: loop[0] * ppb, width: (loop[1] - loop[0]) * ppb }} />}
                {Array.from({ length: Math.ceil(laneWidth / ppb) }, (_, bar) => (
                  <span key={bar} style={{ left: bar * ppb }} className={bar % 4 === 0 ? 'major' : undefined}>
                    {(bar % 4 === 0 || ppb >= 34) && bar + 1}
                  </span>
                ))}
              </div>
            </div>
          </div>

          {tracks.map((track) => {
            const trackSelected = selection.kind === 'track' && selection.trackId === track.id
            const audible = studio.isTrackAudible(project, track)
            const lanes = expanded[track.id]
            return (
              <div key={track.id} className="track-block">
                <div className={`track-row${trackSelected ? ' is-selected' : ''}${audible ? '' : ' is-silent'}`} style={{ '--track': track.color } as CSSProperties}>
                  <div className="track-head" onClick={() => select({ kind: 'track', trackId: track.id })}>
                    <i className="track-color" />
                    <button
                      type="button"
                      className="lane-toggle"
                      aria-expanded={Boolean(lanes)}
                      aria-label={`${lanes ? 'Hide' : 'Show'} automation for ${track.name}`}
                      onClick={(event) => {
                        event.stopPropagation()
                        setExpanded((current) => {
                          const next = { ...current }
                          if (next[track.id]) delete next[track.id]
                          else next[track.id] = project.automation.filter((l) => l.trackId === track.id).map((l) => l.param)
                          return next
                        })
                      }}
                    >
                      {lanes ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                    </button>
                    <div className="track-name" onDoubleClick={() => setRenaming(track.id)}>
                      {renaming === track.id ? (
                        <input
                          autoFocus
                          defaultValue={track.name}
                          aria-label="Track name"
                          onClick={(event) => event.stopPropagation()}
                          onKeyDown={(event) => {
                            event.stopPropagation()
                            if (event.key === 'Enter') (event.target as HTMLInputElement).blur()
                            if (event.key === 'Escape') setRenaming(null)
                          }}
                          onBlur={(event) => {
                            const name = event.target.value.trim()
                            if (name && name !== track.name) dispatch({ type: 'track.update', params: { trackId: track.id, name } }, { label: 'Rename track' })
                            setRenaming(null)
                          }}
                        />
                      ) : (
                        <strong>{track.name}</strong>
                      )}
                      <small>{studio.DEVICE_NAMES[track.kind]}{track.mixer.output !== 'master' ? ` → ${project.tracks.find((t) => t.id === track.mixer.output)?.name ?? ''}` : ''}</small>
                    </div>
                    <div className="track-btns" onClick={(event) => event.stopPropagation()}>
                      <button type="button" className={`ms mute${track.mixer.mute ? ' is-on' : ''}`} aria-pressed={track.mixer.mute} aria-label={`Mute ${track.name}`} title="Mute" onClick={() => dispatch({ type: 'mixer.set', params: { trackId: track.id, mute: !track.mixer.mute } }, { label: `${track.mixer.mute ? 'Unmute' : 'Mute'} ${track.name}` })}>
                        M
                      </button>
                      <button type="button" className={`ms solo${track.mixer.solo ? ' is-on' : ''}`} aria-pressed={track.mixer.solo} aria-label={`Solo ${track.name}`} title="Solo" onClick={() => dispatch({ type: 'mixer.set', params: { trackId: track.id, solo: !track.mixer.solo } }, { label: `${track.mixer.solo ? 'Unsolo' : 'Solo'} ${track.name}` })}>
                        S
                      </button>
                    </div>
                    <TrackMeter trackId={track.id} />
                  </div>
                  <div
                    className={`lane${dropTarget === track.id ? ' is-drop' : ''}`}
                    style={{ width: laneWidth }}
                    onPointerDown={(event) => {
                      if (event.target === event.currentTarget) select({ kind: 'track', trackId: track.id })
                    }}
                    onDoubleClick={(event) => {
                      if (event.target !== event.currentTarget || !studio.patternKindFor(track.kind)) return
                      const rect = event.currentTarget.getBoundingClientRect()
                      const bar = Math.max(0, Math.floor((event.clientX - rect.left) / ppb))
                      const results = dispatch({ type: 'clip.create', params: { trackId: track.id, start: bar, length: 4 } }, { label: `Create clip on ${track.name}` })
                      const clipId = (results?.[0] as { clipId: string } | undefined)?.clipId
                      if (clipId) select({ kind: 'clip', clipId })
                    }}
                    onDragOver={(event) => {
                      if (!['audio', 'sampler', 'deck'].includes(track.kind)) return
                      event.preventDefault()
                      setDropTarget(track.id)
                    }}
                    onDragLeave={() => setDropTarget(null)}
                    onDrop={(event) => void onDrop(event, track)}
                  >
                    {project.sections.map((section) => (
                      <i key={section.id} className="lane-section" style={{ left: section.start * ppb, width: section.length * ppb, '--sec': section.color } as CSSProperties} />
                    ))}
                    {track.kind === 'audio' && !project.clips.some((c) => c.trackId === track.id) && <span className="lane-hint">Drop audio files here</span>}
                    {track.kind === 'sampler' && !project.clips.some((c) => c.trackId === track.id) && (
                      <span className="lane-hint">{track.device.kind === 'sampler' && track.device.source ? 'Double-click to add a pad clip, or press R and Space to record pads' : 'Drop a break here to chop it'}</span>
                    )}
                    {track.kind === 'deck' && <span className="lane-hint">Deck: play it live in Perform (4). Drop audio to load it.</span>}
                    {project.clips
                      .filter((clip) => clip.trackId === track.id)
                      .map((clip) => {
                        const pattern = clip.patternId ? project.patterns[clip.patternId] : undefined
                        const links = clip.patternId ? studio.linkCount(project, clip.patternId) : 1
                        const selected = clip.id === selectedClipId
                        const sibling = !selected && clip.patternId !== null && clip.patternId === selectedPattern
                        const active = playing && playingBar >= clip.start && playingBar < studio.clipEnd(clip)
                        const name = pattern?.name ?? (clip.assetId ? project.assets[clip.assetId]?.name : 'Clip')
                        return (
                          <div
                            key={clip.id}
                            className={`clip${selected ? ' is-selected' : ''}${sibling ? ' is-sibling' : ''}${active ? ' is-playing' : ''}${clip.mute ? ' is-muted' : ''}`}
                            style={{ left: clip.start * ppb, width: Math.max(4, clip.length * ppb) }}
                            onPointerDown={(event) => onClipDown(event, clip, 'move')}
                            onPointerMove={onClipMove}
                            onPointerUp={() => (drag.current = null)}
                            role="button"
                            tabIndex={0}
                            aria-label={`${name}, bars ${clip.start + 1} to ${studio.clipEnd(clip)}${links > 1 ? `, linked with ${links - 1} other clips` : ''}`}
                            onFocus={() => {
                              if (!selected) select({ kind: 'clip', clipId: clip.id })
                            }}
                            title="Drag to move (Shift for quarter bars, Alt to copy). Drag the right edge to resize."
                          >
                            <div className="clip-top">
                              <span className="clip-name">{name}</span>
                              {links > 1 && (
                                <span className="link-badge" title={`Linked: ${links} clips share this pattern. Edits change all of them.`}>
                                  <Link2 size={10} />
                                  {links}
                                </span>
                              )}
                            </div>
                            <ClipContent pattern={pattern} clip={clip} assetId={clip.assetId} />
                            <span className="clip-resize" onPointerDown={(event) => onClipDown(event, clip, 'resize')} onPointerMove={onClipMove} onPointerUp={() => (drag.current = null)} aria-hidden="true" />
                          </div>
                        )
                      })}
                  </div>
                </div>
                {lanes && (
                  <div className="lane-stack" style={{ '--track': track.color } as CSSProperties}>
                    {lanes.map((param) => (
                      <LaneView key={param} track={track} param={param} width={laneWidth} ppb={ppb} />
                    ))}
                    <div className="lane-add">
                      <AddLane track={track} existing={lanes} onAdd={(param) => setExpanded((c) => ({ ...c, [track.id]: [...(c[track.id] ?? []), param] }))} />
                    </div>
                  </div>
                )}
              </div>
            )
          })}
          <div className="add-track-row">
            <AddTrackMenu />
          </div>
          <Playhead ppb={ppb} />
        </div>
      </div>
      <Overview ppb={ppb} width={width} scroll={scroll} onJump={(x) => scrollRef.current && (scrollRef.current.scrollLeft = x)} />
    </div>
  )
}

function Overview({ ppb, width, scroll, onJump }: { ppb: number; width: number; scroll: number; onJump: (x: number) => void }) {
  const sections = useStudio((s) => s.project.sections)
  const length = useStudio((s) => s.project.length)
  const clips = useStudio((s) => s.project.clips)
  const tracks = useStudio((s) => s.project.tracks)
  const scale = (width - 16) / Math.max(1, length)
  const view = { left: scroll / ppb, width: (width - HEAD_W) / ppb }
  return (
    <div
      className="overview"
      onPointerDown={(event) => {
        const rect = event.currentTarget.getBoundingClientRect()
        const bar = (event.clientX - rect.left - 8) / scale
        onJump(Math.max(0, (bar - view.width / 2) * ppb))
      }}
      title="Song overview. Click to jump."
    >
      {sections.map((s) => (
        <i key={s.id} className="ov-section" style={{ left: 8 + s.start * scale, width: s.length * scale, background: s.color }} />
      ))}
      {clips.map((c) => {
        const row = tracks.findIndex((t) => t.id === c.trackId)
        return <i key={c.id} className="ov-clip" style={{ left: 8 + c.start * scale, width: Math.max(1, c.length * scale), top: 4 + (row / Math.max(1, tracks.length)) * 14, background: tracks[row]?.color }} />
      })}
      <i className="ov-view" style={{ left: 8 + view.left * scale, width: Math.min(width - 16, view.width * scale) }} />
    </div>
  )
}

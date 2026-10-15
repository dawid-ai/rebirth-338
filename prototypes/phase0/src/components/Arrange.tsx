import { Link2, Minus, Plus } from 'lucide-react'
import { type CSSProperties, type PointerEvent, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { clock, useClock } from '../clock'
import {
  type Clip,
  type Pattern,
  type Project,
  type Track,
  STEPS_PER_BAR,
  clipEnd,
  createClip,
  insertTime,
  isAudible,
  linkCount,
  moveClip,
  resizeClip,
  updateTrack,
} from '../model'
import { LIBRARY } from '../break'
import { useStudio } from '../studio'
import { SAMPLE_MIME, importBreak } from './actions'

const HEAD_W = 168

export function ClipContent({ pattern, clip }: { pattern: Pattern; clip: Pick<Clip, 'length' | 'offset'> }) {
  const total = clip.length * STEPS_PER_BAR
  const marks: { x: number; y: number; accent: boolean }[] = []
  if (pattern.kind === 'notes') {
    for (let s = 0; s < total; s += 1) {
      const step = pattern.steps[(s + clip.offset * STEPS_PER_BAR) % pattern.length]
      if (step?.on) marks.push({ x: s, y: 18 - ((step.note % 24) / 24) * 16, accent: step.accent })
    }
  } else if (pattern.kind === 'drums') {
    for (let s = 0; s < total; s += 1) {
      const index = (s + clip.offset * STEPS_PER_BAR) % pattern.length
      pattern.lanes.slice(0, 4).forEach((lane, row) => {
        if (lane.hits[index]) marks.push({ x: s, y: 3 + row * 5, accent: lane.hits[index] === 2 })
      })
    }
  } else {
    for (let s = 0; s < total; s += 1) {
      const index = (s + clip.offset * STEPS_PER_BAR) % pattern.length
      for (const hit of pattern.hits) if (hit.step === index) marks.push({ x: s, y: 2 + (hit.pad / 16) * 17, accent: hit.velocity > 110 })
    }
  }
  return (
    <svg className="clip-content" viewBox={`0 0 ${total} 22`} preserveAspectRatio="none" aria-hidden="true">
      {marks.map((m, i) => (
        <rect key={i} x={m.x + 0.1} y={m.y} width={0.8} height={m.accent ? 3 : 2} className={m.accent ? 'accent' : undefined} />
      ))}
    </svg>
  )
}

function Meter({ track, project }: { track: Track; project: Project }) {
  const level = useClock((position, playing) => {
    if (!playing || !isAudible(project, track)) return 0
    const active = project.clips.some((c) => c.trackId === track.id && c.start <= position && clipEnd(c) > position)
    if (!active) return 0
    const beat = (position * 4) % 1
    const base = 0.55 + track.volume / 30
    return Math.round(Math.max(0, base * (1 - beat * 0.6) + Math.sin(position * 97 + track.name.length) * 0.06) * 40) / 40
  })
  return (
    <span className="meter" aria-hidden="true">
      <i style={{ transform: `scaleY(${level})` }} className={level > 0.85 ? 'hot' : undefined} />
    </span>
  )
}

function Playhead({ ppb }: { ppb: number }) {
  const position = useClock((p) => p)
  return <div className="playhead" style={{ transform: `translateX(${HEAD_W + position * ppb}px)` }} aria-hidden="true" />
}

interface DragState {
  clipId: string
  mode: 'move' | 'resize'
  x: number
  start: number
  length: number
  moved: boolean
}

export function Arrange() {
  const studio = useStudio()
  const { project, selection } = studio
  const scrollRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(900)
  const [zoom, setZoom] = useState<number | 'fit'>('fit')
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const drag = useRef<DragState | null>(null)
  const playingBar = useClock((position, playing) => (playing ? Math.floor(position) : -1))

  useLayoutEffect(() => {
    const element = scrollRef.current
    if (!element) return
    const observer = new ResizeObserver(() => setWidth(element.clientWidth))
    observer.observe(element)
    setWidth(element.clientWidth)
    return () => observer.disconnect()
  }, [])

  const fit = Math.max(14, Math.floor((width - HEAD_W - 12) / project.length))
  const ppb = zoom === 'fit' ? fit : zoom
  const selectedClipId = selection.kind === 'clip' || selection.kind === 'step' ? selection.clipId : null
  const selectedPattern = selectedClipId ? project.clips.find((c) => c.id === selectedClipId)?.patternId : null

  useEffect(() => {
    if (!selectedClipId || !scrollRef.current) return
    const clip = project.clips.find((c) => c.id === selectedClipId)
    if (!clip) return
    const element = scrollRef.current
    const left = HEAD_W + clip.start * ppb
    const right = HEAD_W + clipEnd(clip) * ppb
    if (left - HEAD_W < element.scrollLeft) element.scrollLeft = left - HEAD_W - 8
    else if (right > element.scrollLeft + element.clientWidth) element.scrollLeft = right - element.clientWidth + 8
  }, [ppb, project.clips, selectedClipId])

  const insertAt = (at: number) => {
    const next = insertTime(project, at, 8, 'New 8')
    const section = next.sections.find((s) => s.start === at && !project.sections.some((old) => old.id === s.id))
    studio.commit(`Insert 8 bars at bar ${at + 1}`, () => next)
    studio.markTask('insert')
    if (section) studio.select({ kind: 'section', sectionId: section.id })
  }

  const onClipPointerDown = (event: PointerEvent<HTMLElement>, clip: Clip, mode: DragState['mode']) => {
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { clipId: clip.id, mode, x: event.clientX, start: clip.start, length: clip.length, moved: false }
    if (!(selection.kind === 'step' && selection.clipId === clip.id)) studio.select({ kind: 'clip', clipId: clip.id })
  }
  const onClipPointerMove = (event: PointerEvent<HTMLElement>) => {
    const state = drag.current
    if (!state) return
    const bars = Math.round((event.clientX - state.x) / ppb)
    if (!state.moved && bars === 0) return
    state.moved = true
    if (state.mode === 'move') studio.commit('Move clip', (p) => moveClip(p, state.clipId, state.start + bars), { key: `move-${state.clipId}` })
    else studio.commit('Resize clip', (p) => resizeClip(p, state.clipId, state.length + bars), { key: `size-${state.clipId}` })
  }
  const onClipPointerUp = () => {
    drag.current = null
  }

  const laneWidth = project.length * ppb
  const boundaries = [...new Set(project.sections.map((s) => s.start).filter((b) => b > 0).concat(project.length))]

  return (
    <div className="arrange" style={{ '--ppb': `${ppb}px`, '--head': `${HEAD_W}px` } as CSSProperties}>
      <div className="arrange-scroll" ref={scrollRef}>
        <div className="arr-canvas" style={{ width: HEAD_W + laneWidth + 12 }}>
          <div className="ruler-row">
            <div className="corner">
              <span>Zoom</span>
              <button type="button" className="icon-btn sm" aria-label="Zoom out" onClick={() => setZoom(Math.max(10, ppb - 8))}>
                <Minus size={13} />
              </button>
              <button type="button" className="icon-btn sm" aria-label="Zoom in" onClick={() => setZoom(Math.min(120, ppb + 8))}>
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
                    onClick={() => studio.select({ kind: 'section', sectionId: section.id })}
                    title={`${section.name}: bars ${section.start + 1}–${section.start + section.length}`}
                  >
                    <span>{section.name}</span>
                    <small>{section.length}</small>
                  </button>
                ))}
                {boundaries.map((bar) => (
                  <button
                    key={`b-${bar}`}
                    type="button"
                    className="insert-btn"
                    style={{ left: bar * ppb }}
                    onClick={() => insertAt(bar)}
                    title={`Insert 8 empty bars at bar ${bar + 1}. Later clips move right.`}
                    aria-label={`Insert 8 bars at bar ${bar + 1}`}
                  >
                    <Plus size={11} />8
                  </button>
                ))}
              </div>
              <div
                className="bars"
                onPointerDown={(event) => {
                  const rect = event.currentTarget.getBoundingClientRect()
                  clock.seek(Math.floor((event.clientX - rect.left) / ppb))
                }}
                title="Click to move the playhead"
              >
                {Array.from({ length: project.length }, (_, bar) => (
                  <span key={bar} style={{ left: bar * ppb }} className={bar % 4 === 0 ? 'major' : undefined}>
                    {(bar % 4 === 0 || ppb >= 34) && bar + 1}
                  </span>
                ))}
              </div>
            </div>
          </div>

          {project.tracks.map((track) => {
            const trackSelected = selection.kind === 'track' && selection.trackId === track.id
            const audible = isAudible(project, track)
            return (
              <div key={track.id} className={`track-row${trackSelected ? ' is-selected' : ''}${audible ? '' : ' is-silent'}`} style={{ '--track': track.color } as CSSProperties}>
                <div className="track-head" onClick={() => studio.select({ kind: 'track', trackId: track.id })}>
                  <i className="track-color" />
                  <div className="track-name">
                    <strong>{track.name}</strong>
                    <small>{track.device}</small>
                  </div>
                  <div className="track-btns" onClick={(event) => event.stopPropagation()}>
                    <button
                      type="button"
                      className={`ms mute${track.mute ? ' is-on' : ''}`}
                      aria-pressed={track.mute}
                      aria-label={`Mute ${track.name}`}
                      title="Mute"
                      onClick={() => studio.commit(`${track.mute ? 'Unmute' : 'Mute'} ${track.name}`, (p) => updateTrack(p, track.id, { mute: !track.mute }))}
                    >
                      M
                    </button>
                    <button
                      type="button"
                      className={`ms solo${track.solo ? ' is-on' : ''}`}
                      aria-pressed={track.solo}
                      aria-label={`Solo ${track.name}`}
                      title="Solo"
                      onClick={() => studio.commit(`${track.solo ? 'Unsolo' : 'Solo'} ${track.name}`, (p) => updateTrack(p, track.id, { solo: !track.solo }))}
                    >
                      S
                    </button>
                  </div>
                  <Meter track={track} project={project} />
                </div>
                <div
                  className={`lane${dropTarget === track.id ? ' is-drop' : ''}`}
                  style={{ width: laneWidth }}
                  onPointerDown={(event) => {
                    if (event.target === event.currentTarget) studio.select({ kind: 'track', trackId: track.id })
                  }}
                  onDoubleClick={(event) => {
                    if (event.target !== event.currentTarget) return
                    const rect = event.currentTarget.getBoundingClientRect()
                    const bar = Math.floor((event.clientX - rect.left) / ppb)
                    const created = createClip(project, track.id, bar, 4)
                    studio.commit(`Create clip on ${track.name}`, () => created.project)
                    studio.select({ kind: 'clip', clipId: created.clipId })
                  }}
                  onDragOver={(event) => {
                    if (track.kind !== 'sampler' || !event.dataTransfer.types.includes(SAMPLE_MIME)) return
                    event.preventDefault()
                    setDropTarget(track.id)
                  }}
                  onDragLeave={() => setDropTarget(null)}
                  onDrop={(event) => {
                    setDropTarget(null)
                    const item = LIBRARY.find((s) => s.file === event.dataTransfer.getData(SAMPLE_MIME))
                    if (item) importBreak(studio, item)
                  }}
                >
                  {project.sections.map((section) => (
                    <i key={section.id} className="lane-section" style={{ left: section.start * ppb, width: section.length * ppb, '--sec': section.color } as CSSProperties} />
                  ))}
                  {track.kind === 'sampler' && !project.clips.some((c) => c.trackId === track.id) && (
                    <span className="lane-hint">{project.sample ? `${project.sample.name} loaded · press R, then Space, and play pads to record` : 'Drop a break here'}</span>
                  )}
                  {project.clips
                    .filter((clip) => clip.trackId === track.id)
                    .map((clip) => {
                      const pattern = project.patterns[clip.patternId]
                      if (!pattern) return null
                      const links = linkCount(project, clip.patternId)
                      const selected = clip.id === selectedClipId
                      const sibling = !selected && clip.patternId === selectedPattern
                      const playing = playingBar >= clip.start && playingBar < clipEnd(clip)
                      return (
                        <div
                          key={clip.id}
                          className={`clip${selected ? ' is-selected' : ''}${sibling ? ' is-sibling' : ''}${playing ? ' is-playing' : ''}`}
                          style={{ left: clip.start * ppb, width: clip.length * ppb }}
                          onPointerDown={(event) => onClipPointerDown(event, clip, 'move')}
                          onPointerMove={onClipPointerMove}
                          onPointerUp={onClipPointerUp}
                          role="button"
                          tabIndex={0}
                          aria-label={`${pattern.name}, bars ${clip.start + 1} to ${clipEnd(clip)}${links > 1 ? `, linked to ${links - 1} other clips` : ''}`}
                          onFocus={() => {
                            if (!selected) studio.select({ kind: 'clip', clipId: clip.id })
                          }}
                        >
                          <div className="clip-top">
                            <span className="clip-name">{pattern.name}</span>
                            {links > 1 && (
                              <span className="link-badge" title={`Linked: ${links} clips share this pattern. Edits change all of them.`}>
                                <Link2 size={10} />
                                {links}
                              </span>
                            )}
                          </div>
                          <ClipContent pattern={pattern} clip={clip} />
                          <span
                            className="clip-resize"
                            onPointerDown={(event) => onClipPointerDown(event, clip, 'resize')}
                            onPointerMove={onClipPointerMove}
                            onPointerUp={onClipPointerUp}
                            aria-hidden="true"
                          />
                        </div>
                      )
                    })}
                </div>
              </div>
            )
          })}
          <Playhead ppb={ppb} />
        </div>
      </div>
    </div>
  )
}

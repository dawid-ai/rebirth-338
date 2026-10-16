import { Pause, Play, Rewind } from 'lucide-react'
import { type CSSProperties, useEffect, useRef, useState } from 'react'
import { studio } from '@reborn/studio-core'
import { engine, usePlayhead } from '../audio/host'
import { dispatch, getState, select, selectedTrackId, useStudio } from '../state/store'
import { launchScene } from './Build'
import { Knob } from './Controls'

// Perform view: big targets, nothing that edits patterns. With record armed
// and the transport running, every move here is written as automation.

function capture(trackId: string, param: string, value: number) {
  const s = getState()
  if (!s.recording || !s.transport.playing) return
  dispatch({ type: 'automation.write', params: { trackId, param, points: [{ bar: Math.round(engine.position() * 16) / 16, value }] } }, { label: 'Record performance', key: `perf-${trackId}-${param}` })
}

function setParam(trackId: string, param: string, value: number, label: string) {
  dispatch({ type: 'parameter.set', params: { trackId, param, value } }, { label, key: `perf-set-${trackId}-${param}` })
  capture(trackId, param, value)
}

function SafetyMeter() {
  const [level, setLevel] = useState(0)
  const [hold, setHold] = useState(0)
  const playing = useStudio((s) => s.transport.playing)
  useEffect(() => {
    if (!playing) return
    let frame = 0
    const loop = () => {
      const value = engine.outputLevel()
      setLevel(value)
      setHold((h) => Math.max(value, h * 0.985))
      frame = requestAnimationFrame(loop)
    }
    frame = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(frame)
  }, [playing])
  return (
    <div className="safety" aria-label="Output safety meter">
      <span className="safety-bar">
        <i style={{ transform: `scaleX(${level})` }} />
        <b style={{ left: `${hold * 100}%` }} />
      </span>
      <span className={hold > 0.95 ? 'clip' : undefined}>{hold > 0.95 ? 'Near the ceiling' : 'Headroom OK'}</span>
    </div>
  )
}

function DeckPlayer({ track }: { track: studio.Track }) {
  const asset = useStudio((s) => (track.device.kind === 'deck' && track.device.assetId ? s.project.assets[track.device.assetId] : undefined))
  const [playing, setPlaying] = useState(engine.deckPlaying(track.id))
  const [time, setTime] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => {
      setPlaying(engine.deckPlaying(track.id))
      setTime(engine.deckTime(track.id))
    }, 120)
    return () => clearInterval(timer)
  }, [track.id])
  useEffect(() => engine.updateDeck(track.id), [track])
  if (track.device.kind !== 'deck') return null
  const device = track.device
  return (
    <div className={`deck${playing ? ' is-playing' : ''}`} style={{ '--track': track.color } as CSSProperties}>
      <header>
        <strong>{track.name}</strong>
        <span>{asset ? asset.name : 'No audio — load one in the inspector or drop a file on its lane'}</span>
      </header>
      <div className="deck-time">
        {Math.floor(time / 60)}:{String(Math.floor(time % 60)).padStart(2, '0')}
        {asset ? ` / ${Math.floor(asset.duration / 60)}:${String(Math.floor(asset.duration % 60)).padStart(2, '0')}` : ''}
      </div>
      <div className="deck-buttons">
        <button type="button" className={`big-btn${playing ? ' is-on' : ''}`} disabled={!asset} onClick={() => (playing ? engine.deckStop(track.id) : void engine.deckPlay(track.id))} aria-label={playing ? `Pause ${track.name}` : `Play ${track.name}`}>
          {playing ? <Pause size={22} /> : <Play size={22} />}
        </button>
        <button type="button" className="big-btn" disabled={!asset} onClick={() => engine.deckCue(track.id)} aria-label={`Cue ${track.name}`}>
          <Rewind size={20} />
        </button>
      </div>
      <div className="deck-knobs">
        <Knob label="Pitch" value={(device.pitch + 12) / 24} defaultValue={0.5} format={(v) => `${(v * 24 - 12).toFixed(1)} st`} onChange={(v) => setParam(track.id, 'device.pitch', Math.round((v * 24 - 12) * 10) / 10, `${track.name} pitch`)} />
        <Knob label="Filter" value={(device.filter + 1) / 2} defaultValue={0.5} format={(v) => (Math.abs(v - 0.5) < 0.01 ? 'Off' : v < 0.5 ? `HP ${Math.round((0.5 - v) * 200)}` : `LP ${Math.round((v - 0.5) * 200)}`)} onChange={(v) => setParam(track.id, 'device.filter', v * 2 - 1, `${track.name} filter`)} />
        <Knob label="Gain" value={device.gain} onChange={(v) => setParam(track.id, 'device.gain', v, `${track.name} gain`)} />
      </div>
    </div>
  )
}

function Crossfader({ a, b }: { a: studio.Track; b: studio.Track }) {
  const [position, setPosition] = useState(0.5)
  const apply = (value: number) => {
    setPosition(value)
    const gainA = Math.cos((value * Math.PI) / 2)
    const gainB = Math.sin((value * Math.PI) / 2)
    const toDb = (g: number) => (g < 0.001 ? -60 : Math.max(-60, Math.round(20 * Math.log10(g / Math.SQRT1_2) * 10) / 10))
    dispatch([{ type: 'mixer.set', params: { trackId: a.id, volume: toDb(gainA) } }, { type: 'mixer.set', params: { trackId: b.id, volume: toDb(gainB) } }], { label: 'Crossfader', key: 'crossfader' })
    capture(a.id, 'mixer.volume', toDb(gainA))
    capture(b.id, 'mixer.volume', toDb(gainB))
  }
  return (
    <label className="crossfader">
      <span>{a.name}</span>
      <input type="range" min={0} max={1} step={0.01} value={position} aria-label="Crossfader" onChange={(event) => apply(Number(event.target.value))} onKeyDown={(event) => event.stopPropagation()} onDoubleClick={() => apply(0.5)} />
      <span>{b.name}</span>
    </label>
  )
}

function EchoThrow({ track }: { track: studio.Track }) {
  const saved = useRef<number | null>(null)
  const start = () => {
    saved.current = track.mixer.sends.delay?.level ?? 0
    dispatch({ type: 'send.set', params: { trackId: track.id, returnId: 'delay', level: 0.85 } }, { label: 'Echo throw', key: `throw-${track.id}` })
    capture(track.id, 'send.delay', 0.85)
  }
  const end = () => {
    if (saved.current === null) return
    dispatch({ type: 'send.set', params: { trackId: track.id, returnId: 'delay', level: saved.current } }, { label: 'Echo throw', key: `throw-${track.id}` })
    capture(track.id, 'send.delay', saved.current)
    saved.current = null
  }
  return (
    <button type="button" className="big-btn wide" onPointerDown={start} onPointerUp={end} onPointerLeave={end} title="Hold to throw this track into the delay">
      Echo throw · {track.name}
    </button>
  )
}

export function Perform() {
  const scenes = useStudio((s) => s.project.scenes)
  const tracks = useStudio((s) => s.project.tracks)
  const launched = useStudio((s) => s.transport.launchedSceneId)
  const queued = useStudio((s) => s.transport.queuedSceneId)
  const recording = useStudio((s) => s.recording)
  const trackId = useStudio((s) => selectedTrackId(s))
  const beat = usePlayhead((bar) => Math.floor((bar % 1) * 4))
  const focus = tracks.find((t) => t.id === trackId) ?? tracks.find((t) => t.kind === 'acid') ?? tracks[0]
  const decks = tracks.filter((t) => t.kind === 'deck')
  return (
    <div className="perform">
      <div className="perform-top">
        <div className="beat-dots big" aria-hidden="true">
          {[0, 1, 2, 3].map((b) => (
            <i key={b} className={b === beat ? 'on' : undefined} />
          ))}
        </div>
        <SafetyMeter />
        <p className="muted">{recording ? 'Recording: scene launches and every move here are captured.' : 'Arm record (R) to capture this performance into the arrangement.'}</p>
      </div>
      <div className="scene-triggers">
        {scenes.map((scene) => (
          <button key={scene.id} type="button" className={`scene-trigger${launched === scene.id ? ' is-playing' : ''}${queued === scene.id ? ' is-queued' : ''}`} onClick={() => launchScene(scene.id)}>
            <strong>{scene.name}</strong>
            <small>{launched === scene.id ? 'Playing' : queued === scene.id ? 'Next bar' : 'Launch'}</small>
          </button>
        ))}
        <button type="button" className="scene-trigger stop" onClick={() => engine.returnToArrangement()}>
          <strong>Arrangement</strong>
          <small>Back to the song</small>
        </button>
      </div>
      <div className="perform-grid">
        <section className="perform-panel">
          <header>
            <h3>Macros</h3>
            <select value={focus?.id ?? ''} aria-label="Macro track" onChange={(event) => select({ kind: 'track', trackId: event.target.value })}>
              {tracks.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </header>
          {focus && (
            <div className="macro-grid">
              {focus.macros.map((macro, index) => (
                <Knob
                  key={macro.name}
                  label={macro.name}
                  value={macro.value}
                  onChange={(value) => {
                    dispatch({ type: 'macro.set', params: { trackId: focus.id, index, value } }, { label: `${focus.name} ${macro.name}`, key: `perf-macro-${focus.id}-${index}` })
                    const target = macro.targets[0]
                    if (target) capture(focus.id, target.param, target.min + (target.max - target.min) * value)
                  }}
                />
              ))}
            </div>
          )}
        </section>
        <section className="perform-panel">
          <header>
            <h3>Performance FX</h3>
          </header>
          {focus && (
            <>
              <div className="macro-grid">
                <Knob label="Filter" value={(focus.inserts.filter + 1) / 2} defaultValue={0.5} format={(v) => (Math.abs(v - 0.5) < 0.01 ? 'Off' : v < 0.5 ? `HP ${Math.round((0.5 - v) * 200)}` : `LP ${Math.round((v - 0.5) * 200)}`)} onChange={(v) => setParam(focus.id, 'insert.filter', v * 2 - 1, `${focus.name} filter`)} />
                <Knob label="Drive" value={focus.inserts.drive} defaultValue={0} onChange={(v) => setParam(focus.id, 'insert.drive', v, `${focus.name} drive`)} />
              </div>
              <EchoThrow track={focus} />
            </>
          )}
          <div className="mute-grid">
            {tracks
              .filter((t) => t.kind !== 'group')
              .map((t) => (
                <button key={t.id} type="button" className={`mute-btn${t.mixer.mute ? ' is-muted' : ''}`} style={{ '--track': t.color } as CSSProperties} aria-pressed={!t.mixer.mute} onClick={() => dispatch({ type: 'mixer.set', params: { trackId: t.id, mute: !t.mixer.mute } }, { label: `${t.mixer.mute ? 'Unmute' : 'Mute'} ${t.name}` })}>
                  {t.name}
                </button>
              ))}
          </div>
        </section>
        <section className="perform-panel decks">
          <header>
            <h3>Decks</h3>
          </header>
          {decks.length ? decks.map((deck) => <DeckPlayer key={deck.id} track={deck} />) : <p className="muted">Add a Deck track from the browser to play loops and records live.</p>}
          {decks.length >= 2 && <Crossfader a={decks[0]} b={decks[1]} />}
        </section>
      </div>
    </div>
  )
}

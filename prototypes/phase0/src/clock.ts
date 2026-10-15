import { useSyncExternalStore } from 'react'

// Visual transport clock. Position is in bars; the prototype has no audio,
// so the clock only drives the playhead, meters, and pad recording.

type Listener = () => void

const listeners = new Set<Listener>()
let position = 0
let playing = false
let tempo = 120
let loop: [number, number] | null = null
let songLength = 40
let frame = 0
let last = 0

function emit() {
  for (const listener of listeners) listener()
}

function tick(now: number) {
  const elapsed = (now - last) / 1000
  last = now
  position += elapsed * (tempo / 240)
  if (loop && position >= loop[1]) position = loop[0] + (position - loop[1])
  if (!loop && position >= songLength) position = 0
  emit()
  frame = requestAnimationFrame(tick)
}

export const clock = {
  get: () => position,
  isPlaying: () => playing,
  subscribe(listener: Listener) {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
  configure(options: { tempo: number; loop: [number, number] | null; length: number }) {
    tempo = options.tempo
    loop = options.loop
    songLength = options.length
  },
  play() {
    if (playing) return
    playing = true
    last = performance.now()
    frame = requestAnimationFrame(tick)
    emit()
  },
  pause() {
    playing = false
    cancelAnimationFrame(frame)
    emit()
  },
  seek(bar: number) {
    position = Math.max(0, bar)
    emit()
  },
}

export function useClock<T>(select: (position: number, playing: boolean) => T): T {
  return useSyncExternalStore(clock.subscribe, () => select(position, playing))
}

export function formatPosition(bars: number) {
  const bar = Math.floor(bars)
  const beat = Math.floor((bars - bar) * 4)
  const tick = Math.floor(((bars - bar) * 4 - beat) * 240)
  return `${String(bar + 1).padStart(3, '0')}.${beat + 1}.${String(tick).padStart(3, '0')}`
}

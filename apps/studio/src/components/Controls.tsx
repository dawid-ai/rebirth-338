import type { MidiTarget } from '../midi/midi'
import { type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode, useRef, useState } from 'react'
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

interface KnobProps {
  label: string
  value: number
  defaultValue?: number
  ghost?: number | null
  format?: (value: number) => string
  onChange: (value: number) => void
  size?: 'sm' | 'md'
  /** Makes the knob a MIDI learn target. */
  midi?: MidiTarget
}

// Vertical drag, Shift for fine control, double-click to reset, arrow keys
// to step, and Enter to type a value.
export function Knob({ label, value, defaultValue = 0.5, ghost = null, format = (v) => `${Math.round(v * 100)}`, onChange, size = 'md', midi }: KnobProps) {
  const drag = useRef<{ y: number; value: number } | null>(null)
  const [active, setActive] = useState(false)
  const [editing, setEditing] = useState(false)
  const angle = -135 + value * 270
  const ghostAngle = ghost === null ? null : -135 + ghost * 270

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { y: event.clientY, value }
    setActive(true)
  }
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return
    const range = event.shiftKey ? 600 : 160
    onChange(clamp(drag.current.value + (drag.current.y - event.clientY) / range, 0, 1))
  }
  const end = () => {
    drag.current = null
    setActive(false)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 0.01 : 0.05
    if (event.key === 'ArrowUp' || event.key === 'ArrowRight') onChange(clamp(value + step, 0, 1))
    else if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') onChange(clamp(value - step, 0, 1))
    else if (event.key === 'Enter') setEditing(true)
    else return
    event.preventDefault()
    event.stopPropagation()
  }

  return (
    <div className={`knob knob-${size}${active ? ' is-active' : ''}`} data-midi-target={midi ? JSON.stringify(midi) : undefined}>
      <div
        className="knob-dial"
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(value * 100)}
        aria-valuetext={format(value)}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={end}
        onPointerCancel={end}
        onDoubleClick={() => onChange(defaultValue)}
        onKeyDown={onKeyDown}
        title={`${label}: drag up or down, Shift for fine, double-click to reset`}
      >
        <svg viewBox="0 0 40 40" aria-hidden="true">
          <path className="knob-track" d={arc(-135, 135)} />
          <path className="knob-fill" d={arc(-135, angle)} />
          {ghostAngle !== null && Math.abs(ghostAngle - angle) > 0.5 && <path className="knob-ghost" d={arc(Math.min(angle, ghostAngle), Math.max(angle, ghostAngle))} />}
          <line className="knob-pointer" x1="20" y1="20" x2={20 + 11 * Math.sin((angle * Math.PI) / 180)} y2={20 - 11 * Math.cos((angle * Math.PI) / 180)} />
        </svg>
      </div>
      {editing ? (
        <input
          className="knob-entry"
          autoFocus
          defaultValue={Math.round(value * 100)}
          onBlur={() => setEditing(false)}
          onKeyDown={(event) => {
            event.stopPropagation()
            if (event.key === 'Escape') setEditing(false)
            if (event.key === 'Enter') {
              const next = Number((event.target as HTMLInputElement).value)
              if (Number.isFinite(next)) onChange(clamp(next / 100, 0, 1))
              setEditing(false)
            }
          }}
        />
      ) : (
        <output className="knob-value">{format(value)}</output>
      )}
      <span className="knob-label">{label}</span>
    </div>
  )
}

function arc(from: number, to: number) {
  const r = 15
  const point = (deg: number) => {
    const rad = (deg * Math.PI) / 180
    return `${(20 + r * Math.sin(rad)).toFixed(2)} ${(20 - r * Math.cos(rad)).toFixed(2)}`
  }
  const large = to - from > 180 ? 1 : 0
  return `M ${point(from)} A ${r} ${r} 0 ${large} 1 ${point(to)}`
}

interface ToggleProps {
  label: string
  on: boolean
  onChange: (on: boolean) => void
  tone?: 'signal' | 'select' | 'mod' | 'alert'
  short?: string
  title?: string
}

export function Toggle({ label, on, onChange, tone = 'select', short, title }: ToggleProps) {
  return (
    <button type="button" className={`toggle tone-${tone}${on ? ' is-on' : ''}`} aria-pressed={on} aria-label={label} title={title ?? label} onClick={() => onChange(!on)}>
      {short ?? label}
    </button>
  )
}

interface FieldProps {
  label: string
  children: ReactNode
  hint?: string
}

export function Field({ label, children, hint }: FieldProps) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <span className="field-control">{children}</span>
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  )
}

interface SliderProps {
  label: string
  value: number
  min: number
  max: number
  step?: number
  ghost?: number | null
  format: (value: number) => string
  onChange: (value: number) => void
  /** Makes the slider a MIDI learn target. */
  midi?: MidiTarget
}

export function Slider({ label, value, min, max, step = 0.01, ghost = null, format, onChange, midi }: SliderProps) {
  const position = ((value - min) / (max - min)) * 100
  const ghostPosition = ghost === null ? null : ((ghost - min) / (max - min)) * 100
  return (
    <div className="slider" data-midi-target={midi ? JSON.stringify(midi) : undefined}>
      <div className="slider-head">
        <span>{label}</span>
        <output>
          {format(value)}
          {ghost !== null && ghost !== value && <em className="ghost-value"> → {format(ghost)}</em>}
        </output>
      </div>
      <div className="slider-rail" style={{ '--pos': `${position}%`, '--ghost': ghostPosition === null ? 'none' : `${ghostPosition}%` } as CSSProperties}>
        <input
          type="range"
          aria-label={label}
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(event) => onChange(Number(event.target.value))}
          onKeyDown={(event) => event.stopPropagation()}
        />
        {ghostPosition !== null && ghost !== value && <i className="slider-ghost" style={{ left: `${ghostPosition}%` }} />}
      </div>
    </div>
  )
}

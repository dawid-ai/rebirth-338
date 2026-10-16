// Tracks held modifier keys so controls that only report values (knobs)
// can still honor Alt for step locks and Shift for fine moves.

export const modifiers = { alt: false, shift: false }

if (typeof window !== 'undefined') {
  const sync = (event: KeyboardEvent | PointerEvent) => {
    modifiers.alt = event.altKey
    modifiers.shift = event.shiftKey
  }
  window.addEventListener('keydown', sync, true)
  window.addEventListener('keyup', sync, true)
  window.addEventListener('pointerdown', sync, true)
  window.addEventListener('pointermove', sync, true)
  window.addEventListener('blur', () => {
    modifiers.alt = false
    modifiers.shift = false
  })
}

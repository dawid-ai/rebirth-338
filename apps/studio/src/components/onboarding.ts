import { getState, setPrefs } from '../state/store'

// First-run checklist. Progress follows real actions in App.tsx.

export const ONBOARDING = [
  { id: 'play', label: 'Press Space to hear the starter beat' },
  { id: 'step', label: 'Click the Acid clip and change a step in the dock' },
  { id: 'clip', label: 'Double-click an empty lane to create a clip' },
  { id: 'chop', label: 'Drag a break from Samples onto the Sampler lane' },
  { id: 'mix', label: 'Open Mix (3) and analyze the mix' },
  { id: 'export', label: 'Export a WAV' },
]

export function completeOnboarding(id: string) {
  const done = getState().prefs.onboardingDone
  if (!done.includes(id)) setPrefs({ onboardingDone: [...done, id] })
}

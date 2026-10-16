import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// Fonts ship with the app so the desktop edition works offline.
import '@fontsource/big-shoulders-display/600'
import '@fontsource/big-shoulders-display/700'
import '@fontsource/big-shoulders-display/800'
import '@fontsource/ibm-plex-sans/400'
import '@fontsource/ibm-plex-sans/500'
import '@fontsource/ibm-plex-sans/600'
import '@fontsource/ibm-plex-mono/400'
import '@fontsource/ibm-plex-mono/500'
import '@fontsource/ibm-plex-mono/600'
import './styles/app.css'
import './styles/studio.css'
import './audio/host'
import './audio/recorder'
import { startApiHost } from './platform/apiHost'
import { restoreSession, startAutosave } from './state/persistence'
import App from './App'
import { engine } from './audio/host'
import { getState } from './state/store'

async function boot() {
  // End-to-end tests read state through this hook; it is only exposed on request.
  if (location.search.includes('e2e')) {
    // Audit helpers load as a separate chunk, only in test mode.
    const [studioEngine, analysis, core, v1Engine, store] = await Promise.all([import('@reborn/audio-engine/studio'), import('@reborn/analysis'), import('@reborn/studio-core'), import('@reborn/audio-engine'), import('./state/store')])
    Object.assign(window, { __studio: { engine, getState, audit: { studioEngine, analysis, core, v1Engine, store } } })
  }
  if (!location.search.includes('fresh')) await restoreSession()
  startAutosave()
  startApiHost()
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}

void boot()

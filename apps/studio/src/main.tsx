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

async function boot() {
  await restoreSession()
  startAutosave()
  startApiHost()
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}

void boot()

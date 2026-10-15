import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
// Fonts ship with the app so the desktop edition works offline.
import '@fontsource/barlow-condensed/400.css'
import '@fontsource/barlow-condensed/500.css'
import '@fontsource/barlow-condensed/600.css'
import '@fontsource/barlow-condensed/700.css'
import '@fontsource/barlow-condensed/800.css'
import '@fontsource/chakra-petch/400.css'
import '@fontsource/chakra-petch/500.css'
import '@fontsource/chakra-petch/600.css'
import '@fontsource/chakra-petch/700.css'
import '@fontsource/share-tech-mono/400.css'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

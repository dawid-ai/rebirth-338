import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// RE:BORN v2 studio. Relative asset paths let the same build load from the
// desktop app:// scheme and from a static host. Starter audio is shared with
// the v1 web edition.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: './',
  publicDir: fileURLToPath(new URL('../web/public', import.meta.url)),
  plugins: [react()],
  server: { host: '127.0.0.1', port: 5175, strictPort: true },
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 1500 },
})

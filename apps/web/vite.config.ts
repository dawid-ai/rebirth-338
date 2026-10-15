import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// `--mode desktop` builds with relative asset paths so Electron can load
// the bundle from disk; the default build targets GitHub Pages.
export default defineConfig(({ command, mode }) => ({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: mode === 'desktop' ? './' : command === 'build' ? '/rebirth-338/' : '/',
  plugins: [react()],
  build: { outDir: mode === 'desktop' ? 'dist-desktop' : 'dist', emptyOutDir: true },
}))

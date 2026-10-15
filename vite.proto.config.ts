import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Phase 0 interaction prototypes for RE:BORN v2. Served separately from the
// v1 workstation so the two never share a bundle.
export default defineConfig({
  root: fileURLToPath(new URL('./prototypes/phase0', import.meta.url)),
  base: './',
  plugins: [react()],
  server: { port: 5174, strictPort: true },
  build: { outDir: fileURLToPath(new URL('./dist-proto', import.meta.url)), emptyOutDir: true },
})

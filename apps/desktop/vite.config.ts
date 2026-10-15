import { builtinModules } from 'node:module'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

// Bundles the Electron main process (default mode) and the preload script
// (`--mode preload`) to CommonJS. They build separately because the
// sandboxed preload may only require `electron`, so it cannot share chunks.
export default defineConfig(({ mode }) => {
  const preload = mode === 'preload'
  return {
    root: fileURLToPath(new URL('.', import.meta.url)),
    build: {
      outDir: 'dist',
      emptyOutDir: !preload,
      target: 'node22',
      ssr: true,
      minify: false,
      sourcemap: true,
      rollupOptions: {
        input: (preload ? { preload: 'src/preload.ts' } : { main: 'src/main.ts' }) as Record<string, string>,
        external: ['electron', ...builtinModules, ...builtinModules.map((name) => `node:${name}`)],
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
    ssr: { noExternal: true },
  }
})

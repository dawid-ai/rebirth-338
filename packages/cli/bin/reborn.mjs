#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Launches the bundled CLI. Build it with
// `vite build --config packages/cli/vite.config.ts`.
const bundle = fileURLToPath(new URL('../dist/reborn.mjs', import.meta.url))
if (existsSync(bundle)) {
  await import(pathToFileURL(bundle).href)
} else {
  process.stderr.write(`reborn is not built yet: ${bundle} is missing.\nRun \`npx vite build --config packages/cli/vite.config.ts\` from the repository root.\n`)
  process.exitCode = 1
}

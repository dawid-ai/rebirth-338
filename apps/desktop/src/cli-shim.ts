import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// `reborn` on PATH: a .cmd shim that runs the bundled CLI with the app's own
// Electron binary in Node mode, so no separate Node.js install is needed.

export function shimContents(executable: string, cliBundle: string): string {
  return ['@echo off', 'setlocal', 'set ELECTRON_RUN_AS_NODE=1', `"${executable}" "${cliBundle}" %*`, ''].join('\r\n')
}

/**
 * The user's WindowsApps folder is on PATH by default on Windows 10 and 11.
 * Falls back to a folder the user adds to PATH themselves.
 */
export function shimDirectory(env: NodeJS.ProcessEnv, fallback: string): { dir: string; onPath: boolean } {
  const windowsApps = env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'Microsoft', 'WindowsApps') : null
  if (windowsApps && existsSync(windowsApps)) return { dir: windowsApps, onPath: true }
  return { dir: fallback, onPath: false }
}

export async function installCliShim(dir: string, executable: string, cliBundle: string): Promise<string> {
  await mkdir(dir, { recursive: true })
  const target = join(dir, 'reborn.cmd')
  await writeFile(target, shimContents(executable, cliBundle))
  return target
}

# Repository Guidelines

## Project Structure & Module Organization

This repository is an npm-workspaces monorepo for RE:BORN, a React and TypeScript music workstation. The v2 desktop studio is the main product; the v1 web edition stays on GitHub Pages.

- `packages/studio-core/` holds the v1 model and the `.reborn` file format, the bridge contract (`platform.ts`), the local API contract (`api.ts`), and the v2 studio in `src/studio/`: the project model (`model.ts`), pure edits (`ops.ts`), the typed command registry (`commands.ts`, the only way to change a project), the v1 importer (`import-v1.ts`), migrations, and starter templates (`templates.ts`).
- `packages/audio-engine/` owns Web Audio. `src/studio/` is the v2 engine: scheduling, the mixer graph with returns and groups, device voices, live playback, and offline rendering for export, stems, and resampling.
- `packages/analysis/` is the DSP library: loudness, true peak, band energy, onsets, tempo, key, slicing, tails, dither, and loudness matching.
- `packages/cli/` is the `reborn` CLI and the MCP stdio server. Both talk to the running desktop app through its local API.
- `apps/studio/` is the v2 UI: `components/` (views, dock, inspector, browser, transport), `state/` (store, persistence, proposals), `audio/` (engine host, export, analysis, resampling), `midi/` (MIDI input and learn), `agent/`, and `platform/` (desktop bridge and asset storage).
- `apps/desktop/` is the Electron shell: `main.ts` (windows, menus, IPC, `app://` protocol), `preload.ts`, project folders and packing, sessions and crash recovery, background jobs, the local API server, agent providers, the analysis sidecar supervisor, updates, and the CLI installer.
- `apps/web/` is the v1 web edition. `python/ismail-bridge/` is the optional Python analysis sidecar. `prototypes/phase0/` holds the v2 interaction prototypes.
- `docs/` holds the user guide, the CLI and MCP guide, and the release guide.

Keep unit tests beside their subject as `*.test.ts`. Browser automation, audits, and benchmarks live in `scripts/`; golden audio fingerprints live in `scripts/golden/`. Build output goes to each package's `dist/` and installers to `release/`; screenshots, WAV files, and other test output go to ignored `artifacts/`.

## Build, Test, and Development Commands

- `npm ci` installs the exact dependency versions recorded in `package-lock.json`.
- `npm test` runs all colocated Vitest tests once. `npx tsc -b` type-checks every workspace.
- `npm run studio` starts the v2 studio dev server on `127.0.0.1:5175`. Add `?fresh` to the URL to skip restoring the last session.
- `npm run desktop` builds the studio, CLI, and Electron main and preload, then starts the desktop app. `npm run desktop:dev` starts Electron against the running studio dev server.
- `npm run dist` builds the Windows installer into `release/`. See `docs/releasing.md` for publishing.
- `npm run dev` and `npm run build` serve and build the v1 web edition in `apps/web/`.
- `node scripts/studio-smoke.mjs` runs the studio end-to-end workflow against the dev server on port 5175.
- `node scripts/desktop-smoke.mjs` checks the desktop app: playback, save, export, pack, reopen, UI, CLI, and MCP editing with shared undo, sidecar restarts, and crash recovery. Run `npm run desktop:build` first.
- `npm run audit:a11y` and `npm run audit:audio` run the accessibility and audio audits against the studio dev server. `node scripts/smoke.mjs` covers the v1 web edition on port 5173.

## Coding Style & Naming Conventions

Follow the existing TypeScript style: two-space indentation, single quotes, trailing commas in multiline constructs, and no semicolons unless needed for correctness. Use `PascalCase` for React components and classes, `camelCase` for functions and variables, and descriptive domain names such as `hydrateProject`. Keep strict typing intact; avoid `any` and unsafe casts. No formatter or linter is configured, so match adjacent code and rely on `npm run build` for static validation.

## Testing Guidelines

Use Vitest with `describe` and behavior-focused `it` statements. Name tests `<module>.test.ts` and colocate them with implementation files. Add `// @vitest-environment jsdom` when a test needs DOM or browser storage APIs. Cover model migrations, audio behavior, and persistence edge cases affected by each change. There is no documented numeric coverage threshold. For UI, sequencing, export, or media changes, also run the studio smoke test; for audio changes, run `npm run audit:audio`; for desktop, file-format, API, or bridge changes, run the desktop smoke test. Their generated files belong only in `artifacts/`.

## Commit & Pull Request Guidelines

Use short, imperative commit subjects (for example, `Fix sampler loop timing`) and keep commits focused. Pull requests should explain user-visible behavior, list verification commands, link relevant issues, and include screenshots for layout changes or audio/export observations when visual evidence is insufficient. Do not commit `node_modules/`, build output (`dist/`, `dist-desktop/`, `dist-proto/`, `release/`), TypeScript build metadata, generated Vite files, or `artifacts/`.

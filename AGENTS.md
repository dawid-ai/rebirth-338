# Repository Guidelines

## Project Structure & Module Organization

This repository is an npm-workspaces monorepo for a React and TypeScript music workstation with a web edition and an Electron desktop edition.

- `packages/studio-core/` holds the project model and transformations (`model.ts`), migrations and the `.reborn` file format (`project-file.ts`), the shared undo `History`, the desktop bridge contract (`platform.ts`), and the demo projects (`demo/`).
- `packages/audio-engine/` owns Web Audio synthesis and offline export.
- `apps/web/` is the workstation UI: `src/App.tsx` contains the interface, `src/state/` handles browser persistence, and `src/desktop.ts` connects to the desktop bridge when it exists.
- `apps/desktop/` is the Electron shell: `main.ts` (windows, menus, IPC, `app://` protocol), `preload.ts` (the only page-visible bridge), `project-dir.ts` (`.reborn` folders), `zip.ts` (Pack Project), `session.ts` (recent files, crash recovery, logs), and `jobs.ts` (cancellable background work).
- `prototypes/phase0/` holds the v2 interaction prototypes.

Keep unit tests beside their subject as `*.test.ts`. Browser automation and benchmarking scripts live in `scripts/`. Generated builds go to `apps/web/dist/`, `apps/web/dist-desktop/`, and `apps/desktop/dist/`; screenshots, WAV files, and other test output go to ignored `artifacts/`.

## Build, Test, and Development Commands

- `npm ci` installs the exact dependency versions recorded in `package-lock.json`.
- `npm run dev` starts the Vite development server with hot reload.
- `npm test` runs all colocated Vitest tests once.
- `npm run build` runs strict TypeScript project checks for every workspace, then creates the web bundle in `apps/web/dist/`.
- `npm run preview` serves the production build locally for final inspection.
- `npm run desktop` builds the desktop renderer and main process, then starts Electron. `npm run desktop:dev` starts Electron against the running `npm run dev` server.
- `node scripts/smoke.mjs` runs the Playwright end-to-end workflow. Start `npm run dev` separately on `127.0.0.1:5173` first and ensure Chromium is installed.
- `node scripts/desktop-smoke.mjs` checks the desktop shell: play, save, export, pack, reopen, crash recovery, and WAV parity with the web build. Run `npm run desktop:build` and `npm run dev` first.

## Coding Style & Naming Conventions

Follow the existing TypeScript style: two-space indentation, single quotes, trailing commas in multiline constructs, and no semicolons unless needed for correctness. Use `PascalCase` for React components and classes, `camelCase` for functions and variables, and descriptive domain names such as `hydrateProject`. Keep strict typing intact; avoid `any` and unsafe casts. No formatter or linter is configured, so match adjacent code and rely on `npm run build` for static validation.

## Testing Guidelines

Use Vitest with `describe` and behavior-focused `it` statements. Name tests `<module>.test.ts` and colocate them with implementation files. Add `// @vitest-environment jsdom` when a test needs DOM or browser storage APIs. Cover model migrations, audio behavior, and persistence edge cases affected by each change. There is no documented numeric coverage threshold. For UI, sequencing, export, or media changes, also run the Playwright smoke test; for desktop, file-format, or bridge changes, also run the desktop smoke test. Their generated files belong only in `artifacts/`.

## Commit & Pull Request Guidelines

History currently contains only `Initial commit`, so no detailed convention is established. Use short, imperative commit subjects (for example, `Fix sampler loop timing`) and keep commits focused. Pull requests should explain user-visible behavior, list verification commands, link relevant issues, and include screenshots for layout changes or audio/export observations when visual evidence is insufficient. Do not commit `node_modules/`, build output (`dist/`, `dist-desktop/`, `dist-proto/`), TypeScript build metadata, generated Vite files, or `artifacts/`.

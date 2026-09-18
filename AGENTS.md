# Repository Guidelines

## Project Structure & Module Organization

This repository is a Vite-powered React and TypeScript browser workstation. Application code lives in `src/`: `App.tsx` contains the main interface, `model.ts` defines project data and transformations, `audio/` owns synthesis and export logic, `state/` handles browser persistence, and `demo/` builds the bundled demo project. Keep unit tests beside their subject as `*.test.ts`. Browser automation and benchmarking scripts live in `scripts/`. Generated builds go to `dist/`; screenshots, WAV files, and other test output go to ignored `artifacts/`.

## Build, Test, and Development Commands

- `npm ci` installs the exact dependency versions recorded in `package-lock.json`.
- `npm run dev` starts the Vite development server with hot reload.
- `npm test` runs all colocated Vitest tests once.
- `npm run build` runs strict TypeScript project checks, then creates the production bundle in `dist/`.
- `npm run preview` serves the production build locally for final inspection.
- `node scripts/smoke.mjs` runs the Playwright end-to-end workflow. Start `npm run dev` separately on `127.0.0.1:5173` first and ensure Chromium is installed.

## Coding Style & Naming Conventions

Follow the existing TypeScript style: two-space indentation, single quotes, trailing commas in multiline constructs, and no semicolons unless needed for correctness. Use `PascalCase` for React components and classes, `camelCase` for functions and variables, and descriptive domain names such as `hydrateProject`. Keep strict typing intact; avoid `any` and unsafe casts. No formatter or linter is configured, so match adjacent code and rely on `npm run build` for static validation.

## Testing Guidelines

Use Vitest with `describe` and behavior-focused `it` statements. Name tests `<module>.test.ts` and colocate them with implementation files. Add `// @vitest-environment jsdom` when a test needs DOM or browser storage APIs. Cover model migrations, audio behavior, and persistence edge cases affected by each change. There is no documented numeric coverage threshold. For UI, sequencing, export, or media changes, also run the Playwright smoke test; its generated files belong only in `artifacts/`.

## Commit & Pull Request Guidelines

History currently contains only `Initial commit`, so no detailed convention is established. Use short, imperative commit subjects (for example, `Fix sampler loop timing`) and keep commits focused. Pull requests should explain user-visible behavior, list verification commands, link relevant issues, and include screenshots for layout changes or audio/export observations when visual evidence is insufficient. Do not commit `node_modules/`, `dist/`, TypeScript build metadata, generated Vite files, or `artifacts/`.

# Releasing the desktop app

Releases are Windows NSIS installers published to [GitHub Releases](https://github.com/dawid-ai/rebirth-338/releases). Installed apps check there for updates through `electron-updater`.

## Before you release

Run the checks the release workflow doesn't:

1. Start the studio dev server on port 5175: `npm run studio`.
2. Run the studio end-to-end test: `node scripts/studio-smoke.mjs`.
3. Run the audits:
   - `npm run audit:a11y` fails on serious or critical accessibility violations.
   - `npm run audit:audio` compares golden renders, chunked and live parity, v1 migration, and a stress pass. Set `STRESS_SECONDS=600` for the full ten-minute pass.
4. Build the desktop app and run its end-to-end test: `npm run desktop:build`, then `node scripts/desktop-smoke.mjs`.

If you change a device or effect on purpose, regenerate the golden fingerprints with `node scripts/audio-audit.mjs --update` and commit `scripts/golden/audio.json` with the change.

## Build an installer locally

```bash
npm run dist
```

The installer and `latest.yml` land in `release/` (ignored by git). If Windows Defender locks the freshly extracted files and the build fails with `EPERM`, rerun it; to avoid the scan, add `--config.directories.output=<folder outside the repo>`.

## Publish a release

1. Set the version in `package.json` and `apps/desktop/package.json`, for example `2.0.0`.
2. Commit, then tag and push:

   ```bash
   git tag v2.0.0
   git push origin v2.0.0
   ```

3. The **Release desktop** workflow (`.github/workflows/release.yml`) type-checks, tests, builds, and uploads the installer to a **draft** release.
4. Download the installer from the draft, install it, and check that it starts, plays, and saves.
5. Publish the draft on GitHub. Installed apps see the update on their next launch.

## Code signing

Unsigned installers work, but Windows SmartScreen warns on first run. To sign:

1. Get a Windows code-signing certificate as a `.pfx` file.
2. In the repository settings, add two secrets:
   - `WINDOWS_CSC_LINK`: the `.pfx` file, base64-encoded.
   - `WINDOWS_CSC_KEY_PASSWORD`: its password.

The workflow passes them to electron-builder as `CSC_LINK` and `CSC_KEY_PASSWORD`. For a local signed build, set those two environment variables before `npm run dist`.

## What the installer contains

- The Electron app (`app.asar`).
- `resources/studio`: the v2 studio UI.
- `resources/cli/reborn.mjs`: the CLI and MCP server.
- `resources/python/ismail-bridge`: the analysis sidecar. It creates its own virtual environment on first deep analysis if `numpy` is missing.

Users' data lives in `%APPDATA%\RE-BORN` and isn't touched by installs, updates, or uninstalls.

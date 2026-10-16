# RE:BORN 338

A music workstation inspired by the original ReBirth software. Make acid lines, drum patterns, sampled beats, and full arrangements.

RE:BORN comes in two editions:

- **RE:BORN v2 (desktop, Windows):** the full studio. Arrange, build scenes, sample and chop, mix with returns and groups, perform, play MIDI controllers, and work with agents through the UI, the `reborn` CLI, or MCP. Download the installer from [Releases](https://github.com/dawid-ai/rebirth-338/releases).
- **RE:BORN 338 (web):** the original browser workstation. [Open it here](https://dawid-ai.github.io/rebirth-338/). Its projects open in v2.

Three loadable demos include an original dubstep arrangement and original big-beat and acid-techno tributes. They don't contain commercial soundtrack recordings.

## Documentation

- [User guide](docs/user-guide.md): first beat, views, sampling, mixing, MIDI, agents, and export.
- [CLI and MCP](docs/cli-and-mcp.md): drive the open project from scripts and agents.
- [Releasing](docs/releasing.md): build, sign, and publish installers.
- [reBORNv2.md](reBORNv2.md): the v2 product plan and its delivery status.

## Run from source

```bash
npm ci
npm run desktop
```

This builds and starts the desktop app. For UI work, run `npm run studio` and open `http://127.0.0.1:5175`. The web edition runs with `npm run dev`, and pushes to `main` deploy it to GitHub Pages.

Run `npm test` for unit tests and `npx tsc -b` for type checks. [AGENTS.md](AGENTS.md) lists every build, test, and audit command.

RE:BORN 338 is an independent project and isn't affiliated with the original ReBirth software or its creators. Bundled starter audio is CC0; see [its license](apps/web/public/audio/starter/LICENSE.md).

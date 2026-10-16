# CLI and MCP

The desktop app runs a local API while it's open. The `reborn` command and the MCP server use it to read and edit the open project. Every edit runs through the same undoable commands as the mouse, and shows up in the undo history with its origin (**script** or **agent**).

## Install the reborn command

In the desktop app, click **Help** > **Install Command-Line Tool**. This writes `reborn.cmd` to `%LOCALAPPDATA%\Microsoft\WindowsApps`, which is on your `PATH` by default. Open a new terminal and run:

```bash
reborn status
```

The command uses the app's own runtime, so you don't need Node.js. From a source checkout, run `npm run cli:build` and use `node packages/cli/dist/reborn.mjs` instead.

## Common commands

| Command | Does |
|---|---|
| `reborn status` | Shows the open project, transport, and API status. |
| `reborn commands --json` | Lists every registry command with its parameter schema. |
| `reborn pattern write acid-1 "C2 . D#2! C3~ . G2"` | Writes notes (`!` accent, `~` slide, `.` rest). |
| `reborn pattern write 808.kick "X...x...X...x..."` | Writes one drum voice (`X` accent). |
| `reborn set acid-1.cutoff 62 --bar 9` | Writes an automation point at bar 9. Without `--bar`, sets the value now. |
| `reborn run mixer.set --trackId 808 --volume -3` | Runs any registry command as one undoable edit. |
| `reborn play`, `stop`, `seek 17`, `launch 2` | Controls the transport and scenes. Bars and scenes are 1-based. |
| `reborn render --wait` | Renders the mix and prints the WAV path, with progress on stderr. Add `--stems` for one file per track. |
| `reborn analyze --bars 1:16 --wait` | Prints loudness, peaks, band balance, and warnings. |
| `reborn undo`, `redo`, `save` | Edits history and saves. |
| `reborn open path/to/Beat.reborn` | Opens a project. Refuses if the open project has unsaved changes, unless you add `--discard-changes`. |
| `reborn cancel <job>` | Cancels a render or analysis job. Pressing `Ctrl+C` during `--wait` also cancels it. |
| `reborn watch` | Streams project, transport, job, and proposal events. |

Add `--json` to any command for machine-readable output. Add `--read-only` to use the read token, so edits fail.

Exit codes: `0` ok, `1` error, `2` usage, `3` RE:BORN isn't running, `4` stale revision (pass `--expect-revision` to guard against concurrent edits), `5` not authorized.

## Connect an agent over MCP

`reborn mcp` runs an MCP server over stdio. To add it to Claude Code:

```bash
claude mcp add reborn -- reborn mcp
```

For other MCP clients, use this server entry:

```json
{
  "mcpServers": {
    "reborn": { "command": "reborn", "args": ["mcp"] }
  }
}
```

The server exposes one tool per registry command (for example `pattern_write`, `mixer_set`, and `mixer_trace`), plus `render_mix`, `render_stems`, `analysis_run`, transport tools, `history_undo`, and `proposal_status`.

Agent edits arrive in RE:BORN as proposals you review, unless you turned on direct agent edits in the agent settings. Each edit result says whether it was applied or is pending; agents check `proposal_status` before relying on a change.

## Security

- The API listens on `127.0.0.1` only, on a random port. It rejects requests not addressed to `127.0.0.1` or `localhost`, and any request from a web page (one that carries an `Origin` header).
- `api.json` in the app's data folder (`%APPDATA%\RE-BORN`) holds the port and two tokens: a read token and a write token. The CLI finds it automatically; pass `--api-file` or set `REBORN_API_FILE` to point elsewhere.
- Tokens change every time the app starts. The file is deleted when the app quits.

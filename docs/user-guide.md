# RE:BORN user guide

RE:BORN is a desktop music workstation for acid lines, drum machines, sampled beats, and full arrangements. This guide covers the main workflows. Press **F1** in the app for the searchable guide and the full shortcut map.

## Install

1. Download `RE-BORN-Setup-<version>.exe` from the [releases page](https://github.com/dawid-ai/rebirth-338/releases).
2. Run it. If Windows SmartScreen warns about an unsigned build, click **More info** > **Run anyway**.
3. Start **RE-BORN** from the Start menu.

Installed builds check GitHub Releases for updates on launch. To check now, click **Help** > **Check for Updates**.

## Make a first beat

1. Press `Space`. The starter project plays.
2. Click the **Acid line** clip. The dock under the arrangement shows its steps; click a step to change it.
3. To start over from a different style, open the **Projects** browser and pick a template: **Boom bap**, **Acid house**, **Starter rack**, or **Blank**. You can also run **New project from template** in the command palette (`Ctrl+K`) or use **File** > **New from Template**.

The checklist in the status bar tracks the first six things to try.

## Views

| Key | View | Use it to |
|---|---|---|
| `1` | **Arrange** | Place clips on tracks, add sections, insert or delete time. |
| `2` | **Build** | Launch scenes (one pattern per track) live. Arm record (`R`) to write launches into the arrangement. |
| `3` | **Mix** | Set levels, sends, and returns; trace any channel to the master; analyze the mix. |
| `4` | **Perform** | Play macros, the crossfader, and decks with large targets. With record armed, moves become automation. |

The dock always shows the editor for the current selection. The inspector on the right shows every setting of the selected track, clip, or step.

## Edit patterns and clips

- Double-click an empty lane to create a clip.
- `Ctrl+D` duplicates a clip as a linked repeat. Editing one copy edits both; **Make unique** in the inspector separates them.
- Hold `Alt` while you turn a knob with a step selected to lock that value to the step.
- `Delete` clears the selected clip, step, slice marker, or section marker. Every edit is undoable with `Ctrl+Z`.

## Sample and chop

1. Drag an audio file (or a starter sample from the **Samples** browser) onto a Sampler lane.
2. The chop editor finds transients and suggests slices. Adjust them, or choose equal, beat, or bar slicing.
3. Play slices from the pad grid with the mouse, the right-hand keys on your keyboard, or MIDI pads.
4. With record armed and the transport running, your pad performance is written into the clip.

Audio tracks hold whole recordings with non-destructive gain, offsets, and fades. Any track, group, return, or master range can be printed to a new sample with **Resample**.

## Mix and diagnose

- Each track has an insert EQ, filter, and drive, then a fader, pan, and sends to the shared returns.
- Select a return (for example **Tape Delay**) to see which tracks feed it. **Why can I hear echo?** in the palette does this for you.
- **Analyze** measures loudness, peaks, band balance, stereo correlation, and tails per section, and lists warnings such as clipping or sub buildup. Warnings describe evidence; nothing changes until you act.
- **FX Safe Bypass** mutes every return at once, which helps you check a dry mix.

## Play with a controller

- MIDI notes play the selected instrument. On drum machines and samplers, note 36 plays the first voice or pad.
- To map knobs and buttons, click **MIDI** in the transport (or run **MIDI learn** from the palette). Click a knob, slider, macro, or **Play**, **Stop**, or **Record**, then move a control on your device. Repeat for more controls and click **Done**.
- Mappings are saved per device. Macro mappings follow the selected track, so one row of knobs plays whichever instrument you select.
- Computer keys play instruments too: `A`–`K` for notes, `Z` and `X` for octaves, and the right-hand key grid for pads. Turn this off in the dock or the palette.

## Work with an agent

Click **Agent** in the transport. Choose a provider:

- **Claude CLI** uses your Claude Code login.
- **Claude API** uses an Anthropic API key, stored in the Windows credential store.
- **Local or compatible** uses Ollama, LM Studio, or any OpenAI-compatible server.

Agent edits arrive as proposals. Preview a proposal to hear it, then apply all of it, part of it, or none. To let the agent edit directly, turn on direct edits in the agent settings; each edit is still one undo step. Measurements are shared with the provider only when you turn that on.

Other agents and scripts can drive RE:BORN too. See [CLI and MCP](cli-and-mcp.md).

## Save, share, and export

- `Ctrl+S` saves the project as a `.reborn` folder with its audio. Unchanged audio files are never rewritten.
- **File** > **Pack Project** writes a single `.rebornpack` file to share.
- RE:BORN 338 web projects (`.rb338.json`) open directly; the import report lists anything that changed.
- **Export** renders the song, a section, or stems as 16- or 24-bit WAV, with an optional loudness target and a true-peak ceiling.
- If the app closes unexpectedly, the next launch offers to recover your unsaved work.

## Accessibility

- `F6` moves focus between the browser, workspace, dock, and inspector.
- The palette changes density (compact, normal, large) and switches to high contrast.
- Shortcuts are remappable in **Help** (`F1`).

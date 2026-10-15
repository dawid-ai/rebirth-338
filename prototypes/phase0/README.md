# RE:BORN v2 Phase 0 prototypes

These are high-fidelity, audio-free prototypes of the v2 interaction model described in `reBORNv2.md`. Their purpose is to test the fixed shell, the selection-driven dock and inspector, and the visual direction before Phase 1 code is written.

## Run

1. Start the prototype server: `npm run proto` (serves `http://127.0.0.1:5174`).
2. Open **Phase 0 tasks** in the status bar to see the six validation tasks and which ones you've completed.
3. Optional: with the server running, run the scripted pass with `node scripts/phase0-smoke.mjs`. It completes all six tasks, checks the layout at 1024 × 700, 1440 × 900, and 1920 × 1080, and writes screenshots to `artifacts/phase0/`.

`npm run proto:build` type-checks the prototype and builds it to `dist-proto/`.

## What each prototype covers

| Prototype | Where | Tasks |
| --- | --- | --- |
| Arrange with an Acid Synth clip and step editor | **Arrange** view, select an Acid clip | Create and edit a bass pattern, insert eight bars, make a repeated clip unique |
| Sample import, chop, and pads | Drag a break from **Samples** onto the Sampler lane | Chop a break and record a four-bar pad take |
| Mix diagnostics and an agent proposal | **Mix** view (`3`), then `Ctrl+K` | Find the echo source, preview and partially accept an agent change |

## Keyboard

| Key | Action |
| --- | --- |
| `Space` | Play or pause |
| `R` | Arm pad recording |
| `1`–`4` | Arrange, Build, Mix, Perform |
| `Ctrl+K` | Command palette and agent |
| `Ctrl+Z`, `Ctrl+Shift+Z` | Undo, redo |
| `Ctrl+D` | Duplicate the selected clip as a linked repeat |
| `Delete` | Delete the selected clip, step, or slice marker |
| Arrow keys | Move the selection. `Alt` nudges a clip, `Shift` resizes it. |
| `M , . /`, `J K L ;`, `U I O P`, `7 8 9 0` | Pads 1–16 (MPC layout, pad 1 bottom-left) when **Keys → pads** is on |

## Deliberate limits

- No audio. The transport clock, meters, and analyzer readings are simulated. Breaks are generated waveforms.
- The agent response is scripted. It only handles the echo diagnosis, and it builds its proposal from the actual project state.
- **Build** and **Perform** are placeholders. Phase 0 doesn't validate them.
- Fonts load from Google Fonts. The desktop build has to bundle them.
- The model in `src/model.ts` is a sketch for validation, not the Phase 1 `studio-core` API.

## Design decisions to review

- **Pad keys moved to the right hand.** A left-hand `1234/QWER/ASDF/ZXCV` grid collides with `R` (record) and `1`–`4` (views). The right-hand grid avoids every global shortcut, so pad mode never steals transport keys. This also drops the planned `L` loop shortcut, which collided with the `J K L ;` pad row.
- **Color carries meaning only.** Acid green means playing, cyan means selected or editing, amber means sends, modulation, or a pending agent change, and red means record, mute, or clipping.
- **Editing surfaces are bone, the field is graphite.** The step, drum, pad, and waveform editors use the warm light surface. Everything else stays dark.
- **Agent edits are visible before they apply.** Previewed values show as amber ghosts on knobs, faders, the delay tail, and the analyzer. Applying is one undo step labeled **Agent** in history.

# RE:BORN v2 — Product and Implementation Plan

> Status: direction approved 2026-10-15; Phase 0 complete, Phase 1 in progress  
> Target: standalone Electron workstation with an optional web edition  
> Core idea: preserve the immediacy of a groovebox while replacing the vertically stacked hardware replica with a software-native production environment.

## 1. Executive Summary

RE:BORN v2 should not be a cosmetic refresh of RE:BORN 338. The current application has capable machines, sequencing, sampling, automation, decks, projects and export, but its interface still follows a twenty-year-old rack metaphor. It requires scrolling between the thing being edited and the controls that affect it, repeats navigation and mixer controls, and makes arrangement structure harder to understand than it needs to be.

Version 2 will become a desktop-first music workstation built around four permanent ideas:

1. **The song stays visible.** The transport and timeline never disappear while editing a sound.
2. **Selection drives context.** Selecting a track, clip, step, sample or mixer channel updates one inspector instead of revealing another duplicate control set.
3. **Patterns become clips.** Patterns can be reused, made unique, dragged, extended and arranged without being constrained to a fixed intro/build/drop structure.
4. **The agent is a collaborator, not a chatbot pasted onto a DAW.** Agent actions use the same undoable command system as manual edits, show proposed changes on the song and can analyze rendered audio before making claims about it.

The existing React interface and Web Audio engine remain valuable. They should be extracted into reusable packages and migrated incrementally rather than discarded. The current GitHub Pages application can remain available as a lightweight web edition while Electron becomes the complete local edition.

## 2. Product Definition

### Primary audience

- Beatmakers building hip-hop, breakbeat, acid, techno and sample-based music.
- Musicians who want immediate hardware-like sequencing without learning a full traditional DAW.
- Producers who want an agent to perform repetitive editing, analysis and sound-design work without surrendering creative decisions.
- Developers and power users who want to control the workstation through CLI, MCP or a local API.

### North-star workflow

A user should be able to open the application, drag in a break, auto-detect its tempo, chop it to pads, record or paint a beat, add a bass line, arrange several sections, ask the agent to diagnose the mix, audition its proposed change and export a finished WAV without leaving the main workspace or hunting through vertically separated machines.

### Product principles

- **Immediate:** sound within one click; no setup dialog before the first beat.
- **Spatially stable:** transport, timeline, track controls and inspector have predictable locations.
- **Non-destructive:** sample edits, automation, agent operations and arrangement changes can always be undone.
- **Explainable:** every automated or agent-made change states what changed, where and why.
- **Playable:** mouse, computer keyboard and MIDI remain first-class inputs.
- **Local first:** projects, samples and analysis remain on the machine unless the user explicitly chooses a cloud provider.
- **Progressive:** beginners see the essential controls; advanced modulation, routing and analysis unfold when requested.

## 3. What Changes From v1

### Keep

- The two acid bass engines, Wave Designer, 808/909-style drums, sampler, decks and performance effects.
- Real-time Web Audio playback and offline rendering knowledge.
- Pattern editing, per-step properties, keyboard performance and project snapshots.
- Named scenes, demos, automation, resampling and WAV export.
- The recognizable acid-green signal identity.

### Replace or reinterpret

- Replace the long rack page with a fixed application shell.
- Replace fake faceplates, screws and permanent hardware geometry with compact device surfaces.
- Replace separate copies of mixer and automation controls with one contextual inspector.
- Replace fixed device-specific song-chain entries with general tracks and clips.
- Replace the Global/Bar/Step control mode with visible automation lanes and step locks.
- Replace “Focus versus Overview” with normal selection: the selected object is focused automatically.
- Replace a help modal full of prose with contextual help, first-run tasks and searchable documentation.
- Treat scenes as launchable musical states that can also be recorded into the arrangement.

### Explicit non-goals for the first desktop release

- VST/AU plugin hosting.
- A full notation editor.
- Cloud collaboration or accounts.
- Replacing the audio engine with Ismail's renderer.
- Letting an agent execute unrestricted shell commands from a project prompt.
- Perfect feature parity with Ableton Live, FL Studio or Logic.

## 4. Experience Architecture

### Application shell

The application uses a fixed viewport. The document itself does not scroll; each major region manages its own content.

```text
+--------------------------------------------------------------------------+
| Project | Undo/Redo | Transport | Position | Tempo | CPU | Export | Agent |
+----------+--------------------------------------------------+------------+
|          |                                                  |            |
| Browser  |                 Main workspace                   | Inspector  |
| samples  |       Arrangement / Clips / Mix / Perform        | selection  |
| presets  |                                                  | controls   |
| devices  |                                                  | routing    |
| projects |                                                  | help       |
|          +--------------------------------------------------+            |
|          | Device / Piano / Steps / Sample / Automation dock|            |
+----------+--------------------------------------------------+------------+
| Status / audio device / background render / agent activity               |
+--------------------------------------------------------------------------+
```

Recommended desktop geometry:

- Top command and transport bar: 56 px.
- Collapsible left browser: 264–320 px.
- Flexible center workspace: minimum 640 px.
- Collapsible right inspector: 300–360 px.
- Resizable lower detail dock: 220–420 px.
- Status bar: 24 px.

The inspector and browser may overlay the center below 1180 px. At narrow sizes, only one side panel is open at a time. The application should define a realistic desktop minimum of approximately 1024 × 700 rather than forcing the complete workstation into a phone layout. The web edition may keep a simplified touch layout.

### Primary views

Views change the center canvas, not the entire application.

#### Arrange

The default view. Tracks run vertically and musical time horizontally. It supports:

- Dragging, duplicating, splitting, looping, resizing and muting clips.
- Section markers of arbitrary names and lengths.
- Insert/delete time without accidentally appending material to the outro.
- Per-track automation lanes below their clips.
- A compact overview strip for navigating long songs.
- Linked clips by default, with **Make Unique** available when editing one occurrence.
- Variable clip and pattern lengths rather than assuming every idea is 16 steps.

#### Build

A clip-launch and pattern-building surface for quick beat creation. Rows represent tracks; columns represent scenes. A cell contains a clip or pattern. Launching a scene starts its column on the next quantization boundary. Recording scene launches writes the performance into Arrange.

#### Mix

A software-native mixer with resizable channel strips, group buses and explicit send/return routing. The selected strip's detailed EQ, dynamics and routing appear in the inspector. The mixer must make it visually impossible to confuse a channel send with the global return level.

#### Perform

A stage-oriented layout containing large scene triggers, macro controls, crossfader, decks, performance effects and safety meters. Edit-only controls disappear, but the currently playing section and queued action remain obvious. Performance moves may be captured as automation.

### Persistent transport

The top bar contains only global actions:

- Project name and save state.
- Undo/redo.
- Return to start, stop, play/pause, record and loop.
- Bar/beat/tick position and elapsed time.
- Tempo, tap tempo, swing and metronome.
- Audio/MIDI health indicator.
- Background task progress.
- Export and agent entry points.

Machine navigation, project browsing and media loading do not belong in the transport.

## 5. Editing Model

### Track model

The fixed rack becomes an ordered track list. Initial track/device types are:

- Acid Synth
- Wave Synth
- Drum Machine
- Sampler
- Audio/Stem Track
- Deck
- Group Bus
- Return Bus

Each track contains an input, one primary instrument or audio source, an effect chain, mixer state, clips and automation. The default project can still instantiate two Acid Synths, 808, 909 and Sampler tracks so the RE:BORN character is immediate.

### Clip and pattern model

A **pattern** stores musical events. A **clip** places a pattern on the arrangement with its own start, length, loop region, transpose, gain and overrides. This distinction solves several current limitations:

- The same pattern can appear in multiple sections without copying data.
- A user can extend a song by dragging or duplicating clips at the intended position.
- A four-bar variation can reference a base pattern and become unique only when changed.
- Drum, bass, wave and sampler material can all use the same arrangement rules.
- Sections are labels and ranges, not hard-coded musical forms.

Suggested initial limits are 1–64 steps per pattern, selectable step divisions from 1/4 through 1/64, and independent pattern lengths per track. Polymetric playback should be supported even if the default remains 16 steps.

### Detail dock

Selecting content opens the appropriate editor in the lower dock:

- Acid or Wave clip → step grid plus piano roll toggle.
- Drum clip → lane sequencer with all drum voices visible.
- Sampler clip → pad grid plus trigger lane.
- Audio clip → waveform, trim, fades, warp markers and gain envelope.
- Automation lane → curve editor.
- Track header → device chain.

The dock is resizable, pinnable and detachable into a second window in a later release. It remembers height by editor type.

### Inspector

The right inspector always describes the current selection and never duplicates an unrelated panel.

- Track selected: input, output, mixer, sends and device summary.
- Device selected: full sound parameters and preset management.
- Clip selected: clip properties, launch settings and pattern link state.
- Step selected: note, velocity, accent, slide, probability, ratchet and parameter locks.
- Sample selected: source, trim, pitch, warp, choke and normalization.
- Section selected: name, color, range and scene assignment.

Frequently adjusted parameters remain available as eight assignable macros above the detail dock. A macro can control multiple parameters with defined ranges.

### Automation and parameter locks

The underlying precedence should be explicit:

```text
device base value → clip automation → arrangement automation → step lock
```

The user edits this through visible lanes and step-lock markers rather than a hidden scope switch. Moving a knob while automation recording is armed writes a curve. Holding a modifier while moving a parameter on a selected step creates a step lock. Clearing automation reveals the inherited value immediately.

## 6. Sampling and Hip-Hop Workflow

Sampling should be a flagship workflow, not an oversized subsystem below the synthesizers.

### Import and analysis

- Drag audio from the browser, desktop or either deck.
- Detect tempo, downbeat, transients, key and approximate loudness.
- Show confidence and allow manual correction.
- Preserve the original file; every operation references it non-destructively.

### Chop editor

- Large zoomable waveform with transient and grid snapping.
- Add, delete and drag slice markers.
- Automatic equal, transient, beat and bar slicing.
- Audition slices from keyboard or MIDI pads while editing.
- Distribute slices across a pad bank in one action.
- Select several slices and normalize, reverse, pitch or choke them together.
- Convert a played pad performance into a clip.

### Timing and feel

- Per-hit velocity, microtiming, probability, ratchet and note length.
- Extract groove from an imported break and apply it to other clips.
- Global and per-clip swing with a clear indication of which wins.
- Quantize strength rather than only hard quantization.
- 16 Levels for velocity, pitch, filter or any mapped macro.

### Resampling

Any track, group, return or master range can be printed to a new sample. The resulting asset records its source, project position and settings so an agent or user can trace where it came from.

## 7. Sound, Mixer and Diagnostics

### Signal flow

Every channel should expose a readable path:

```text
Source → Device FX → Insert FX → Fader/Pan → Sends → Output bus
                                             ↘ Delay return
                                             ↘ Reverb return
```

Solo, mute, send and return behavior must be shared by live playback, preview and offline export. Return channels remain visible in Mix, and a global **FX Safe Bypass** should bypass returns without rewriting any send values.

### Sound-quality goals

- Configurable 44.1/48 kHz device rate and buffer size.
- Float processing internally; selectable 16- or 24-bit WAV export with dither.
- Oversampling around nonlinear distortion stages.
- DC blocking and gain staging at every generated source.
- Sample-rate-independent envelopes and filters.
- Click-free parameter ramps, mute/solo changes and transport stops.
- True-peak-aware final ceiling and optional loudness target for export.
- Offline and live render parity tests for every built-in device.

### Readback and diagnostics

The Analyzer panel should make invisible routing problems visible:

- Peak, RMS, crest factor and approximate loudness by section or bar.
- Frequency-band energy for sub, bass, low-mid, mid, harshness and air.
- Stereo balance, correlation and DC offset.
- Delay and reverb tail estimates.
- Active solo/mute paths and inaudible-channel explanations.
- Clipping, excessive resonance, sub buildup and masking warnings.
- A signal-flow trace answering “why can I still hear echo?” or “why is Deck A silent?”

Diagnostics report evidence and possible causes; they must not silently “fix” artistic decisions.

## 8. Agentic Workflow

### Interaction model

The agent is available through a command palette and an optional conversation drawer. The timeline remains the primary interface. Agent suggestions appear where they apply: changed notes overlay a clip, proposed automation overlays a lane, and mix adjustments appear as ghost values in the inspector.

Each proposal contains:

- Plain-language intent.
- Exact affected tracks, bars, steps and parameters.
- Before/after values.
- Measurement or user instruction supporting the change.
- **Preview**, **Apply**, **Apply selected** and **Reject** actions.

Applying a proposal is one undoable transaction. The history identifies whether an operation was manual, scripted or agent-generated.

### Shared command layer

Manual UI, keyboard shortcuts, CLI, API and agents must call the same typed command registry. Example commands:

```text
track.add
clip.create
clip.duplicate
pattern.write
step.set
sample.slice
parameter.set
automation.write
scene.launch
render.mix
render.stems
analysis.run
history.undo
```

Commands validate IDs, ranges and project versions before execution. Multi-command batches are atomic. Read operations are distinct from mutating operations so an external agent can inspect a project without acquiring write authority.

### Ismail integration

Ismail should initially be an optional supervised Python sidecar used for deeper audio analysis, reference comparison and sound generation. RE:BORN renders audio or stems; the sidecar reads them and returns structured results. It must not directly rewrite the canonical RE:BORN project.

The adapter translates analysis into native suggestions. Ismail-generated sounds return as documented sample assets, wavetables or audio tracks. Heavy optional dependencies such as stem separation and perceptual models are installed on demand.

### Provider support and privacy

The first agent release ships three provider paths together:

- **Claude CLI:** the installed `claude` executable run headless as a supervised child process, using the user's existing Claude login and reaching RE:BORN through its MCP server.
- **Cloud API:** user-supplied API keys for the Claude API and other providers.
- **Local:** OpenAI-compatible servers such as Ollama or LM Studio.

Shared requirements:

- External agents through MCP.
- A provider-neutral internal message and tool format.
- Secrets stored with the operating system credential facility.
- A visible disclosure of what text or audio will leave the machine before a cloud request.
- Raw audio stays local by default; compact measurements may be shared only with user consent.

### CLI, API and MCP

The desktop host should expose one local service bound to `127.0.0.1` or a named pipe, authenticated with a rotating local token. Thin adapters provide:

```powershell
reborn project open beat.reborn
reborn pattern write 808.kick "X...X...X...X..."
reborn set acid-1.cutoff 62 --bar 9
reborn render --stems
reborn analyze --bars 1:16
reborn agent "make the chorus drums hit harder"
reborn mcp
```

The API should support job progress, cancellation, subscriptions to transport/project changes and optimistic concurrency through project revision numbers.

## 9. Visual and Interaction Direction

### Concept: “instrument-grade software”

The visual language should feel like a purpose-built electronic instrument from the near future, not a browser dashboard and not a photographic rack recreation. The memorable element is a continuous **signal field**: tracks, clips, meters and automation share one visual grammar, so the user can see sound moving through the application.

### Material and color

- Graphite-black application field with subtle texture, not a uniform flat background.
- Warm bone editing surfaces for note and sample detail where high contrast matters.
- Acid green reserved for playing/active signal.
- Cyan reserved for selection and editing focus.
- Amber reserved for modulation, sends and pending actions.
- Red reserved for recording, clipping and destructive confirmation.
- Muted track colors used on clips without turning the entire interface into a rainbow.

Decorative screws, engraved fake metal and deep 3D gradients should disappear. A small amount of industrial detailing may remain in device icons, knobs and meter caps as brand heritage.

### Typography

Bundle fonts so the desktop works offline. Use one distinctive condensed display family for device/section identity, a highly legible text family for explanations and a tabular mono family for timing and measurement. Font choices must be tested at 100%, 125%, 150% and 200% operating-system scaling. Important labels should never rely on all-caps at tiny sizes.

### Controls

- Knobs support vertical drag, fine adjustment with a modifier, double-click reset and direct numeric entry.
- Every parameter shows its value and unit during interaction.
- Buttons use state, label and icon together where ambiguity is possible.
- Context menus expose advanced actions without hiding primary ones.
- Tooltips describe consequences, not merely repeat labels.
- Right-click never performs an irreversible clear without confirmation or undo.

### Motion

Motion communicates state: clips queue toward a beat boundary, panels resize smoothly, automation previews fade between states and meters respond immediately. Avoid constant decorative animation. Respect reduced-motion settings.

## 10. Keyboard, MIDI and Accessibility

### Keyboard foundation

- `Space`: play/pause.
- `Enter`: play from selection.
- `R`: record when focus is not in a text field.
- `Ctrl/Cmd + K`: command palette and agent instruction.
- `Tab` / `Shift+Tab`: cycle major regions.
- `1–4`: switch Arrange, Build, Mix and Perform.
- `Z/X`: octave down/up while playing keys.
- Arrow keys: move selection; modifiers resize or nudge.
- `Delete`: clear selected content through undoable commands.

All shortcuts must be discoverable and remappable. Computer-keyboard performance never steals keys while typing into a field.

### MIDI

- MIDI note input for all playable devices.
- Learn mode for knobs, faders, pads and transport.
- Saved device profiles.
- Separate input monitoring and recording destinations.
- MIDI clock input/output after core note/control support is stable.

### Accessibility

- Complete keyboard navigation with visible focus.
- Semantic controls and accessible names for custom widgets.
- No meaning communicated by color alone.
- High-contrast theme and scalable interface density.
- Screen-reader summaries for clips, patterns and analyzer reports.
- Minimum pointer targets appropriate for touch-capable laptops.

## 11. Desktop Technical Architecture

### Repository structure

```text
apps/
  web/                 lightweight browser edition
  desktop/             Electron main, preload and packaging
packages/
  studio-core/         versioned project model and commands
  audio-engine/        live and offline audio graph
  ui/                  design system and shared components
  agent-protocol/      tools, patches, jobs and audit history
  cli/                 reborn executable
python/
  ismail-bridge/       optional analysis sidecar
```

### Process boundaries

- **Electron main:** windows, menus, project files, updates, credentials and sidecar supervision.
- **Preload:** narrow typed IPC bridge; no raw Node or Electron objects exposed.
- **Renderer:** React UI and real-time interaction.
- **Audio render window/worker:** offline renders using the same Web Audio implementation without blocking the UI.
- **Agent service:** command orchestration, provider adapters, MCP and local API.
- **Python sidecar:** optional Ismail analysis with explicit job inputs and outputs.

Background jobs must stream progress and support cancellation. A Python crash or model timeout must not stop playback or corrupt the project.

### Project storage

Use a versioned project directory during editing:

```text
My Beat.reborn/
  project.json
  assets/
  previews/
  analysis/
  history/
```

Audio assets receive stable IDs and checksums. Project JSON references them relatively. Writes use a temporary file plus atomic rename, and recovery snapshots are retained. **Pack Project** creates a single shareable archive while normal saves avoid rewriting gigabytes of audio.

API keys, machine configuration and recent-file history do not belong inside the project.

### Generalized v2 project model

The new model should include:

- Project metadata, tempo map, meter and sample rate.
- Tracks, groups, returns and routing.
- Devices and ordered effect chains.
- Pattern library and arrangement clips.
- Audio assets, slices and derived-asset provenance.
- Arrangement markers and launchable scenes.
- Automation lanes and step locks.
- Mixer and master state.
- Agent proposals, accepted-operation history and analysis references.

IDs must be stable UUIDs rather than array positions. Model migrations are pure, versioned and covered by fixtures.

## 12. Migration Strategy

This should be an incremental product evolution, not a flag-day rewrite.

### v1 import

The importer maps:

- Each bass, wave, drum and sampler machine to a v2 track/device.
- Pattern banks to pattern-library entries.
- Song-chain bars to arrangement clips, merging repeated adjacent references.
- Song scenes to section markers and launchable scenes.
- Global/bar/step automation to base values, arrangement automation and step locks.
- Deck and sample assets to stable asset references.
- Master settings and channel sends to the v2 mixer graph.

The original project remains untouched. Import produces a report for anything that could not be represented exactly.

### Web edition

Keep the deployed v1 application stable while v2 is developed. Once the shared core is ready, the web edition can adopt the new shell selectively or become a project viewer/light editor. Desktop-only controls must be capability-gated rather than allowed to fail in the browser.

## 13. Delivery Plan

### Phase 0 — Validate the interaction model

Deliver three high-fidelity, non-audio prototypes:

1. Arrange with selected Acid Synth clip and step editor.
2. Sample import/chop/pad workflow.
3. Mix diagnostics plus an agent proposal.

Validate these tasks before implementation:

- Create and edit a bass pattern without scrolling.
- Insert eight bars between two existing sections.
- Make one repeated clip unique.
- Find the source of audible echo.
- Chop a break and record a four-bar pad performance.
- Preview and partially accept an agent change.

Exit when the layout works at 1024, 1440 and 1920 widths and the primary tasks require no panel hunting.

Status (2026-10-15): the prototypes live in `prototypes/phase0/` (`npm run proto`). `scripts/phase0-smoke.mjs` completes all six tasks and checks the layout at 1024 × 700, 1440 × 900 and 1920 × 1080. Decisions 2 and 7 in section 16 are approved. Pads now use a right-hand MPC key grid so they never collide with `R` and `1–4`; see `prototypes/phase0/README.md`.

### Phase 1 — Shared core and Electron shell

- Create the monorepo/package boundaries.
- Move project types, migrations and undoable commands into `studio-core`.
- Wrap the current renderer in Electron.
- Add native project open/save, crash recovery and recent files.
- Establish secure preload IPC, logging and background jobs.
- Keep the existing workstation UI functional inside the shell.

Exit when an existing project opens, plays, saves and exports identically in desktop and web builds.

### Phase 2 — New shell and device editing

- Implement design tokens and foundational components.
- Build the fixed transport, browser, workspace, inspector and detail dock.
- Port Acid Synth, Wave Synth and drum editing into contextual device panels.
- Add command palette, shortcut map and scalable density.

Exit when the two bass machines, wave and drums can be fully edited without the legacy page.

### Phase 3 — Tracks, patterns and arrangement

- Introduce stable track, pattern and clip IDs.
- Build Arrange and Build views.
- Add arbitrary sections, insert/delete time, linked clips and Make Unique.
- Convert automation scope data into lanes and locks.
- Implement v1 project import.

Exit when a complete imported demo can be rearranged without touching the legacy song chain.

### Phase 4 — Sampling, audio tracks and mixer

- Build the media browser, waveform editor and pad workflow.
- Add audio/stem tracks and non-destructive clip edits.
- Implement explicit mixer returns, groups and signal tracing.
- Add stem/resample workflows and improved export.

Exit when the north-star hip-hop workflow can be completed entirely in v2.

### Phase 5 — Command surface and agents

- Publish the typed command registry.
- Add local service, CLI and MCP adapters.
- Implement proposal previews, partial acceptance and agent audit history.
- Add provider configuration and OS credential storage.
- Add browser-native readback measurements.

Exit when UI, CLI and MCP can perform the same edit and produce the same undo history.

### Phase 6 — Ismail and advanced analysis

- Add supervised Python environment installation.
- Implement render/stem handoff and structured result validation.
- Add reference comparison, deeper audio reports and optional stem separation.
- Convert findings into native, previewable proposals.

Exit when an analysis job can fail, cancel or restart without affecting transport, project integrity or manual editing.

### Phase 7 — Performance and release readiness

- Complete Perform view and performance automation capture.
- Optimize cold start, waveform caching and long arrangements.
- Add signed installers, updates and GitHub Releases.
- Run accessibility, migration, audio parity and recovery audits.
- Produce onboarding projects and concise documentation.

## 14. Quality Gates

### Product usability

- A first beat plays within 60 seconds of first launch.
- Core editing never requires document-level scrolling.
- Any audible channel can be traced from source to master in at most two actions.
- Inserting time changes the intended position and never silently appends to the outro.
- Loading a project restores devices, mixer, automation, assets and agent-independent settings exactly.

### Audio reliability

- No clicks during normal transport, mute, solo or parameter changes.
- Live/offline render differences remain within defined numerical tolerances.
- Every channel's send reaches the same shared return implementation.
- Solo and mute logic is tested for sources, groups, returns and master export.
- A ten-minute stress project plays without scheduler drift or unbounded memory growth.

### Engineering

- Unit tests for every command and migration.
- Golden audio tests for every device and effect.
- Electron end-to-end tests for open/save/recovery/export.
- Contract tests shared by UI, CLI, HTTP and MCP adapters.
- No privileged APIs in the renderer and no unauthenticated external network listener.
- Background operations expose progress, cancellation and actionable errors.

## 15. Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Rebuilding too much at once | Keep v1 running, migrate one subsystem behind shared commands, and require phase exits. |
| UI becomes another generic DAW | Preserve device personality, macros and live pattern workflow; use the signal-field visual language consistently. |
| Agent makes destructive or inexplicable edits | Typed commands, project revisions, proposal previews, atomic batches and complete undo history. |
| Python packaging inflates or destabilizes the app | Make Ismail optional, install managed modules on demand and isolate the sidecar process. |
| Audio differs between desktop, web and export | Share one scheduling/graph implementation and enforce render-parity tests. |
| Arbitrary track model harms immediacy | Ship a strong default rack and focused templates; complexity appears only when tracks are added. |
| Desktop API exposes projects to other programs | Bind locally, require tokens, separate read/write authority and show connected clients. |
| Visual redesign delays functional work | Approve the three Phase 0 prototypes and tokens before broad component implementation. |

## 16. Decisions Required Before Coding v2

Decided 2026-10-15:

1. **Desktop-first.** Electron is the complete edition; the web edition may become a reduced feature set.
2. **Fixed shell and four primary views.** Approved 2026-10-15 after the Phase 0 prototypes completed all six tasks at 1024, 1440 and 1920 widths.
3. **Project storage.** Both: a visible `.reborn` directory while editing, plus **Pack Project** for a single shareable archive.
4. **First operating system.** Windows.
5. **Agent providers.** Claude CLI, cloud API and local OpenAI-compatible servers all ship in the first agent release.
6. **Ismail.** Starts as an optional analysis sidecar; RE:BORN's own engine stays the canonical sequencer and renderer.
7. **Visual direction.** Approved 2026-10-15 as prototyped: graphite field, bone editing surfaces, and color reserved for meaning (acid = playing, cyan = selection, amber = sends/modulation/pending, red = record/clip). Pads use a right-hand MPC key grid.

## 17. Definition of RE:BORN v2

RE:BORN v2 is complete when it is a stable desktop instrument rather than a wrapped web page: a producer can create, sample, arrange, mix, perform and export in one spatially consistent interface; the same project is controllable through UI, CLI and MCP; agents can read measurable evidence and propose reversible native edits; and existing RE:BORN projects migrate without losing their musical intent.

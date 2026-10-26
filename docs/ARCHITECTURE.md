# Architecture

Current state of the rebuild (milestones M0–M3 of `docs/REDESIGN-PLAN.md`).
The original prototype (SVG gauges, transparent WebM export) is preserved at
git tag `prototype-v0`.

## Overview

```
                    ┌──────────── src/core (framework-free, testable) ────────────┐
CSV text ──► data/  parseCsv → ProfileRegistry → importParsed → TelemetrySession
                                                                (base units, laps)
MP4 file ──► media/ readMp4 (sample tables) → camera adapters → VideoProbe
                    (byte ranges via RandomAccessFile)     (DJI djmd motion)
Layout   ──► widgets/ OverlayRenderer: cached static layers + per-frame dynamic
                    └──────────────────────────────────────────────────────────────┘
src/app (React UI) ── host.ts ──► Electron IPC + media:// │ dev-server endpoints
Project (.json) ◄── project/ schema + Zustand store with undo/redo
```

`src/core/` is plain TypeScript (canvas drawing uses OffscreenCanvas-
compatible APIs), so the same code can move into workers.

## Telemetry import (`src/core/data/`)

| File | Responsibility |
| --- | --- |
| `csv.ts` | Papa Parse wrapper that finds the real header row under logger preambles, an optional units row, and key/value metadata. `splitHeaderUnit` reads `NAME (unit)` headers. |
| `time.ts` | Timestamp units (s/ms/µs, auto-inferred from spacing) and clocks: `relative`, `unix-utc`, `unix-gps` (GPS time = UTC + 18 s). |
| `units.ts` | Unit table with aliases, base units per quantity, and conversion (incl. °F/°C offsets). |
| `channels.ts` | Canonical channel ids (speed, yawRate, lateralAccel, …) with display units, plus name heuristics for unknown loggers. |
| `series.ts` | `Series` (typed arrays), building from rows (sort, drop invalid, last duplicate wins), interpolation. |
| `gps.ts` | Lat/lon → local east/north metres, single-point projection, and a north-up fit into a box. |
| `import.ts` | `importTelemetry` / `importParsed`: one shared time base, each mapped column converted to base units, one column per canonical channel, warnings. |

### Logger profiles (`src/core/data/profiles/`)

A `LoggerProfile` answers four questions about a CSV: is it mine
(`detect`), where is time (`time`), which columns mean what (`channels`), and
where are the laps (`laps`, optional).

| Profile | Detection | Notes |
| --- | --- | --- |
| `solostorm` | `GPS_TIME (ms)` + `SYSTEM_TIME (ms)` headers | Unix ms on the GPS scale. Units from header suffixes. Laps from `MATH_LAP_NUMBER`. `ACCEL_X` is lateral. |
| `aim` | `Format` metadata, GPS headers, or preamble + units row | Relative seconds. Units from the units row. Laps from `Beacon Markers`. |
| user (`user.ts`) | All saved match headers present | A confirmed mapping saved as JSON (`UserProfileDefinition`). |
| `generic` | Fallback | Guesses time column, unit, clock, channel roles, and units the header omits (rpm, degrees; g vs m/s² by magnitude). Seeds the mapping screen. |

`ProfileRegistry` tries user profiles first, then built-ins with high
confidence, then low-confidence matches, then generic.

## Laps (`src/core/laps/laps.ts`)

`Lap` has a 1-based session `index`, the logger's `loggerNumber` when
available, start/end in session seconds and a `kind`. With more than one lap
the first is `out` and the last `in`; a single segment is `timed`.
GPS start/finish-line detection is planned, not built.

`delta.ts` builds the delta-to-best model: speed integrated into distance,
the best lap's elapsed time by distance, and each lap scaled to the best
lap's length so slightly different lines compare point for point.

## Media (`src/core/media/`)

| File | Responsibility |
| --- | --- |
| `file.ts` | `RandomAccessFile`: size + batched `readRanges`, so thousands of small metadata samples cost one host round trip. |
| `mp4.ts` | Minimal ISO-BMFF reader: finds `moov` by walking box headers (works with moov-at-end 9 GB files), reads tracks (handler, sample-entry four-cc, size, rotation) and sample tables (offsets, sizes, times). |
| `protobuf.ts` | Schema-less protobuf decoding for camera metadata. |
| `cameras/` | `CameraAdapter` registry. `dji.ts` detects the `djmd` track, reads the model (`DJI AC003` → Osmo Action 4), and turns per-frame orientation quaternions into gravity-projected yaw rate. Some recordings interleave stray orientation streams (2.3–3 rad away, wrong-sign turn rates) around dropped frames. Samples are therefore split into continuity tracks (a jump is capped at 1.5 rad even across gaps), rates are measured within each track, and tracks that overlap a larger one are dropped. GoPro (GPMF) is planned for M5. |
| `probe.ts` | `probeVideo`: codec, size, fps, frame count, audio, camera, and whether motion data is available. Picks the longest visual track (DJI adds an MJPEG thumbnail track). |

## Sync (`src/core/sync/`, `src/app/sync/`)

Sync is defined as **video time = offset + logger time × (1 + drift)**. The
app converts through `timeMap` / `useActivePair().time` (`toData`,
`toVideo`); never add or subtract the offset directly.

| File | Responsibility |
| --- | --- |
| `fft.ts` | Radix-2 FFT, cross-correlation, and `maskedLagSums` (the six lag sums for a Pearson r that ignores missing samples). |
| `engine.ts` | `synchronize(logger, camera)`, in steps:<br>1. Resample both to 50 Hz, marking gaps over 0.5 s as missing (NaN), and clip spikes.<br>2. Masked Pearson r at every lag in one FFT pass.<br>3. Peak candidates of the dominant sign, refined to sub-sample, with the half-split drift check when peaks are close (laps of the same track).<br>4. Robust pass: drop 5 s windows that disagree at the chosen offset, and refine on the rest (`coverage`).<br>5. Line fit of 10 s window offsets: clock `drift` (recordings of at least 120 s) and `precision` (scatter around the line).<br>6. Confidence from strength, separation and coverage. |
| `yaw.ts` | `loggerYaw(session)`: the gyro yaw channel, else the rate of GPS heading, else the GPS course over 2 m steps. GPS-derived signals are flagged (about 0.08 s of latency). |

In the app:
- `app/sync/worker.ts` runs `readMp4` → camera adapter `readMotion` →
  `synchronize` off the UI thread.
- The worker's file reads are answered by `app/sync/client.ts` through
  `FileHost`.
- The worker is bundled inline (`?worker&inline`), so it works when the
  app loads from `file://`.
- `actions.autoSync` applies the result as an undoable edit (method
  `camera-imu`).
- `runtimeStore.syncRun` keeps the candidates and both signals for the
  Sync panel and its plot.

## Widgets (`src/core/widgets/`)

A `WidgetDefinition` declares inputs (bound to canonical channels by
default), a fixed aspect, the style fields the inspector edits
(`styleFields`), default style derived from the data, and two drawing
passes:

- `drawStatic` renders the faces, ticks, track outline and rings into a
  cached layer, keyed by pixel size, style and bound data. It can return
  prepared data, such as the track map's projection.
- `drawDynamic` draws only the moving parts every frame.

`OverlayRenderer.render(ctx, frame, widgets, session, time)` positions
widgets from fractional rects, resolves bindings once per widget, and
records `lastFrameMs`. `data.ts` converts values to display units (mph, °F,
psi, g, or a per-input override in `WidgetInstance.units`) and gives
widgets the session's laps. `defaults.ts` builds a starting layout from the
channels present.

| Widget | Inputs | Notes |
| --- | --- | --- |
| `gauge` | value (speed) | 240° dial, range from the data's peak |
| `bar` | value (throttle) | vertical fill |
| `readout` | value | label + number + unit |
| `lapTimer` | (laps) | lap number, running lap time, best lap |
| `delta` | speed | time ahead of or behind the best lap, number and centred bar |
| `trackMap` | latitude, longitude | outline from the whole session (decimated), car marker |
| `gMeter` | lateral, longitudinal | rings per 0.5 g, fading 1 s trail, axis-flip options |

## Layout editing (`src/core/layout/`)

| File | Responsibility |
| --- | --- |
| `geometry.ts` | Frame-fraction geometry: snap targets (frame edges, centre, 2% safe margin, other widgets' edges and centres), `moveRect` and `resizeRect` with snapping and guides, aspect-locked corner resize, typed resizes around the centre, hit testing. |
| `templates.ts` | `LayoutTemplate`: a saved layout with canonical bindings (raw column bindings are converted when the column is recognised), applied to any session with fresh ids and a list of channels it lacks. |

## App (`src/app/`, `src/App.tsx`)

- `state.ts` has two stores:
  - `projectStore`: the undoable document (files, sync offset, layout).
  - `runtimeStore`: decoded data that's never saved (video probes,
    sessions, raw CSV text, logger profiles, layout templates, playback
    time, the widget selection and the inspector tab).
- `layout.ts` has the layout edits: selection, moves and nudges, styles,
  bindings and units (data-derived style values follow a new channel),
  layer order, lock and visibility, add, duplicate, delete, and templates.
- `host.ts` (`FileHost`) is the only place that knows where the app runs:
  - In Electron it uses IPC, and `media://local/<path>` for `<video>`.
  - In a plain browser it uses the dev-server endpoints, with
    `window.prompt` for picking files.
- `player.ts` is the playback clock: it wraps the `<video>` element, or a
  virtual clock when only telemetry is loaded. It supports seeking and
  frame stepping, landing mid-frame.
- `components/Stage.tsx` (the viewer) draws the overlay on every presented video frame
  using `requestVideoFrameCallback` and that frame's exact `mediaTime`.
  Telemetry time comes from the sync's time map. It also shows a
  performance HUD (draw time, presented fps, dropped frames).
- `components/LayoutEditor.tsx` sits over the viewer: select (click,
  Shift/Ctrl-click, marquee), drag to move, corner handles to resize, snap
  guides (Alt to place freely). Each drag is one undo step.
- The layout has three columns:
  - `MediaPanel` (left): source cards with secondary details folded away,
    and the lap list with gaps to best.
  - The viewer and `Transport` (centre): custom timeline with lap bands,
    hover time and drag scrubbing.
  - `InspectorPanel` (right): Sync and Layout tabs. `LayoutPanel` has
    the layer list (drag to reorder, show/hide, lock, missing-channel
    warnings), the Add and Templates menus, and the selected widget's
    properties. `ChannelPicker` lists channels with their live value and
    range.
- Files can also be dropped anywhere in the window (desktop app only;
  browsers don't expose paths).
- Styling uses the theme tokens in `src/index.css` and the primitives in
  `components/ui.tsx`.
- `components/MappingDialog.tsx` is the column mapping screen. Saving
  creates a `UserProfileDefinition`, persists it, re-imports with it, and
  embeds it in the project.

Keyboard: Space play/pause, ←/→ frame step (Shift: 1 s), Ctrl+Z / Ctrl+Y.
With widgets selected: arrows nudge by an output pixel (Shift: 10), Del
deletes, Ctrl+D duplicates, Esc clears; Ctrl+A selects all.

## Electron and dev harness

- `electron/main.ts` registers the privileged `media://` scheme (served by
  `electron/files.ts` with HTTP range support) and IPC for:
  - picking files
  - file size, batched range reads and text reads
  - logger profiles and layout templates, stored in
    `userData/logger-profiles.json` and `userData/layout-templates.json`
- The renderer may only read files the user picked (an allowlist in
  `files.ts`).
- `dev/fileServer.ts` is a Vite dev-server middleware (`apply: 'serve'`,
  loopback only) providing the same operations, so `npm run dev:browser`
  runs the UI in a normal browser. `?video=…&csv=…&offset=…` loads files
  directly in that mode.

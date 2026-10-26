# Architecture

Telemetry Overlay turns a racecar data-logger CSV into a transparent VP9/WebM
video of gauges that can be composited over onboard footage. One set of React
SVG components renders both the interactive preview and every exported frame.

```
CSV file ──► parseCsv ──► detectCsvFormat ──► preset / fallback overlays
                                                     │
                     OverlayConfig[] (column-based, editable in App.tsx)
                                                     │  buildSeries / buildGpsTrack
                                                     ▼
                     per-overlay SeriesPoint[] / GpsPoint[] (time 0-based, seconds)
                          │                                   │
                  live preview (App.tsx)            OverlayDefinition (points baked in)
                                                              │  IPC export:start
                                                              ▼
                                   main process: offscreen BrowserWindow (?export=1)
                                   ─► OverlayFrame at t ─► paint BGRA ─► raw chunk
                                   ─► ffmpeg VP9 yuva420p per chunk ─► concat ─► .webm
```

## Processes

### Electron main (`electron/`)

- `main.ts` creates the editor window (`contextIsolation: true`,
  `nodeIntegration: false`) and registers IPC handlers:
  - `csv:open` — native open dialog, returns `{ name, text }`.
  - `export:choose-path` — save dialog for the `.webm`.
  - `export:start` — runs `exportOverlayVideo`, streaming `export:progress`.
  - `export:cancel` — flags the job and kills FFmpeg.
- `preload.ts` exposes these as `window.telemetryOverlay` (typed in
  `src/types/electron.d.ts`).
- `exportVideo.ts` is the frame-accurate renderer/encoder (see below).
- `vp9AlphaArgs.ts` holds the shared FFmpeg output flags (`libvpx-vp9`,
  `yuva420p`, `alpha_mode=1`, no audio). `exportVideo.test.ts` encodes a few
  synthetic frames with these flags and checks alpha survives via ffprobe.

### Renderer (`src/`)

`src/main.tsx` has two modes chosen by the URL:

- **Editor** (default): mounts `App.tsx`.
- **Export renderer** (`?export=1`): transparent page that mounts
  `ExportRenderer`, which exposes two globals driven by the main process:
  - `window.setExportOverlay({ width, height, overlay })`
  - `window.renderOverlayFrame(time)` — `flushSync` render, then waits two
    animation frames so the paint reflects that time.

## Data pipeline (`src/renderer/lib/`)

| File | Responsibility |
| --- | --- |
| `telemetry.ts` | `parseCsv` (Papa Parse) finds the main numeric data block, walks back to the header row, detects an optional units row below it and key/value metadata rows above it (AiM preamble). `buildSeries` / `buildGpsTrack` pick columns, skip invalid rows (recorded in `errors`), infer timestamp unit, sort, dedupe (last wins) and shift so the first sample is t=0. `sampleAt` linearly interpolates with clamping. |
| `csvFormats.ts` | `CsvFormatProfile` registry (`aim`, `generic`). A profile detects itself, says which columns to avoid as the default value channel, and resolves GPS and g-meter column pairs. Add new loggers here, before Generic. |
| `overlayConfig.ts` | Editor-side overlay model: `gauge`, `bar`, `key-value`, `track-map`, `g-meter`. These reference **CSV column names**; positions are fractions of the frame (`x`,`y` centre, `size` relative to frame height). |
| `overlayPresets.ts` | Preset JSON schema (`version: 1`), `applyOverlayPreset` (resolves `$primary`, recomputes ranges from data, drops items whose columns are missing), `serializeOverlayPreset` (not yet wired to any UI). |
| `gauge.ts`, `gMeter.ts`, `trackMap.ts` | Pure math for components: value→fraction, `samplePoints` interpolation, g-range rounding, GPS equirectangular projection and trail paths, AiM column-name constants. |

Bundled presets live in `src/renderer/presets/*.json` and are registered in
`presets/index.ts`. `aim-default.json` is the default layout for AiM files
(speed gauge, TPS bar, oil/coolant key-value, track map, g-meter).

## Overlay components (`src/renderer/components/`)

All are pure SVG components with a fixed `viewBox`, scaling to their
container. They take already-sampled values (plus `points`/`time` for
`TrackMap`).

| Component | Shape | viewBox |
| --- | --- | --- |
| `Gauge` | 240° dial, label/unit/value | 320×320 |
| `Bar` | vertical pedal bar (throttle/brake) | 120×320 |
| `KeyValue` | stacked numeric readouts, vertical or horizontal | dynamic (`keyValueViewBox`) |
| `TrackMap` | GPS path with trail and live marker | 320×320 |
| `GMeter` | friction circle with ±maxG rings | 320×320 |

`src/renderer/export/OverlayFrame.tsx` positions components on an absolute
`width×height` transparent frame. Its `OverlayDefinition` types carry the
pre-built point arrays, not column names, so the export renderer never sees the
CSV.

## Editor (`src/App.tsx`)

A single large component (~2.3k lines) holding all state: parsed CSV, format,
timestamp column/unit, `OverlayConfig[]`, selection, playback time, trim
in/out, output size/fps and export progress. It:

1. Loads a CSV (Electron dialog, or a hidden `<input type=file>` when running
   in a plain browser), detects the format, applies the default preset or
   builds fallback overlays (`configureDataset`).
2. Memoises series per overlay (`valueSeries`, `trackSeries`, `gMeterSeries`;
   key-value entries are keyed by entry id).
3. Renders the left sidebar (data mapping, format/preset pickers, overlay list
   and per-overlay editors with `LayoutSliders`) and the checkerboard preview.
4. Plays back with `requestAnimationFrame` between trim points.
5. On export, converts previewable overlays into `OverlayComponentDefinition`s
   and calls `window.telemetryOverlay.startExport`.

## Export pipeline (`electron/exportVideo.ts`)

1. Validate the request (size ≥ 64 px, 1–120 fps, duration ≤ 24 h, every
   component has points).
2. Create a hidden **offscreen** transparent `BrowserWindow` at the exact
   output size, load the app with `?export=1`, wait for the globals, call
   `setExportOverlay`.
3. For each frame `t = startTime + frame / fps`: call `renderOverlayFrame(t)`,
   `invalidate()`, take the next `paint` event's `NativeImage` and append its
   BGRA bitmap to a raw temp file.
4. Every 300 frames (`FRAMES_PER_CHUNK`) encode the raw chunk with FFmpeg to a
   VP9-alpha WebM segment and delete the raw file. The render window is
   recreated every 150 frames to release Chromium paint buffers.
5. Concatenate segments (`-f concat -c copy`) to the chosen path. Rendering is
   92% of reported progress; concat is the rest.
6. On failure/cancel the partial output and temp dir are removed.

FFmpeg comes from `ffmpeg-static`; in packaged builds the path is rewritten to
`app.asar.unpacked` (see `asarUnpack` in `package.json`).

## Known rough edges

- **Export types are declared three times**: `electron/exportVideo.ts`,
  `src/types/electron.d.ts` and `src/renderer/export/OverlayFrame.tsx`. Keep
  them in sync when adding a component type.
- Adding an overlay type touches: `overlayConfig.ts`, `overlayPresets.ts`
  (materialise + type union), `OverlayFrame.tsx` (definition, `componentBox`,
  render switch), the three export type copies, `hasTelemetry` in
  `exportVideo.ts`, and several places in `App.tsx` (series memo,
  `previewableOverlays`, preview sizing, editor panel, `startExport`).
- Preview sizing in `App.tsx` reimplements `componentBox` from `OverlayFrame`
  in percentages instead of reusing it.
- `sampleAt` (telemetry.ts) and `samplePoints` (gauge.ts) are duplicate
  interpolators; `niceRange`/`dataRange` exist in both `App.tsx` and
  `overlayPresets.ts`.
- `serializeOverlayPreset` exists but there is no save/load preset UI, and
  layouts are not persisted between sessions.
- Only Windows (NSIS) packaging is configured.

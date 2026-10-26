# Telemetry Overlay

An Electron desktop utility for turning timestamped CSV logger data into a
transparent gauge video. The same React component powers both the live preview
and deterministic frame-by-frame export.

## Current MVP

- Import a CSV and select timestamp and numeric value columns.
- Auto-detect **AiM** vs **Generic CSV** (with a manual format override).
- Interpret timestamps as seconds, milliseconds, microseconds, or auto-detect.
- Configure overlays: dial gauges, pedal bars, key-value readouts, a GPS track
  map, and a g-meter (friction circle).
- Apply bundled layout presets; AiM files get a default race layout (speed,
  TPS, oil/coolant, track map, g-meter).
- Preview interpolated telemetry with play and scrub controls.
- Trim the timeline in/out points to export only a subset of the session.
- Export VP9 WebM at 24, 30, or 60 fps with an alpha channel.

CSV files must have a header row. Invalid samples are skipped and reported. The
first valid timestamp becomes `0:00`, and values between samples are linearly
interpolated.

Supported import formats today are AiM Race Studio exports and plain
header+rows CSVs. Detection lives in `src/renderer/lib/csvFormats.ts` — add
another profile there to support a new logger.

The exported WebM is intended for compositing in editors that support VP9
alpha. It contains no background and no audio.

## Commands

- `npm install` installs the application and bundled media tools.
- `npm run dev` starts Vite and Electron in development mode.
- `npm run build` type-checks and builds the renderer and Electron processes.
- `npm test` runs the Vitest suite.
- `npm run test:watch` runs tests while developing.
- `npm run typecheck` runs TypeScript without building.
- `npm run lint` runs Oxlint.
- `npm run dist` creates a Windows installer with Electron Builder.

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full design.

- `electron/` owns native file dialogs, the secure preload bridge, and FFmpeg.
- `src/renderer/lib/telemetry.ts` parses, validates, and samples logger data.
- `src/renderer/lib/csvFormats.ts` detects CSV logger format and holds profiles.
- `src/renderer/components/Gauge.tsx` is the reusable SVG dial gauge.
- `src/renderer/components/TrackMap.tsx` draws the GPS track and live marker.
- `src/renderer/export/OverlayFrame.tsx` renders an explicit point in time on a
  transparent canvas.

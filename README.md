# Telemetry Overlay

A Windows desktop app for racing drivers: import in-car video and data-logger
CSVs, sync them automatically, design an overlay of gauges and maps, and
export a finished video.

## Status

Being rebuilt. See [docs/REDESIGN-PLAN.md](docs/REDESIGN-PLAN.md) for the
plan. Milestone M0 (foundation) is in place:

- Telemetry import for **Solostorm** and **AiM Race Studio**, plus a generic
  importer that guesses columns and units for other loggers. Confirmed
  mappings can be saved as reusable profiles.
- Logger-independent channels (speed, yaw rate, g-forces, GPS, engine…)
  converted to consistent units.
- Lap detection from logger lap markers, with out/in laps and best lap.
- Project files (save/load with validation) and undo/redo.

Milestone M1 (import and preview) adds:

- Opening MP4/MOV videos of any size (streamed, never loaded whole), with
  camera detection. DJI Osmo Action files show their model and built-in
  motion data.
- A column mapping screen for unknown loggers, saved as reusable profiles.
- A preview player with an overlay of five widget types (dial gauge, bar,
  readout, track map, g-meter) redrawn on every video frame, frame
  stepping, a scrubber with lap markers, and a manual sync offset.

The original prototype (SVG gauges, transparent WebM export) is at git tag
`prototype-v0`. Measured results behind the redesign are in `spike/`.

## Commands

- `npm install` installs dependencies.
- `npm run dev` starts Vite and Electron in development mode.
- `npm run dev:browser` serves the UI alone at http://localhost:5199 for
  testing in a browser (development only).
- `npm run build` type-checks and builds the renderer and Electron processes.
- `npm test` runs the Vitest suite.
- `npm run test:watch` runs tests while developing.
- `npm run typecheck` runs TypeScript without building.
- `npm run lint` runs Oxlint.
- `npm run dist` creates a Windows installer with Electron Builder.

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

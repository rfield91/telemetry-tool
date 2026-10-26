# CLAUDE.md

Electron + React 19 + Vite 8 + Tailwind 4 Windows desktop app, being rebuilt as
an all-in-one tool: import in-car video and racecar logger CSVs, auto-sync
them, lay out an overlay, and export a composited MP4.

Follow `docs/REDESIGN-PLAN.md` (milestones M0–M5 and scope decisions).
`docs/ARCHITECTURE.md` describes the current code. The spikes in
`spike/export-speed` and `spike/auto-sync` hold the measured results the plan
builds on. The old prototype is at git tag `prototype-v0`.

## Commands

- `npm run dev`: Vite + Electron in dev mode.
- `npm test`: Vitest (jsdom). Core tests import real logger files from
  `sample-data/` with Vite `?raw` imports.
- `npm run typecheck`: `tsc -b` over `tsconfig.app.json` (src) and
  `tsconfig.node.json` (electron + vite config).
- `npm run lint`: oxlint (also covers `spike/`).
- `npm run dist`: Windows NSIS installer into `release/`.

## Layout

- `electron/`: main process (window, `csv:open` IPC) and preload bridge.
- `src/App.tsx`: placeholder shell until M1 builds the editor.
- `src/core/`: framework-free logic (no DOM or React, so it can run in
  workers), unit tested:
  - `data/`: CSV parsing, timestamps and clocks, units, canonical channels,
    series, logger profiles (`profiles/`), and `import.ts` (CSV →
    `TelemetrySession`).
  - `laps/`: lap model from logger markers.
  - `project/`: project schema, save/load validation, Zustand store with
    Immer-patch undo/redo.
- `sample-data/3.csv`: AiM session (4 laps). `sample-data/solostorm/`: two
  Solostorm single-lap exports that match the DJI videos used in the spikes.
- `spike/`: throwaway benchmarks and sync experiments (CommonJS/ESM scripts,
  not part of the app build).

## Conventions

- Session times are seconds from the first valid timestamp. Absolute time,
  when a logger has it, is `time.startUtcMs`.
- Imported channel values are stored in base units (`BASE_UNITS` in
  `units.ts`: m/s, rad/s, m/s², °C, kPa…). Convert only for display.
- Widgets, sync and templates bind to canonical channel ids
  (`channels.ts`), never to logger column names.
- New loggers: add a `LoggerProfile` in `src/core/data/profiles/` and
  register it in `registry.ts`, with a fixture test. Unknown loggers go
  through the generic profile, and confirmed mappings become
  `UserProfileDefinition`s.
- Project files reference media and CSVs by path; decoded data is never
  stored in them.
- Every project edit goes through `store.update(label, recipe)` so it is
  undoable; pass a `coalesceKey` for continuous edits like drags.
- Style: single quotes, no semicolons, two-space indent.

## Status

On branch `redesign`: M0 (foundation) is implemented. Tests, typecheck and
lint pass. `dist/`, `dist-electron/` and `release/` are build output and are
gitignored.

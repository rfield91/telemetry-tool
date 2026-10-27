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
- `npm run dev:browser`: the renderer alone on http://localhost:5199 (no
  Electron), using dev-server file endpoints. Load files with
  `?video=<abs path>&csv=<abs path>&offset=<s>`; add `laps=3` and
  `export=<abs path>` to run an export (logs `EXPORT_RESULT`). For the real
  app, `npm run build` then run `npx electron .` with
  `TELEMETRY_OVERLAY_AUTOTEST` set to the same keys as JSON. `.claude/launch.json` runs
  it for the built-in browser preview.
- `npm test`: Vitest (jsdom). Tests import real fixtures from `sample-data/`
  with Vite `?raw` imports (binary fixtures are base64 `.b64` text).
  `electron/files.test.ts` runs in node.
- `npm run typecheck`: `tsc -b` over `tsconfig.app.json` (src) and
  `tsconfig.node.json` (electron, dev/, vite config).
- `npm run lint`: oxlint (also covers `spike/`).
- `npm run dist`: Windows NSIS installer into `release/`.

## Layout

- `electron/`: main process (window, `media://` streaming protocol, file,
  export-output and profile IPC with picked-file and save-path allowlists
  in `files.ts`) and preload.
- `dev/fileServer.ts`: dev-only Vite middleware mirroring the file IPC.
- `src/App.tsx` + `src/app/`: the React UI. `state.ts` (undoable project
  store + runtime store), `actions.ts`, `host.ts` (Electron vs browser file
  access), `player.ts` (playback clock), `layout.ts` (layout edits and
  templates), `exporting.ts` (export plan and run), `sync/` and `export/`
  (workers + clients), `components/` (Stage,
  LayoutEditor, Transport, MediaPanel, InspectorPanel, LayoutPanel,
  ChannelPicker, MappingDialog, ExportDialog, ui primitives).
- `src/core/`: framework-free logic (no React; canvas code is
  OffscreenCanvas-compatible), unit tested:
  - `data/`: CSV parsing, timestamps and clocks, units, canonical channels,
    series, GPS projection, logger profiles (`profiles/`), and `import.ts`
    (CSV → `TelemetrySession`).
  - `laps/`: lap model from logger markers, delta to best lap.
  - `media/`: MP4 reader, protobuf decoding, camera adapters (`cameras/`,
    DJI so far), `probeVideo`.
  - `sync/`: auto-sync engine (FFT correlation, lap candidates, half-split
    drift check, confidence) and logger yaw extraction with GPS fallbacks.
  - `widgets/`: widget definitions (with their editable `styleFields`),
    binding/units (`data.ts`), default layout, and `OverlayRenderer`
    (cached static layers).
  - `export/`: export planning (segments, sizes, bitrate, atlas), the
    WebGPU and Canvas 2D compositors, and the mediabunny/WebCodecs
    pipeline.
  - `layout/`: editor geometry (snapping, move, resize) and layout
    templates bound to canonical channels.
  - `project/`: project schema, save/load validation, Zustand store with
    Immer-patch undo/redo.
- `sample-data/3.csv`: AiM session (4 laps). `sample-data/solostorm/`: two
  Solostorm single-lap exports that match the DJI videos used in the spikes.
  `svt-canaan-session.csv` is the full 12-lap session trimmed to the columns
  sync and laps use. `sample-data/media/`: a tiny H.264/AAC MP4 and 240 real DJI `djmd` packets
  (base64). `sample-data/sync/`: camera yaw (50 Hz, int16) extracted from the
  NER and SVT DJI videos, pinning the auto-sync results in tests.
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
  undoable; pass a `coalesceKey` for continuous edits like drags (use
  `gestureKey()` in `layout.ts` so separate drags stay separate steps).
- New widget types: add the definition with its `styleFields` and register
  it in `widgets/registry.ts` (that order is the Add menu's order).
- Widgets put everything that doesn't change per frame in `drawStatic`;
  `drawDynamic` must stay cheap (the full layout is ~0.2 ms per frame).
- New cameras: add a `CameraAdapter` in `src/core/media/cameras/` and
  register it in `registry.ts`.
- Renderer code never touches files directly; go through `FileHost`.
- Video ↔ data time always goes through the sync's time map
  (`useActivePair().time.toData/toVideo`); syncs include clock `drift`, so
  never add or subtract the offset by hand.
- UI colours come from the theme tokens in `src/index.css` (`canvas`,
  `surface`, `raised`, `hover`, `line`, `fg`/`fg-muted`/`fg-subtle`,
  `accent`, `good`/`warn`/`danger`). Don't use raw Tailwind palette
  colours. The accent is for primary actions, the playhead, best lap and
  selection only. Use sentence-case headings, icons from `lucide-react`, and
  primitives from `src/app/components/ui.tsx`. Overlay widget colours are
  separate (they're part of the video).
- Style: single quotes, no semicolons, two-space indent.

## Status

On branch `redesign`: M0 (foundation) and M1 (import and preview) are
implemented, M2 (auto-sync) is done except image-motion sync and lap
thumbnails, M3 (layout editor) is done except overlay fonts, and M4
(export) is done: the full 16.5-minute DJI session exports at 5.2x real
time in Electron (via the autotest hook). Tests, typecheck, lint and build
pass. Playback of exports in other players and editors hasn't been checked
yet. `dist/`, `dist-electron/` and `release/` are build output and are
gitignored.

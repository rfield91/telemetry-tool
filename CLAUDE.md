# CLAUDE.md

Electron + React 19 + Vite 8 + Tailwind 4 desktop app that imports racecar
logger CSVs (AiM Race Studio or generic), lets the user lay out SVG gauges, and
exports a transparent VP9/WebM overlay video via bundled FFmpeg.

Read `docs/ARCHITECTURE.md` before non-trivial changes. It covers the data
pipeline, the two renderer modes, the export pipeline, and known rough edges.

## Commands

- `npm run dev`: Vite + Electron in dev mode (the export path needs Electron;
  in a plain browser only CSV loading and preview work).
- `npm test`: Vitest (jsdom; `electron/exportVideo.test.ts` runs in node and
  shells out to ffmpeg/ffprobe).
- `npm run typecheck`: `tsc -b` over `tsconfig.app.json` (src) and
  `tsconfig.node.json` (electron + vite config).
- `npm run lint`: oxlint.
- `npm run dist`: Windows NSIS installer into `release/`.

## Layout

- `electron/`: main process (window, IPC, preload bridge, offscreen frame
  capture + FFmpeg encode).
- `src/main.tsx`: switches between the editor (`App.tsx`) and the headless
  export renderer when the URL has `?export=1`.
- `src/App.tsx`: the entire editor UI and state, in one large file.
- `src/renderer/lib/`: pure logic (CSV parsing, format detection, presets,
  interpolation, GPS projection). Unit tested.
- `src/renderer/components/`: SVG overlay widgets (Gauge, Bar, KeyValue,
  TrackMap, GMeter).
- `src/renderer/export/OverlayFrame.tsx`: renders all components at time `t`
  on a fixed-size transparent frame. The preview and the export share these
  components.
- `src/renderer/presets/*.json`: bundled layouts, registered in `index.ts`.
- `sample-data/3.csv`: a real AiM export (20 Hz, GPS + ECU channels), and
  `3-overlay.webm`, an example output.

## Conventions

- Times in series are seconds, normalised so the first valid sample is 0.
- Overlay positions are fractions: `x`/`y` give the centre as a fraction of
  frame width/height, and `size` is a fraction of frame height.
- Editor overlays (`OverlayConfig`) reference CSV column names. Export
  definitions (`OverlayComponentDefinition`) carry pre-built point arrays.
- Export request/definition types are duplicated in `electron/exportVideo.ts`,
  `src/types/electron.d.ts` and `OverlayFrame.tsx`. Update all three together.
- To support a new logger, add a `CsvFormatProfile` in
  `src/renderer/lib/csvFormats.ts` before `genericProfile`.
- Style varies by file. Older modules use single quotes and no semicolons;
  `App.tsx`, `overlayConfig.ts` and `overlayPresets.ts` use double quotes and
  semicolons. Match the file you're editing.

## Status

This is an earlier prototype. Tests (43) and typecheck pass. `dist/`,
`dist-electron/` and `release/` are build output and are gitignored.

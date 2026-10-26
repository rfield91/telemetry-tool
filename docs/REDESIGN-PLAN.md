# Redesign plan

How to rebuild Telemetry Overlay as an all-in-one tool (import video and
telemetry, sync them, lay out an overlay, and export the finished video),
using what the spikes in `spike/` proved.

## Goals

1. **A good user interface.** This is the main complaint about existing
   tools. Direct manipulation, few modal steps, and sensible defaults.
2. **Flexible layouts.** Users place, size and style any widget, and choose
   which data drives it.
3. **Fast enough to never be a burden.** Sync in seconds, preview at full
   frame rate, and export faster than real time.

## Decisions (2026-10-26)

| Topic | Decision | Consequence for the plan |
| --- | --- | --- |
| Platform | **Windows only** | Windows codec paths (Media Foundation, NVENC/AMF/QSV), NSIS installer. No macOS work. |
| Cameras | **DJI and GoPro** for now; adding more must be easy | A camera-adapter registry. Each adapter detects its files and supplies motion data and metadata. |
| Outputs | **Composited video only** | No overlay-only/transparent export. Output is MP4 (HEVC or H.264) with audio. |
| Loggers | **Unknown, so stay flexible** | Built-in profiles plus a generic column-mapping importer whose mappings save as reusable user profiles. |
| Laps | **Accept full-session exports and pick laps in the app** | Lap detection (logger lap markers, or a GPS start/finish line) and a lap picker. Sync the whole session once, then choose laps. Single-lap files still work through the multi-lap search. |

## What the spikes established

| Area | Finding | Source |
| --- | --- | --- |
| Export speed | Decode → composite → hardware encode inside Electron runs at 3.8–5x real time on a real 2.7K60 10-bit DJI file and 2–2.6x at 4K60 (RTX 3070 Ti). | `spike/export-speed` |
| Overlay cost | Per-frame overlay drawing is the bottleneck, not readback or encoding. Re-stroking a 22k-point track path cut 4K to 21 fps; caching static layers restored 105–156 fps. | `spike/export-speed` |
| Compositor | WebGPU (zero-copy video texture, in-shader NV12 packing, async readback at ~10 GB/s) is fastest. Plain Canvas 2D is 13–30% slower but viable as a fallback. WebGL `readPixels` was too slow to be worth using (~0.3–0.5 GB/s). | `spike/export-speed` |
| Codecs | HEVC output is ~30% faster than H.264 on NVENC at the same size. 10-bit HEVC sources decode in hardware; output is 8-bit. | `spike/export-speed` |
| Large files | Byte-range reads (mediabunny `CustomSource`) handle 8.8 GB files; nothing is loaded whole. | `spike/export-speed` |
| Sync (camera IMU) | DJI `djmd` metadata carries per-frame orientation and acceleration. Yaw from it matches logger yaw at r = 0.986, ±6 ms, in 0.3 s, with no video decode. | `spike/auto-sync` |
| Sync (any camera) | Horizontal image motion in a windshield region vs logger yaw gives r = 0.89, ±20 ms. A slower fallback (decodes the video). | `spike/auto-sync` |
| Multi-lap | A single-lap export is found in a session video by correlating per lap, then checking that the lap's two halves agree (21 ms vs 415 ms for the next-best lap). 9.8 s for a 16.5 min session. | `spike/auto-sync` |
| Clocks | Camera clocks were 18–18.5 min off and shifted between days. Solostorm `GPS_TIME` is GPS time (UTC + 18 s). Timestamps can only narrow a search. | `spike/auto-sync` |

## Architecture

Keep Electron + React 19 + Vite + TypeScript + Tailwind. Add:

- **mediabunny** for demuxing and muxing. WebCodecs for hardware decode and
  encode. WebGPU for compositing, with a Canvas 2D fallback.
- **Zustand** (or similar) for a single project store, with undo/redo
  through Immer patches.
- **Web workers** for CSV parsing, sync correlation and anything else
  CPU-heavy, so the UI never stalls.

```
Project file (.json)
 ├─ videos[]      file paths (chapters joined), camera adapter, metadata
 ├─ telemetry[]   file path, logger profile or user mapping, channels, laps[]
 ├─ syncs[]       video ↔ telemetry offset, method, confidence
 ├─ selection     chosen lap(s) or time range to export
 ├─ layout        widgets[] (type, rect, style, channel bindings), canvas size
 └─ export        codec, bitrate, resolution, audio
```

### Extension points

Cameras and loggers are open-ended, so both sit behind small registries.
Adding one is a new adapter file plus test fixtures, with no changes
elsewhere.

```ts
interface CameraAdapter {
  id: string                       // 'dji-action', 'gopro'
  detect(probe: MediaProbe): boolean
  /** Per-frame or high-rate camera motion, on the video timeline. */
  readMotion?(file: MediaSource): Promise<{ times: Float64Array; yawRate: Float64Array } | null>
  /** Absolute UTC time hint (e.g. GoPro GPS time), if trustworthy. */
  readTimeHint?(file: MediaSource): Promise<number | null>
  /** Group chaptered files into one recording. */
  chapterKey?(fileName: string): string | null
}

interface LoggerProfile {
  id: string                       // 'aim', 'solostorm', or a user mapping id
  detect(parsed: ParsedCsv): Detection | null
  /** Map source columns to canonical channels with units. */
  channels(parsed: ParsedCsv): ChannelMapping[]
  time(parsed: ParsedCsv): { column: string; unit: TimeUnit; clock?: 'gps' | 'utc' | 'relative' }
  laps?(parsed: ParsedCsv): Lap[]   // logger-provided lap markers
}
```

- **Built-in camera adapters:** DJI Osmo Action (`djmd` quaternions) and
  GoPro (GPMF `GYRO`/`ACCL`, GPS time).
- **Built-in logger profiles:** AiM and Solostorm.
- **User mappings:** for any other CSV, the importer guesses the time column,
  units and channels (the existing heuristics in `telemetry.ts`), and the
  user confirms or corrects them in a mapping screen. The confirmed mapping
  is saved as a `LoggerProfile` that auto-detects matching files next time.
  The mapping screen can also export the profile so it can be shared.
- **Canonical channels** (speed, yaw rate, lateral/longitudinal g, lat/lon,
  throttle, brake, RPM, temperatures, pressures…) are what widgets and sync
  bind to. That makes layouts and sync independent of the logger.

Modules:

| Module | Responsibility | Built from |
| --- | --- | --- |
| `data/` | CSV parsing, logger-profile registry (AiM, Solostorm, user mappings), canonical channels with units and conversion, interpolation | Port `src/renderer/lib/` (tested) + Solostorm profile |
| `laps/` | Lap detection from logger markers or a GPS start/finish line, lap times, best lap, lap picker data | New; Solostorm `MATH_LAP_NUMBER`, AiM beacon markers |
| `media/` | Streaming file source, track probing, chapter joining, camera-adapter registry (DJI, GoPro), frame decode for preview and export | `spike/export-speed/bench.cjs`, `spike/auto-sync/djiImu.mjs` |
| `sync/` | Tiered sync engine in a worker: camera IMU → image motion → manual. Whole-session sync by default; multi-lap candidate search with the half-split check for single-lap files. Returns offset + confidence + candidates. | `spike/auto-sync/*.mjs` |
| `widgets/` | Canvas 2D widgets with a `drawStatic` / `drawDynamic` split, a bounding-rect API, and a style schema | `spike/export-speed/overlay.cjs`, old `components/` for visuals |
| `render/` | Shared frame compositor for preview and export (WebGPU atlas + NV12 pack, Canvas 2D fallback) | `spike/export-speed/webgpuNv12.cjs` |
| `export/` | Pipeline orchestration in a hidden renderer: decode → compose → encode → mux, audio passthrough, progress, cancel | `spike/export-speed/bench.cjs` |
| `editor/` | UI: video stage with draggable widgets, inspector, channel picker, timeline, sync panel | New |

Design rules carried from the spikes:

1. **Widgets cache everything static** (faces, ticks, track outlines, rings)
   and draw only the moving parts per frame. Budget: under 1 ms per frame for
   a full layout at 4K.
2. **The same widget code draws preview and export**, so what you see is what
   you get.
3. **Never load a video whole.** Read byte ranges, and keep at most a few
   decoded frames in flight with backpressure.
4. **Sync is signal-based.** Timestamps are only a hint for narrowing the
   search.
5. **One Electron renderer per export job**, destroyed afterwards. Destroying
   GPU windows broke later windows in the same process.

## Milestones

Each milestone ends with something usable and a short demo.

### M0 — Foundation

- Tag the current code as `prototype-v0`. Start the new app structure on a
  branch, replacing `src/` and `electron/`.
- Port `telemetry.ts`, `csvFormats.ts`, interpolation and GPS projection
  with their tests, reshaped into the `LoggerProfile` registry.
- Add a **Solostorm profile**: `GPS_TIME` as GPS time,
  `RECORDED_SAMPLE_COUNT` marking real samples, lap number and lap elapsed
  time.
- Canonical channels with unit conversion (m/s ↔ mph, rad/s ↔ °/s, kPa ↔
  psi, °C ↔ °F).
- **Lap model:** laps from logger markers (Solostorm lap number, AiM
  beacon markers), with lap times and best lap.
- Project store, save/load of `.json` project files, undo/redo.
- Request a **full-session Solostorm export** of the SVT Canaan session as
  a test fixture.

**Done when** both sample CSVs (AiM and Solostorm) load into canonical
channels and laps with tests, and a project round-trips through save/load.

### M1 — Import and preview

- Import video with streaming reads through the camera-adapter registry;
  show its metadata, including whether camera motion data is available.
- **Generic CSV mapping screen:** for files no profile recognises, show the
  guessed time column, units and channel roles. Let the user correct them,
  then save the result as a reusable profile.
- A preview player: a `<video>` element with a canvas overlay, scrubbing,
  playback, and frame stepping.
- Widget framework plus the first widgets, rebuilt on the static/dynamic
  split: dial gauge, bar, numeric readout, track map, g-meter.
- Measure preview frame time; target 60 fps at 2.7K with a full layout.

**Done when** a DJI video and a CSV play together with a hand-entered offset
and five widgets at 60 fps.

### M2 — Auto-sync

- Move the sync engine into a worker with progress reporting.
- Tier 1: camera motion from the camera adapter (DJI `djmd` quaternions now;
  the GoPro adapter adds GPMF gyro in M5), gravity-projected yaw.
- **Session-first flow:** sync the full session once, then show a **lap
  picker** (lap list with times, best lap highlighted, thumbnail at each lap
  start) to choose what to export. Single-lap files go through the
  multi-lap candidate search instead.
- Tier 2: windshield image motion, with a draggable region on a video
  frame.
- Tier 3: manual nudge (frame step, ±10 ms) with the yaw comparison plot as
  live feedback.
- Multi-lap: candidate search, half-split check, confidence score. If the
  margin is thin, show the top candidates with previews for a one-click
  choice.
- Map yaw channels across formats (Solostorm `YAW_RATE` rad/s; AiM `GPS
  Gyro` °/s — confirm the AiM sign and units).

**Done when** both test sets (NER autocross, SVT Canaan session) sync with
no user input, matching the spike results (29.146 s; lap at 4:14.69). A
full-session export of SVT Canaan should sync once, with every lap
selectable.

### M3 — Layout editor

- Direct manipulation on the video stage: drag, resize, snap to edges,
  centres and other widgets, keyboard nudging, multi-select.
- Inspector: per-widget style (colours, fonts, ranges, units) and a channel
  picker that shows each channel's live value and plausible range.
- Layer list (order, show/hide, lock).
- Layout templates: save, load and apply, using the channel registry so a
  template made for AiM data works with Solostorm data.
- New widgets driven by lap data: lap timer and delta to best lap.

**Done when** a user can build the AiM-default layout from scratch in under
two minutes, and apply it to a Solostorm session.

### M4 — Export

- Production pipeline from the spike: WebGPU atlas compositor, NV12 pack,
  WebCodecs HEVC/H.264, mediabunny MP4 mux.
- **Audio passthrough** (AAC copy) — not done in the spike.
- Export range from the selected lap(s), with optional lead-in and lead-out
  seconds, or from trim points. Bitrate and codec choices with sensible
  defaults (HEVC, source resolution and frame rate).
- Progress with ETA, cancel, and cleanup of partial files.
- Canvas 2D fallback when WebGPU or hardware encode is unavailable.
- Composited MP4 only. The old prototype's transparent overlay export is
  dropped.
- Run a full 16.5-minute export and record sustained throughput.

**Done when** the full DJI session exports with overlay and audio at ≥3x
real time, and the output plays in common players and editors.

### M5 — Breadth and polish

- **GoPro camera adapter:** GPMF gyro and accelerometer for sync; GPS with
  UTC time as a first-guess offset. Needs sample GoPro footage with a
  matching logger file.
- Recordings split across several files (GoPro and DJI chapters) treated as
  one continuous video.
- Rotation metadata, HDR/log sources (tone-map to SDR).
- Other Windows GPUs: test AMD (AMF) and Intel (QSV), and machines without
  hardware encode.
- Windows installer (NSIS), first-run experience, error reporting.
- A short "adding a camera / logger" guide, using the DJI adapter and the
  Solostorm profile as worked examples.

## Performance budgets

| Operation | Target (RTX 3070 Ti class) |
| --- | --- |
| Open a 9 GB video | < 2 s to first frame |
| Auto-sync, camera IMU, 16 min session | < 15 s including multi-lap search |
| Preview | 60 fps at source resolution with a full layout |
| Widget drawing | < 1 ms per frame (dynamic parts only) |
| Export 2.7K60 | ≥ 3x real time with HEVC output |
| Export 4K60 | ≥ 2x real time with HEVC output |

## Risks

| Risk | Mitigation |
| --- | --- |
| Other GPUs (AMD/Intel) behave differently, or have no hardware HEVC encode | Benchmark early in M4. Canvas 2D + H.264 fallback. Detect encoder support before export. |
| WebGPU unavailable or blocklisted on some drivers | Canvas 2D compositor fallback, already measured as viable. |
| DJI metadata format changes with firmware or model | The decoder is schema-less and keyed on structure; check for unit quaternions before trusting a field. Image-motion fallback. |
| Laps nearly identical in time and line | Encourage full-session imports (no ambiguity). For single-lap files: confidence threshold, then one-click candidate choice with previews. |
| Unknown loggers with odd CSV layouts | Mapping screen with editable guesses; saved user profiles; keep varied sample files as fixtures. |
| Loggers without lap markers | Detect laps from a GPS start/finish line the user places on the track map. |
| Logger yaw channels differ in name, units and sign | Channel registry with explicit units. Correlation ignores sign. |
| Very long sessions (memory, sustained thermals) | Streaming everywhere, bounded queues, a full-length export test in M4. |

## Open questions

- **10-bit output** for 10-bit sources, or 8-bit only? 8-bit is assumed for
  now.
- **Test data still needed:**
  - a full-session Solostorm export (for M0/M2)
  - GoPro footage with a matching logger file (for M5)
  - an AiM file recorded alongside video, to check the `GPS Gyro` sign and
    units for sync

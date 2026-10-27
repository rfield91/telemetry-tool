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

**Status (2026-10-26): done.**
- The NER DJI video (2.7K60 10-bit HEVC) and the Solostorm lap played
  together at offset 29.146 s with seven widgets.
- In steady playback: 300 frames decoded in 5 s with 0 dropped, 58.8 fps
  presented, and the overlay drew in 0.19 ms per frame on average (0.40 ms
  max).
- Verified in the browser harness (`npm run dev:browser`). Electron file
  access (media:// ranges, IPC) is covered by unit tests but hasn't been
  exercised in a real Electron window yet.

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

**Status (2026-10-26): core done; three items open.**

Done:
- Sync engine in `src/core/sync/`: FFT-based normalised correlation over
  all lags, peak candidates, the half-split drift check, per-window
  precision and a confidence level.
- It runs in a worker. Camera motion comes through the camera adapter, and
  file reads go over an RPC to `FileHost`.
- Auto-sync runs on load when the camera has motion data. It is undoable,
  and never overwrites an offset you changed meanwhile.
- The Sync panel shows status (match, precision), the data-vs-camera yaw
  plot around the playhead, nudges, and **Other matches** with Use / Go
  back.
- Lap list checkboxes set the export selection.
- Logger yaw falls back to GPS heading, then GPS course. These are about
  0.07–0.08 s behind the gyro (GPS latency), and the UI says ±0.1 s.

Verified in the browser harness, with no user input:

| Session | Offset | Spike result | Notes |
| --- | --- | --- | --- |
| NER | 29.146 s | 29.146 s | match 0.99, ±6 ms |
| SVT | 254.693 s | lap at 4:14.69 | picked from 8 similar laps; drift 0.02 s vs 0.41 s for the runner-up |

The same results are pinned in `src/core/sync/sync.test.ts` using camera-yaw
fixtures extracted from the real videos.

**Full session (2026-10-26).** `svt-canaan-session.csv` (12 laps, 800 s)
first synced at 127.86 s with match 0.81 and ±242 ms. There were three
causes:
- **Interleaved orientation streams.** The DJI file writes other streams
  2.3–3 rad away from the main one, around dropped-frame stretches (video
  798–918 s). Read as one stream, they produced ±150 rad/s spikes and
  wrong-sign turn rates.
- **Equal weighting.** The engine trusted every window equally.
- **Clock drift.** The logger clock runs 46 ppm fast relative to the camera,
  about 37 ms over the session.

Fixes:
- The DJI decode splits samples into continuity tracks and drops stray ones.
- The engine ignores gaps (masked FFT correlation) and excludes windows that
  disagree.
- Drift is fitted and applied (`sync.drift`).

It now reads match 0.99, 99% coverage, ±34 ms, and places lap 37 at
254.692 s (single-lap export: 254.693 s).

Open:
- **Tier 2 image motion** for cameras without motion data. The panel says
  to set the offset by hand for now.
- **Lap thumbnails** in the lap list.
- The AiM `GPS Gyro` sign is still unchecked against video. Correlation
  ignores sign, so sync doesn't depend on it.

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

**Status (2026-10-26): done except custom fonts; the two-minute build is
not yet timed by a person.**
- Stage editing: click or marquee to select, Shift/Ctrl-click to add,
  drag to move, corner handles to resize (aspect kept, opposite corner
  fixed). Moves and resizes snap to the frame edges, centre, a 2% safe
  margin, and other widgets' edges and centres, with guides; Alt places
  freely. Arrows nudge by one output pixel (Shift: ten), Ctrl+D
  duplicates, Del deletes, Ctrl+A selects all, Esc clears. Each drag is one
  undo step.
- The right column has Sync and Layout tabs. Layout has the layer list
  (front first, drag to reorder, show/hide, lock, a warning when the data
  lacks a bound channel) and the selected widget's properties: channel
  picker with each channel's live value and range, display unit, style
  fields declared by each widget (`styleFields`), and position in pixels.
  Changing a channel moves data-derived style values (a gauge's range) and
  channel-named labels along with it; values the user edited stay.
- Templates (`core/layout/templates.ts`) store canonical bindings, so a
  layout built on Solostorm data resolved every channel on the AiM file in
  the harness, and the reverse is a unit test. They're saved to
  `userData/layout-templates.json` (localStorage in the browser harness).
- New widgets: lap timer (lap number, running time, best lap) and delta to
  best lap. Delta is distance-based: speed is integrated into distance and
  each lap is scaled to the best lap's length. On the 12-lap SVT session it
  is 0 on the best lap and matches each lap's time difference at the line
  to within 5 ms.
- The default layout adds the lap timer when the data has laps, and the
  delta when there are at least two timed laps.
- The full 10-widget layout draws in 0.1 ms per frame (0.3 ms p95) at
  2688×1512.
- Verified in the browser harness by driving pointer events, keyboard
  shortcuts and the menus. The harness pane was too small for a useful
  visual review of the new panels.
- **Open:** font choice for overlay text; template import/export to a file
  for sharing; align and distribute commands for multi-selections.

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

**Status (2026-10-26): done; playback in other players and editors not
checked yet.**
- The full SVT Canaan session (DJI Osmo Action 4, 8.8 GB, 2688×1512 10-bit
  HEVC, 16:29) exported in the Electron app with the 10-widget layout and
  audio in **191 s: 5.2x real time (306 fps)**. That's HEVC at 29.2 Mb/s
  with the WebGPU compositor, measured on an RTX 3070 Ti. The run was
  repeated with byte-identical output, and memory stayed flat at about
  2.1 GB.
- Output checks with ffprobe and ffmpeg:
  - all 58,300 source frames are kept with their original timing (the
    camera dropped some, so the average is 58.92 fps);
  - AAC audio has the same length;
  - a full decode is error-free;
  - the container has a BT.709 `colr` box.
- Frames checked at 0:28 into lap 37 and at 14:30 (in-lap, after the
  camera's dropped frames) match the car's dash display.
- Lap export: lap 37 plus 2 s either side came out as 3946 frames and
  65.8 s, with the lap timer at 0:28.0 and delta +0.00 on the best lap.
- Export runs in a worker in the main window, not a separate window, so
  the spike's GPU-window teardown problem doesn't arise. Two exports in a
  row both used WebGPU and produced identical files.
- The Canvas 2D fallback (H.264) produced the same lap. Cancelling deletes
  the `.part` file.
- **Open:**
  - One early run exited at about 94% with no error output, leaving the
    `.part` file. This was before crash logging was added to the autotest
    hook; the next two runs were clean. Watch for it.
  - Check that the output plays in VLC, Windows Media Player, Premiere and
    DaVinci Resolve.
  - Exports per lap as separate files; non-lap trim points.
  - HEVC's in-stream color info is unspecified (only the container is
    tagged).

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

**Status (2026-10-26): installer, first run, error reporting and the guide
are done. GoPro, chapters, rotation/HDR and other GPUs are deferred (no
GoPro footage yet).**
- **Installer:** `npm run dist` builds a 100 MB NSIS installer. The app
  itself is an 880 KB `app.asar`; the rest is Electron.
  - All npm packages became dev dependencies, because Vite bundles
    everything the app uses. This drops about 80 MB of ffmpeg from the
    install.
  - Assisted setup with a chosen folder, Start menu and desktop shortcuts.
  - A generated app icon (`npm run icon`, `scripts/make-icon.mjs`).
  - Electron is copied from `node_modules` (`electronDist`), because
    extracting its zip failed when Windows held the fresh files.
  - The packaged exe passes `--smoke-test`: the UI renders, the preload
    API is present, and there are no console errors under the CSP. The
    installer itself hasn't been run.
- **Security:** the built page has a Content-Security-Policy (build only,
  since dev needs inline scripts). A lap export under it still runs on
  WebGPU at 4.8x real time.
- **Error reporting:** `userData/logs/telemetry-overlay.log` (rotated at
  2 MB) records:
  - the app, Electron, Windows and GPU versions;
  - uncaught main and renderer errors, and renderer/GPU process crashes;
  - every error the UI shows, and export results.
  A crashed window offers Reload or "Open log folder". The header's help
  menu opens the folder and shows the version.
- **First run:** the start screen adds a three-step outline (sync, lay out,
  export) under the Add buttons.
- **Guide:** `docs/EXTENDING.md` covers adding a logger profile
  (Solostorm) or a camera adapter (DJI), with fixtures, tests and a
  checklist.
- Full-window screenshots of the start screen, editor and export dialog
  were captured from Electron (`--smoke-test --screenshot=…`). They
  caught the toggle switches' knob drawing outside the track, now fixed.

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

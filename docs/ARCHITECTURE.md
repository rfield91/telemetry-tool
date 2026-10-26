# Architecture

Current state of the rebuild (milestone M0 of `docs/REDESIGN-PLAN.md`). The
original prototype (SVG gauges, transparent WebM export) is preserved at git
tag `prototype-v0`.

## Overview

```
CSV text
  └─ parseCsv ─────────────► ParsedCsv (headers, rows, metadata, units row)
        └─ ProfileRegistry.detect ─► LoggerProfile (user → built-in → generic)
              ├─ time()      ─► time column, unit, clock
              ├─ channels()  ─► column → canonical channel + unit
              └─ laps()      ─► Lap[] from logger markers
        └─ importParsed ───► TelemetrySession
                               channels (base units), laps, startUtcMs, warnings

Project (.json)  ◄── serializeProject / parseProject
  └─ createProjectStore ─► Zustand store, Immer patches for undo/redo
```

Everything under `src/core/` is plain TypeScript with no DOM or React
dependencies, so the same code can run in a worker (planned for parsing and
sync).

## Telemetry import (`src/core/data/`)

| File | Responsibility |
| --- | --- |
| `csv.ts` | Papa Parse wrapper that finds the real header row under logger preambles, an optional units row, and key/value metadata. `splitHeaderUnit` reads `NAME (unit)` headers. |
| `time.ts` | Timestamp units (s/ms/µs, auto-inferred from spacing) and clocks: `relative`, `unix-utc`, `unix-gps` (GPS time = UTC + 18 s). |
| `units.ts` | Unit table with aliases, base units per quantity, and conversion (incl. °F/°C offsets). |
| `channels.ts` | Canonical channel ids (speed, yawRate, lateralAccel, …) with display units, plus name heuristics for unknown loggers. |
| `series.ts` | `Series` (typed arrays), building from rows (sort, drop invalid, last duplicate wins), interpolation. |
| `gps.ts` | Lat/lon → local east/north metres, and a north-up fit into a box (for track maps and, later, start/finish-line lap detection). |
| `import.ts` | `importTelemetry` / `importParsed`: builds one shared time base, converts each mapped column to base units, assigns each canonical channel to one column at most, and collects warnings. |

### Logger profiles (`src/core/data/profiles/`)

A `LoggerProfile` answers four questions about a CSV: is it mine
(`detect`), where is time (`time`), which columns mean what (`channels`), and
where are the laps (`laps`, optional).

| Profile | Detection | Notes |
| --- | --- | --- |
| `solostorm` | `GPS_TIME (ms)` + `SYSTEM_TIME (ms)` headers | Time is Unix ms on the GPS scale. Units come from header suffixes. Laps from `MATH_LAP_NUMBER`. `ACCEL_X` is the lateral axis. |
| `aim` | `Format` metadata, GPS headers, or preamble + units row | Relative seconds. Units from the units row. Laps from `Beacon Markers`. |
| user (`user.ts`) | All saved match headers present | A confirmed mapping saved as JSON (`UserProfileDefinition`). |
| `generic` | Fallback | Guesses time column, unit, clock and channel roles. Its guesses seed the mapping screen (M1). |

`ProfileRegistry` tries user profiles first, then built-ins with high
confidence, then low-confidence matches, then generic.

## Laps (`src/core/laps/laps.ts`)

`Lap` has a 1-based session `index`, the logger's own `loggerNumber` when
available, start/end in session seconds, and a `kind`. When a session has
more than one lap, the first is `out` and the last `in`. A single segment
(a one-lap export) is `timed`. `bestLap` considers timed laps only.

GPS start/finish-line lap detection for loggers without markers is planned,
not built.

## Projects (`src/core/project/`)

| File | Responsibility |
| --- | --- |
| `schema.ts` | `Project` v1: videos (chapter path lists), telemetry (path + profile id + embedded user mapping), syncs (offset, method, confidence), lap selection with lead-in/out, layout widgets (fractional rects, canonical bindings, style), export settings. |
| `serialize.ts` | JSON save/load with structural validation and readable errors; rejects files from newer versions; migrations slot in by version. |
| `store.ts` | Vanilla Zustand store. `update(label, recipe, { coalesceKey })` records Immer patches; `undo`/`redo` apply them; rapid edits with the same key within 1 s merge into one step; history is capped at 200. |

## Electron shell

`electron/main.ts` opens the window and handles `csv:open` (returns path,
name and text). `electron/preload.ts` exposes it as
`window.telemetryOverlay`. Video, sync and export IPC arrive in M1–M4.

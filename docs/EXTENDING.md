# Adding a logger or a camera

Loggers and cameras each sit behind a small registry. Adding one is a new
file plus test fixtures. The rest of the app (import, laps, widgets, sync,
export) works unchanged, because it only sees canonical channels and camera
motion.

| You want to support | Add | Register in | Worked example |
| --- | --- | --- | --- |
| A data logger's CSV export | a `LoggerProfile` | `src/core/data/profiles/registry.ts` | `profiles/solostorm.ts` |
| A camera's motion data, for auto-sync | a `CameraAdapter` | `src/core/media/cameras/registry.ts` | `cameras/dji.ts` |

## Adding a logger

### First, check whether you need code

Users can already load any CSV that has a time column. The generic profile
guesses the columns, the mapping screen lets the user correct them, and the
result is saved as a user profile (`UserProfileDefinition`). From then on,
files with the same headers are recognised automatically.

A built-in profile is worth writing when a logger:
- is common enough to ship;
- needs logic that a column mapping can't express, such as an unusual clock,
  laps from markers, or sign conventions; or
- writes files the generic guesses get wrong.

### The interface

```ts
interface LoggerProfile {
  id: string                 // stable; stored in project files
  label: string              // shown in the UI
  builtIn: boolean
  detect(parsed): Detection | null              // is this file mine?
  time(parsed): { column, unit, clock }         // where time is
  channels(parsed): ChannelMapping[]            // which columns mean what
  laps?(context): Lap[]                         // logger lap markers, if any
}
```

`parsed` is the output of `parseCsv` (`src/core/data/csv.ts`). It has
already found the real header row under any preamble, an optional units
row, and key/value metadata lines.

### Worked example: Solostorm (`profiles/solostorm.ts`)

1. **Detect** with headers only this logger writes:
   `GPS_TIME (ms)` and `SYSTEM_TIME (ms)`.
   - Return `confidence: 'high'` for an unambiguous match.
   - Return `'low'` for a plausible one; a later high-confidence profile
     wins over it.
   - Return `null` otherwise.
2. **Time.** Solostorm's `GPS_TIME` is Unix milliseconds on the GPS time
   scale, so the clock is `'unix-gps'` (UTC + 18 s). The importer turns
   this into `time.startUtcMs`.
   - Use `'relative'` for loggers that count from the start of the
     session (AiM).
   - Use `'unix-utc'` for loggers that write wall-clock UTC.
3. **Channels.** Map each numeric column to a canonical channel id
   (`src/core/data/channels.ts`), with the unit text the logger uses.
   - The importer converts values to base units (`BASE_UNITS` in
     `units.ts`). Profiles never convert values themselves.
   - Solostorm puts units in the header (`SPEED (m/s)`), which
     `splitHeaderUnit` separates.
   - Columns whose headers leave the unit out get one from
     `IMPLIED_UNITS`.
   - Columns with no canonical id are still imported, and widgets can bind
     them by column name.
4. **Axes and signs.** Solostorm's `ACCEL_X` is lateral and `ACCEL_Y` is
   longitudinal; this was checked against the video in `spike/auto-sync`.
   Write down any such finding in a comment next to the mapping.
5. **Laps.** `MATH_LAP_NUMBER` changes at each crossing, so
   `lapsFromLapNumbers` builds laps from it.
   - Loggers with beacon times use `lapsFromBoundaries` (see `aim.ts`).
   - Return `[]` when the file has no markers.

### Checklist

- Unit spellings: `lookupUnit` must recognise them. Add an alias to `UNITS`
  in `units.ts` if needed.
- Canonical ids: add one to `channels.ts` only for a genuinely new kind of
  data, and give it a display unit.
- Register the profile in `ProfileRegistry`'s default list, more specific
  profiles before more general ones.
- Add a fixture under `sample-data/<logger>/`. Trim it to the columns and
  rows the tests need, and strip personal details you don't want
  published (driver names, home GPS tracks).
- Add tests next to the existing ones in `src/core/data/import.test.ts`:
  - detection picks your profile;
  - the time column and clock (check `startUtcMs` for absolute clocks);
  - several channels with values converted to base units;
  - lap count and lap times.
- Load the real file in the app (`npm run dev:browser`, then
  `?csv=<path>`), and check the lap list and a few widget values.

## Adding a camera

### What an adapter is for

Any H.264 or HEVC MP4 already plays, previews and exports, because media
decoding doesn't depend on the camera. An adapter adds three things:
- the camera's name in the UI;
- the description of its motion data;
- most importantly, a **yaw-rate signal on the video timeline**. Auto-sync
  correlates it with the logger's yaw (`src/core/sync/engine.ts`).

### The interface

```ts
interface CameraAdapter {
  id: string
  label: string
  detect(info: Mp4Info): boolean                         // is this file mine?
  motionSource(info: Mp4Info): string | null             // e.g. "DJI djmd orientation (58,300 samples)"
  identify?(file, info): Promise<{ model: string | null }>
  readMotion?(file, info): Promise<CameraMotion | null>  // { times, yawRate, source }
}
```

- `info` comes from `readMp4` (`src/core/media/mp4.ts`): every track's
  handler, sample-entry four-cc and sample table (byte offsets, sizes,
  times), read without loading the file.
- `file` is a `RandomAccessFile`. Read samples with `readTrackSamples`,
  which batches the byte ranges into one host round trip.

### Worked example: DJI Osmo Action (`cameras/dji.ts`)

1. **Detect** by the metadata track's four-cc: DJI writes a `djmd` track.
   Check structure, not file names.
2. **Identify.** The first `djmd` sample is a protobuf. The device code
   (string field 4 of the message at path 3.4.1, e.g. `DJI AC003`) maps to
   the model name. Decoding is
   schema-less (`protobuf.ts`), so unknown fields are ignored.
3. **Read motion.**
   - Each sample carries an orientation quaternion (3.2.9) and an
     acceleration vector (3.2.10).
   - `gravityYawRate` turns consecutive orientations into the rotation rate
     about the gravity axis, in rad/s. That is how fast the car is turning,
     whichever way the camera is mounted.
   - Return times in **video seconds**, one value per sample.
4. **Distrust the data.**
   - Some DJI files interleave stray orientation streams around dropped
     frames. The adapter splits samples into continuity tracks and drops
     the ones that overlap a larger track.
   - It also skips quaternions that aren't unit length.
   - Expect firmware differences and guard for them.

The sync engine handles the rest:
- signal sign (correlation ignores it);
- gaps (longer than 0.5 s counts as missing);
- clock drift between camera and logger;
- picking the right lap when the data covers only part of the video.

A rate of 25 Hz or more is plenty. The engine resamples to 50 Hz.

### Checklist

- Register the adapter in `CAMERA_ADAPTERS`, most specific first.
- Fixtures go in `sample-data/media/` as base64 text:
  - Real metadata packets are enough. `buildMetadataMp4` in
    `media/testing.ts` wraps packets into a minimal MP4 for tests.
  - Keep them small; 240 DJI packets are about 40 KB.
- Tests in `src/core/media/media.test.ts`:
  - detection;
  - model;
  - a decoded motion signal with sane magnitudes;
  - malformed packets skipped.
- Pin a real sync result: extract the camera yaw from a real video at
  50 Hz as int16. Use scale 10000, with -32768 for missing samples. Save it
  next to `sample-data/sync/ner-camera-yaw.b64`, and assert the offset in
  `src/core/sync/sync.test.ts` against a matching logger file.
- Run auto-sync in the app on a real recording and check the Sync panel's
  match, precision and plot.

### Next up: GoPro

GoPro writes GPMF in a `gpmd` metadata track. `GYRO` and `ACCL` give the
camera's rotation and acceleration, and `GPSU` gives a UTC time hint. The
yaw rate about gravity can be computed like the DJI one, from gyro rates
plus the accelerometer's gravity direction. GoPro also splits long
recordings into chapters (`GX01xxxx.MP4`, `GX02xxxx.MP4`, …). Those have to
be joined into one video before preview, sync and export. That isn't built
yet.

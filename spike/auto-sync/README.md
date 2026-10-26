# Auto-sync spike

Finds the time offset between a data-logger CSV and in-car video
automatically, with no clap, beep or manual scrubbing.

**Result on the NER 10-25 autocross run (Solostorm CSV + DJI Osmo Action 4):
video time = logger time + 29.177 s, consistent to about ±20 ms (one frame)
across the whole run.**

## Camera IMU (DJI) — preferred when available

The Osmo Action 4 embeds its IMU state in the `djmd` metadata track: one
protobuf packet per video frame (about 122 B), timestamped on the video
timeline. Decoded without a schema (`djiDump.mjs`):

| Path | Content |
| --- | --- |
| `3.2.9` | orientation quaternion (w, x, y, z), unit length |
| `3.2.10` | accelerometer in g (fields 2–4; proto3 omits zeros) |
| `3.2.2` / `3.2.3` / `3.2.6` | likely ISO, shutter and white balance (K) |
| `3.4.1` | camera model `DJI AC003` and frame rate |

`djiImu.mjs` converts the quaternions into turn rate, projects it onto
gravity (the mean accelerometer vector, so the mount angle doesn't matter),
and correlates that with the logger's `YAW_RATE`:

| | Camera IMU | Windshield image motion |
| --- | --- | --- |
| Offset | **29.146 s** | 29.177 s |
| Correlation | **0.986** | 0.894 |
| Precision (10 s windows) | **±6 ms** | ±20 ms |
| Time to extract | **0.3 s** (no video decode) | 29 s |

The camera's turn rate matches the logger's within 6% (least-squares ratio
−1.058), which confirms this is the vehicle's yaw in rad/s. The `dbgi`
track (about 7.4 KB/frame) holds sensor and image-processing debug values;
its largest block is opaque packed binary rather than IMU samples, so it
isn't needed.

**Strategy for the app:** use camera IMU metadata when present (DJI `djmd`,
GoPro GPMF `GYRO`/`ACCL`), and fall back to windshield image motion for
cameras that record no motion data.

## Multi-lap session + single-lap export

`lapSync.mjs` finds which lap of a session video a single-lap CSV belongs
to:

1. Correlate the lap's yaw against the camera IMU yaw for the whole video.
   Every lap of the track produces a peak, and each peak is a candidate.
2. For each candidate, align the lap's **first and second halves
   separately**. On the right lap they agree; on a wrong lap the second half
   drifts by roughly the difference in lap time.
3. Pick the candidate with the smallest half drift.

**SVT Canaan test** (`DJI_20261024145651_0016_D.MP4`, 989 s session; `SVT
Canaan.csv`, Solostorm lap 37, 61.831 s). The analysis took 9.8 s:

| Candidate | Offset | r | Half drift |
| --- | --- | --- | --- |
| 3 | 128.951 s | 0.866 | 1470 ms |
| 4 | 192.462 s | 0.960 | 415 ms |
| **5** | **254.693 s** | **0.986** | **21 ms** |
| 6 | 319.114 s | 0.753 | 2185 ms |
| others | | 0.31–0.91 | 0.55–5.2 s |

**Result: the lap starts at 4:14.69 in the video (video time = logger time +
254.693 s).** Per-5-second-window offsets confirm it:

- Candidate 5 holds within ±0.03 s through the middle of the lap (edge
  windows −0.07 and +0.05 s).
- Lap 4 wanders over about 0.9 s.
- Lap 6 slopes steadily from −1.3 to +2.0 s, so it's a slower lap.

`out/lap-sync-plot.png` overlays laps 5 and 4. They look almost identical,
which is why the half-drift test matters more than correlation alone (0.986
vs 0.960).

**Clock prior.** Applying the camera clock error measured the next day
(18 min 29 s fast) predicted the lap at 226 s, which falls between laps 4
and 5. The camera's clock error changed by about 28 s between days, so a
remembered clock error can narrow the search but can't pick the lap by
itself.

Remaining ambiguity: two laps within a few hundredths of a second of each
other, driven on the same line, would produce similar half drifts. In that
case the app should show the top candidates for a one-click choice.

## Method (image motion, any camera)

With the camera fixed to the car, the view through the windshield slides
sideways whenever the car yaws. That gives a yaw signal from the video
itself, for any camera:

1. FFmpeg decodes a cropped, downscaled grayscale strip of the windshield:
   x 27–67%, y 35–49%, scaled to 320×64 (`--region` overrides it).
2. For each pair of consecutive frames, find the horizontal shift that best
   aligns them (sum of absolute differences over ±16 px, refined to subpixel).
3. Resample both the video shift and the logger's `YAW_RATE` onto a 50 Hz grid,
   then compute the Pearson correlation at every candidate offset across the
   whole video. The strongest |r| wins. The sign is ignored because image
   motion vs yaw sign depends on how the camera is mounted.

The whole pass took 29 s for a 153 s 2.7K60 HEVC video, dominated by
decoding. Using only the run's time span, or decoding at lower resolution,
would make it faster.

## Results

Inputs: `DJI_20261025141513_0020_D.MP4` (153 s, 2688×1512, 59.94 fps) and
`NER 10-25-Ryan Field-7.csv` (Solostorm lap 7 export, 71 s at 25 Hz).

| Check | Offset | Notes |
| --- | --- | --- |
| Gyro `YAW_RATE`, full run | **29.179 s** | r = −0.894; next-best peak is 3.1x weaker |
| Gyro yaw, 13 × 10 s windows | 29.177 s ± 20 ms | no clock drift (0.16 ms/s) |
| GPS heading rate (independent of the gyro) | 29.138 s | r = −0.565 (GPS heading is noisy) |
| `ACCEL_X` (lateral on this logger) | 29.077 s | r = −0.853 |
| Solostorm RUN TIME timer on the dash tablet | 29.404 s ± 0.02 | read at 5 frames; see below |

`out/sync-plot.png` shows the logger yaw and video motion overlaid for the
whole run, a zoomed slalom section comparing the auto offset with the
dash-timer offset, and the correlation-vs-offset curve (a single sharp peak).

**Dash timer vs auto-sync (0.22 s gap).** At the timer's offset the video
visibly leads the logger on every yaw transition, while the auto offset
lines up. GPS heading agrees with the gyro to within 40 ms, so a gyro lag is
unlikely. The likeliest explanation is that the on-screen timer itself is
late (app update plus display latency). The overlay should use the
motion-based offset, because the goal is for overlay motion to match the
picture.

## Things learned about the inputs

- **Camera clocks can't be trusted.** The DJI metadata says recording started
  at 18:15:14Z; the run actually happened at 17:56:45Z (UTC), so the camera
  clock was about 18.5 minutes off. Timestamps can give a rough first guess
  at best.
- **Solostorm `GPS_TIME` is GPS time, not UTC.** It's 18 s ahead of
  `SYSTEM_TIME` (the GPS–UTC leap seconds).
- Solostorm exports interpolate to 25 Hz. `RECORDED_SAMPLE_COUNT > 0` marks
  real samples (about 23 Hz here). `YAW_RATE` is quantized to 1 °/s steps.
- A lap export starts at the lap/run start (the car is already rolling),
  not at the start of recording.
- DJI `djmd` holds per-frame orientation and acceleration (see above).

## Limits / next steps

- The windshield region is hard-coded for this mount. The app should let the
  user drag a box on a frame, or find the region by looking for where image
  motion correlates best.
- Needs yaw variation (autocross and road courses have plenty). A straight
  drag run wouldn't work; speed vs forward image expansion, or engine audio
  vs RPM, would be the fallback signals.
- Motion blur during fast transitions makes the per-frame shift noisy (visible
  around 2.5–3.5 s in the plot). The correlation is robust to it, but a
  coarse-to-fine or optical-flow measure would be cleaner.
- Only one run tested so far. The method should also be checked on:
  - a long video containing several runs
  - an AiM file with a different yaw channel name (AiM has `GPS Gyro`)
  - a different camera mount

## Running it

```bash
cd spike/auto-sync
node sync.mjs <video.mp4> <solostorm.csv> [--region x,y,w,h]
node analyze.mjs <solostorm.csv>
../../node_modules/.bin/electron plot.cjs 29.404
```

For DJI files, `node djiImu.mjs <video.mp4> <solostorm.csv>` syncs from the
camera IMU instead. For a session video and a single-lap export, run
`node lapSync.mjs <video.mp4> <lap.csv> [cameraClockAheadSeconds]`, then
`ALT_LABEL="lap 4" ../../node_modules/.bin/electron plot.cjs --lap <altOffset>`. `node djiDump.mjs <stream.bin> <sizes.csv> <index>`
dumps a single metadata packet.

`sync.mjs` prints the offset and writes `out/signals.json`. `analyze.mjs`
runs the cross-checks against other channels and computes per-window
precision. `plot.cjs` renders `out/sync-plot.png`; its argument is an
alternative offset to compare against.

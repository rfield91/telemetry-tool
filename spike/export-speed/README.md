# Export speed spike

Throwaway benchmark answering one question for the redesign: can Electron
decode a camera video, draw a telemetry overlay on every frame, and
hardware-encode an MP4 fast enough that export isn't a burden?

**Answer: yes.** With an AiM-style layout (speed gauge, TPS bar, three
readouts, track map, g-meter), driven by real data from `sample-data/3.csv`:

| Source | Output | Best path | Throughput | vs real time |
| --- | --- | --- | --- | --- |
| 1080p60 H.264 | HEVC | WebGPU | 540 fps | 9.0x |
| 1080p60 H.264 | H.264 | WebGPU | 409 fps | 6.8x |
| 4K60 HEVC | HEVC | WebGPU | 156 fps | 2.6x |
| 4K60 HEVC | H.264 | WebGPU | 119 fps | 2.0x |

A 20-minute 4K60 session would export in about 8–10 minutes, and a
1080p session in about 2–3 minutes.

### Real camera file (DJI)

`DJI_20261024145651_0016_D.MP4`: 8.8 GB, 16.5 min, HEVC Main 10 (10-bit),
2688×1512, 59.94 fps, 67 Mb/s, BT.709 SDR. The file also has AAC audio, a
720p MJPEG thumbnail track, and DJI `djmd`/`dbgi` metadata tracks. The
benchmark covers a 60 s window starting at 5:00 (3,597 frames), streamed from
disk:

| Path | Throughput | vs real time | Full 16.5 min file (est.) |
| --- | --- | --- | --- |
| Decode only (hardware, 10-bit) | 679 fps | 11.3x | — |
| Canvas 2D → H.264 | 207 fps | 3.5x | ~4.8 min |
| WebGPU atlas → H.264 | 228 fps | 3.8x | ~4.3 min |
| WebGPU atlas → HEVC | 298 fps | 5.0x | ~3.3 min |

I compared an output frame with the same source frame decoded independently
by FFmpeg. Alignment, brightness and color all match, so the 10-bit to 8-bit
path is correct. The output is 8-bit 4:2:0. The full-length estimates are
extrapolated; a full 16.5-minute run (sustained throughput, thermals) hasn't
been measured.

Test machine: Ryzen 7 9800X3D, RTX 3070 Ti (driver 581.80), Windows 11,
Electron 43.1.1. Sources are 30 s synthetic `testsrc2` clips encoded with
NVENC at GoPro-like bitrates (30 Mb/s 1080p, 60 Mb/s 4K). Real camera files
have not been tested yet.

## Pipeline

```
mediabunny demux → VideoDecoder (hardware) → compose → VideoEncoder (hardware) → mediabunny MP4 mux → file
```

Compose variants (`compositor` in `main.cjs`):

| Variant | How | 1080p → H.264 | 4K → H.264 |
| --- | --- | --- | --- |
| `canvas2d` (default) | `drawImage(frame)` + overlay on a 2D OffscreenCanvas, then `new VideoFrame(canvas)` | 318 fps | 105 fps |
| `nv12` | WebGL2: composite, convert to NV12 in a shader, `readPixels` | 347 fps | 110 fps |
| `webgpu` | WebGPU: video as a zero-copy external texture, overlay canvas uploaded, composite + NV12 pack in one pass, async `mapAsync` readback | 409 fps | 119 fps |

All three are viable. WebGPU is about 13–30% faster than the simple 2D
canvas path. WebGPU readback alone measured about 10 GB/s, versus about
0.3–0.5 GB/s for WebGL `readPixels`.

## What actually mattered

1. **Overlay raster cost, not readback or the encoder.** The first runs showed
   4K at about 21 fps on every path. The cause was the track map re-stroking
   a 22,000-segment path every frame. Canvas 2D work is deferred, so the cost
   showed up inside whichever step forced the GPU to finish (readback or
   upload), which made readback look guilty. Pre-rendering the outline into
   a cached layer (`overlay.cjs`) took 4K from 21 fps to 105–156 fps.
   **Design rule for the redesign:** widgets must cache their static parts
   (faces, ticks, track outline, rings) and draw only the dynamic parts each
   frame.
2. **HEVC output is faster than H.264 on NVENC** (about 30% at 4K) and gives
   the same file size at the same bitrate.
3. **Encoder ceilings** (no compositing): 4K H.264 takes CPU-memory NV12
   frames at 123 fps, and GPU frames straight from the decoder at 83 fps.
   Decoding alone runs at 727 fps for 1080p H.264 and 409 fps for 4K HEVC.
4. Hardware vs software encode made no difference when the overlay was the
   bottleneck. Software encode was not re-measured after the fix.

## Gotchas found

- Destroying a BrowserWindow that used the GPU logged "GPU state invalid"
  and broke the next window in the same process. That's why each job runs in
  its own Electron process.
- Hardware decoders buffer several packets before the first output, so a
  feed loop must also wake on the decoder's `dequeue` event, not only on
  output.
- WebGL fence status only updates between tasks, so a fence can't be awaited
  inside a decoder callback.
- An AiM CSV has a `"Time","1:28 PM"` metadata row above the real header.

## Not covered yet

- Other cameras: GoPro (GPMF), HDR/HLG/D-Log, rotation metadata, and
  chaptered files split across several MP4s. The DJI file above covers
  10-bit SDR HEVC and an 8.8 GB file read in pieces (`CustomSource`).
- Audio passthrough (the DJI file has AAC that should be copied through).
- The DJI `djmd` metadata track. It may hold per-frame sensor data useful for
  automatic sync.
- Other GPUs (AMD, Intel, or no hardware encoder) and fallback behaviour.
- Overlay complexity well beyond this layout. Text-heavy widgets with
  per-frame changes should be profiled.
- Live preview performance. That uses a `<video>` element and is a separate
  path.

## Running it

```bash
cd spike/export-speed
npm install
ONLY=43 ../../node_modules/.bin/electron main.cjs
```

`ONLY` picks job indices (see the job list in `main.cjs`). With no `ONLY`,
it runs everything in one process, which hits the GPU-teardown issue above.
Passing `.mp4` paths as arguments benchmarks your own files instead,
with a focused set of 4 jobs over a window set by `START` and `DURATION`
(defaults 300 and 60 seconds). Set `FPS` if the file isn't 59.94. Test sources go in `media/` (generation commands below).
Outputs and `results.json` go in `out/`. Both folders are gitignored.

```bash
FF=$(node -p "require('../../node_modules/ffmpeg-static')")
"$FF" -f lavfi -i "testsrc2=size=1920x1080:rate=60,format=yuv420p" -t 30 -c:v h264_nvenc -b:v 30M -g 60 -bf 0 media/src-1080p60-h264.mp4
"$FF" -f lavfi -i "testsrc2=size=3840x2160:rate=60,format=yuv420p" -t 30 -c:v hevc_nvenc -b:v 60M -g 60 -bf 0 -tag:v hvc1 media/src-4k60-hevc.mp4
```

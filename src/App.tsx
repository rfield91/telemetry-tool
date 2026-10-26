import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import Gauge from "./renderer/components/Gauge";
import TrackMap from "./renderer/components/TrackMap";
import Bar from "./renderer/components/Bar";
import KeyValue, {
  KEY_VALUE_VIEW_W,
  keyValueViewBox,
} from "./renderer/components/KeyValue";
import GMeter from "./renderer/components/GMeter";
import type { OverlayComponentDefinition } from "./renderer/export/OverlayFrame";
import {
  buildGpsTrack,
  buildSeries,
  inferNumericColumns,
  parseCsv,
  sampleAt,
  type GpsTrack,
  type ParsedCsv,
  type TelemetrySeries,
  type TimestampUnit,
} from "./renderer/lib/telemetry";
import {
  CSV_FORMAT_PROFILES,
  detectCsvFormat,
  getCsvFormatProfile,
  type CsvFormatId,
  type FormatConfidence,
  type FormatDetection,
} from "./renderer/lib/csvFormats";
import { niceMaxG } from "./renderer/lib/gMeter";
import type {
  BarConfig,
  BaseOverlayConfig,
  GaugeConfig,
  GMeterConfig,
  KeyValueConfig,
  KeyValueEntry,
  OverlayConfig,
  TrackMapConfig,
  ValueOverlayConfig,
} from "./renderer/lib/overlayConfig";
import { applyOverlayPreset } from "./renderer/lib/overlayPresets";
import {
  getDefaultPreset,
  getPresetById,
  OVERLAY_PRESETS,
} from "./renderer/presets";

const ACCENTS = [
  "#2dd4bf",
  "#fbbf24",
  "#38bdf8",
  "#fb7185",
  "#a78bfa",
  "#a3e635",
];
const GAUGE_POSITIONS = [
  { x: 0.5, y: 0.5 },
  { x: 0.18, y: 0.72 },
  { x: 0.82, y: 0.72 },
  { x: 0.18, y: 0.28 },
  { x: 0.82, y: 0.28 },
  { x: 0.5, y: 0.78 },
];

const THROTTLE_BAR_ACCENT = "#22c55e";
const BRAKE_BAR_ACCENT = "#ef4444";

function barAccentFor(column: string) {
  if (/brake/i.test(column)) return BRAKE_BAR_ACCENT;
  if (/throttle|tps|accel(?:erator)?/i.test(column)) return THROTTLE_BAR_ACCENT;
  return THROTTLE_BAR_ACCENT;
}

/** Exact data min/max for bar empty/full (unlike gauges' rounded niceRange). */
function dataRange(values: number[]) {
  if (values.length === 0) return { min: 0, max: 100 };
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max <= min) return { min, max: min + 1 };
  return { min, max };
}
function formatTime(seconds: number) {
  const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const minutes = Math.floor(safe / 60);
  const remainder = safe - minutes * 60;
  return `${minutes}:${remainder.toFixed(2).padStart(5, "0")}`;
}

/** Human-readable remaining-time estimate for export progress. */
function formatEta(seconds: number) {
  const safe = Math.max(0, Math.ceil(seconds));
  if (safe < 60) return `${safe}s`;
  const minutes = Math.floor(safe / 60);
  const remainder = safe % 60;
  if (minutes < 60) {
    return remainder > 0 ? `${minutes}m ${remainder}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

function estimateExportRemaining(
  startedAt: number | null,
  progress: ExportProgress | null,
  now = Date.now(),
): number | null {
  if (!startedAt || !progress) return null;
  if (progress.status === "encoding" || progress.status === "complete")
    return 0;
  // Wait for a couple frames so window/FFmpeg startup doesn't dominate the rate.
  if (progress.frame < 2 || progress.totalFrames <= 0) return null;

  const elapsedSeconds = (now - startedAt) / 1000;
  if (elapsedSeconds <= 0) return null;

  const framesRemaining = Math.max(0, progress.totalFrames - progress.frame);
  if (framesRemaining === 0) return 0;

  return framesRemaining * (elapsedSeconds / progress.frame);
}
function niceRange(values: number[]) {
  if (values.length === 0) return { min: 0, max: 100 };
  const low = Math.min(...values);
  const high = Math.max(...values);
  const min = low >= 0 ? 0 : Math.floor(low);
  if (high <= min) return { min, max: min + 100 };
  const magnitude = 10 ** Math.floor(Math.log10(high - min));
  const step = magnitude / 2;
  return {
    min,
    max: Math.ceil(high / step) * step,
  };
}
function fieldClassName() {
  return "w-full rounded-lg border border-slate-700/80 bg-slate-900/80 px-3 py-2 text-sm text-slate-100 outline-none transition focus:border-teal-400/70 focus:ring-2 focus:ring-teal-400/10";
}
function defaultUnitFor(column: string, csv: ParsedCsv | null) {
  return (
    csv?.units[column] ?? (column.toLowerCase().includes("rpm") ? "RPM" : "")
  );
}
function overlayTitle(overlay: OverlayConfig) {
  if (overlay.type === "track-map") {
    return overlay.label || "Track map";
  }
  if (overlay.type === "g-meter") {
    return overlay.label || "G-meter";
  }
  if (overlay.type === "key-value") {
    const count = overlay.entries.length;
    if (count === 0) return overlay.label || "Values";
    if (count === 1) {
      return overlay.entries[0]!.label || overlay.entries[0]!.valueColumn;
    }
    return overlay.label || `Values (${count})`;
  }
  return overlay.label || overlay.valueColumn || "Overlay";
}

function usedValueColumns(overlays: OverlayConfig[]) {
  const used = new Set<string>();
  for (const overlay of overlays) {
    if (overlay.type === "gauge" || overlay.type === "bar") {
      used.add(overlay.valueColumn);
    } else if (overlay.type === "key-value") {
      for (const entry of overlay.entries) {
        used.add(entry.valueColumn);
      }
    }
  }
  return used;
}
function App() {
  const [csv, setCsv] = useState<ParsedCsv | null>(null);
  const [csvFormat, setCsvFormat] = useState<CsvFormatId>("generic");
  const [formatConfidence, setFormatConfidence] =
    useState<FormatConfidence>("high");
  const [timestampColumn, setTimestampColumn] = useState("");
  const [timestampUnit, setTimestampUnit] = useState<TimestampUnit>("seconds");
  const [overlays, setOverlays] = useState<OverlayConfig[]>([]);
  const [selectedOverlayId, setSelectedOverlayId] = useState<string | null>(
    null,
  );
  const [selectedPresetId, setSelectedPresetId] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [trimStart, setTrimStart] = useState(0);
  const [trimEnd, setTrimEnd] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [width, setWidth] = useState(1920);
  const [height, setHeight] = useState(1080);
  const [fps, setFps] = useState(30);
  const [message, setMessage] = useState<string | null>(null);
  const [exportId, setExportId] = useState<string | null>(null);
  const [exportProgress, setExportProgress] = useState<ExportProgress | null>(
    null,
  );
  const [exportStartedAt, setExportStartedAt] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const formatProfile = useMemo(
    () => getCsvFormatProfile(csvFormat),
    [csvFormat],
  );
  const numericColumns = useMemo(
    () => (csv ? inferNumericColumns(csv) : []),
    [csv],
  );
  const gpsColumns = useMemo(
    () => (csv ? formatProfile.resolveGpsColumns(csv.headers) : null),
    [csv, formatProfile],
  );
  const gMeterColumns = useMemo(
    () => (csv ? formatProfile.resolveGMeterColumns(csv.headers) : null),
    [csv, formatProfile],
  );
  const canAddTrackMap = Boolean(gpsColumns);
  const canAddGMeter = Boolean(gMeterColumns);
  const excludedValueColumns = useMemo(
    () => formatProfile.excludeFromDefaultValue(csv?.headers ?? []),
    [csv, formatProfile],
  );
  /** Known formats assume Time + units; only show mapping for Generic or uncertain detects. */
  const showTimestampMapping =
    !csv ||
    !formatProfile.assumesTimestampMapping ||
    formatConfidence === "low";
  const valueSeries = useMemo(() => {
    const byOverlay = new Map<string, TelemetrySeries>();
    if (!csv || !timestampColumn) return byOverlay;
    const byColumn = new Map<string, TelemetrySeries>();
    const seriesFor = (column: string) => {
      let series = byColumn.get(column);
      if (!series) {
        series = buildSeries(csv, {
          timestampColumn,
          valueColumn: column,
          timestampUnit,
        });
        byColumn.set(column, series);
      }
      return series;
    };
    for (const overlay of overlays) {
      if (overlay.type === "gauge" || overlay.type === "bar") {
        byOverlay.set(overlay.id, seriesFor(overlay.valueColumn));
      } else if (overlay.type === "key-value") {
        for (const entry of overlay.entries) {
          byOverlay.set(entry.id, seriesFor(entry.valueColumn));
        }
      }
    }
    return byOverlay;
  }, [csv, overlays, timestampColumn, timestampUnit]);
  const trackSeries = useMemo(() => {
    const byOverlay = new Map<string, GpsTrack>();
    if (!csv || !timestampColumn) return byOverlay;
    const byKey = new Map<string, GpsTrack>();
    for (const overlay of overlays) {
      if (overlay.type !== "track-map") continue;
      const key = `${overlay.latitudeColumn}\0${overlay.longitudeColumn}`;
      let track = byKey.get(key);
      if (!track) {
        track = buildGpsTrack(csv, {
          timestampColumn,
          latitudeColumn: overlay.latitudeColumn,
          longitudeColumn: overlay.longitudeColumn,
          timestampUnit,
        });
        byKey.set(key, track);
      }
      byOverlay.set(overlay.id, track);
    }
    return byOverlay;
  }, [csv, overlays, timestampColumn, timestampUnit]);
  const gMeterSeries = useMemo(() => {
    const byOverlay = new Map<
      string,
      { lateral: TelemetrySeries; longitudinal: TelemetrySeries }
    >();
    if (!csv || !timestampColumn) return byOverlay;
    const byColumn = new Map<string, TelemetrySeries>();
    const seriesFor = (column: string) => {
      let series = byColumn.get(column);
      if (!series) {
        series = buildSeries(csv, {
          timestampColumn,
          valueColumn: column,
          timestampUnit,
        });
        byColumn.set(column, series);
      }
      return series;
    };
    for (const overlay of overlays) {
      if (overlay.type !== "g-meter") continue;
      byOverlay.set(overlay.id, {
        lateral: seriesFor(overlay.lateralColumn),
        longitudinal: seriesFor(overlay.longitudinalColumn),
      });
    }
    return byOverlay;
  }, [csv, overlays, timestampColumn, timestampUnit]);
  const duration = useMemo(() => {
    let max = 0;
    for (const series of valueSeries.values()) {
      max = Math.max(max, series.stats.durationSeconds);
    }
    for (const track of trackSeries.values()) {
      max = Math.max(max, track.stats.durationSeconds);
    }
    for (const pair of gMeterSeries.values()) {
      max = Math.max(
        max,
        pair.lateral.stats.durationSeconds,
        pair.longitudinal.stats.durationSeconds,
      );
    }
    return max;
  }, [valueSeries, trackSeries, gMeterSeries]);

  const selectedOverlay =
    overlays.find((overlay) => overlay.id === selectedOverlayId) ?? null;
  const selectedSeries =
    selectedOverlay &&
    (selectedOverlay.type === "gauge" || selectedOverlay.type === "bar")
      ? (valueSeries.get(selectedOverlay.id) ?? null)
      : null;
  const selectedTrack =
    selectedOverlay?.type === "track-map"
      ? (trackSeries.get(selectedOverlay.id) ?? null)
      : null;
  const selectedGMeter =
    selectedOverlay?.type === "g-meter"
      ? (gMeterSeries.get(selectedOverlay.id) ?? null)
      : null;
  const previewableOverlays = overlays.filter((overlay) => {
    if (overlay.type === "track-map") {
      const track = trackSeries.get(overlay.id);
      return Boolean(track && track.points.length > 0);
    }
    if (overlay.type === "g-meter") {
      const pair = gMeterSeries.get(overlay.id);
      return Boolean(
        pair &&
        pair.lateral.points.length > 0 &&
        pair.longitudinal.points.length > 0 &&
        overlay.maxG > 0,
      );
    }
    const series = valueSeries.get(overlay.id);
    if (overlay.type === "key-value") {
      return overlay.entries.some((entry) => {
        const entrySeries = valueSeries.get(entry.id);
        return Boolean(entrySeries && entrySeries.points.length > 0);
      });
    }
    if (!series || series.points.length === 0) return false;
    return overlay.max > overlay.min;
  });
  const canPreview = previewableOverlays.length > 0;
  const minTrimGap = Math.max(1 / Math.max(fps, 1), 0.05);
  const exportDuration = Math.max(0, trimEnd - trimStart);
  const canExport = canPreview && exportDuration > 0;
  const trimStartPct = duration > 0 ? (trimStart / duration) * 100 : 0;
  const trimEndPct = duration > 0 ? (trimEnd / duration) * 100 : 100;
  const isTrimmed = trimStart > 0.0005 || trimEnd < duration - 0.0005;
  const exportEtaSeconds = estimateExportRemaining(
    exportStartedAt,
    exportProgress,
  );
  const exportEtaLabel =
    exportProgress?.status === "encoding"
      ? "Finishing…"
      : exportEtaSeconds === null
        ? "Estimating…"
        : exportEtaSeconds <= 1
          ? "Almost done"
          : `~${formatEta(exportEtaSeconds)} left`;
  useEffect(() => {
    const unsubscribe = window.telemetryOverlay?.onExportProgress(
      (progress) => {
        setExportProgress(progress);
      },
    );
    return unsubscribe;
  }, []);
  useEffect(() => {
    if (!playing || exportDuration <= 0) return;
    let previous = performance.now();
    let animationFrame = 0;
    const tick = (now: number) => {
      const elapsed = (now - previous) / 1000;
      previous = now;
      setCurrentTime((time) => {
        const next = time + elapsed;
        if (next >= trimEnd) {
          setPlaying(false);
          return trimEnd;
        }
        return next;
      });
      animationFrame = requestAnimationFrame(tick);
    };
    animationFrame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animationFrame);
  }, [exportDuration, playing, trimEnd]);

  useEffect(() => {
    setTrimStart(0);
    setTrimEnd(duration);
    setCurrentTime(0);
    setPlaying(false);
  }, [duration]);

  function updateTrimStart(next: number) {
    const clamped = Math.min(
      Math.max(0, next),
      Math.max(0, trimEnd - minTrimGap),
    );
    setTrimStart(clamped);
    setCurrentTime((time) => Math.min(Math.max(time, clamped), trimEnd));
  }

  function updateTrimEnd(next: number) {
    const clamped = Math.max(
      Math.min(duration, next),
      Math.min(duration, trimStart + minTrimGap),
    );
    setTrimEnd(clamped);
    setCurrentTime((time) => Math.min(Math.max(time, trimStart), clamped));
  }
  function makeGauge(
    column: string,
    parsed: ParsedCsv,
    timeColumn: string,
    timeUnit: TimestampUnit,
    index: number,
  ): GaugeConfig {
    const series = buildSeries(parsed, {
      timestampColumn: timeColumn,
      valueColumn: column,
      timestampUnit: timeUnit,
    });
    const range = niceRange(series.points.map((point) => point.value));
    const position = GAUGE_POSITIONS[index % GAUGE_POSITIONS.length]!;
    return {
      id: crypto.randomUUID(),
      type: "gauge",
      valueColumn: column,
      label: column.toUpperCase(),
      unit: defaultUnitFor(column, parsed),
      min: range.min,
      max: range.max,
      accent: ACCENTS[index % ACCENTS.length]!,
      x: position.x,
      y: position.y,
      size: index === 0 ? 0.55 : 0.4,
    };
  }
  function makeBar(
    column: string,
    parsed: ParsedCsv,
    timeColumn: string,
    timeUnit: TimestampUnit,
    index: number,
  ): BarConfig {
    const series = buildSeries(parsed, {
      timestampColumn: timeColumn,
      valueColumn: column,
      timestampUnit: timeUnit,
    });
    const range = dataRange(series.points.map((point) => point.value));
    const position = GAUGE_POSITIONS[index % GAUGE_POSITIONS.length]!;
    return {
      id: crypto.randomUUID(),
      type: "bar",
      valueColumn: column,
      label: column.toUpperCase(),
      min: range.min,
      max: range.max,
      accent: barAccentFor(column),
      x: position.x,
      y: position.y,
      size: 0.35,
    };
  }
  function makeKeyValueEntry(
    column: string,
    parsed: ParsedCsv,
    index: number,
  ): KeyValueEntry {
    return {
      id: crypto.randomUUID(),
      valueColumn: column,
      label: column.toUpperCase(),
      unit: defaultUnitFor(column, parsed),
      accent: ACCENTS[index % ACCENTS.length]!,
    };
  }
  function makeKeyValue(
    column: string,
    parsed: ParsedCsv,
    index: number,
  ): KeyValueConfig {
    const position = GAUGE_POSITIONS[index % GAUGE_POSITIONS.length]!;
    const entry = makeKeyValueEntry(column, parsed, index);
    return {
      id: crypto.randomUUID(),
      type: "key-value",
      label: "VALUES",
      accent: entry.accent,
      stack: "vertical",
      entries: [entry],
      x: position.x,
      y: position.y,
      size: 0.28,
    };
  }
  function makeTrackMap(
    index: number,
    latitudeColumn: string,
    longitudeColumn: string,
  ): TrackMapConfig {
    const position = GAUGE_POSITIONS[index % GAUGE_POSITIONS.length]!;
    return {
      id: crypto.randomUUID(),
      type: "track-map",
      latitudeColumn,
      longitudeColumn,
      label: "TRACK",
      accent: ACCENTS[index % ACCENTS.length]!,
      x: position.x,
      y: position.y,
      size: 0.45,
    };
  }
  function makeGMeter(
    parsed: ParsedCsv,
    timeColumn: string,
    timeUnit: TimestampUnit,
    index: number,
    lateralColumn: string,
    longitudinalColumn: string,
  ): GMeterConfig {
    const lateral = buildSeries(parsed, {
      timestampColumn: timeColumn,
      valueColumn: lateralColumn,
      timestampUnit: timeUnit,
    });
    const longitudinal = buildSeries(parsed, {
      timestampColumn: timeColumn,
      valueColumn: longitudinalColumn,
      timestampUnit: timeUnit,
    });
    const maxG = niceMaxG([
      ...lateral.points.map((point) => point.value),
      ...longitudinal.points.map((point) => point.value),
    ]);
    const position = GAUGE_POSITIONS[index % GAUGE_POSITIONS.length]!;
    return {
      id: crypto.randomUUID(),
      type: "g-meter",
      lateralColumn,
      longitudinalColumn,
      label: "G",
      maxG,
      accent: ACCENTS[index % ACCENTS.length]!,
      x: position.x,
      y: position.y,
      size: 0.42,
    };
  }
  function loadStatusMessage(
    parsed: ParsedCsv,
    detection: FormatDetection | null,
  ) {
    if (detection?.confidence === "low") {
      const label = getCsvFormatProfile(detection.id).label;
      return `Format unclear — defaulted to ${label}. Confirm or change below.`;
    }
    if (parsed.errors.length > 0) {
      return `Loaded with ${parsed.errors.length} CSV parsing warning${
        parsed.errors.length === 1 ? "" : "s"
      }.`;
    }
    return null;
  }
  function configureDataset(
    parsed: ParsedCsv,
    formatId: CsvFormatId,
    detection: FormatDetection | null = null,
  ) {
    if (parsed.headers.length < 2 || parsed.rows.length === 0) {
      setMessage("The CSV needs a header row and at least one data row.");
      return;
    }
    const profile = getCsvFormatProfile(formatId);
    const excluded = profile.excludeFromDefaultValue(parsed.headers);
    const numeric = inferNumericColumns(parsed);
    const time =
      parsed.headers.find((header) =>
        /(^|[_\s])(time|timestamp|elapsed)([_\s]|$)/i.test(header),
      ) ??
      numeric[0] ??
      parsed.headers[0]!;
    const value =
      numeric.find(
        (header) => header !== time && !excluded.has(header),
      ) ??
      numeric.find((header) => header !== time) ??
      parsed.headers[1]!;
    const timeText = `${time} ${parsed.units[time] ?? ""}`;
    const detectedUnit: TimestampUnit = /(?:^|[_\s])(?:us|µs)(?:$|[_\s])/i.test(
      timeText,
    )
      ? "microseconds"
      : /(?:^|[_\s])ms(?:$|[_\s])/i.test(timeText)
        ? "milliseconds"
        : "seconds";
    const fallbackOverlays = (): OverlayConfig[] => {
      const firstGauge = makeGauge(value, parsed, time, detectedUnit, 0);
      const nextOverlays: OverlayConfig[] = [firstGauge];
      const gps = profile.resolveGpsColumns(parsed.headers);
      if (gps) {
        nextOverlays.push(
          makeTrackMap(nextOverlays.length, gps.latitude, gps.longitude),
        );
      }
      const gMeter = profile.resolveGMeterColumns(parsed.headers);
      if (gMeter) {
        nextOverlays.push(
          makeGMeter(
            parsed,
            time,
            detectedUnit,
            nextOverlays.length,
            gMeter.lateral,
            gMeter.longitudinal,
          ),
        );
      }
      return nextOverlays;
    };

    const preset = getDefaultPreset(formatId);
    const presetOverlays = preset
      ? applyOverlayPreset(preset, {
          parsed,
          timestampColumn: time,
          timestampUnit: detectedUnit,
          formatId,
        })
      : [];
    const nextOverlays =
      presetOverlays.length > 0 ? presetOverlays : fallbackOverlays();

    setCsv(parsed);
    setCsvFormat(formatId);
    setFormatConfidence(detection?.confidence ?? "high");
    setTimestampColumn(time);
    setTimestampUnit(detectedUnit);
    setOverlays(nextOverlays);
    setSelectedOverlayId(nextOverlays[0]?.id ?? null);
    setSelectedPresetId(
      presetOverlays.length > 0 && preset ? preset.id : null,
    );
    setCurrentTime(0);
    setTrimStart(0);
    setTrimEnd(0);
    setPlaying(false);
    setMessage(loadStatusMessage(parsed, detection));
  }
  function applyParsedCsv(parsed: ParsedCsv) {
    const detection = detectCsvFormat(parsed);
    configureDataset(parsed, detection.id, detection);
  }
  function handleFormatChange(formatId: CsvFormatId) {
    if (!csv || formatId === csvFormat) return;
    configureDataset(csv, formatId, {
      id: formatId,
      confidence: "high",
      reason: "Manually selected",
    });
  }
  function handlePresetChange(presetId: string) {
    if (!csv || !presetId) return;
    const preset = getPresetById(presetId);
    if (!preset) return;
    const nextOverlays = applyOverlayPreset(preset, {
      parsed: csv,
      timestampColumn,
      timestampUnit,
      formatId: csvFormat,
    });
    if (nextOverlays.length === 0) {
      setMessage("Preset has no overlays matching columns in this CSV.");
      return;
    }
    setOverlays(nextOverlays);
    setSelectedOverlayId(nextOverlays[0]?.id ?? null);
    setSelectedPresetId(preset.id);
    setMessage(null);
  }
  async function openCsv() {
    setMessage(null);
    if (!window.telemetryOverlay) {
      fileInputRef.current?.click();
      return;
    }
    try {
      const file = await window.telemetryOverlay.openCsv();
      if (file) applyParsedCsv(parseCsv(file.text, file.name));
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Could not open CSV.",
      );
    }
  }
  async function handleBrowserFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    applyParsedCsv(parseCsv(await file.text(), file.name));
    event.target.value = "";
  }
  function addGauge() {
    if (!csv) return;
    const usedColumns = new Set(
      overlays
        .filter((overlay): overlay is GaugeConfig => overlay.type === "gauge")
        .map((overlay) => overlay.valueColumn),
    );
    const column =
      numericColumns.find(
        (header) =>
          header !== timestampColumn &&
          !excludedValueColumns.has(header) &&
          !usedColumns.has(header),
      ) ??
      numericColumns.find((header) => header !== timestampColumn) ??
      csv.headers[0]!;
    const gauge = makeGauge(
      column,
      csv,
      timestampColumn,
      timestampUnit,
      overlays.length,
    );
    setOverlays((current) => [...current, gauge]);
    setSelectedOverlayId(gauge.id);
  }
  function nextUnusedColumn(prefer?: RegExp) {
    if (!csv) return "";
    const usedColumns = usedValueColumns(overlays);
    const candidates = numericColumns.filter(
      (header) =>
        header !== timestampColumn && !excludedValueColumns.has(header),
    );
    if (prefer) {
      const match = candidates.find(
        (header) => prefer.test(header) && !usedColumns.has(header),
      );
      if (match) return match;
    }
    return (
      candidates.find((header) => !usedColumns.has(header)) ??
      candidates[0] ??
      numericColumns.find((header) => header !== timestampColumn) ??
      csv.headers[0]!
    );
  }
  function addBar() {
    if (!csv) return;
    const column =
      nextUnusedColumn(/throttle|tps|brake|accel(?:erator)?/i) ??
      csv.headers[0]!;
    const bar = makeBar(
      column,
      csv,
      timestampColumn,
      timestampUnit,
      overlays.length,
    );
    setOverlays((current) => [...current, bar]);
    setSelectedOverlayId(bar.id);
  }
  function addKeyValue() {
    if (!csv) return;
    const column = nextUnusedColumn() ?? csv.headers[0]!;
    const existing = overlays.find(
      (overlay): overlay is KeyValueConfig => overlay.type === "key-value",
    );
    if (existing) {
      const entry = makeKeyValueEntry(
        column,
        csv,
        existing.entries.length,
      );
      updateOverlay(existing.id, {
        entries: [...existing.entries, entry],
        accent: existing.accent || entry.accent,
      });
      setSelectedOverlayId(existing.id);
      return;
    }
    const keyValue = makeKeyValue(column, csv, overlays.length);
    setOverlays((current) => [...current, keyValue]);
    setSelectedOverlayId(keyValue.id);
  }
  function addTrackMap() {
    if (!csv || !gpsColumns) return;
    if (overlays.some((overlay) => overlay.type === "track-map")) {
      const existing = overlays.find(
        (overlay) => overlay.type === "track-map",
      )!;
      setSelectedOverlayId(existing.id);
      return;
    }
    const trackMap = makeTrackMap(
      overlays.length,
      gpsColumns.latitude,
      gpsColumns.longitude,
    );
    setOverlays((current) => [...current, trackMap]);
    setSelectedOverlayId(trackMap.id);
  }
  function addGMeter() {
    if (!csv || !gMeterColumns) return;
    if (overlays.some((overlay) => overlay.type === "g-meter")) {
      const existing = overlays.find((overlay) => overlay.type === "g-meter")!;
      setSelectedOverlayId(existing.id);
      return;
    }
    const gMeter = makeGMeter(
      csv,
      timestampColumn,
      timestampUnit,
      overlays.length,
      gMeterColumns.lateral,
      gMeterColumns.longitudinal,
    );
    setOverlays((current) => [...current, gMeter]);
    setSelectedOverlayId(gMeter.id);
  }
  function removeOverlay(id: string) {
    setOverlays((current) => {
      const next = current.filter((overlay) => overlay.id !== id);
      if (selectedOverlayId === id) {
        setSelectedOverlayId(next[next.length - 1]?.id ?? null);
      }
      return next;
    });
  }
  function updateOverlay(id: string, patch: Partial<OverlayConfig>) {
    setOverlays((current) =>
      current.map((overlay) => {
        if (overlay.id !== id) return overlay;
        return { ...overlay, ...patch } as OverlayConfig;
      }),
    );
  }
  function selectValueColumn(overlay: ValueOverlayConfig, nextColumn: string) {
    if (overlay.type === "gauge") {
      const patch: Partial<GaugeConfig> = {
        valueColumn: nextColumn,
        label: nextColumn.toUpperCase(),
        unit: defaultUnitFor(nextColumn, csv),
      };
      if (csv) {
        const nextSeries = buildSeries(csv, {
          timestampColumn,
          valueColumn: nextColumn,
          timestampUnit,
        });
        const range = niceRange(nextSeries.points.map((point) => point.value));
        patch.min = range.min;
        patch.max = range.max;
      }
      updateOverlay(overlay.id, patch);
      return;
    }
    if (overlay.type === "bar") {
      const patch: Partial<BarConfig> = {
        valueColumn: nextColumn,
        label: nextColumn.toUpperCase(),
        accent: barAccentFor(nextColumn),
      };
      if (csv) {
        const nextSeries = buildSeries(csv, {
          timestampColumn,
          valueColumn: nextColumn,
          timestampUnit,
        });
        const range = dataRange(nextSeries.points.map((point) => point.value));
        patch.min = range.min;
        patch.max = range.max;
      }
      updateOverlay(overlay.id, patch);
    }
  }
  function updateKeyValueEntry(
    overlayId: string,
    entryId: string,
    patch: Partial<KeyValueEntry>,
  ) {
    setOverlays((current) =>
      current.map((overlay) => {
        if (overlay.id !== overlayId || overlay.type !== "key-value") {
          return overlay;
        }
        return {
          ...overlay,
          entries: overlay.entries.map((entry) =>
            entry.id === entryId ? { ...entry, ...patch } : entry,
          ),
        };
      }),
    );
  }
  function selectKeyValueEntryColumn(
    overlay: KeyValueConfig,
    entry: KeyValueEntry,
    nextColumn: string,
  ) {
    updateKeyValueEntry(overlay.id, entry.id, {
      valueColumn: nextColumn,
      label: nextColumn.toUpperCase(),
      unit: defaultUnitFor(nextColumn, csv),
    });
  }
  function removeKeyValueEntry(overlayId: string, entryId: string) {
    setOverlays((current) => {
      const next: OverlayConfig[] = [];
      for (const overlay of current) {
        if (overlay.id !== overlayId || overlay.type !== "key-value") {
          next.push(overlay);
          continue;
        }
        const entries = overlay.entries.filter((entry) => entry.id !== entryId);
        if (entries.length === 0) {
          if (selectedOverlayId === overlayId) {
            const fallback = current.filter((item) => item.id !== overlayId);
            setSelectedOverlayId(fallback[fallback.length - 1]?.id ?? null);
          }
          continue;
        }
        next.push({
          ...overlay,
          entries,
          accent: entries[0]!.accent,
        });
      }
      return next;
    });
  }
  async function startExport() {
    if (!window.telemetryOverlay) {
      setMessage("Video export is available in the Electron desktop app.");
      return;
    }
    if (!canExport) return;
    const baseName = (csv?.fileName ?? "telemetry")
      .replace(/\.csv$/i, "")
      .replace(/[<>:"/\\|?*]+/g, "-");
    const outputPath = await window.telemetryOverlay.chooseExportPath(
      `${baseName}-overlay.webm`,
    );
    if (!outputPath) return;
    const components: OverlayComponentDefinition[] = previewableOverlays.map(
      (overlay) => {
        if (overlay.type === "track-map") {
          return {
            id: overlay.id,
            type: "track-map",
            label: overlay.label || "Track",
            accent: overlay.accent,
            x: overlay.x,
            y: overlay.y,
            size: overlay.size,
            points: trackSeries.get(overlay.id)?.points ?? [],
          };
        }
        if (overlay.type === "g-meter") {
          const pair = gMeterSeries.get(overlay.id);
          return {
            id: overlay.id,
            type: "g-meter",
            label: overlay.label || "G",
            maxG: overlay.maxG,
            accent: overlay.accent,
            x: overlay.x,
            y: overlay.y,
            size: overlay.size,
            lateralPoints: pair?.lateral.points ?? [],
            longitudinalPoints: pair?.longitudinal.points ?? [],
          };
        }
        if (overlay.type === "key-value") {
          return {
            id: overlay.id,
            type: "key-value",
            accent: overlay.accent,
            stack: overlay.stack,
            x: overlay.x,
            y: overlay.y,
            size: overlay.size,
            entries: overlay.entries.map((entry) => ({
              id: entry.id,
              label: entry.label || entry.valueColumn,
              unit: entry.unit,
              accent: entry.accent,
              points: valueSeries.get(entry.id)?.points ?? [],
            })),
          };
        }
        const points = valueSeries.get(overlay.id)?.points ?? [];
        if (overlay.type === "bar") {
          return {
            id: overlay.id,
            type: "bar",
            label: overlay.label || overlay.valueColumn,
            min: overlay.min,
            max: overlay.max,
            accent: overlay.accent,
            x: overlay.x,
            y: overlay.y,
            size: overlay.size,
            points,
          };
        }
        return {
          id: overlay.id,
          type: "gauge",
          label: overlay.label || overlay.valueColumn,
          unit: overlay.unit,
          min: overlay.min,
          max: overlay.max,
          accent: overlay.accent,
          x: overlay.x,
          y: overlay.y,
          size: overlay.size,
          points,
        };
      },
    );
    const id = crypto.randomUUID();
    setExportId(id);
    setMessage(null);
    setExportStartedAt(Date.now());
    setExportProgress({
      id,
      frame: 0,
      totalFrames: Math.ceil(exportDuration * fps),
      percent: 0,
      status: "rendering",
    });
    try {
      await window.telemetryOverlay.startExport({
        id,
        outputPath,
        width,
        height,
        fps,
        startTime: trimStart,
        duration: exportDuration,
        overlay: { components },
      });
      setMessage(`Export complete: ${outputPath}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Export failed.");
    } finally {
      setExportStartedAt(null);
      setExportId(null);
    }
  }
  function cancelCurrentExport() {
    if (!exportId) return;
    void window.telemetryOverlay?.cancelExport(exportId);
  }
  return (
    <main className="min-h-screen text-slate-100">
      <input
        ref={fileInputRef}
        type="file"
        accept=".csv,text/csv"
        className="hidden"
        onChange={(event) => void handleBrowserFile(event)}
      />
      <header className="flex h-16 items-center justify-between border-b border-white/7 bg-slate-950/55 px-6 backdrop-blur-xl">
        <div className="flex items-center gap-3">
          <div className="grid size-9 place-items-center rounded-xl border border-teal-400/25 bg-teal-400/10 text-teal-300">
            <svg
              viewBox="0 0 24 24"
              className="size-5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
            >
              <path d="M4 16a8 8 0 1 1 16 0" />
              <path d="m12 13 4-5" />
              <circle cx="12" cy="16" r="1.5" />
            </svg>
          </div>
          <div>
            <h1 className="text-sm font-semibold tracking-wide">
              Telemetry Overlay
            </h1>
            <p className="text-xs text-slate-500">Gauge composer</p>
          </div>
        </div>
        <div className="rounded-full border border-white/8 bg-white/3 px-3 py-1 text-[11px] font-medium tracking-[0.16em] text-slate-400 uppercase">
          VP9 alpha
        </div>
      </header>
      <div className="grid min-h-[calc(100vh-4rem)] grid-cols-[340px_minmax(0,1fr)]">
        <aside className="overflow-y-auto border-r border-white/7 bg-slate-950/35 p-5">
          <section>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-xs font-semibold tracking-[0.16em] text-slate-400 uppercase">
                Telemetry source
              </h2>
              {csv && (
                <span
                  className="max-w-40 truncate text-xs text-teal-300"
                  title={csv.fileName}
                >
                  {csv.fileName}
                </span>
              )}
            </div>
            <button
              type="button"
              onClick={() => void openCsv()}
              className="w-full rounded-xl border border-dashed border-slate-600 bg-slate-900/45 px-4 py-4 text-left transition hover:border-teal-400/60 hover:bg-teal-400/5"
            >
              <span className="block text-sm font-medium text-slate-200">
                {csv ? "Replace CSV file" : "Choose a CSV file"}
              </span>
              <span className="mt-1 block text-xs text-slate-500">
                Timestamped numeric logger data
              </span>
            </button>
            {csv && (
              <label className="mt-3 block text-xs text-slate-400">
                CSV format
                <select
                  value={csvFormat}
                  onChange={(event) =>
                    handleFormatChange(event.target.value as CsvFormatId)
                  }
                  className={`mt-1.5 ${fieldClassName()}`}
                >
                  {CSV_FORMAT_PROFILES.map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.label}
                    </option>
                  ))}
                </select>
                <span className="mt-1.5 block text-[11px] leading-relaxed text-slate-500">
                  {formatConfidence === "low"
                    ? "Detection was uncertain — confirm the format above."
                    : `Detected: ${formatProfile.label}`}
                </span>
              </label>
            )}
          </section>
          {showTimestampMapping && (
            <>
              <div className="my-5 h-px bg-white/7" />
              <section className="space-y-3">
                <h2 className="text-xs font-semibold tracking-[0.16em] text-slate-400 uppercase">
                  Data mapping
                </h2>
                <label className="block text-xs text-slate-400">
                  Timestamp column
                  <select
                    value={timestampColumn}
                    disabled={!csv}
                    onChange={(event) => setTimestampColumn(event.target.value)}
                    className={`mt-1.5 ${fieldClassName()}`}
                  >
                    {csv?.headers.map((header) => (
                      <option key={header}>{header}</option>
                    ))}
                  </select>
                </label>
                <label className="block text-xs text-slate-400">
                  Timestamp unit
                  <select
                    value={timestampUnit}
                    disabled={!csv}
                    onChange={(event) =>
                      setTimestampUnit(event.target.value as TimestampUnit)
                    }
                    className={`mt-1.5 ${fieldClassName()}`}
                  >
                    <option value="seconds">Seconds</option>
                    <option value="milliseconds">Milliseconds</option>
                    <option value="microseconds">Microseconds</option>
                    <option value="auto">Auto detect</option>
                  </select>
                </label>
              </section>
            </>
          )}
          <div className="my-5 h-px bg-white/7" />
          <section className="space-y-3">
            <div className="flex flex-col gap-2">
              <h2 className="text-xs font-semibold tracking-[0.16em] text-slate-400 uppercase">
                Overlays
              </h2>
              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-slate-400">
                  Preset
                </span>
                <select
                  value={selectedPresetId ?? ""}
                  disabled={!csv}
                  onChange={(event) => handlePresetChange(event.target.value)}
                  className={fieldClassName()}
                >
                  <option value="" disabled>
                    {csv ? "Select a preset" : "Load a CSV first"}
                  </option>
                  {OVERLAY_PRESETS.map((preset) => (
                    <option key={preset.id} value={preset.id}>
                      {preset.name}
                      {preset.csvFormat !== csvFormat
                        ? ` (${preset.csvFormat})`
                        : ""}
                    </option>
                  ))}
                </select>
              </label>
              <div className="flex flex-wrap gap-1.5">
                <button
                  type="button"
                  disabled={!csv}
                  onClick={addGauge}
                  className="rounded-lg border border-teal-400/30 bg-teal-400/10 px-2.5 py-1 text-xs font-semibold text-teal-300 transition hover:bg-teal-400/20 disabled:border-slate-700 disabled:bg-transparent disabled:text-slate-600"
                >
                  + Gauge
                </button>
                <button
                  type="button"
                  disabled={!csv}
                  onClick={addBar}
                  className="rounded-lg border border-emerald-400/30 bg-emerald-400/10 px-2.5 py-1 text-xs font-semibold text-emerald-300 transition hover:bg-emerald-400/20 disabled:border-slate-700 disabled:bg-transparent disabled:text-slate-600"
                >
                  + Bar
                </button>
                <button
                  type="button"
                  disabled={!csv}
                  onClick={addKeyValue}
                  className="rounded-lg border border-amber-400/30 bg-amber-400/10 px-2.5 py-1 text-xs font-semibold text-amber-300 transition hover:bg-amber-400/20 disabled:border-slate-700 disabled:bg-transparent disabled:text-slate-600"
                >
                  + Value
                </button>
                <button
                  type="button"
                  disabled={!canAddTrackMap}
                  onClick={addTrackMap}
                  title={
                    canAddTrackMap
                      ? "Add GPS track map"
                      : "Requires latitude and longitude columns for this format"
                  }
                  className="rounded-lg border border-sky-400/30 bg-sky-400/10 px-2.5 py-1 text-xs font-semibold text-sky-300 transition hover:bg-sky-400/20 disabled:border-slate-700 disabled:bg-transparent disabled:text-slate-600"
                >
                  + Track
                </button>
                <button
                  type="button"
                  disabled={!canAddGMeter}
                  onClick={addGMeter}
                  title={
                    canAddGMeter
                      ? "Add g-meter"
                      : "Requires lateral and longitudinal g columns for this format"
                  }
                  className="rounded-lg border border-rose-400/30 bg-rose-400/10 px-2.5 py-1 text-xs font-semibold text-rose-300 transition hover:bg-rose-400/20 disabled:border-slate-700 disabled:bg-transparent disabled:text-slate-600"
                >
                  + G
                </button>
              </div>
            </div>
            {overlays.length === 0 && (
              <p className="rounded-lg bg-slate-900/60 px-3 py-2 text-xs text-slate-500">
                Load a CSV to add overlays.
              </p>
            )}
            <div className="space-y-1.5">
              {overlays.map((overlay) => (
                <div
                  key={overlay.id}
                  className={`flex items-center gap-2 rounded-lg border px-2.5 py-2 transition ${
                    overlay.id === selectedOverlayId
                      ? "border-teal-400/50 bg-teal-400/8"
                      : "border-white/8 bg-slate-900/40 hover:border-white/20"
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => setSelectedOverlayId(overlay.id)}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  >
                    <span
                      className="size-2.5 shrink-0 rounded-full"
                      style={{ background: overlay.accent }}
                    />
                    <span className="truncate text-sm text-slate-200">
                      {overlayTitle(overlay)}
                    </span>
                    {overlay.type === "track-map" && (
                      <span className="shrink-0 rounded bg-sky-400/15 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-sky-300 uppercase">
                        Map
                      </span>
                    )}
                    {overlay.type === "g-meter" && (
                      <span className="shrink-0 rounded bg-rose-400/15 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-rose-300 uppercase">
                        G
                      </span>
                    )}
                    {overlay.type === "bar" && (
                      <span className="shrink-0 rounded bg-emerald-400/15 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-emerald-300 uppercase">
                        Bar
                      </span>
                    )}
                    {overlay.type === "key-value" && (
                      <span className="shrink-0 rounded bg-amber-400/15 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-amber-300 uppercase">
                        Values
                      </span>
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => removeOverlay(overlay.id)}
                    aria-label={`Remove ${overlayTitle(overlay)}`}
                    className="shrink-0 rounded p-1 text-slate-500 transition hover:bg-white/10 hover:text-white"
                  >
                    <svg
                      viewBox="0 0 24 24"
                      className="size-3.5"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <path d="M18 6 6 18M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              ))}
            </div>
            {selectedOverlay?.type === "gauge" && (
              <div className="space-y-3 rounded-xl border border-white/8 bg-slate-900/40 p-3">
                <label className="block text-xs text-slate-400">
                  Data field
                  <select
                    value={selectedOverlay.valueColumn}
                    onChange={(event) =>
                      selectValueColumn(selectedOverlay, event.target.value)
                    }
                    className={`mt-1.5 ${fieldClassName()}`}
                  >
                    {(numericColumns.length > 0
                      ? numericColumns
                      : (csv?.headers ?? [])
                    ).map((header) => (
                      <option key={header}>{header}</option>
                    ))}
                  </select>
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <label className="text-xs text-slate-400">
                    Label
                    <input
                      value={selectedOverlay.label}
                      onChange={(event) =>
                        updateOverlay(selectedOverlay.id, {
                          label: event.target.value,
                        })
                      }
                      className={`mt-1.5 ${fieldClassName()}`}
                    />
                  </label>
                  <label className="text-xs text-slate-400">
                    Unit
                    <input
                      value={selectedOverlay.unit}
                      onChange={(event) =>
                        updateOverlay(selectedOverlay.id, {
                          unit: event.target.value,
                        })
                      }
                      className={`mt-1.5 ${fieldClassName()}`}
                    />
                  </label>
                  <label className="text-xs text-slate-400">
                    Minimum
                    <input
                      type="number"
                      value={selectedOverlay.min}
                      onChange={(event) =>
                        updateOverlay(selectedOverlay.id, {
                          min: Number(event.target.value),
                        })
                      }
                      className={`mt-1.5 ${fieldClassName()}`}
                    />
                  </label>
                  <label className="text-xs text-slate-400">
                    Maximum
                    <input
                      type="number"
                      value={selectedOverlay.max}
                      onChange={(event) =>
                        updateOverlay(selectedOverlay.id, {
                          max: Number(event.target.value),
                        })
                      }
                      className={`mt-1.5 ${fieldClassName()}`}
                    />
                  </label>
                </div>
                {selectedOverlay.max <= selectedOverlay.min && (
                  <p className="text-xs text-amber-300">
                    Maximum must be greater than minimum.
                  </p>
                )}
                <LayoutSliders
                  overlay={selectedOverlay}
                  onChange={(patch) => updateOverlay(selectedOverlay.id, patch)}
                />
                {selectedSeries && (
                  <p className="rounded-lg bg-slate-950/60 px-3 py-2 text-xs leading-relaxed text-slate-500">
                    {selectedSeries.stats.acceptedRows.toLocaleString()} samples
                    · {formatTime(selectedSeries.stats.durationSeconds)}
                    {selectedSeries.stats.invalidRows > 0 &&
                      ` · ${selectedSeries.stats.invalidRows} skipped`}
                  </p>
                )}
              </div>
            )}
            {selectedOverlay?.type === "bar" && (
              <div className="space-y-3 rounded-xl border border-white/8 bg-slate-900/40 p-3">
                <label className="block text-xs text-slate-400">
                  Data field
                  <select
                    value={selectedOverlay.valueColumn}
                    onChange={(event) =>
                      selectValueColumn(selectedOverlay, event.target.value)
                    }
                    className={`mt-1.5 ${fieldClassName()}`}
                  >
                    {(numericColumns.length > 0
                      ? numericColumns
                      : (csv?.headers ?? [])
                    ).map((header) => (
                      <option key={header}>{header}</option>
                    ))}
                  </select>
                </label>
                <label className="block text-xs text-slate-400">
                  Label
                  <input
                    value={selectedOverlay.label}
                    onChange={(event) =>
                      updateOverlay(selectedOverlay.id, {
                        label: event.target.value,
                      })
                    }
                    className={`mt-1.5 ${fieldClassName()}`}
                  />
                </label>
                <p className="rounded-lg bg-slate-950/60 px-3 py-2 text-xs leading-relaxed text-slate-400">
                  Empty/full from data range:{" "}
                  <span className="tabular-nums text-slate-300">
                    {selectedOverlay.min.toLocaleString()} –{" "}
                    {selectedOverlay.max.toLocaleString()}
                  </span>
                  . Throttle/TPS columns use green; brake columns use red.
                </p>
                <LayoutSliders
                  overlay={selectedOverlay}
                  onChange={(patch) => updateOverlay(selectedOverlay.id, patch)}
                />
                {selectedSeries && (
                  <p className="rounded-lg bg-slate-950/60 px-3 py-2 text-xs leading-relaxed text-slate-500">
                    {selectedSeries.stats.acceptedRows.toLocaleString()} samples
                    · {formatTime(selectedSeries.stats.durationSeconds)}
                    {selectedSeries.stats.invalidRows > 0 &&
                      ` · ${selectedSeries.stats.invalidRows} skipped`}
                  </p>
                )}
              </div>
            )}
            {selectedOverlay?.type === "key-value" && (
              <div className="space-y-3 rounded-xl border border-white/8 bg-slate-900/40 p-3">
                <p className="text-xs leading-relaxed text-slate-500">
                  Values share one plate. Use + Value to append another field.
                </p>
                <div className="grid grid-cols-2 gap-1.5">
                  {(
                    [
                      ["vertical", "Vertical"],
                      ["horizontal", "Horizontal"],
                    ] as const
                  ).map(([value, label]) => {
                    const active = selectedOverlay.stack === value;
                    return (
                      <button
                        key={value}
                        type="button"
                        onClick={() =>
                          updateOverlay(selectedOverlay.id, { stack: value })
                        }
                        className={`rounded-lg border px-2.5 py-2 text-xs font-semibold transition ${
                          active
                            ? "border-amber-400/50 bg-amber-400/15 text-amber-200"
                            : "border-white/8 bg-slate-950/40 text-slate-400 hover:border-white/20 hover:text-slate-200"
                        }`}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
                <div className="space-y-2">
                  {selectedOverlay.entries.map((entry, index) => {
                    const entrySeries = valueSeries.get(entry.id);
                    return (
                      <div
                        key={entry.id}
                        className="space-y-2 rounded-lg border border-white/8 bg-slate-950/50 p-2.5"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[11px] font-semibold tracking-wide text-slate-500 uppercase">
                            Field {index + 1}
                          </span>
                          <button
                            type="button"
                            onClick={() =>
                              removeKeyValueEntry(selectedOverlay.id, entry.id)
                            }
                            aria-label={`Remove ${entry.label || entry.valueColumn}`}
                            className="rounded p-1 text-slate-500 transition hover:bg-white/10 hover:text-white"
                          >
                            <svg
                              viewBox="0 0 24 24"
                              className="size-3.5"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                            >
                              <path d="M18 6 6 18M6 6l12 12" />
                            </svg>
                          </button>
                        </div>
                        <label className="block text-xs text-slate-400">
                          Data field
                          <select
                            value={entry.valueColumn}
                            onChange={(event) =>
                              selectKeyValueEntryColumn(
                                selectedOverlay,
                                entry,
                                event.target.value,
                              )
                            }
                            className={`mt-1.5 ${fieldClassName()}`}
                          >
                            {(numericColumns.length > 0
                              ? numericColumns
                              : (csv?.headers ?? [])
                            ).map((header) => (
                              <option key={header}>{header}</option>
                            ))}
                          </select>
                        </label>
                        <div className="grid grid-cols-2 gap-2">
                          <label className="text-xs text-slate-400">
                            Label
                            <input
                              value={entry.label}
                              onChange={(event) =>
                                updateKeyValueEntry(
                                  selectedOverlay.id,
                                  entry.id,
                                  { label: event.target.value },
                                )
                              }
                              className={`mt-1.5 ${fieldClassName()}`}
                            />
                          </label>
                          <label className="text-xs text-slate-400">
                            Unit
                            <input
                              value={entry.unit}
                              onChange={(event) =>
                                updateKeyValueEntry(
                                  selectedOverlay.id,
                                  entry.id,
                                  { unit: event.target.value },
                                )
                              }
                              className={`mt-1.5 ${fieldClassName()}`}
                            />
                          </label>
                        </div>
                        {entrySeries && (
                          <p className="text-[11px] leading-relaxed text-slate-600">
                            {entrySeries.stats.acceptedRows.toLocaleString()}{" "}
                            samples
                            {entrySeries.stats.invalidRows > 0 &&
                              ` · ${entrySeries.stats.invalidRows} skipped`}
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>
                <LayoutSliders
                  overlay={selectedOverlay}
                  onChange={(patch) => updateOverlay(selectedOverlay.id, patch)}
                />
              </div>
            )}
            {selectedOverlay?.type === "track-map" && (
              <div className="space-y-3 rounded-xl border border-white/8 bg-slate-900/40 p-3">
                <p className="rounded-lg bg-slate-950/60 px-3 py-2 text-xs leading-relaxed text-slate-400">
                  Uses <span className="text-slate-300">
                    {selectedOverlay.latitudeColumn}
                  </span>{" "}
                  and{" "}
                  <span className="text-slate-300">
                    {selectedOverlay.longitudeColumn}
                  </span>{" "}
                  to draw the session track with a live position marker.
                </p>
                <label className="text-xs text-slate-400">
                  Label
                  <input
                    value={selectedOverlay.label}
                    onChange={(event) =>
                      updateOverlay(selectedOverlay.id, {
                        label: event.target.value,
                      })
                    }
                    className={`mt-1.5 ${fieldClassName()}`}
                  />
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <label className="text-xs text-slate-400">
                    Latitude
                    <select
                      value={selectedOverlay.latitudeColumn}
                      onChange={(event) =>
                        updateOverlay(selectedOverlay.id, {
                          latitudeColumn: event.target.value,
                        })
                      }
                      className={`mt-1.5 ${fieldClassName()}`}
                    >
                      {(numericColumns.length > 0
                        ? numericColumns
                        : (csv?.headers ?? [])
                      ).map((header) => (
                        <option key={header}>{header}</option>
                      ))}
                    </select>
                  </label>
                  <label className="text-xs text-slate-400">
                    Longitude
                    <select
                      value={selectedOverlay.longitudeColumn}
                      onChange={(event) =>
                        updateOverlay(selectedOverlay.id, {
                          longitudeColumn: event.target.value,
                        })
                      }
                      className={`mt-1.5 ${fieldClassName()}`}
                    >
                      {(numericColumns.length > 0
                        ? numericColumns
                        : (csv?.headers ?? [])
                      ).map((header) => (
                        <option key={header}>{header}</option>
                      ))}
                    </select>
                  </label>
                </div>
                <LayoutSliders
                  overlay={selectedOverlay}
                  onChange={(patch) => updateOverlay(selectedOverlay.id, patch)}
                />
                {selectedTrack && (
                  <p className="rounded-lg bg-slate-950/60 px-3 py-2 text-xs leading-relaxed text-slate-500">
                    {selectedTrack.stats.acceptedRows.toLocaleString()} GPS
                    samples · {formatTime(selectedTrack.stats.durationSeconds)}
                    {selectedTrack.stats.invalidRows > 0 &&
                      ` · ${selectedTrack.stats.invalidRows} skipped`}
                  </p>
                )}
              </div>
            )}
            {selectedOverlay?.type === "g-meter" && (
              <div className="space-y-3 rounded-xl border border-white/8 bg-slate-900/40 p-3">
                <p className="rounded-lg bg-slate-950/60 px-3 py-2 text-xs leading-relaxed text-slate-400">
                  Plots{" "}
                  <span className="text-slate-300">
                    {selectedOverlay.lateralColumn}
                  </span>{" "}
                  (X) and{" "}
                  <span className="text-slate-300">
                    {selectedOverlay.longitudinalColumn}
                  </span>{" "}
                  (Y) as a g-force dot. Positive Lon is up (accel); positive Lat
                  is right.
                </p>
                <label className="text-xs text-slate-400">
                  Label
                  <input
                    value={selectedOverlay.label}
                    onChange={(event) =>
                      updateOverlay(selectedOverlay.id, {
                        label: event.target.value,
                      })
                    }
                    className={`mt-1.5 ${fieldClassName()}`}
                  />
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <label className="text-xs text-slate-400">
                    Lateral
                    <select
                      value={selectedOverlay.lateralColumn}
                      onChange={(event) =>
                        updateOverlay(selectedOverlay.id, {
                          lateralColumn: event.target.value,
                        })
                      }
                      className={`mt-1.5 ${fieldClassName()}`}
                    >
                      {(numericColumns.length > 0
                        ? numericColumns
                        : (csv?.headers ?? [])
                      ).map((header) => (
                        <option key={header}>{header}</option>
                      ))}
                    </select>
                  </label>
                  <label className="text-xs text-slate-400">
                    Longitudinal
                    <select
                      value={selectedOverlay.longitudinalColumn}
                      onChange={(event) =>
                        updateOverlay(selectedOverlay.id, {
                          longitudinalColumn: event.target.value,
                        })
                      }
                      className={`mt-1.5 ${fieldClassName()}`}
                    >
                      {(numericColumns.length > 0
                        ? numericColumns
                        : (csv?.headers ?? [])
                      ).map((header) => (
                        <option key={header}>{header}</option>
                      ))}
                    </select>
                  </label>
                  <label className="text-xs text-slate-400">
                    Max g (±)
                    <input
                      type="number"
                      min="0.5"
                      step="0.5"
                      value={selectedOverlay.maxG}
                      onChange={(event) =>
                        updateOverlay(selectedOverlay.id, {
                          maxG: Number(event.target.value),
                        })
                      }
                      className={`mt-1.5 ${fieldClassName()}`}
                    />
                  </label>
                </div>
                {selectedOverlay.maxG <= 0 && (
                  <p className="text-xs text-amber-300">
                    Max g must be greater than zero.
                  </p>
                )}
                <LayoutSliders
                  overlay={selectedOverlay}
                  onChange={(patch) => updateOverlay(selectedOverlay.id, patch)}
                />
                {selectedGMeter && (
                  <p className="rounded-lg bg-slate-950/60 px-3 py-2 text-xs leading-relaxed text-slate-500">
                    {Math.min(
                      selectedGMeter.lateral.stats.acceptedRows,
                      selectedGMeter.longitudinal.stats.acceptedRows,
                    ).toLocaleString()}{" "}
                    samples ·{" "}
                    {formatTime(
                      Math.max(
                        selectedGMeter.lateral.stats.durationSeconds,
                        selectedGMeter.longitudinal.stats.durationSeconds,
                      ),
                    )}
                  </p>
                )}
              </div>
            )}
          </section>
          <div className="my-5 h-px bg-white/7" />
          <section className="space-y-3">
            <h2 className="text-xs font-semibold tracking-[0.16em] text-slate-400 uppercase">
              Export
            </h2>
            <div className="grid grid-cols-3 gap-2">
              <label className="text-xs text-slate-400">
                Width
                <input
                  type="number"
                  min="64"
                  value={width}
                  onChange={(event) => setWidth(Number(event.target.value))}
                  className={`mt-1.5 ${fieldClassName()}`}
                />
              </label>
              <label className="text-xs text-slate-400">
                Height
                <input
                  type="number"
                  min="64"
                  value={height}
                  onChange={(event) => setHeight(Number(event.target.value))}
                  className={`mt-1.5 ${fieldClassName()}`}
                />
              </label>
              <label className="text-xs text-slate-400">
                FPS
                <select
                  value={fps}
                  onChange={(event) => setFps(Number(event.target.value))}
                  className={`mt-1.5 ${fieldClassName()}`}
                >
                  <option value={24}>24</option>
                  <option value={30}>30</option>
                  <option value={60}>60</option>
                </select>
              </label>
            </div>
            {exportId ? (
              <div className="rounded-xl border border-teal-400/20 bg-teal-400/5 p-3">
                <div className="mb-2 flex justify-between gap-3 text-xs text-slate-300">
                  <span>
                    {exportProgress?.status === "encoding"
                      ? "Finishing video"
                      : "Rendering frames"}
                  </span>
                  <span className="shrink-0 tabular-nums">
                    {Math.round((exportProgress?.percent ?? 0) * 100)}%
                  </span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-slate-800">
                  <div
                    className="h-full rounded-full bg-teal-400 transition-[width]"
                    style={{
                      width: `${(exportProgress?.percent ?? 0) * 100}%`,
                    }}
                  />
                </div>
                <div className="mt-2 flex items-center justify-between gap-3 text-xs text-slate-500">
                  <span>
                    {exportProgress
                      ? `${exportProgress.frame.toLocaleString()} / ${exportProgress.totalFrames.toLocaleString()} frames`
                      : "Starting…"}
                  </span>
                  <span className="shrink-0 tabular-nums text-teal-300/90">
                    {exportEtaLabel}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={cancelCurrentExport}
                  className="mt-3 text-xs font-medium text-slate-400 hover:text-white"
                >
                  Cancel export
                </button>
              </div>
            ) : (
              <button
                type="button"
                disabled={!canExport}
                onClick={() => void startExport()}
                className="w-full rounded-xl bg-teal-400 px-4 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-teal-300 disabled:bg-slate-800 disabled:text-slate-600"
              >
                Export transparent WebM
                {canExport && (
                  <span className="mt-0.5 block text-[11px] font-medium text-slate-800/70">
                    {formatTime(exportDuration)}
                    {isTrimmed
                      ? ` · ${formatTime(trimStart)}–${formatTime(trimEnd)}`
                      : ""}
                  </span>
                )}
              </button>
            )}
          </section>
        </aside>
        <section className="flex min-w-0 flex-col p-6">
          <div className="mb-4 flex items-end justify-between">
            <div>
              <h2 className="text-lg font-semibold text-slate-100">
                Overlay preview
              </h2>
              <p className="mt-1 text-sm text-slate-500">
                Transparent {width}×{height} composition
              </p>
            </div>
            <span className="font-mono text-sm tabular-nums text-slate-400">
              {formatTime(currentTime)}{" "}
              <span className="text-slate-600">/</span> {formatTime(duration)}
              {isTrimmed && (
                <span className="ml-3 text-teal-300/90">
                  export {formatTime(trimStart)}–{formatTime(trimEnd)}
                </span>
              )}
            </span>
          </div>
          <div className="checkerboard flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-2xl border border-white/8 p-8 shadow-2xl shadow-black/20">
            <div
              className="relative max-h-full w-full max-w-5xl overflow-hidden rounded-lg border border-white/8 bg-transparent shadow-[0_0_0_1px_rgba(0,0,0,0.3)]"
              style={{ aspectRatio: `${width} / ${height}` }}
            >
              {canPreview ? (
                previewableOverlays.map((overlay) => {
                  const sizeWidthPct = overlay.size * (height / width) * 100;
                  const widthPct =
                    overlay.type === "bar"
                      ? sizeWidthPct * (120 / 320)
                      : overlay.type === "key-value"
                        ? sizeWidthPct *
                          (keyValueViewBox(
                            overlay.entries.length,
                            overlay.stack,
                          ).width /
                            KEY_VALUE_VIEW_W)
                        : sizeWidthPct;
                  const keyValueBox =
                    overlay.type === "key-value"
                      ? keyValueViewBox(overlay.entries.length, overlay.stack)
                      : null;
                  return (
                    <div
                      key={overlay.id}
                      onClick={() => setSelectedOverlayId(overlay.id)}
                      className={`absolute -translate-x-1/2 -translate-y-1/2 cursor-pointer ${
                        overlay.type === "bar"
                          ? "aspect-[120/320]"
                          : overlay.type === "key-value"
                            ? ""
                            : "aspect-square"
                      }`}
                      style={{
                        left: `${overlay.x * 100}%`,
                        top: `${overlay.y * 100}%`,
                        width: `${widthPct}%`,
                        ...(keyValueBox
                          ? {
                              aspectRatio: `${keyValueBox.width} / ${keyValueBox.height}`,
                            }
                          : {}),
                      }}
                    >
                      {overlay.type === "track-map" ? (
                        <TrackMap
                          points={trackSeries.get(overlay.id)?.points ?? []}
                          time={currentTime}
                          label={overlay.label || "Track"}
                          accent={overlay.accent}
                        />
                      ) : overlay.type === "g-meter" ? (
                        <GMeter
                          lateral={
                            sampleAt(
                              gMeterSeries.get(overlay.id)!.lateral,
                              currentTime,
                            ) ?? 0
                          }
                          longitudinal={
                            sampleAt(
                              gMeterSeries.get(overlay.id)!.longitudinal,
                              currentTime,
                            ) ?? 0
                          }
                          maxG={overlay.maxG}
                          label={overlay.label || "G"}
                          accent={overlay.accent}
                        />
                      ) : overlay.type === "bar" ? (
                        <Bar
                          value={
                            sampleAt(
                              valueSeries.get(overlay.id)!,
                              currentTime,
                            ) ?? 0
                          }
                          min={overlay.min}
                          max={overlay.max}
                          label={overlay.label || overlay.valueColumn}
                          accent={overlay.accent}
                        />
                      ) : overlay.type === "key-value" ? (
                        <KeyValue
                          stack={overlay.stack}
                          items={overlay.entries.map((entry) => ({
                            id: entry.id,
                            value:
                              sampleAt(
                                valueSeries.get(entry.id)!,
                                currentTime,
                              ) ?? 0,
                            label: entry.label || entry.valueColumn,
                            unit: entry.unit,
                            accent: entry.accent,
                          }))}
                        />
                      ) : (
                        <Gauge
                          value={
                            sampleAt(
                              valueSeries.get(overlay.id)!,
                              currentTime,
                            ) ?? 0
                          }
                          min={overlay.min}
                          max={overlay.max}
                          label={overlay.label || overlay.valueColumn}
                          unit={overlay.unit}
                          accent={overlay.accent}
                        />
                      )}
                    </div>
                  );
                })
              ) : (
                <div className="absolute inset-0 grid place-items-center bg-slate-950/35">
                  <div className="text-center">
                    <div className="mx-auto mb-3 grid size-12 place-items-center rounded-2xl border border-white/8 bg-slate-900/70 text-slate-500">
                      <svg
                        viewBox="0 0 24 24"
                        className="size-6"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                      >
                        <path d="M4 16a8 8 0 1 1 16 0" />
                        <path d="m12 13 4-5" />
                      </svg>
                    </div>
                    <p className="text-sm font-medium text-slate-300">
                      Load telemetry to begin
                    </p>
                    <p className="mt-1 text-xs text-slate-500">
                      Choose a timestamp and numeric field
                    </p>
                  </div>
                </div>
              )}
            </div>
          </div>
          <div className="mt-4 space-y-2 rounded-xl border border-white/7 bg-slate-950/45 p-3">
            <div className="flex items-center gap-4">
              <button
                type="button"
                disabled={!canExport}
                onClick={() => {
                  if (
                    currentTime < trimStart ||
                    currentTime >= trimEnd - 0.001
                  ) {
                    setCurrentTime(trimStart);
                  }
                  setPlaying((value) => !value);
                }}
                aria-label={playing ? "Pause" : "Play"}
                className="grid size-10 shrink-0 place-items-center rounded-full bg-slate-100 text-slate-950 transition hover:bg-white disabled:bg-slate-800 disabled:text-slate-600"
              >
                {playing ? (
                  <span className="flex gap-1">
                    <span className="h-4 w-1.5 bg-current" />
                    <span className="h-4 w-1.5 bg-current" />
                  </span>
                ) : (
                  <span className="ml-0.5 block size-0 border-y-[8px] border-l-[12px] border-y-transparent border-l-current" />
                )}
              </button>
              <div className="relative h-7 min-w-0 flex-1">
                <div className="pointer-events-none absolute inset-x-0 top-1/2 h-2 -translate-y-1/2 overflow-hidden rounded-full bg-slate-800">
                  <div
                    className="absolute inset-y-0 left-0 bg-slate-950/55"
                    style={{ width: `${trimStartPct}%` }}
                  />
                  <div
                    className="absolute inset-y-0 bg-teal-400/35"
                    style={{
                      left: `${trimStartPct}%`,
                      width: `${Math.max(0, trimEndPct - trimStartPct)}%`,
                    }}
                  />
                  <div
                    className="absolute inset-y-0 right-0 bg-slate-950/55"
                    style={{ width: `${Math.max(0, 100 - trimEndPct)}%` }}
                  />
                </div>
                <input
                  type="range"
                  min={0}
                  max={Math.max(duration, 0.001)}
                  step={0.001}
                  value={currentTime}
                  disabled={!canPreview}
                  aria-label="Playback position"
                  onChange={(event) => {
                    setPlaying(false);
                    setCurrentTime(Number(event.target.value));
                  }}
                  className="timeline-range timeline-range-playhead"
                  style={{ zIndex: 1 }}
                />
                <input
                  type="range"
                  min={0}
                  max={Math.max(duration, 0.001)}
                  step={0.001}
                  value={trimStart}
                  disabled={!canPreview || duration <= 0}
                  aria-label="Export start"
                  onChange={(event) => {
                    setPlaying(false);
                    updateTrimStart(Number(event.target.value));
                  }}
                  className="timeline-range timeline-range-in"
                  style={{ zIndex: trimStart > duration * 0.5 ? 4 : 3 }}
                />
                <input
                  type="range"
                  min={0}
                  max={Math.max(duration, 0.001)}
                  step={0.001}
                  value={trimEnd}
                  disabled={!canPreview || duration <= 0}
                  aria-label="Export end"
                  onChange={(event) => {
                    setPlaying(false);
                    updateTrimEnd(Number(event.target.value));
                  }}
                  className="timeline-range timeline-range-out"
                  style={{ zIndex: trimEnd < duration * 0.5 ? 4 : 3 }}
                />
              </div>
            </div>
            <div className="flex items-center justify-between gap-3 pl-14 text-[11px] tabular-nums text-slate-500">
              <span>
                In {formatTime(trimStart)}
                <span className="text-slate-600"> · </span>
                Out {formatTime(trimEnd)}
              </span>
              <span className="flex items-center gap-3">
                <span className="font-medium text-slate-400">
                  {formatTime(exportDuration)} selected
                </span>
                {isTrimmed && (
                  <button
                    type="button"
                    onClick={() => {
                      setPlaying(false);
                      setTrimStart(0);
                      setTrimEnd(duration);
                    }}
                    className="shrink-0 font-medium text-teal-300/90 hover:text-teal-200"
                  >
                    Reset
                  </button>
                )}
              </span>
            </div>
          </div>
          {message && (
            <p className="mt-3 rounded-lg border border-white/7 bg-slate-900/60 px-3 py-2 text-xs text-slate-300">
              {message}
            </p>
          )}
        </section>
      </div>
    </main>
  );
}
function LayoutSliders({
  overlay,
  onChange,
}: {
  overlay: OverlayConfig;
  onChange: (patch: Partial<BaseOverlayConfig>) => void;
}) {
  return (
    <div className="space-y-2.5 pt-1">
      <label className="block text-xs text-slate-400">
        <span className="flex justify-between">
          <span>Horizontal (X)</span>
          <span className="tabular-nums text-slate-500">
            {Math.round(overlay.x * 100)}%
          </span>
        </span>
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={Math.round(overlay.x * 100)}
          onChange={(event) =>
            onChange({ x: Number(event.target.value) / 100 })
          }
          className="mt-1 w-full"
        />
      </label>
      <label className="block text-xs text-slate-400">
        <span className="flex justify-between">
          <span>Vertical (Y)</span>
          <span className="tabular-nums text-slate-500">
            {Math.round(overlay.y * 100)}%
          </span>
        </span>
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={Math.round(overlay.y * 100)}
          onChange={(event) =>
            onChange({ y: Number(event.target.value) / 100 })
          }
          className="mt-1 w-full"
        />
      </label>
      <label className="block text-xs text-slate-400">
        <span className="flex justify-between">
          <span>Size</span>
          <span className="tabular-nums text-slate-500">
            {Math.round(overlay.size * 100)}%
          </span>
        </span>
        <input
          type="range"
          min={10}
          max={100}
          step={1}
          value={Math.round(overlay.size * 100)}
          onChange={(event) =>
            onChange({ size: Number(event.target.value) / 100 })
          }
          className="mt-1 w-full"
        />
      </label>
    </div>
  );
}
export default App;

import type { CsvFormatId } from "./csvFormats";
import { getCsvFormatProfile } from "./csvFormats";
import { niceMaxG } from "./gMeter";
import type {
  BarConfig,
  GaugeConfig,
  GMeterConfig,
  KeyValueConfig,
  KeyValueEntry,
  OverlayConfig,
  TrackMapConfig,
} from "./overlayConfig";
import {
  buildSeries,
  inferNumericColumns,
  type ParsedCsv,
  type TimestampUnit,
} from "./telemetry";

/** Sentinel column resolved to the first usable numeric value channel. */
export const PRIMARY_VALUE_COLUMN = "$primary";

type OmitId<T> = Omit<T, "id">;

export type OverlayPresetItem =
  | OmitId<GaugeConfig>
  | OmitId<BarConfig>
  | (OmitId<KeyValueConfig> & { entries: OmitId<KeyValueEntry>[] })
  | OmitId<TrackMapConfig>
  | OmitId<GMeterConfig>;

export interface OverlayPreset {
  version: 1;
  id: string;
  name: string;
  description?: string;
  /** Format this preset is intended for; used for auto-apply. */
  csvFormat: CsvFormatId;
  /** When true, this is the preset applied on load for that format. */
  defaultForFormat?: boolean;
  overlays: OverlayPresetItem[];
}

export interface ApplyPresetContext {
  parsed: ParsedCsv;
  timestampColumn: string;
  timestampUnit: TimestampUnit;
  formatId: CsvFormatId;
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

function dataRange(values: number[]) {
  if (values.length === 0) return { min: 0, max: 100 };
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max <= min) return { min, max: min + 1 };
  return { min, max };
}

function defaultUnitFor(column: string, csv: ParsedCsv) {
  return (
    csv.units[column] ?? (column.toLowerCase().includes("rpm") ? "RPM" : "")
  );
}

function headerSet(parsed: ParsedCsv) {
  return new Set(parsed.headers);
}

function resolvePrimaryColumn(
  parsed: ParsedCsv,
  timestampColumn: string,
  formatId: CsvFormatId,
): string | null {
  const profile = getCsvFormatProfile(formatId);
  const excluded = profile.excludeFromDefaultValue(parsed.headers);
  const numeric = inferNumericColumns(parsed);
  return (
    numeric.find(
      (header) => header !== timestampColumn && !excluded.has(header),
    ) ??
    numeric.find((header) => header !== timestampColumn) ??
    null
  );
}

function resolveValueColumn(
  column: string,
  ctx: ApplyPresetContext,
): string | null {
  if (column === PRIMARY_VALUE_COLUMN) {
    return resolvePrimaryColumn(
      ctx.parsed,
      ctx.timestampColumn,
      ctx.formatId,
    );
  }
  return headerSet(ctx.parsed).has(column) ? column : null;
}

function materializeGauge(
  item: OmitId<GaugeConfig>,
  ctx: ApplyPresetContext,
): GaugeConfig | null {
  const valueColumn = resolveValueColumn(item.valueColumn, ctx);
  if (!valueColumn) return null;
  const series = buildSeries(ctx.parsed, {
    timestampColumn: ctx.timestampColumn,
    valueColumn,
    timestampUnit: ctx.timestampUnit,
  });
  const range = niceRange(series.points.map((point) => point.value));
  return {
    ...item,
    id: crypto.randomUUID(),
    valueColumn,
    unit: item.unit || defaultUnitFor(valueColumn, ctx.parsed),
    min: range.min,
    max: range.max,
    label:
      item.valueColumn === PRIMARY_VALUE_COLUMN && item.label === "VALUE"
        ? valueColumn.toUpperCase()
        : item.label,
  };
}

function materializeBar(
  item: OmitId<BarConfig>,
  ctx: ApplyPresetContext,
): BarConfig | null {
  const valueColumn = resolveValueColumn(item.valueColumn, ctx);
  if (!valueColumn) return null;
  const series = buildSeries(ctx.parsed, {
    timestampColumn: ctx.timestampColumn,
    valueColumn,
    timestampUnit: ctx.timestampUnit,
  });
  const range = dataRange(series.points.map((point) => point.value));
  return {
    ...item,
    id: crypto.randomUUID(),
    valueColumn,
    min: range.min,
    max: range.max,
  };
}

function materializeKeyValue(
  item: OmitId<KeyValueConfig> & { entries: OmitId<KeyValueEntry>[] },
  ctx: ApplyPresetContext,
): KeyValueConfig | null {
  const entries: KeyValueEntry[] = [];
  for (const entry of item.entries) {
    const valueColumn = resolveValueColumn(entry.valueColumn, ctx);
    if (!valueColumn) continue;
    entries.push({
      ...entry,
      id: crypto.randomUUID(),
      valueColumn,
      unit: entry.unit || defaultUnitFor(valueColumn, ctx.parsed),
    });
  }
  if (entries.length === 0) return null;
  return {
    ...item,
    id: crypto.randomUUID(),
    entries,
  };
}

function materializeTrackMap(
  item: OmitId<TrackMapConfig>,
  ctx: ApplyPresetContext,
): TrackMapConfig | null {
  const headers = headerSet(ctx.parsed);
  if (
    !headers.has(item.latitudeColumn) ||
    !headers.has(item.longitudeColumn)
  ) {
    return null;
  }
  return {
    ...item,
    id: crypto.randomUUID(),
  };
}

function materializeGMeter(
  item: OmitId<GMeterConfig>,
  ctx: ApplyPresetContext,
): GMeterConfig | null {
  const headers = headerSet(ctx.parsed);
  if (
    !headers.has(item.lateralColumn) ||
    !headers.has(item.longitudinalColumn)
  ) {
    return null;
  }
  const lateral = buildSeries(ctx.parsed, {
    timestampColumn: ctx.timestampColumn,
    valueColumn: item.lateralColumn,
    timestampUnit: ctx.timestampUnit,
  });
  const longitudinal = buildSeries(ctx.parsed, {
    timestampColumn: ctx.timestampColumn,
    valueColumn: item.longitudinalColumn,
    timestampUnit: ctx.timestampUnit,
  });
  const maxG = niceMaxG([
    ...lateral.points.map((point) => point.value),
    ...longitudinal.points.map((point) => point.value),
  ]);
  return {
    ...item,
    id: crypto.randomUUID(),
    maxG,
  };
}

function materializeItem(
  item: OverlayPresetItem,
  ctx: ApplyPresetContext,
): OverlayConfig | null {
  switch (item.type) {
    case "gauge":
      return materializeGauge(item, ctx);
    case "bar":
      return materializeBar(item, ctx);
    case "key-value":
      return materializeKeyValue(item, ctx);
    case "track-map":
      return materializeTrackMap(item, ctx);
    case "g-meter":
      return materializeGMeter(item, ctx);
  }
}

/** Apply a preset to the current CSV, skipping items with missing columns. */
export function applyOverlayPreset(
  preset: OverlayPreset,
  ctx: ApplyPresetContext,
): OverlayConfig[] {
  const overlays: OverlayConfig[] = [];
  for (const item of preset.overlays) {
    const next = materializeItem(item, ctx);
    if (next) overlays.push(next);
  }
  return overlays;
}

function stripOverlayIds(overlay: OverlayConfig): OverlayPresetItem {
  if (overlay.type === "key-value") {
    const { id: _id, entries, ...rest } = overlay;
    return {
      ...rest,
      entries: entries.map(({ id: _entryId, ...entry }) => entry),
    } as OverlayPresetItem;
  }
  const { id: _id, ...rest } = overlay;
  return rest as OverlayPresetItem;
}

/** Serialize current overlays into a save-ready preset (for future Save UI). */
export function serializeOverlayPreset(
  meta: {
    id: string;
    name: string;
    description?: string;
    csvFormat: CsvFormatId;
    defaultForFormat?: boolean;
  },
  overlays: OverlayConfig[],
): OverlayPreset {
  return {
    version: 1,
    id: meta.id,
    name: meta.name,
    description: meta.description,
    csvFormat: meta.csvFormat,
    defaultForFormat: meta.defaultForFormat,
    overlays: overlays.map(stripOverlayIds),
  };
}

export function isOverlayPreset(value: unknown): value is OverlayPreset {
  if (!value || typeof value !== "object") return false;
  const preset = value as Record<string, unknown>;
  return (
    preset.version === 1 &&
    typeof preset.id === "string" &&
    typeof preset.name === "string" &&
    (preset.csvFormat === "aim" || preset.csvFormat === "generic") &&
    Array.isArray(preset.overlays)
  );
}

export function getDefaultPreset(
  presets: readonly OverlayPreset[],
  formatId: CsvFormatId,
): OverlayPreset | undefined {
  return (
    presets.find(
      (preset) => preset.csvFormat === formatId && preset.defaultForFormat,
    ) ?? presets.find((preset) => preset.csvFormat === formatId)
  );
}

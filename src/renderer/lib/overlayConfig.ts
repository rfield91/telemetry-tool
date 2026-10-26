import type { KeyValueStack } from "../components/KeyValue";

export interface BaseOverlayConfig {
  id: string;
  label: string;
  accent: string;
  /** Center position as fraction of frame width/height (0..1). */
  x: number;
  y: number;
  /** Diameter as fraction of frame height (0..1). */
  size: number;
}

export interface GaugeConfig extends BaseOverlayConfig {
  type: "gauge";
  valueColumn: string;
  unit: string;
  min: number;
  max: number;
}

export interface BarConfig extends BaseOverlayConfig {
  type: "bar";
  valueColumn: string;
  min: number;
  max: number;
}

export interface KeyValueEntry {
  id: string;
  valueColumn: string;
  label: string;
  unit: string;
  accent: string;
}

export interface KeyValueConfig extends BaseOverlayConfig {
  type: "key-value";
  stack: KeyValueStack;
  entries: KeyValueEntry[];
}

export interface TrackMapConfig extends BaseOverlayConfig {
  type: "track-map";
  latitudeColumn: string;
  longitudeColumn: string;
}

export interface GMeterConfig extends BaseOverlayConfig {
  type: "g-meter";
  lateralColumn: string;
  longitudinalColumn: string;
  /** Plot range is ±maxG on both axes. */
  maxG: number;
}

export type OverlayConfig =
  | GaugeConfig
  | BarConfig
  | KeyValueConfig
  | TrackMapConfig
  | GMeterConfig;

export type ValueOverlayConfig = GaugeConfig | BarConfig;

import type { CsvFormatId } from "../lib/csvFormats";
import {
  getDefaultPreset as pickDefaultPreset,
  isOverlayPreset,
  type OverlayPreset,
} from "../lib/overlayPresets";
import aimDefault from "./aim-default.json";
import genericDefault from "./generic-default.json";

function asPreset(value: unknown, label: string): OverlayPreset {
  if (!isOverlayPreset(value)) {
    throw new Error(`Invalid overlay preset: ${label}`);
  }
  return value;
}

/** Bundled presets shipped with the app. */
export const OVERLAY_PRESETS: readonly OverlayPreset[] = [
  asPreset(aimDefault, "aim-default.json"),
  asPreset(genericDefault, "generic-default.json"),
];

export function getDefaultPreset(
  formatId: CsvFormatId,
): OverlayPreset | undefined {
  return pickDefaultPreset(OVERLAY_PRESETS, formatId);
}

export function getPresetById(id: string): OverlayPreset | undefined {
  return OVERLAY_PRESETS.find((preset) => preset.id === id);
}

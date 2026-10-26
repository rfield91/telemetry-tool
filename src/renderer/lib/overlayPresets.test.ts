import { describe, expect, it } from "vitest";
import {
  applyOverlayPreset,
  PRIMARY_VALUE_COLUMN,
  serializeOverlayPreset,
  type OverlayPreset,
} from "./overlayPresets";
import type { ParsedCsv } from "./telemetry";

function makeCsv(headers: string[], rows: string[][]): ParsedCsv {
  return {
    fileName: "test.csv",
    headers,
    rows: rows.map((values) => {
      const row: Record<string, string> = {};
      headers.forEach((header, index) => {
        row[header] = values[index]!;
      });
      return row;
    }),
    errors: [],
    metadata: {},
    units: { "GPS Speed": "mph", "ECU TPS": "%" },
  };
}

const aimPreset: OverlayPreset = {
  version: 1,
  id: "aim-test",
  name: "AiM Test",
  csvFormat: "aim",
  defaultForFormat: true,
  overlays: [
    {
      type: "gauge",
      valueColumn: "GPS Speed",
      label: "SPEED",
      unit: "mph",
      min: 0,
      max: 100,
      accent: "#2dd4bf",
      x: 0.2,
      y: 0.8,
      size: 0.4,
    },
    {
      type: "bar",
      valueColumn: "ECU TPS",
      label: "TPS",
      min: 0,
      max: 100,
      accent: "#22c55e",
      x: 0.35,
      y: 0.8,
      size: 0.3,
    },
    {
      type: "track-map",
      latitudeColumn: "GPS Latitude",
      longitudeColumn: "GPS Longitude",
      label: "TRACK",
      accent: "#38bdf8",
      x: 0.8,
      y: 0.3,
      size: 0.4,
    },
  ],
};

describe("applyOverlayPreset", () => {
  it("materializes matching overlays and assigns runtime ids", () => {
    const parsed = makeCsv(
      ["Time", "GPS Speed", "ECU TPS", "GPS Latitude", "GPS Longitude"],
      [
        ["0", "10", "20", "41.9", "-71.8"],
        ["1", "40", "80", "41.91", "-71.81"],
      ],
    );
    const overlays = applyOverlayPreset(aimPreset, {
      parsed,
      timestampColumn: "Time",
      timestampUnit: "seconds",
      formatId: "aim",
    });
    expect(overlays).toHaveLength(3);
    expect(overlays.every((overlay) => typeof overlay.id === "string")).toBe(
      true,
    );
    expect(overlays[0]).toMatchObject({
      type: "gauge",
      valueColumn: "GPS Speed",
      label: "SPEED",
      x: 0.2,
      y: 0.8,
    });
    expect(overlays[1]).toMatchObject({
      type: "bar",
      valueColumn: "ECU TPS",
    });
    expect(overlays[2]).toMatchObject({ type: "track-map" });
  });

  it("skips overlays whose columns are missing", () => {
    const parsed = makeCsv(
      ["Time", "GPS Speed"],
      [
        ["0", "10"],
        ["1", "40"],
      ],
    );
    const overlays = applyOverlayPreset(aimPreset, {
      parsed,
      timestampColumn: "Time",
      timestampUnit: "seconds",
      formatId: "aim",
    });
    expect(overlays).toHaveLength(1);
    expect(overlays[0]?.type).toBe("gauge");
  });

  it("resolves $primary to the first usable numeric column", () => {
    const parsed = makeCsv(
      ["Time", "RPM", "Temp"],
      [
        ["0", "1000", "180"],
        ["1", "2000", "190"],
      ],
    );
    const preset: OverlayPreset = {
      version: 1,
      id: "generic-test",
      name: "Generic",
      csvFormat: "generic",
      overlays: [
        {
          type: "gauge",
          valueColumn: PRIMARY_VALUE_COLUMN,
          label: "VALUE",
          unit: "",
          min: 0,
          max: 100,
          accent: "#2dd4bf",
          x: 0.5,
          y: 0.5,
          size: 0.55,
        },
      ],
    };
    const overlays = applyOverlayPreset(preset, {
      parsed,
      timestampColumn: "Time",
      timestampUnit: "seconds",
      formatId: "generic",
    });
    expect(overlays).toHaveLength(1);
    expect(overlays[0]).toMatchObject({
      type: "gauge",
      valueColumn: "RPM",
      label: "RPM",
    });
  });
});

describe("serializeOverlayPreset", () => {
  it("strips runtime ids for a save-ready shape", () => {
    const parsed = makeCsv(
      ["Time", "GPS Speed", "ECU TPS", "GPS Latitude", "GPS Longitude"],
      [
        ["0", "10", "20", "41.9", "-71.8"],
        ["1", "40", "80", "41.91", "-71.81"],
      ],
    );
    const overlays = applyOverlayPreset(aimPreset, {
      parsed,
      timestampColumn: "Time",
      timestampUnit: "seconds",
      formatId: "aim",
    });
    const serialized = serializeOverlayPreset(
      {
        id: "saved",
        name: "Saved",
        csvFormat: "aim",
        defaultForFormat: false,
      },
      overlays,
    );
    expect(serialized.version).toBe(1);
    expect(serialized.overlays).toHaveLength(3);
    for (const item of serialized.overlays) {
      expect(item).not.toHaveProperty("id");
    }
  });
});

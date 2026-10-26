import { useId, useMemo } from "react";
import type { GpsPoint } from "../lib/telemetry";
import {
  buildTrailPath,
  pointsToPath,
  projectGpsTrack,
  sampleGpsPoints,
  trackIndexAt,
} from "../lib/trackMap";

export interface TrackMapProps {
  points: GpsPoint[];
  time: number;
  label?: string;
  accent?: string;
  className?: string;
}

const VIEW = 320;

export function TrackMap({
  points,
  time,
  label = "Track",
  accent = "#2dd4bf",
  className = "",
}: TrackMapProps) {
  const gradientId = useId().replace(/:/g, "");

  // Project the full track once; only marker/trail depend on time.
  const { projected, fullPath } = useMemo(() => {
    const { projected: nextProjected } = projectGpsTrack(points, VIEW, VIEW);
    return {
      projected: nextProjected,
      fullPath: pointsToPath(nextProjected),
    };
  }, [points]);

  const { trailPath, marker } = useMemo(() => {
    if (projected.length === 0) {
      return { trailPath: "", marker: null };
    }

    const index = trackIndexAt(points, time);
    let markerPoint = projected[index]!;

    if (index >= 0 && index < points.length - 1 && time > points[index]!.time) {
      const before = points[index]!;
      const after = points[index + 1]!;
      const beforePt = projected[index]!;
      const afterPt = projected[index + 1]!;
      const progress =
        after.time === before.time
          ? 0
          : (time - before.time) / (after.time - before.time);
      markerPoint = {
        x: beforePt.x + (afterPt.x - beforePt.x) * progress,
        y: beforePt.y + (afterPt.y - beforePt.y) * progress,
      };
    }

    const trail = buildTrailPath(
      projected,
      index,
      markerPoint !== projected[index] ? markerPoint : null,
    );

    return { trailPath: trail, marker: markerPoint };
  }, [points, projected, time]);

  const position = sampleGpsPoints(points, time);

  return (
    <div
      className={`relative aspect-square w-full drop-shadow-[0_18px_32px_rgba(0,0,0,0.35)] ${className}`}
      role="img"
      aria-label={
        position
          ? `${label}: ${position.lat.toFixed(5)}, ${position.lon.toFixed(5)}`
          : label
      }
    >
      <svg
        viewBox={`0 0 ${VIEW} ${VIEW}`}
        className="h-full w-full overflow-visible"
        aria-hidden="true"
      >
        <defs>
          <radialGradient id={gradientId} cx="50%" cy="42%" r="62%">
            <stop offset="0%" stopColor="#172231" stopOpacity="0.96" />
            <stop offset="72%" stopColor="#0a111c" stopOpacity="0.96" />
            <stop offset="100%" stopColor="#05080e" stopOpacity="0.98" />
          </radialGradient>
          <filter
            id={`${gradientId}-glow`}
            x="-50%"
            y="-50%"
            width="200%"
            height="200%"
          >
            <feGaussianBlur stdDeviation="3" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {fullPath && (
          <path
            d={fullPath}
            fill="none"
            stroke="#3d4f66"
            strokeWidth="3.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity="0.85"
          />
        )}
        {trailPath && (
          <path
            d={trailPath}
            fill="none"
            stroke={accent}
            strokeWidth="3.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            filter={`url(#${gradientId}-glow)`}
          />
        )}
        {marker && (
          <>
            <circle
              cx={marker.x}
              cy={marker.y}
              r="10"
              fill={accent}
              opacity="0.25"
              filter={`url(#${gradientId}-glow)`}
            />
            <circle
              cx={marker.x}
              cy={marker.y}
              r="5.5"
              fill="#f8fafc"
              stroke={accent}
              strokeWidth="3"
            />
          </>
        )}
      </svg>
    </div>
  );
}

export default TrackMap;

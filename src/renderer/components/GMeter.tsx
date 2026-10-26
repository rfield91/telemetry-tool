import { useId } from "react";
import { formatGValue, gMeterFraction } from "../lib/gMeter";

export interface GMeterProps {
  /** Lateral acceleration in g (X axis; positive → right). */
  lateral: number;
  /** Longitudinal acceleration in g (Y axis; positive → up / accel). */
  longitudinal: number;
  /** Plot range is ±maxG on both axes. */
  maxG: number;
  label?: string;
  accent?: string;
  className?: string;
}

const FACE = 160;
/** Plot center sits above face center to leave room for readouts. */
const PLOT_CX = 160;
const PLOT_CY = 142;
const PLOT_RADIUS = 98;
const RING_STEP = 0.5;

export function GMeter({
  lateral,
  longitudinal,
  maxG,
  label = "G",
  accent = "#2dd4bf",
  className = "",
}: GMeterProps) {
  const gradientId = useId().replace(/:/g, "");
  const safeMax = Number.isFinite(maxG) && maxG > 0 ? maxG : 2;
  const fx = gMeterFraction(lateral, safeMax);
  const fy = gMeterFraction(longitudinal, safeMax);
  // SVG Y grows downward; invert so positive longitudinal is up.
  const dotX = PLOT_CX - PLOT_RADIUS + fx * 2 * PLOT_RADIUS;
  const dotY = PLOT_CY + PLOT_RADIUS - fy * 2 * PLOT_RADIUS;

  const ringCount = Math.max(1, Math.floor(safeMax / RING_STEP));

  return (
    <div
      className={`relative aspect-square w-full ${className}`}
      role="img"
      aria-label={`${label}: lateral ${formatGValue(lateral)} g, longitudinal ${formatGValue(longitudinal)} g`}
    >
      <svg
        viewBox="0 0 320 320"
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
            <feGaussianBlur stdDeviation="2.5" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <clipPath id={`${gradientId}-plot`}>
            <circle cx={PLOT_CX} cy={PLOT_CY} r={PLOT_RADIUS} />
          </clipPath>
        </defs>

        <circle
          cx={FACE}
          cy={FACE}
          r="145"
          fill={`url(#${gradientId})`}
          stroke="#273447"
          strokeWidth="2"
        />
        <circle
          cx={FACE}
          cy={FACE}
          r="137"
          fill="none"
          stroke="#ffffff"
          strokeOpacity="0.05"
        />

        <text
          x={FACE}
          y="36"
          textAnchor="middle"
          fill="#94a3b8"
          fontSize="12"
          fontWeight="700"
          letterSpacing="3"
        >
          {label.toUpperCase()}
        </text>

        <g clipPath={`url(#${gradientId}-plot)`}>
          {Array.from({ length: ringCount }, (_, index) => {
            const g = (index + 1) * RING_STEP;
            if (g > safeMax + 1e-6) return null;
            const radius = (g / safeMax) * PLOT_RADIUS;
            const major = Math.abs(g - Math.round(g)) < 1e-6;
            return (
              <circle
                key={g}
                cx={PLOT_CX}
                cy={PLOT_CY}
                r={radius}
                fill="none"
                stroke={major ? "#4a5d75" : "#334155"}
                strokeWidth={major ? 1.5 : 1}
                strokeOpacity={major ? 0.9 : 0.55}
              />
            );
          })}

          <line
            x1={PLOT_CX - PLOT_RADIUS}
            y1={PLOT_CY}
            x2={PLOT_CX + PLOT_RADIUS}
            y2={PLOT_CY}
            stroke="#64748b"
            strokeWidth="1.5"
            strokeOpacity="0.7"
          />
          <line
            x1={PLOT_CX}
            y1={PLOT_CY - PLOT_RADIUS}
            x2={PLOT_CX}
            y2={PLOT_CY + PLOT_RADIUS}
            stroke="#64748b"
            strokeWidth="1.5"
            strokeOpacity="0.7"
          />

          <circle
            cx={dotX}
            cy={dotY}
            r="14"
            fill={accent}
            opacity="0.22"
            filter={`url(#${gradientId}-glow)`}
          />
          <circle
            cx={dotX}
            cy={dotY}
            r="7"
            fill="#f8fafc"
            stroke={accent}
            strokeWidth="3"
            filter={`url(#${gradientId}-glow)`}
          />
        </g>

        <circle
          cx={PLOT_CX}
          cy={PLOT_CY}
          r={PLOT_RADIUS}
          fill="none"
          stroke="#3d4f66"
          strokeWidth="2"
        />

        <text
          x={PLOT_CX + PLOT_RADIUS - 4}
          y={PLOT_CY - 6}
          textAnchor="end"
          fill="#718096"
          fontSize="11"
          fontWeight="600"
        >
          {formatGValue(safeMax)}
        </text>
        <text
          x={PLOT_CX - PLOT_RADIUS + 4}
          y={PLOT_CY - 6}
          textAnchor="start"
          fill="#718096"
          fontSize="11"
          fontWeight="600"
        >
          {formatGValue(-safeMax)}
        </text>
        <text
          x={PLOT_CX + 6}
          y={PLOT_CY - PLOT_RADIUS + 14}
          textAnchor="start"
          fill="#718096"
          fontSize="11"
          fontWeight="600"
        >
          {formatGValue(safeMax)}
        </text>
        <text
          x={PLOT_CX + 6}
          y={PLOT_CY + PLOT_RADIUS - 4}
          textAnchor="start"
          fill="#718096"
          fontSize="11"
          fontWeight="600"
        >
          {formatGValue(-safeMax)}
        </text>

        <text
          x="88"
          y="268"
          textAnchor="middle"
          fill="#94a3b8"
          fontSize="11"
          fontWeight="700"
          letterSpacing="2"
        >
          LAT
        </text>
        <text
          x="88"
          y="290"
          textAnchor="middle"
          fill="#f8fafc"
          fontSize="22"
          fontWeight="750"
          letterSpacing="-0.5"
        >
          {formatGValue(lateral)}
        </text>
        <text
          x="232"
          y="268"
          textAnchor="middle"
          fill="#94a3b8"
          fontSize="11"
          fontWeight="700"
          letterSpacing="2"
        >
          LON
        </text>
        <text
          x="232"
          y="290"
          textAnchor="middle"
          fill="#f8fafc"
          fontSize="22"
          fontWeight="750"
          letterSpacing="-0.5"
        >
          {formatGValue(longitudinal)}
        </text>
        <text
          x={FACE}
          y="290"
          textAnchor="middle"
          fill={accent}
          fontSize="12"
          fontWeight="700"
          letterSpacing="1"
        >
          G
        </text>
      </svg>
    </div>
  );
}

export default GMeter;

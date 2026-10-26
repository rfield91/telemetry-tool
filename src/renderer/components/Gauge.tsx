import { useId } from "react";
import { formatGaugeValue, gaugeFraction } from "../lib/gauge";

export interface GaugeProps {
  value: number;
  min: number;
  max: number;
  label: string;
  unit?: string;
  accent?: string;
  className?: string;
}

const START_ANGLE = 150;
const SWEEP_ANGLE = 240;
const CENTER = 160;
const RADIUS = 119;

function polarPoint(angle: number, radius: number) {
  const radians = (angle * Math.PI) / 180;
  return {
    x: CENTER + radius * Math.cos(radians),
    y: CENTER + radius * Math.sin(radians),
  };
}

function arcPath(startAngle: number, endAngle: number, radius: number) {
  const start = polarPoint(startAngle, radius);
  const end = polarPoint(endAngle, radius);
  const sweep = Math.max(0, endAngle - startAngle);
  return `M ${start.x} ${start.y} A ${radius} ${radius} 0 ${
    sweep > 180 ? 1 : 0
  } 1 ${end.x} ${end.y}`;
}

export function Gauge({
  value,
  min,
  max,
  label,
  unit = "",
  accent = "#2dd4bf",
  className = "",
}: GaugeProps) {
  const fraction = gaugeFraction(value, min, max);
  const valueAngle = START_ANGLE + fraction * SWEEP_ANGLE;
  const needle = polarPoint(valueAngle, 91);
  const gradientId = useId().replace(/:/g, "");

  return (
    <div
      className={`relative aspect-square w-full ${className}`}
      role="meter"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-valuetext={`${formatGaugeValue(value)} ${unit}`.trim()}
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
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        <circle
          cx={CENTER}
          cy={CENTER}
          r="145"
          fill={`url(#${gradientId})`}
          stroke="#273447"
          strokeWidth="2"
        />
        <circle
          cx={CENTER}
          cy={CENTER}
          r="137"
          fill="none"
          stroke="#ffffff"
          strokeOpacity="0.05"
        />

        <path
          d={arcPath(START_ANGLE, START_ANGLE + SWEEP_ANGLE, RADIUS)}
          fill="none"
          stroke="#263243"
          strokeWidth="10"
          strokeLinecap="round"
        />
        {fraction > 0 && (
          <path
            d={arcPath(START_ANGLE, valueAngle, RADIUS)}
            fill="none"
            stroke={accent}
            strokeWidth="10"
            strokeLinecap="round"
            filter={`url(#${gradientId}-glow)`}
          />
        )}

        {Array.from({ length: 41 }, (_, index) => {
          const angle = START_ANGLE + (SWEEP_ANGLE * index) / 40;
          const major = index % 5 === 0;
          const outer = polarPoint(angle, 106);
          const inner = polarPoint(angle, major ? 96 : 101);
          return (
            <line
              key={angle}
              x1={inner.x}
              y1={inner.y}
              x2={outer.x}
              y2={outer.y}
              stroke={major ? "#dbe7f5" : "#7a899c"}
              strokeOpacity={major ? 0.75 : 0.38}
              strokeWidth={major ? 2 : 1}
              strokeLinecap="round"
            />
          );
        })}

        <line
          x1={CENTER}
          y1={CENTER}
          x2={needle.x}
          y2={needle.y}
          stroke="#f8fafc"
          strokeWidth="4"
          strokeLinecap="round"
        />
        <circle
          cx={CENTER}
          cy={CENTER}
          r="11"
          fill="#0a111c"
          stroke={accent}
          strokeWidth="4"
        />

        <text
          x={CENTER}
          y="105"
          textAnchor="middle"
          fill="#94a3b8"
          fontSize="13"
          fontWeight="700"
          letterSpacing="3"
        >
          {label.toUpperCase()}
        </text>
        <text
          x={CENTER}
          y="232"
          textAnchor="middle"
          fill="#f8fafc"
          fontSize="42"
          fontWeight="750"
          letterSpacing="-1"
        >
          {formatGaugeValue(value)}
        </text>
        <text
          x={CENTER}
          y="254"
          textAnchor="middle"
          fill={accent}
          fontSize="13"
          fontWeight="700"
          letterSpacing="2"
        >
          {unit.toUpperCase()}
        </text>
        <text x="80" y="230" textAnchor="middle" fill="#718096" fontSize="14">
          {formatGaugeValue(min)}
        </text>
        <text x="230" y="230" textAnchor="middle" fill="#718096" fontSize="14">
          {formatGaugeValue(max)}
        </text>
      </svg>
    </div>
  );
}

export default Gauge;

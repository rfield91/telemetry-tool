import { formatGaugeValue, gaugeFraction } from "../lib/gauge";

export interface BarProps {
  value: number;
  min: number;
  max: number;
  label: string;
  accent?: string;
  className?: string;
}

const VIEW_W = 120;
const VIEW_H = 320;
const TRACK_X = 34;
const TRACK_Y = 18;
const TRACK_W = 52;
const TRACK_H = 230;
const TRACK_RX = 14;

export function Bar({
  value,
  min,
  max,
  label,
  accent = "#22c55e",
  className = "",
}: BarProps) {
  const fraction = gaugeFraction(value, min, max);
  const fillHeight = TRACK_H * fraction;
  const fillY = TRACK_Y + TRACK_H - fillHeight;

  return (
    <div
      className={`relative h-full w-full ${className}`}
      role="meter"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-valuetext={formatGaugeValue(value)}
    >
      <svg
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        className="h-full w-full overflow-visible"
        aria-hidden="true"
      >
        <rect
          x={TRACK_X}
          y={TRACK_Y}
          width={TRACK_W}
          height={TRACK_H}
          rx={TRACK_RX}
          fill="#0a111c"
          fillOpacity="0.92"
          stroke="#273447"
          strokeWidth="2"
        />
        {fraction > 0 && (
          <rect
            x={TRACK_X + 3}
            y={fillY + 3}
            width={TRACK_W - 6}
            height={Math.max(0, fillHeight - 6)}
            rx={TRACK_RX - 4}
            fill={accent}
          />
        )}
        <text
          x={VIEW_W / 2}
          y={268}
          textAnchor="middle"
          fill="#f8fafc"
          fontSize="22"
          fontWeight="750"
        >
          {formatGaugeValue(value)}
        </text>
        <text
          x={VIEW_W / 2}
          y={292}
          textAnchor="middle"
          fill={accent}
          fontSize="12"
          fontWeight="700"
          letterSpacing="2"
        >
          {label.toUpperCase()}
        </text>
      </svg>
    </div>
  );
}

export default Bar;

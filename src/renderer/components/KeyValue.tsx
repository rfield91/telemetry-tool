import { formatGaugeValue } from "../lib/gauge";

export type KeyValueStack = "vertical" | "horizontal";

export interface KeyValueItem {
  id?: string;
  value: number;
  label: string;
  unit?: string;
  accent?: string;
}

export interface KeyValueProps {
  items: KeyValueItem[];
  stack?: KeyValueStack;
  className?: string;
}

/** Reference width for vertical plate / size scaling unit. */
export const KEY_VALUE_VIEW_W = 280;
const PAD = 18;
const ROW_H = 86;
const COL_W = 200;

export function keyValueViewBox(
  itemCount: number,
  stack: KeyValueStack = "vertical",
) {
  const count = Math.max(1, itemCount);
  if (stack === "horizontal") {
    return {
      width: PAD * 2 + count * COL_W,
      height: PAD * 2 + ROW_H,
    };
  }
  return {
    width: KEY_VALUE_VIEW_W,
    height: PAD * 2 + count * ROW_H,
  };
}

export function keyValueFrameSize(
  itemCount: number,
  stack: KeyValueStack,
  sizeFraction: number,
  frameHeight: number,
) {
  const sizePx = Math.round(sizeFraction * frameHeight);
  const box = keyValueViewBox(itemCount, stack);
  const pxPerUnit = sizePx / KEY_VALUE_VIEW_W;
  return {
    width: Math.round(box.width * pxPerUnit),
    height: Math.round(box.height * pxPerUnit),
  };
}

function renderEntry(
  item: KeyValueItem,
  centerX: number,
  rowTop: number,
) {
  const accent = item.accent ?? "#2dd4bf";
  const valueY = rowTop + 42;
  const labelY = rowTop + 72;
  const unit = item.unit ?? "";
  return (
    <>
      <text
        x={centerX}
        y={valueY}
        textAnchor="middle"
        fill="#f8fafc"
        fontSize="40"
        fontWeight="750"
        letterSpacing="-1"
      >
        {formatGaugeValue(item.value)}
        {unit ? (
          <tspan
            fill={accent}
            fontSize="16"
            fontWeight="700"
            letterSpacing="1"
            dx="6"
            dy="-14"
          >
            {unit.toUpperCase()}
          </tspan>
        ) : null}
      </text>
      <text
        x={centerX}
        y={labelY}
        textAnchor="middle"
        fill="#94a3b8"
        fontSize="13"
        fontWeight="700"
        letterSpacing="3"
      >
        {item.label.toUpperCase()}
      </text>
    </>
  );
}

export function KeyValue({
  items,
  stack = "vertical",
  className = "",
}: KeyValueProps) {
  const box = keyValueViewBox(items.length, stack);
  const rows = items.length > 0 ? items : [{ value: 0, label: "—" }];

  return (
    <div
      className={`relative h-full w-full ${className}`}
      role="group"
      aria-label={
        rows.length === 1
          ? rows[0]!.label
          : `Values: ${rows.map((row) => row.label).join(", ")}`
      }
    >
      <svg
        viewBox={`0 0 ${box.width} ${box.height}`}
        className="h-full w-full overflow-visible"
        aria-hidden="true"
      >
        <rect
          x="4"
          y="4"
          width={box.width - 8}
          height={box.height - 8}
          rx="22"
          fill="#0a111c"
          fillOpacity="0.92"
          stroke="#273447"
          strokeWidth="2"
        />
        {rows.map((item, index) => {
          if (stack === "horizontal") {
            const colLeft = PAD + index * COL_W;
            const centerX = colLeft + COL_W / 2;
            return (
              <g key={item.id ?? `${item.label}-${index}`}>
                {index > 0 && (
                  <line
                    x1={colLeft}
                    x2={colLeft}
                    y1={PAD + 8}
                    y2={box.height - PAD - 8}
                    stroke="#273447"
                    strokeWidth="1.5"
                    strokeOpacity="0.9"
                  />
                )}
                {renderEntry(item, centerX, PAD)}
              </g>
            );
          }

          const rowTop = PAD + index * ROW_H;
          return (
            <g key={item.id ?? `${item.label}-${index}`}>
              {index > 0 && (
                <line
                  x1="28"
                  x2={box.width - 28}
                  y1={rowTop}
                  y2={rowTop}
                  stroke="#273447"
                  strokeWidth="1.5"
                  strokeOpacity="0.9"
                />
              )}
              {renderEntry(item, box.width / 2, rowTop)}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export default KeyValue;

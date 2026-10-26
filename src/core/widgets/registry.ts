import { barWidget } from './bar'
import { gaugeWidget } from './gauge'
import { gMeterWidget } from './gMeter'
import { readoutWidget } from './readout'
import { trackMapWidget } from './trackMap'
import type { AnyWidgetDefinition } from './types'

export const WIDGETS: Record<string, AnyWidgetDefinition> = Object.fromEntries(
  [gaugeWidget, barWidget, readoutWidget, trackMapWidget, gMeterWidget].map((widget) => [widget.type, widget]),
)

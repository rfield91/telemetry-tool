import { barWidget } from './bar'
import { deltaWidget } from './delta'
import { gaugeWidget } from './gauge'
import { gMeterWidget } from './gMeter'
import { lapTimerWidget } from './lapTimer'
import { readoutWidget } from './readout'
import { trackMapWidget } from './trackMap'
import type { AnyWidgetDefinition } from './types'

/** Widget types, in the order the Add menu lists them. */
export const WIDGETS: Record<string, AnyWidgetDefinition> = Object.fromEntries(
  [gaugeWidget, barWidget, readoutWidget, lapTimerWidget, deltaWidget, trackMapWidget, gMeterWidget].map((widget) => [widget.type, widget]),
)

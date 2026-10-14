import type { MetricExpression } from './configuration'

export type PerformanceBucket = 'day' | 'week' | 'month'

export type PerformanceEvent = {
  contractVersion: number
  eventType: string
  occurredAt: string
  productId: string
  locationId?: string
  orgUnitId?: string
  location?: { latitude: number; longitude: number }
  fields: Record<string, unknown>
}

export type PerformanceMetric = {
  id: string
  contractVersion: number
  name: string
  unit: string
  direction: 'higher' | 'lower'
  eventType: string
  formula: MetricExpression
  aggregation?: 'sum' | 'average' | 'min' | 'max' | 'count'
}

export type PerformanceReport = {
  metric: {
    id: string
    contractVersion?: number
    name: string
    unit: string
    direction: 'higher' | 'lower'
    aggregation?: string
  }
  range: { from: string; to: string; bucket: PerformanceBucket }
  filters: { productId?: string; locationId?: string; orgUnitIds?: string[] }
  summary: { value: number | null; matchedEvents: number; calculatedEvents: number; excludedEvents: number }
  timeSeries: Array<{ period: string; value: number; events: number }>
  products: Array<{ productId: string; value: number; events: number }>
  reportingLocations: Array<{ locationId: string; value: number; events: number }>
  senderLocationCells: Array<{
    id: string
    latitude: number
    longitude: number
    value: number
    events: number
  }>
  suppressedSenderLocationCellCount: number
  calculation?: {
    kind: 'metric-operation' | 'percentage-of-reference'
    operator?: 'add' | 'subtract' | 'multiply' | 'divide'
    referenceMetricId?: string
    referenceProductId?: string
    zeroReferencePeriods?: number
    missingReferencePeriods?: number
    zeroReferenceTotal?: boolean
  }
}

type AggregateState = { count: number; sum: number; min: number; max: number }
type Aggregate = { value: number; events: number }
type LocationCell = { id: string; latitude: number; longitude: number; state: AggregateState }

const locationCellSize = 0.05
const minimumLocationEvents = 5

export function createPerformanceCalculator(
  metric: PerformanceMetric,
  options: {
    from: string
    to: string
    bucket: PerformanceBucket
    productId?: string
    locationId?: string
    orgUnitIds?: string[]
  },
) {
  const timeSeries = new Map<string, AggregateState>()
  const products = new Map<string, AggregateState>()
  const reportingLocations = new Map<string, AggregateState>()
  const senderLocations = new Map<string, LocationCell>()
  let matchedEvents = 0
  let calculatedEvents = 0
  let excludedEvents = 0

  function addEvent(event: PerformanceEvent): void {
    if (event.contractVersion !== metric.contractVersion ||
      event.eventType !== metric.eventType ||
      options.productId && event.productId !== options.productId ||
      options.locationId && event.locationId !== options.locationId) return
    if (options.orgUnitIds && (!event.orgUnitId || !options.orgUnitIds.includes(event.orgUnitId))) return

    matchedEvents += 1
    const value = evaluateExpression(metric.formula, event.fields)
    if (value === undefined || !Number.isFinite(value)) {
      excludedEvents += 1
      return
    }

    calculatedEvents += 1
    add(timeSeries, bucketDate(event.occurredAt, options.bucket), value)
    add(products, event.productId, value)
    if (event.locationId) add(reportingLocations, event.locationId, value)
    if (event.location) addSenderLocation(senderLocations, event.location, value)
  }

  function report() {
    const visibleSenderLocations = [...senderLocations.entries()]
      .filter(([, cell]) => cell.state.count >= minimumLocationEvents)
      .map(([, cell]) => toLocationCell(cell, metric.aggregation))
      .sort((left, right) => left.id.localeCompare(right.id))

    return {
      metric: {
        id: metric.id,
        contractVersion: metric.contractVersion,
        name: metric.name,
        unit: metric.unit,
        direction: metric.direction,
        aggregation: metric.aggregation ?? 'sum',
      },
      range: { from: options.from, to: options.to, bucket: options.bucket },
      filters: { productId: options.productId, locationId: options.locationId, orgUnitIds: options.orgUnitIds },
      summary: {
        value: aggregateValue(calculatedEvents ? {
          count: calculatedEvents,
          sum: [...timeSeries.values()].reduce((sum, group) => sum + group.sum, 0),
          min: Math.min(...[...timeSeries.values()].map((group) => group.min)),
          max: Math.max(...[...timeSeries.values()].map((group) => group.max)),
        } : undefined, metric.aggregation) ?? null,
        matchedEvents,
        calculatedEvents,
        excludedEvents,
      },
      timeSeries: [...timeSeries.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([period, state]) => ({ period, ...toAggregate(state, metric.aggregation) })),
      products: [...products.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([productId, state]) => ({ productId, ...toAggregate(state, metric.aggregation) })),
      reportingLocations: [...reportingLocations.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([locationId, state]) => ({ locationId, ...toAggregate(state, metric.aggregation) })),
      senderLocationCells: visibleSenderLocations,
      suppressedSenderLocationCellCount: senderLocations.size - visibleSenderLocations.length,
    }
  }

  return { addEvent, report }
}

export function calculatePerformance(
  events: PerformanceEvent[],
  metric: PerformanceMetric,
  options: {
    from: string
    to: string
    bucket: PerformanceBucket
    productId?: string
    locationId?: string
    orgUnitIds?: string[]
  },
) {
  const calculator = createPerformanceCalculator(metric, options)
  for (const event of events) calculator.addEvent(event)
  return calculator.report()
}

export function combinePerformanceReports(
  left: PerformanceReport,
  right: PerformanceReport,
  operator: 'add' | 'subtract' | 'multiply' | 'divide',
  metric: { id: string; name: string; unit: string; direction: 'higher' | 'lower' },
): PerformanceReport {
  const rightPeriods = new Map(right.timeSeries.map((period) => [period.period, period]))
  const timeSeries = left.timeSeries.flatMap((period) => {
    const other = rightPeriods.get(period.period)
    const value = other ? applyOperation(operator, period.value, other.value) : undefined
    return value === undefined
      ? []
      : [{ period: period.period, value, events: 1 }]
  })
  const summaryValue = left.summary.value !== null && right.summary.value !== null
    ? applyOperation(operator, left.summary.value, right.summary.value)
    : undefined
  const matchedPeriods = new Set([
    ...left.timeSeries.map((period) => period.period),
    ...right.timeSeries.map((period) => period.period),
  ]).size

  return {
    metric: { ...metric },
    range: left.range,
    filters: { locationId: left.filters.locationId, orgUnitIds: left.filters.orgUnitIds },
    summary: {
      value: summaryValue ?? null,
      matchedEvents: matchedPeriods,
      calculatedEvents: timeSeries.length,
      excludedEvents: matchedPeriods - timeSeries.length,
    },
    timeSeries,
    products: [],
    reportingLocations: [],
    senderLocationCells: [],
    suppressedSenderLocationCellCount: 0,
    calculation: { kind: 'metric-operation', operator },
  }
}

export function percentageOfReference(
  numerator: PerformanceReport,
  denominator: PerformanceReport,
  referenceMetricId: string,
  referenceProductId: string,
): PerformanceReport {
  const denominatorPeriods = new Map(denominator.timeSeries.map((period) => [period.period, period]))
  let missingReferencePeriods = 0
  let zeroReferencePeriods = 0
  let comparableNumeratorTotal = 0
  let comparableReferenceTotal = 0
  const timeSeries = numerator.timeSeries.flatMap((period) => {
    const reference = denominatorPeriods.get(period.period)
    if (!reference) {
      missingReferencePeriods += 1
      return []
    }
    if (reference.value === 0) {
      zeroReferencePeriods += 1
      return []
    }
    const value = (period.value / reference.value) * 100
    if (!Number.isFinite(value)) throw new Error('Relative metric calculation exceeded the finite numeric range')
    comparableNumeratorTotal += period.value
    comparableReferenceTotal += reference.value
    if (!Number.isFinite(comparableNumeratorTotal) || !Number.isFinite(comparableReferenceTotal)) {
      throw new Error('Relative metric calculation exceeded the finite numeric range')
    }
    return [{ period: period.period, value, events: 1 }]
  })
  const hasComparablePeriods = timeSeries.length > 0
  const zeroReferenceTotal = hasComparablePeriods && comparableReferenceTotal === 0
  const summaryValue = !hasComparablePeriods || zeroReferenceTotal
    ? null
    : (comparableNumeratorTotal / comparableReferenceTotal) * 100
  if (summaryValue !== null && !Number.isFinite(summaryValue)) {
    throw new Error('Relative metric calculation exceeded the finite numeric range')
  }
  const matchedPeriods = new Set([
    ...numerator.timeSeries.map((period) => period.period),
    ...denominator.timeSeries.map((period) => period.period),
  ]).size

  return {
    metric: {
      id: numerator.metric.id,
      name: `${numerator.metric.name} as a share of ${denominator.metric.name}`,
      unit: '%',
      direction: 'higher',
      aggregation: 'ratio',
    },
    range: numerator.range,
    filters: { locationId: numerator.filters.locationId, orgUnitIds: numerator.filters.orgUnitIds },
    summary: {
      value: summaryValue,
      matchedEvents: matchedPeriods,
      calculatedEvents: timeSeries.length,
      excludedEvents: matchedPeriods - timeSeries.length,
    },
    timeSeries,
    products: [],
    reportingLocations: [],
    senderLocationCells: [],
    suppressedSenderLocationCellCount: 0,
    calculation: {
      kind: 'percentage-of-reference',
      referenceMetricId,
      referenceProductId,
      zeroReferencePeriods,
      missingReferencePeriods,
      zeroReferenceTotal,
    },
  }
}

function applyOperation(
  operator: 'add' | 'subtract' | 'multiply' | 'divide',
  left: number,
  right: number,
): number | undefined {
  let value: number
  switch (operator) {
    case 'add': value = left + right; break
    case 'subtract': value = left - right; break
    case 'multiply': value = left * right; break
    case 'divide':
      if (right === 0) return undefined
      value = left / right
      break
  }
  if (!Number.isFinite(value)) throw new Error('Calculated metric exceeded the finite numeric range')
  return value
}

export function evaluateExpression(
  expression: MetricExpression,
  fields: Record<string, unknown>,
): number | undefined {
  if (expression.type === 'constant') return expression.value
  if (expression.type === 'field') {
    const value = fields[expression.key]
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined
  }

  const left = evaluateExpression(expression.operands[0], fields)
  const right = evaluateExpression(expression.operands[1], fields)
  if (left === undefined || right === undefined) return undefined

  switch (expression.operator) {
    case 'add': return left + right
    case 'subtract': return left - right
    case 'multiply': return left * right
    case 'divide': return right === 0 ? undefined : left / right
  }
}

function bucketDate(value: string, bucket: PerformanceBucket): string {
  const date = new Date(value)
  if (bucket === 'month') return date.toISOString().slice(0, 7)
  if (bucket === 'week') {
    const day = date.getUTCDay() || 7
    date.setUTCDate(date.getUTCDate() - day + 1)
  }
  return date.toISOString().slice(0, 10)
}

function add(
  aggregates: Map<string, AggregateState>,
  key: string,
  value: number,
): void {
  const state = aggregates.get(key) ?? { count: 0, sum: 0, min: value, max: value }
  state.count += 1
  state.sum += value
  state.min = Math.min(state.min, value)
  state.max = Math.max(state.max, value)
  if (!Number.isFinite(state.sum)) throw new Error('Metric aggregation exceeded the finite numeric range')
  aggregates.set(key, state)
}

function addSenderLocation(
  aggregates: Map<string, LocationCell>,
  location: { latitude: number; longitude: number },
  value: number,
): void {
  const latitudeCell = Math.floor((location.latitude + 90) / locationCellSize)
  const longitudeCell = Math.floor((location.longitude + 180) / locationCellSize)
  const id = `${latitudeCell}:${longitudeCell}`
  const latitude = Math.min(90, latitudeCell * locationCellSize - 90 + locationCellSize / 2)
  const longitude = Math.min(180, longitudeCell * locationCellSize - 180 + locationCellSize / 2)
  const aggregate = aggregates.get(id) ?? {
    id,
    latitude,
    longitude,
    state: { count: 0, sum: 0, min: value, max: value },
  }
  aggregate.state.count += 1
  aggregate.state.sum += value
  aggregate.state.min = Math.min(aggregate.state.min, value)
  aggregate.state.max = Math.max(aggregate.state.max, value)
  if (!Number.isFinite(aggregate.state.sum)) {
    throw new Error('Metric aggregation exceeded the finite numeric range')
  }
  aggregates.set(id, aggregate)
}

function toAggregate(
  state: AggregateState,
  aggregation: PerformanceMetric['aggregation'],
): Aggregate {
  const value = aggregateValue(state, aggregation)
  if (value === undefined) throw new Error('Cannot aggregate an empty performance group')
  return { value, events: state.count }
}

function toLocationCell(
  cell: LocationCell,
  aggregation: PerformanceMetric['aggregation'],
) {
  return {
    id: cell.id,
    latitude: cell.latitude,
    longitude: cell.longitude,
    ...toAggregate(cell.state, aggregation),
  }
}

function aggregateValue(
  state: AggregateState | undefined,
  aggregation: PerformanceMetric['aggregation'],
): number | undefined {
  if (!state || state.count === 0) return undefined
  let result: number
  switch (aggregation ?? 'sum') {
    case 'sum': result = state.sum; break
    case 'average': result = state.sum / state.count; break
    case 'min': result = state.min; break
    case 'max': result = state.max; break
    case 'count': result = state.count; break
  }
  if (!Number.isFinite(result)) throw new Error('Metric aggregation exceeded the finite numeric range')
  return result
}

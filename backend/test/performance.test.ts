import assert from 'node:assert/strict'
import test from 'node:test'
import {
  calculatePerformance,
  combinePerformanceReports,
  percentageOfReference,
  type PerformanceEvent,
  type PerformanceMetric,
} from '../src/domain/performance'

const metric: PerformanceMetric = {
  id: '01234567-89ab-4cde-8fab-0123456789ab',
  contractVersion: 1,
  name: 'Net revenue',
  unit: 'KES',
  direction: 'higher',
  eventType: 'money_transfer',
  formula: {
    type: 'operation',
    operator: 'subtract',
    operands: [{ type: 'field', key: 'revenue' }, { type: 'field', key: 'cost' }],
  },
}

function makeEvent(
  eventId: number,
  values: Record<string, unknown>,
  extra: Partial<PerformanceEvent> = {},
): PerformanceEvent {
  return {
    contractVersion: 1,
    eventType: 'money_transfer',
    occurredAt: `2026-10-${String(eventId).padStart(2, '0')}T10:00:00.000Z`,
    productId: eventId % 2 === 0 ? 'product-a' : 'product-b',
    locationId: eventId % 2 === 0 ? 'location-a' : undefined,
    fields: values,
    ...extra,
  }
}

test('calculates formula results across time, products, and reporting locations', () => {
  const events = [
    makeEvent(12, { revenue: 100, cost: 20 }),
    makeEvent(13, { revenue: 80, cost: 30 }),
    makeEvent(14, { revenue: 50, cost: 10 }),
    makeEvent(15, { revenue: 40, cost: 5 }),
  ]
  const report = calculatePerformance(events, metric, {
    from: '2026-10-12',
    to: '2026-10-15',
    bucket: 'week',
  })

  assert.equal(report.summary.value, 205)
  assert.deepEqual(report.summary, {
    value: 205,
    matchedEvents: 4,
    calculatedEvents: 4,
    excludedEvents: 0,
  })
  assert.deepEqual(report.timeSeries, [{ period: '2026-10-12', value: 205, events: 4 }])
  assert.deepEqual(report.products, [
    { productId: 'product-a', value: 120, events: 2 },
    { productId: 'product-b', value: 85, events: 2 },
  ])
  assert.deepEqual(report.reportingLocations, [{ locationId: 'location-a', value: 120, events: 2 }])
})

test('uses configured metric aggregation and excludes missing or invalid formula values', () => {
  const events = [
    makeEvent(12, { revenue: 100, cost: 20 }),
    makeEvent(13, { revenue: 80 }),
    makeEvent(14, { revenue: 50, cost: 10 }),
    makeEvent(15, { revenue: 40, cost: 'invalid' }),
  ]
  const average = calculatePerformance(events, { ...metric, aggregation: 'average' }, {
    from: '2026-10-12',
    to: '2026-10-15',
    bucket: 'day',
  })

  assert.equal(average.summary.value, 60)
  assert.equal(average.summary.matchedEvents, 4)
  assert.equal(average.summary.calculatedEvents, 2)
  assert.equal(average.summary.excludedEvents, 2)
  assert.equal(average.timeSeries[0].value, 80)
})

test('supports minimum, maximum, and valid-event count aggregations', () => {
  const events = [
    makeEvent(12, { revenue: 100, cost: 20 }),
    makeEvent(13, { revenue: 80, cost: 30 }),
    makeEvent(14, { revenue: 50, cost: 10 }),
  ]
  const options = { from: '2026-10-12', to: '2026-10-14', bucket: 'day' as const }
  const minimum = calculatePerformance(events, { ...metric, aggregation: 'min' }, options)
  const maximum = calculatePerformance(events, { ...metric, aggregation: 'max' }, options)
  const count = calculatePerformance(events, { ...metric, aggregation: 'count' }, options)

  assert.equal(minimum.summary.value, 40)
  assert.equal(maximum.summary.value, 80)
  assert.equal(count.summary.value, 3)
})

test('filters by product and location without mixing other groups', () => {
  const events = [
    makeEvent(12, { revenue: 100, cost: 20 }),
    makeEvent(13, { revenue: 80, cost: 30 }),
  ]
  const report = calculatePerformance(events, metric, {
    from: '2026-10-12',
    to: '2026-10-13',
    bucket: 'day',
    productId: 'product-a',
    locationId: 'location-a',
  })

  assert.equal(report.summary.value, 80)
  assert.deepEqual(report.products, [{ productId: 'product-a', value: 80, events: 1 }])
})

test('limits performance aggregation to the selected organization subtree', () => {
  const events = [
    makeEvent(12, { revenue: 100, cost: 20 }, { orgUnitId: 'unit-a' }),
    makeEvent(13, { revenue: 80, cost: 30 }, { orgUnitId: 'unit-b' }),
    makeEvent(14, { revenue: 50, cost: 10 }, { orgUnitId: 'unit-outside' }),
    makeEvent(15, { revenue: 40, cost: 5 }),
  ]
  const report = calculatePerformance(events, metric, {
    from: '2026-10-12',
    to: '2026-10-15',
    bucket: 'day',
    orgUnitIds: ['unit-a', 'unit-b'],
  })
  assert.equal(report.summary.value, 130)
  assert.equal(report.summary.matchedEvents, 2)
})

test('does not apply a metric to events from a different contract version', () => {
  const events = [
    makeEvent(12, { revenue: 100, cost: 20 }),
    makeEvent(13, { revenue: 80, cost: 30 }, { contractVersion: 2 }),
  ]
  const report = calculatePerformance(events, metric, {
    from: '2026-10-12',
    to: '2026-10-13',
    bucket: 'day',
  })

  assert.equal(report.summary.value, 80)
  assert.equal(report.summary.matchedEvents, 1)
})

test('combines independently aggregated product metrics into a calculated metric', () => {
  const events = [
    makeEvent(12, { revenue: 100, cost: 20 }, { productId: 'product-a' }),
    makeEvent(12, { revenue: 30, cost: 0 }, { productId: 'product-b' }),
    makeEvent(13, { revenue: 80, cost: 10 }, { productId: 'product-a' }),
    makeEvent(13, { revenue: 0, cost: 0 }, { productId: 'product-b' }),
  ]
  const options = { from: '2026-10-12', to: '2026-10-13', bucket: 'day' as const }
  const revenue = calculatePerformance(events, metric, { ...options, productId: 'product-a' })
  const cost = calculatePerformance(events, metric, { ...options, productId: 'product-b' })
  const profit = combinePerformanceReports(
    revenue,
    cost,
    'subtract',
    { id: 'profit-id', name: 'Profit', unit: 'KES', direction: 'higher' },
  )

  assert.equal(profit.summary.value, 120)
  assert.deepEqual(profit.timeSeries, [
    { period: '2026-10-12', value: 50, events: 1 },
    { period: '2026-10-13', value: 70, events: 1 },
  ])
  assert.equal(profit.calculation?.kind, 'metric-operation')
})

test('calculates a percentage share and reports zero or missing reference periods explicitly', () => {
  const events = [
    makeEvent(12, { revenue: 50, cost: 0 }, { productId: 'product-a' }),
    makeEvent(12, { revenue: 200, cost: 0 }, { productId: 'product-b' }),
    makeEvent(13, { revenue: 25, cost: 0 }, { productId: 'product-a' }),
    makeEvent(13, { revenue: 0, cost: 0 }, { productId: 'product-b' }),
    makeEvent(14, { revenue: 10, cost: 0 }, { productId: 'product-a' }),
  ]
  const options = { from: '2026-10-12', to: '2026-10-14', bucket: 'day' as const }
  const numerator = calculatePerformance(events, metric, { ...options, productId: 'product-a' })
  const denominator = calculatePerformance(events, metric, { ...options, productId: 'product-b' })
  const share = percentageOfReference(numerator, denominator, 'reference-metric', 'reference-product')

  assert.equal(share.summary.value, 25)
  assert.deepEqual(share.timeSeries, [{ period: '2026-10-12', value: 25, events: 1 }])
  assert.equal(share.calculation?.zeroReferencePeriods, 1)
  assert.equal(share.calculation?.missingReferencePeriods, 1)
  assert.equal(share.calculation?.zeroReferenceTotal, false)

  const zeroTotal = calculatePerformance([
    makeEvent(12, { revenue: 0, cost: 0 }, { productId: 'product-b' }),
  ], metric, { ...options, productId: 'product-b' })
  const noValidShare = percentageOfReference(numerator, zeroTotal, 'reference-metric', 'reference-product')
  assert.equal(noValidShare.summary.value, null)
  assert.equal(noValidShare.calculation?.zeroReferencePeriods, 1)
})

test('aggregates sender coordinates into coarse cells and suppresses cells with fewer than five events', () => {
  const events = Array.from({ length: 6 }, (_, index) =>
    makeEvent(12 + index, { revenue: 10, cost: 2 }, {
      location: { latitude: -1.2864 + index * 0.0001, longitude: 36.8172 },
    }))
  const report = calculatePerformance(events, metric, {
    from: '2026-10-12',
    to: '2026-10-17',
    bucket: 'day',
  })

  assert.equal(report.senderLocationCells.length, 1)
  assert.equal(report.senderLocationCells[0].events, 6)
  assert.equal(report.senderLocationCells[0].value, 48)
  assert.equal(report.suppressedSenderLocationCellCount, 0)

  const suppressed = calculatePerformance(events.slice(0, 4), metric, {
    from: '2026-10-12',
    to: '2026-10-15',
    bucket: 'day',
  })
  assert.deepEqual(suppressed.senderLocationCells, [])
  assert.equal(suppressed.suppressedSenderLocationCellCount, 1)
})

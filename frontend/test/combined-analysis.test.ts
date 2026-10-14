import assert from 'node:assert/strict'
import test from 'node:test'
import { combineReportGroups } from '../src/combinedAnalysis'

test('sums each group by matching period before applying the operation', () => {
  const result = combineReportGroups(
    [
      { metric: { unit: 'KES' }, timeSeries: [{ period: '2025-01-01', value: 10 }, { period: '2025-01-02', value: 4 }] },
      { metric: { unit: 'KES' }, timeSeries: [{ period: '2025-01-01', value: 5 }] },
    ],
    [{ metric: { unit: 'KES' }, timeSeries: [{ period: '2025-01-01', value: 3 }, { period: '2025-01-03', value: 2 }] }],
    'subtract',
  )

  assert.deepEqual(result.timeSeries, [
    { period: '2025-01-01', left: 15, right: 3, value: 12 },
    { period: '2025-01-02', left: 4, right: 0, value: 4 },
    { period: '2025-01-03', left: 0, right: 2, value: -2 },
  ])
  assert.equal(result.left.value, 19)
  assert.equal(result.right.value, 5)
  assert.equal(result.value, 14)
})

test('requires compatible units only within additive groups and across add/subtract', () => {
  assert.throws(
    () => combineReportGroups(
      [{ metric: { unit: 'KES' }, timeSeries: [] }],
      [{ metric: { unit: 'count' }, timeSeries: [] }],
      'subtract',
    ),
    /same unit/,
  )
  assert.throws(
    () => combineReportGroups(
      [
        { metric: { unit: 'KES' }, timeSeries: [] },
        { metric: { unit: 'count' }, timeSeries: [] },
      ],
      [{ metric: { unit: 'count' }, timeSeries: [] }],
      'multiply',
    ),
    /within each group/,
  )
  assert.equal(combineReportGroups(
    [{ metric: { unit: 'KES' }, timeSeries: [{ period: '2025-01-01', value: 4 }] }],
    [{ metric: { unit: 'count' }, timeSeries: [{ period: '2025-01-01', value: 2 }] }],
    'multiply',
  ).unit, 'KES·count')
})

test('excludes division periods with zero denominators and reports no-data ranges as null', () => {
  const divided = combineReportGroups(
    [{ metric: { unit: 'KES' }, timeSeries: [{ period: '2025-01-01', value: 10 }, { period: '2025-01-02', value: 4 }] }],
    [{ metric: { unit: 'count' }, timeSeries: [{ period: '2025-01-01', value: 2 }] }],
    'divide',
  )
  assert.equal(divided.timeSeries[0].value, 5)
  assert.equal(divided.timeSeries[1].value, null)
  assert.equal(divided.value, 7)

  const noData = combineReportGroups(
    [{ metric: { unit: 'KES' }, timeSeries: [] }],
    [{ metric: { unit: 'KES' }, timeSeries: [] }],
    'add',
  )
  assert.equal(noData.value, null)
  assert.deepEqual(noData.timeSeries, [])
})

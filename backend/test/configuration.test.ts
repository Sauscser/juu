import assert from 'node:assert/strict'
import test from 'node:test'
import {
  validateLocation,
  validateMetric,
  validateProduct,
  validateTarget,
} from '../src/domain/configuration'
import type { EventContract } from '../src/domain/event-contract'

const contract: EventContract = {
  version: 1,
  eventTypes: [{
    key: 'money_transfer',
    label: 'Money transfer',
    description: 'A completed transfer',
    fields: [
      {
        key: 'revenue',
        label: 'Revenue',
        description: 'Revenue earned',
        type: 'number',
        role: 'measure',
        required: true,
        unit: 'KES',
        aggregation: 'sum',
      },
      {
        key: 'cost',
        label: 'Cost',
        description: 'Cost incurred',
        type: 'number',
        role: 'measure',
        required: true,
        unit: 'KES',
        aggregation: 'sum',
      },
      {
        key: 'channel',
        label: 'Channel',
        description: 'Transfer channel',
        type: 'string',
        role: 'dimension',
        required: false,
      },
    ],
  }],
}

test('validates company products and reporting locations', () => {
  assert.deepEqual(validateProduct({ name: 'Money transfers' }), [])
  assert.deepEqual(validateLocation({
    name: 'Nairobi',
    kind: 'point',
    latitude: -1.2864,
    longitude: 36.8172,
  }), [])
})

test('rejects tenant ownership fields supplied by a caller', () => {
  assert.ok(validateProduct({
    name: 'Unauthorized product',
    companyId: 'another-company',
  }).some((error) => error.includes('companyId is not supported')))
  assert.ok(validateProduct({
    name: 'Spoofed creator',
    createdBy: { subject: 'another-officer', hierarchyLevel: 'company' },
  }).some((error) => error.includes('createdBy is not supported')))
})

test('requires point locations to have valid coordinates', () => {
  assert.ok(validateLocation({ name: 'Invalid point', kind: 'point' }).some((error) =>
    error.includes('require latitude and longitude')))
})

test('validates safe derived metrics using only declared numeric measure fields', () => {
  const profitMetric = {
    name: 'Profit',
    description: 'Revenue less cost',
    unit: 'KES',
    direction: 'higher',
    eventType: 'money_transfer',
    formula: {
      type: 'operation',
      operator: 'subtract',
      operands: [
        { type: 'field', key: 'revenue' },
        { type: 'field', key: 'cost' },
      ],
    },
  }
  assert.deepEqual(validateMetric(profitMetric, contract), [])
  assert.ok(validateMetric({ ...profitMetric, aggregation: 'median' }, contract).some((error) =>
    error.includes('aggregation must be sum, average, min, max, or count')))

  const invalidMetric = {
    ...profitMetric,
    formula: { type: 'field', key: 'channel' },
  }
  assert.ok(validateMetric(invalidMetric, contract).some((error) =>
    error.includes('numeric measure field')))
})

test('validates calculated metric definitions over product-specific metrics', () => {
  const calculated = {
    name: 'Net contribution',
    description: 'Revenue from one product less cost from another',
    unit: 'KES',
    direction: 'higher',
    calculation: {
      operator: 'subtract',
      operands: [
        { metricId: '01234567-89ab-4cde-8fab-0123456789ab', productId: '11234567-89ab-4cde-8fab-0123456789ab' },
        { metricId: '21234567-89ab-4cde-8fab-0123456789ab', productId: '31234567-89ab-4cde-8fab-0123456789ab' },
      ],
    },
  }
  assert.deepEqual(validateMetric(calculated), [])
  assert.ok(validateMetric({
    ...calculated,
    calculation: { ...calculated.calculation, operands: [calculated.calculation.operands[0]] },
  }).some((error) => error.includes('exactly two')))
  assert.ok(validateMetric({
    ...calculated,
    calculation: { ...calculated.calculation, extra: true },
  }).some((error) => error.includes('extra is not supported')))
})

test('validates target scope, period, and date range', () => {
  const validTarget = {
    metricId: '01234567-89ab-4cde-8fab-0123456789ab',
    productId: '11234567-89ab-4cde-8fab-0123456789ab',
    orgUnitId: '21234567-89ab-4cde-8fab-0123456789ab',
    period: 'month',
    startDate: '2026-10-01',
    endDate: '2026-10-31',
    targetValue: 250000,
    warningThreshold: 200000,
  }
  assert.deepEqual(validateTarget(validTarget), [])
  assert.ok(validateTarget({ ...validTarget, endDate: '2026-09-30' }).some((error) =>
    error.includes('on or before')))
  assert.deepEqual(validateTarget({
    ...validTarget,
    targetMode: 'percentage',
    targetValue: 20,
    referenceMetricId: '31234567-89ab-4cde-8fab-0123456789ab',
    referenceProductId: '41234567-89ab-4cde-8fab-0123456789ab',
  }), [])
  assert.ok(validateTarget({
    ...validTarget,
    targetMode: 'percentage',
    targetValue: -1,
    referenceMetricId: '31234567-89ab-4cde-8fab-0123456789ab',
  }).some((error) => error.includes('non-negative')))
})

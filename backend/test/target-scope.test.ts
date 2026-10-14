import assert from 'node:assert/strict'
import test from 'node:test'
import { areTargetProductsEligible, isTargetSetByManager } from '../src/domain/target-scope'

test('top-level leaders inherit only company-wide CEO targets', () => {
  assert.equal(isTargetSetByManager({
    active: true,
    createdBy: { hierarchyLevel: 'company' },
  }), true)
  assert.equal(isTargetSetByManager({
    active: true,
    orgUnitId: 'unit-a',
    createdBy: { hierarchyLevel: 'organization-unit', orgUnitId: 'unit-a' },
  }), false)
})

test('nested leaders inherit only active targets from their direct manager unit', () => {
  assert.equal(isTargetSetByManager({
    active: true,
    orgUnitId: 'unit-a',
    createdBy: { hierarchyLevel: 'organization-unit', orgUnitId: 'unit-a' },
  }, 'unit-a'), true)
  assert.equal(isTargetSetByManager({
    active: true,
    orgUnitId: 'unit-other',
    createdBy: { hierarchyLevel: 'organization-unit', orgUnitId: 'unit-other' },
  }, 'unit-a'), false)
  assert.equal(isTargetSetByManager({
    active: false,
    orgUnitId: 'unit-a',
    createdBy: { hierarchyLevel: 'organization-unit', orgUnitId: 'unit-a' },
  }, 'unit-a'), false)
})

test('a target may include only products delegated by its direct manager', () => {
  const eligible = new Set(['product-a', 'product-b'])
  assert.equal(areTargetProductsEligible(['product-a'], eligible), true)
  assert.equal(areTargetProductsEligible(['product-a', 'product-b'], eligible), true)
  assert.equal(areTargetProductsEligible(['product-a', 'product-c'], eligible), false)
  assert.equal(areTargetProductsEligible([], eligible), false)
})

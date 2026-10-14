import assert from 'node:assert/strict'
import test from 'node:test'
import {
  getUnitSubtreeIds,
  isActiveDirectChildUnit,
  type OrganizationUnit,
} from '../src/domain/organization'
import { validateOrganizationUnit } from '../src/domain/configuration'

const rootId = '01234567-89ab-4cde-8fab-0123456789ab'
const childId = '11234567-89ab-4cde-8fab-0123456789ab'
const grandchildId = '21234567-89ab-4cde-8fab-0123456789ab'

test('validates nested organization units and canonical boundary references', () => {
  assert.deepEqual(validateOrganizationUnit({
    name: 'Mwea Team',
    type: 'Regional team',
    parentUnitId: rootId,
    jurisdiction: {
      provider: 'geoBoundaries',
      boundaryId: 'KEN-ADM2-123',
      boundaryName: 'Mwea',
      boundaryLevel: 'ADM2',
      boundaryCanonical: 'Sub-Counties',
      countryCode: 'KEN',
      countryName: 'Kenya',
      continent: 'Africa',
    },
  }), [])
  assert.deepEqual(validateOrganizationUnit({
    name: 'California team',
    type: 'State',
    jurisdiction: {
      provider: 'geoBoundaries',
      boundaryId: 'USA-ADM1-123',
      boundaryName: 'California',
      boundaryLevel: 'ADM1',
      boundaryCanonical: 'States',
      countryCode: 'USA',
      countryName: 'United States of America',
      continent: 'North America',
    },
  }), [])
  assert.deepEqual(validateOrganizationUnit({
    name: 'Africa team',
    type: 'Continental director',
    jurisdiction: {
      provider: 'naturalEarth',
      boundaryId: 'natural-earth:continent:Africa',
      boundaryName: 'Africa',
      boundaryLevel: 'CONTINENT',
      continent: 'Africa',
    },
  }), [])
  assert.deepEqual(validateOrganizationUnit({
    name: 'Kenya team',
    type: 'Country director',
    jurisdiction: {
      provider: 'naturalEarth',
      boundaryId: 'natural-earth:country:KEN',
      boundaryName: 'Kenya',
      boundaryLevel: 'COUNTRY',
      countryCode: 'KEN',
      countryName: 'Kenya',
      continent: 'Africa',
    },
  }), [])
  assert.ok(validateOrganizationUnit({
    name: 'Subteam',
    type: 'Team',
    parentUnitId: 'bad',
  }).some((error) => error.includes('parentUnitId')))
  assert.ok(validateOrganizationUnit({
    name: 'Invalid country',
    type: 'State',
    jurisdiction: {
      provider: 'geoBoundaries',
      boundaryId: 'X',
      boundaryName: 'Place',
      boundaryLevel: 'ADM6',
      countryCode: 'US',
    },
  }).some((error) => error.includes('boundaryLevel')))
  assert.ok(validateOrganizationUnit({
    name: 'Invalid continent',
    type: 'Team',
    jurisdiction: {
      provider: 'geoBoundaries',
      boundaryId: 'continent:Africa',
      boundaryName: 'Africa',
      boundaryLevel: 'CONTINENT',
    },
  }).some((error) => error.includes('provider')))
})

test('returns only active units in a leader subtree and guards corrupt cycles', () => {
  const units: OrganizationUnit[] = [
    { id: rootId, name: 'Root', type: 'Region', parentUnitId: grandchildId, active: true },
    { id: childId, name: 'Child', type: 'Team', parentUnitId: rootId, active: true },
    { id: grandchildId, name: 'Grandchild', type: 'Team', parentUnitId: childId, active: true },
    { id: '31234567-89ab-4cde-8fab-0123456789ab', name: 'Inactive', type: 'Team', parentUnitId: rootId, active: false },
    { id: '41234567-89ab-4cde-8fab-0123456789ab', name: 'Other', type: 'Region', active: true },
  ]
  assert.deepEqual(new Set(getUnitSubtreeIds(units, rootId)), new Set([rootId, childId, grandchildId]))
})

test('a leader may manage only active direct child units, not deeper descendants', () => {
  const units: OrganizationUnit[] = [
    { id: rootId, name: 'Root', type: 'Region', active: true },
    { id: childId, name: 'Child', type: 'Team', parentUnitId: rootId, active: true },
    { id: grandchildId, name: 'Grandchild', type: 'Team', parentUnitId: childId, active: true },
    { id: '31234567-89ab-4cde-8fab-0123456789ab', name: 'Inactive', type: 'Team', parentUnitId: rootId, active: false },
  ]

  assert.equal(isActiveDirectChildUnit(units, rootId, childId), true)
  assert.equal(isActiveDirectChildUnit(units, rootId, grandchildId), false)
  assert.equal(isActiveDirectChildUnit(units, rootId, '31234567-89ab-4cde-8fab-0123456789ab'), false)
  assert.equal(isActiveDirectChildUnit(units, childId, grandchildId), true)
})

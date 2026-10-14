import assert from 'node:assert/strict'
import test from 'node:test'
import {
  validateContract,
  validatePartnerEvent,
  type EventContract,
} from '../src/domain/event-contract'

const contract: EventContract = {
  version: 1,
  eventTypes: [{
    key: 'money_transfer',
    label: 'Money transfer',
    description: 'A completed transfer',
    fields: [
      {
        key: 'amount',
        label: 'Transfer amount',
        description: 'Amount sent',
        type: 'number',
        role: 'measure',
        required: true,
        unit: 'KES',
        aggregation: 'sum',
      },
      {
        key: 'channel',
        label: 'Channel',
        description: 'Channel used for the transfer',
        type: 'string',
        role: 'dimension',
        required: false,
      },
    ],
  }],
}

test('accepts a valid flexible event contract', () => {
  assert.deepEqual(validateContract(contract), [])
})

test('validates product associations for newly published event contracts', () => {
  const productId = '01234567-89ab-4cde-8fab-0123456789ab'
  const associatedContract: EventContract = {
    ...structuredClone(contract),
    eventTypes: [{ ...structuredClone(contract.eventTypes[0]), productIds: [productId] }],
  }
  assert.deepEqual(validateContract(associatedContract, { requireProductAssociations: true }), [])
  assert.deepEqual(validateContract(contract), [])
  assert.ok(validateContract(contract, { requireProductAssociations: true })
    .some((error) => error.includes('productIds must include at least one active product')))
  assert.ok(validateContract({
    ...associatedContract,
    eventTypes: [{ ...associatedContract.eventTypes[0], productIds: ['invalid'] }],
  }).some((error) => error.includes('must be a valid product ID')))
})

test('rejects events whose product is not associated with their event type', () => {
  const productId = '01234567-89ab-4cde-8fab-0123456789ab'
  const otherProductId = '11234567-89ab-4cde-8fab-0123456789ab'
  const associatedContract: EventContract = {
    ...structuredClone(contract),
    eventTypes: [{ ...structuredClone(contract.eventTypes[0]), productIds: [productId] }],
  }
  const event = {
    contractVersion: 1,
    eventId: 'transfer-123',
    eventType: 'money_transfer',
    occurredAt: '2026-10-13T09:00:00Z',
    productId: otherProductId,
    fields: { amount: 1500 },
  }
  assert.ok(validatePartnerEvent(event, associatedContract)
    .includes('productId is not associated with this eventType'))
  assert.deepEqual(validatePartnerEvent({ ...event, productId }, associatedContract), [])
})

test('rejects duplicate and reserved custom field keys', () => {
  const invalid = structuredClone(contract)
  invalid.eventTypes[0].fields.push({
    key: 'location',
    label: 'Location',
    description: 'Reserved standard field',
    type: 'string',
    role: 'dimension',
    required: false,
  })
  assert.ok(validateContract(invalid).some((error) => error.includes('non-reserved')))
})

test('accepts a contract-matching event with standard sender location', () => {
  const event = {
    contractVersion: 1,
    eventId: 'transfer-123',
    eventType: 'money_transfer',
    occurredAt: '2026-10-13T09:00:00Z',
    productId: '01234567-89ab-4cde-8fab-0123456789ab',
    location: { latitude: -1.2864, longitude: 36.8172, accuracyMeters: 10 },
    fields: { amount: 1500, channel: 'mobile' },
  }
  assert.deepEqual(validatePartnerEvent(event, contract), [])
})

test('accepts an optional organization unit ID and rejects malformed IDs', () => {
  const event = {
    contractVersion: 1,
    eventId: 'transfer-organization-123',
    eventType: 'money_transfer',
    occurredAt: '2026-10-13T09:00:00Z',
    productId: '01234567-89ab-4cde-8fab-0123456789ab',
    orgUnitId: '11234567-89ab-4cde-8fab-0123456789ab',
    fields: { amount: 1500 },
  }
  assert.deepEqual(validatePartnerEvent(event, contract), [])
  assert.ok(validatePartnerEvent({ ...event, orgUnitId: 'not-a-unit' }, contract)
    .some((error) => error.includes('orgUnitId must be a valid company organization unit ID')))
})

test('rejects undeclared fields and invalid coordinates', () => {
  const event = {
    contractVersion: 1,
    eventId: 'transfer-123',
    eventType: 'money_transfer',
    occurredAt: '2026-10-13T09:00:00Z',
    productId: '01234567-89ab-4cde-8fab-0123456789ab',
    location: { latitude: 92, longitude: 36.8172 },
    fields: { amount: 1500, phone_number: 'not allowed' },
  }
  const errors = validatePartnerEvent(event, contract)
  assert.ok(errors.some((error) => error.includes('latitude')))
  assert.ok(errors.some((error) => error.includes('phone_number')))
})

test('rejects unexpected top-level values that could alter stored event keys', () => {
  const event = {
    contractVersion: 1,
    eventId: 'transfer-123',
    eventType: 'money_transfer',
    occurredAt: '2026-10-13T09:00:00Z',
    productId: '01234567-89ab-4cde-8fab-0123456789ab',
    fields: { amount: 1500 },
    pk: 'COMPANY#another-company',
  }
  assert.ok(validatePartnerEvent(event, contract).some((error) => error.includes('pk is not supported')))
})

test('admin can disable or require standard location fields without defining custom fields', () => {
  const requiredContract: EventContract = {
    ...contract,
    standardFields: {
      senderLocation: 'required',
      reportingLocation: 'disabled',
    },
  }
  const event = {
    contractVersion: 1,
    eventId: 'transfer-123',
    eventType: 'money_transfer',
    occurredAt: '2026-10-13T09:00:00Z',
    productId: '01234567-89ab-4cde-8fab-0123456789ab',
    fields: { amount: 1500 },
  }
  const missingLocationErrors = validatePartnerEvent(event, requiredContract)
  assert.ok(missingLocationErrors.includes('location is required by the event contract'))
  assert.deepEqual(validateContract(requiredContract), [])
  assert.ok(validateContract({
    ...contract,
    standardFields: { senderLocation: 'sometimes' },
  }).some((error) => error.includes('senderLocation must be')))
})

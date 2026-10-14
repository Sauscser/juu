import assert from 'node:assert/strict'
import test from 'node:test'
import { isUppyExecutive } from '../src/domain/executive'
import { validateInviteeContact } from '../src/domain/contact'

test('recognizes an executive group in Cognito array or string claims', () => {
  assert.equal(isUppyExecutive({ 'cognito:groups': ['UppyExecutive'] }), true)
  assert.equal(isUppyExecutive({ 'cognito:groups': '["CompanyAdmin","UppyExecutive"]' }), true)
})

test('does not grant executive access based on company admin or malformed claims', () => {
  assert.equal(isUppyExecutive({ 'cognito:groups': ['CompanyAdmin'] }), false)
  assert.equal(isUppyExecutive({ 'custom:company_id': 'company-1' }), false)
  assert.equal(isUppyExecutive(null), false)
})

test('allows omitted invitee contact details and validates details when provided', () => {
  assert.deepEqual(validateInviteeContact(undefined, undefined, 'leaderName', 'leaderPhoneNumber'), [])
  assert.deepEqual(validateInviteeContact('', '', 'leaderName', 'leaderPhoneNumber'), [])
  assert.deepEqual(validateInviteeContact('Amina Njeri', '+254712345678', 'leaderName', 'leaderPhoneNumber'), [])
  assert.deepEqual(validateInviteeContact('Leader', '+254711852707', 'leaderName', 'leaderPhoneNumber'), [])
  assert.ok(validateInviteeContact('Amina Njeri', '0712345678', 'leaderName', 'leaderPhoneNumber')
    .some((error) => error.includes('international format')))
  assert.ok(validateInviteeContact('A'.repeat(129), '+254712345678', 'leaderName', 'leaderPhoneNumber')
    .some((error) => error.includes('leaderName')))
  assert.ok(validateInviteeContact(null, undefined, 'leaderName', 'leaderPhoneNumber')
    .some((error) => error.includes('leaderName')))
})

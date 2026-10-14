import assert from 'node:assert/strict'
import test from 'node:test'
import { getCompanyAdminId, getCompanyLeaderSubject } from '../src/domain/company-admin'

const companyId = 'company_01'

test('resolves company scope only for company admin JWT claims', () => {
  assert.equal(getCompanyAdminId({
    'custom:company_id': companyId,
    'cognito:groups': ['CompanyAdmin'],
  }), companyId)
})

test('accepts Cognito string-form group claims', () => {
  assert.equal(getCompanyAdminId({
    'custom:company_id': companyId,
    'cognito:groups': '["CompanyAdmin"]',
  }), companyId)
})

test('rejects claims without company admin membership or company assignment', () => {
  assert.equal(getCompanyAdminId({
    'custom:company_id': companyId,
    'cognito:groups': ['CompanyUser'],
  }), undefined)
  assert.equal(getCompanyAdminId({ 'cognito:groups': ['CompanyAdmin'] }), undefined)
  assert.equal(getCompanyAdminId({
    'custom:company_id': 'company with spaces',
    'cognito:groups': ['CompanyAdmin'],
  }), undefined)
})

test('resolves a leader subject only from the trusted leader group and Cognito subject', () => {
  const subject = '01234567-89ab-4cde-8fab-0123456789ab'
  assert.equal(getCompanyLeaderSubject({
    sub: subject,
    'cognito:groups': ['CompanyLeader'],
  }), subject)
  assert.equal(getCompanyLeaderSubject({
    sub: subject,
    'cognito:groups': ['CompanyAdmin'],
  }), undefined)
  assert.equal(getCompanyLeaderSubject({
    sub: 'not-a-subject',
    'cognito:groups': ['CompanyLeader'],
  }), undefined)
})

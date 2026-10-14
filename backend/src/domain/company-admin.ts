import { isRecord } from './event-contract'

export function getCompanyAdminId(claims: unknown): string | undefined {
  if (!isRecord(claims)) return undefined

  const companyId = claims['custom:company_id']
  if (typeof companyId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(companyId)) {
    return undefined
  }

  const groupsClaim = claims['cognito:groups']
  const groups = Array.isArray(groupsClaim)
    ? groupsClaim
    : typeof groupsClaim === 'string'
      ? groupsClaim.replace(/^\[|\]$/g, '').split(',').map((group) => group.trim().replace(/^"|"$/g, ''))
      : []
  return groups.includes('CompanyAdmin') ? companyId : undefined
}

export function getCompanyLeaderSubject(claims: unknown): string | undefined {
  if (!isRecord(claims)) return undefined
  const subject = claims.sub
  const groupsClaim = claims['cognito:groups']
  const groups = Array.isArray(groupsClaim)
    ? groupsClaim
    : typeof groupsClaim === 'string'
      ? groupsClaim.replace(/^\[|\]$/g, '').split(',').map((group) => group.trim().replace(/^"|"$/g, ''))
      : []
  if (!groups.includes('CompanyLeader') || typeof subject !== 'string' ||
    !/^[0-9a-f-]{36}$/i.test(subject)) return undefined
  return subject
}

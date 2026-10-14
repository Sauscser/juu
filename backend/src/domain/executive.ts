import { isRecord } from './event-contract'

export function isUppyExecutive(claims: unknown): boolean {
  if (!isRecord(claims)) return false
  const groupClaim = claims['cognito:groups']
  const groups = Array.isArray(groupClaim)
    ? groupClaim
    : typeof groupClaim === 'string'
      ? groupClaim.replace(/^\[|\]$/g, '').split(',').map((group) => group.trim().replace(/^"|"$/g, ''))
      : []
  return groups.includes('UppyExecutive')
}

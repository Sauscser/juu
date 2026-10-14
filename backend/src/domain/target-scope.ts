type TargetCreator = {
  hierarchyLevel?: unknown
  orgUnitId?: unknown
}

export type TargetScopeRecord = {
  active?: unknown
  orgUnitId?: unknown
  createdBy?: TargetCreator
}

export function isTargetSetByManager(
  target: TargetScopeRecord,
  managerUnitId?: string,
): boolean {
  if (target.active !== true) return false
  if (managerUnitId) {
    return target.orgUnitId === managerUnitId &&
      target.createdBy?.hierarchyLevel === 'organization-unit' &&
      target.createdBy.orgUnitId === managerUnitId
  }
  return target.orgUnitId === undefined &&
    target.createdBy?.hierarchyLevel === 'company'
}

export function areTargetProductsEligible(
  requestedProductIds: string[],
  eligibleProductIds: Set<string>,
): boolean {
  return requestedProductIds.length > 0 &&
    requestedProductIds.every((productId) => eligibleProductIds.has(productId))
}

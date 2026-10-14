export type OrganizationUnitJurisdiction = {
  provider: 'geoBoundaries' | 'naturalEarth'
  boundaryId: string
  boundaryName: string
  boundaryLevel: 'CONTINENT' | 'COUNTRY' | `ADM${0 | 1 | 2 | 3 | 4 | 5}`
  boundaryCanonical?: string
  countryCode?: string
  countryName?: string
  continent?: string
}

export type OrganizationUnit = {
  id: string
  parentUnitId?: string
  name: string
  type: string
  active: boolean
  jurisdiction?: OrganizationUnitJurisdiction
}

export function getUnitSubtreeIds(units: OrganizationUnit[], rootId: string): string[] {
  const children = new Map<string, string[]>()
  for (const unit of units) {
    if (!unit.active || !unit.parentUnitId) continue
    const childIds = children.get(unit.parentUnitId) ?? []
    childIds.push(unit.id)
    children.set(unit.parentUnitId, childIds)
  }
  const result: string[] = []
  const pending = [rootId]
  const visited = new Set<string>()
  while (pending.length) {
    const current = pending.pop()
    if (!current || visited.has(current)) continue
    visited.add(current)
    result.push(current)
    pending.push(...(children.get(current) ?? []))
  }
  return result
}

export function isActiveDirectChildUnit(
  units: OrganizationUnit[],
  parentId: string,
  childId: string,
): boolean {
  return units.some((unit) =>
    unit.id === childId && unit.active && unit.parentUnitId === parentId)
}

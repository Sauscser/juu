import { useEffect, useMemo, useState } from 'react'
import type { GeoBoundarySelection } from './GeoBoundaryPicker'

export type DirectoryUnit = {
  id: string
  name: string
  type: string
  parentUnitId?: string
  jurisdiction?: GeoBoundarySelection
  leaderContacts?: Array<{ name?: string; email: string; phoneNumber?: string }>
  leaders?: string[]
  active: boolean
}

export function OrganizationDirectory({
  units,
  initialUnitId,
  highlightedUnitId,
  highlightedLeaderEmail,
  title,
  description,
}: {
  units: DirectoryUnit[]
  initialUnitId?: string
  highlightedUnitId?: string
  highlightedLeaderEmail?: string
  title: string
  description: string
}) {
  const [selectedUnitId, setSelectedUnitId] = useState(initialUnitId ?? units[0]?.id ?? '')
  const unitById = useMemo(() => new Map(units.map((unit) => [unit.id, unit])), [units])
  const selectedUnit = unitById.get(selectedUnitId)

  useEffect(() => {
    if (selectedUnitId && unitById.has(selectedUnitId)) return
    const preferredId = initialUnitId && unitById.has(initialUnitId) ? initialUnitId : units[0]?.id
    setSelectedUnitId(preferredId ?? '')
  }, [initialUnitId, selectedUnitId, unitById, units])

  function unitDepth(unit: DirectoryUnit): number {
    let current = unit
    let depth = 0
    const visited = new Set([unit.id])
    while (current.parentUnitId) {
      const parent = unitById.get(current.parentUnitId)
      if (!parent || visited.has(parent.id)) break
      visited.add(parent.id)
      depth += 1
      current = parent
    }
    return Math.min(depth, 8)
  }

  const parent = selectedUnit?.parentUnitId ? unitById.get(selectedUnit.parentUnitId) : undefined
  const leads: NonNullable<DirectoryUnit['leaderContacts']> = selectedUnit?.leaderContacts?.length
    ? selectedUnit.leaderContacts
    : (selectedUnit?.leaders ?? []).map((email) => ({ email }))

  return (
    <section className="organization-directory" aria-label={title}>
      <div className="organization-directory-list">
        <div className="organization-directory-heading">
          <h3>{title}</h3>
          <p>{description}</p>
        </div>
        {units.length ? units.map((unit) => (
          <button
            type="button"
            key={unit.id}
            className={`organization-directory-item${unit.id === selectedUnitId ? ' selected' : ''}${unit.id === highlightedUnitId ? ' organization-row-new' : ''}`}
            style={{ paddingLeft: `${12 + unitDepth(unit) * 16}px` }}
            aria-pressed={unit.id === selectedUnitId}
            onClick={() => setSelectedUnitId(unit.id)}
          >
            <span className="organization-directory-item-name">
              <strong>{unit.name}</strong>
              <small>{unit.type}{unit.jurisdiction?.boundaryName ? ` · ${unit.jurisdiction.boundaryName}` : ''}</small>
            </span>
            <span className="organization-directory-item-count">
              {unit.leaderContacts?.length ?? unit.leaders?.length ?? 0} leader{(unit.leaderContacts?.length ?? unit.leaders?.length ?? 0) === 1 ? '' : 's'}
            </span>
          </button>
        )) : <p className="muted-copy">No organization units are available.</p>}
      </div>
      {selectedUnit && (
        <div className="organization-directory-details" aria-live="polite">
          <p className="eyebrow">SELECTED UNIT</p>
          <h3>{selectedUnit.name}</h3>
          <p className="organization-directory-summary">{selectedUnit.type} · {selectedUnit.active ? 'Active' : 'Inactive'}</p>
          <dl>
            <div><dt>Reports to</dt><dd>{parent?.name ?? (selectedUnit.parentUnitId ? 'Outside your reporting scope' : 'Company')}</dd></div>
            <div><dt>Jurisdiction</dt><dd>{selectedUnit.jurisdiction
              ? `${selectedUnit.jurisdiction.boundaryName} · ${selectedUnit.jurisdiction.boundaryCanonical ?? selectedUnit.jurisdiction.boundaryLevel}`
              : 'No geographic boundary assigned'}</dd></div>
            <div>
              <dt>Leader{leads.length === 1 ? '' : 's'}</dt>
              <dd>{leads.length
                ? leads.map((leader) => (
                  <span
                    className={leader.email.toLowerCase() === highlightedLeaderEmail ? 'organization-leader-new' : undefined}
                    key={leader.email}
                  >
                    {leader.name ? `${leader.name} · ` : ''}{leader.email}
                    {leader.phoneNumber ? ` · ${leader.phoneNumber}` : ''}
                    {leader.email.toLowerCase() === highlightedLeaderEmail && <strong className="organization-invited-badge">Just invited</strong>}
                  </span>
                ))
                : 'No leader invited yet'}</dd>
            </div>
          </dl>
        </div>
      )}
    </section>
  )
}

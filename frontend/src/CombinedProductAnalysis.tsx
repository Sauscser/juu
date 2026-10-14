import { useEffect, useState, type FormEvent } from 'react'
import { apiRequest } from './api'
import { applyCombinedOperation, combineReportGroups, type CombinedOperator, type CombinedResult } from './combinedAnalysis'

type Metric = {
  id: string
  name: string
  unit: string
  active: boolean
  calculation?: unknown
}
type Product = { id: string; name: string; active: boolean }
type Target = {
  id: string
  metricId: string
  productId?: string
  orgUnitId?: string
  period?: 'day' | 'week' | 'month' | 'quarter' | 'year'
  startDate: string
  endDate: string
  targetValue: number
  targetMode?: 'fixed' | 'percentage'
  active: boolean
}
type OrganizationUnit = { id: string; name: string; active: boolean }
type Report = {
  metric: { unit: string }
  summary: { value: number | null }
  timeSeries: Array<{ period: string; value: number }>
}
type Part = { metricId: string; productId: string; targetId: string }
type Operator = CombinedOperator

const newPart = (): Part => ({ metricId: '', productId: '', targetId: '' })
const maxSelectionsPerGroup = 20

function partTargets(
  targets: Target[],
  part: Part,
  from: string,
  to: string,
  orgUnitId: string,
): Target[] {
  if (!orgUnitId) return []
  return targets.filter((target) =>
    target.active &&
    target.targetMode !== 'percentage' &&
    target.metricId === part.metricId &&
    target.productId === part.productId &&
    target.orgUnitId === orgUnitId &&
    target.startDate === from &&
    target.endDate === to,
  )
}

export function CombinedProductAnalysis({
  apiUrl,
  endpoint,
  metrics,
  products,
  targets,
  organizationUnits,
  fixedOrgUnitId,
  fixedOrgUnitName,
}: {
  apiUrl: string
  endpoint: '/v1/admin/performance/combined' | '/v1/leader/performance/combined'
  metrics: Metric[]
  products: Product[]
  targets: Target[]
  organizationUnits?: OrganizationUnit[]
  fixedOrgUnitId?: string
  fixedOrgUnitName?: string
}) {
  const eventMetrics = metrics.filter((metric) => metric.active && !metric.calculation)
  const activeProducts = products.filter((product) => product.active)
  const defaultMetricId = eventMetrics[0]?.id ?? ''
  const defaultProductId = activeProducts[0]?.id ?? ''
  const [orgUnitId, setOrgUnitId] = useState(fixedOrgUnitId ?? '')
  const [from, setFrom] = useState(() => dateOffset(-29))
  const [to, setTo] = useState(() => dateOffset(0))
  const [operator, setOperator] = useState<Operator>('subtract')
  const [left, setLeft] = useState<Part[]>([newPart()])
  const [right, setRight] = useState<Part[]>([newPart()])
  const [result, setResult] = useState<CombinedResult>()
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!fixedOrgUnitId) return
    setOrgUnitId(fixedOrgUnitId)
  }, [fixedOrgUnitId])

  useEffect(() => {
    if (!defaultMetricId || !defaultProductId) return
    const defaults = { metricId: defaultMetricId, productId: defaultProductId, targetId: '' }
    setLeft((parts) => parts.map((part) => ({
      ...part,
      metricId: part.metricId || defaults.metricId,
      productId: part.productId || defaults.productId,
    })))
    setRight((parts) => parts.map((part) => ({
      ...part,
      metricId: part.metricId || defaults.metricId,
      productId: part.productId || defaults.productId,
    })))
  }, [defaultMetricId, defaultProductId])

  const updatePart = (side: 'left' | 'right', index: number, update: Partial<Part>) => {
    const setParts = side === 'left' ? setLeft : setRight
    setParts((parts) => parts.map((part, itemIndex) =>
      itemIndex === index
        ? { ...part, ...update, ...('metricId' in update || 'productId' in update ? { targetId: '' } : {}) }
        : part,
    ))
  }

  async function runAnalysis(event: FormEvent) {
    event.preventDefault()
    setLoading(true)
    setError('')
    setResult(undefined)
    try {
      const allParts = [...left, ...right]
      if (allParts.some((part) => !part.metricId || !part.productId)) {
        throw new Error('Choose a metric and product for every item in both groups.')
      }
      const selectedMetrics = allParts.map((part) => eventMetrics.find((metric) => metric.id === part.metricId))
      if (selectedMetrics.some((metric) => !metric)) {
        throw new Error('One or more selected metrics are no longer available.')
      }
      const leftUnits = new Set(selectedMetrics.slice(0, left.length).map((metric) => metric?.unit))
      const rightUnits = new Set(selectedMetrics.slice(left.length).map((metric) => metric?.unit))
      if (leftUnits.size !== 1 || rightUnits.size !== 1) {
        throw new Error('Metrics within each group must use the same unit because the group adds its selected values.')
      }
      if ((operator === 'add' || operator === 'subtract') && [...leftUnits][0] !== [...rightUnits][0]) {
        throw new Error('Addition and subtraction require all selected metrics to use the same unit.')
      }
      const response = await apiRequest<{ reports: Report[] }>(apiUrl, endpoint, {
        method: 'POST',
        body: {
          from,
          to,
          bucket: 'day',
          operator,
          left: left.map(({ metricId, productId }) => ({ metricId, productId })),
          right: right.map(({ metricId, productId }) => ({ metricId, productId })),
          ...(!fixedOrgUnitId && orgUnitId ? { orgUnitId } : {}),
        },
      })
      const reports = response.reports
      if (reports.length !== allParts.length) {
        throw new Error('The combined report returned an incomplete set of metric results.')
      }
      const splitIndex = left.length
      const leftReports = reports.slice(0, splitIndex)
      const rightReports = reports.slice(splitIndex)
      const combined = combineReportGroups(
        leftReports,
        rightReports,
        operator,
      )
      setResult(combined)
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setLoading(false)
    }
  }

  function selectedTargetTotal(parts: Part[]): number | undefined {
    const selectedTargets = parts.map((part) =>
      partTargets(targets, part, from, to, orgUnitId).find((target) => target.id === part.targetId),
    )
    if (selectedTargets.some((target) => !target)) return undefined
    const total = selectedTargets.reduce((sum, target) => sum + (target?.targetValue ?? 0), 0)
    return Number.isFinite(total) ? total : undefined
  }

  const leftTarget = selectedTargetTotal(left)
  const rightTarget = selectedTargetTotal(right)
  const combinedTarget = leftTarget !== undefined && rightTarget !== undefined
    ? applyCombinedOperation(operator, leftTarget, rightTarget)
    : undefined
  const leftUnits = new Set(left.map((part) => eventMetrics.find((metric) => metric.id === part.metricId)?.unit).filter(Boolean))
  const rightUnits = new Set(right.map((part) => eventMetrics.find((metric) => metric.id === part.metricId)?.unit).filter(Boolean))
  const incompatibleUnits = leftUnits.size > 1 || rightUnits.size > 1 ||
    ((operator === 'add' || operator === 'subtract') && leftUnits.size === 1 && rightUnits.size === 1 && [...leftUnits][0] !== [...rightUnits][0])
  const targetVariance = result?.value !== null && result?.value !== undefined && combinedTarget !== undefined
    ? result.value - combinedTarget
    : undefined

  return (
    <section className="surface combined-analysis">
      <div className="section-title"><div><h2>Combined product analysis</h2><p>Group product metrics on each side, then compare the groups for the same reporting periods. This is an ad hoc view; it does not create or change targets. Each group supports up to 20 selections.</p></div></div>
      <form className="stack-form" onSubmit={runAnalysis}>
        <div className="inline-fields">
          {fixedOrgUnitId
            ? <div className="form-field"><span>Organization unit</span><input value={fixedOrgUnitName ?? 'Your assigned unit'} readOnly /></div>
            : organizationUnits && <label className="form-field"><span>Organization unit</span><select value={orgUnitId} onChange={(event) => { setOrgUnitId(event.target.value); setLeft((parts) => parts.map((part) => ({ ...part, targetId: '' }))); setRight((parts) => parts.map((part) => ({ ...part, targetId: '' }))); setResult(undefined) }}><option value="">Entire company</option>{organizationUnits.filter((unit) => unit.active).map((unit) => <option key={unit.id} value={unit.id}>{unit.name}</option>)}</select></label>}
          <label className="form-field"><span>From</span><input type="date" value={from} onChange={(event) => { setFrom(event.target.value); setLeft((parts) => parts.map((part) => ({ ...part, targetId: '' }))); setRight((parts) => parts.map((part) => ({ ...part, targetId: '' }))); setResult(undefined) }} required /></label>
          <label className="form-field"><span>To</span><input type="date" value={to} onChange={(event) => { setTo(event.target.value); setLeft((parts) => parts.map((part) => ({ ...part, targetId: '' }))); setRight((parts) => parts.map((part) => ({ ...part, targetId: '' }))); setResult(undefined) }} required /></label>
        </div>
        <div className="combined-groups">
          {([
            { name: 'left' as const, title: 'First group', parts: left, setParts: setLeft },
            { name: 'right' as const, title: 'Second group', parts: right, setParts: setRight },
          ]).map(({ name, title, parts, setParts }) => (
            <div className="combined-group" key={name}>
              <h3>{title}</h3>
              {parts.map((part, index) => (
                <div className="combined-part" key={`${name}-${index}`}>
                  <label className="form-field"><span>Metric</span><select value={part.metricId} onChange={(event) => updatePart(name, index, { metricId: event.target.value })} required><option value="">Choose metric</option>{eventMetrics.map((metric) => <option key={metric.id} value={metric.id}>{metric.name} ({metric.unit})</option>)}</select></label>
                  <label className="form-field"><span>Product</span><select value={part.productId} onChange={(event) => updatePart(name, index, { productId: event.target.value })} required><option value="">Choose product</option>{activeProducts.map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}</select></label>
                  <label className="form-field"><span>Saved fixed target (optional)</span><select value={part.targetId} onChange={(event) => updatePart(name, index, { targetId: event.target.value })}><option value="">No target selected</option>{partTargets(targets, part, from, to, orgUnitId).map((target) => <option key={target.id} value={target.id}>{target.targetValue} · {target.period ?? 'target'}</option>)}</select></label>
                  <button className="text-danger" type="button" disabled={parts.length === 1} onClick={() => setParts((current) => current.filter((_, itemIndex) => itemIndex !== index))}>Remove</button>
                </div>
              ))}
              <button className="secondary-button" type="button" disabled={parts.length >= maxSelectionsPerGroup} onClick={() => setParts((current) => [...current, newPart()])}>Add metric and product</button>
            </div>
          ))}
        </div>
        <label className="form-field combined-operator"><span>Compare groups</span><select value={operator} onChange={(event) => { setOperator(event.target.value as Operator); setResult(undefined) }}><option value="add">Add (+)</option><option value="subtract">Subtract (−)</option><option value="multiply">Multiply (×)</option><option value="divide">Divide (÷)</option></select></label>
        {incompatibleUnits && <p className="callout-warning" role="alert">Each group must use one unit. Addition and subtraction also require the two groups to use the same unit.</p>}
        {!orgUnitId && !fixedOrgUnitId && <p className="form-hint">Select an organization unit to compare against its saved fixed targets. Percentage targets remain available in the existing saved-target report flow.</p>}
        <button className="primary-button" disabled={loading || !eventMetrics.length || !activeProducts.length || from > to}>{loading ? 'Calculating…' : 'Run combined analysis'} <span>↗</span></button>
      </form>
      {error && <div className="error-banner" role="alert"><span>!</span>{error}</div>}
      {result && (
        <div className="combined-results">
          <div className="combined-total"><span>COMBINED RESULT</span><strong>{result.value ?? '—'} <small>{result.unit}</small></strong><p>{result.left.value} {result.left.unit} {operatorSymbol(operator)} {result.right.value} {result.right.unit}</p></div>
          {combinedTarget !== undefined && result.value !== null && <div className="combined-total"><span>SAVED TARGET COMPARISON</span><strong>{targetVariance === undefined ? '—' : targetVariance} <small>{result.unit} variance</small></strong><p>Combined target: {combinedTarget} {result.unit}. A positive or negative variance is shown without changing your target.</p></div>}
          {combinedTarget === undefined && (left.some((part) => part.targetId) || right.some((part) => part.targetId)) && <p className="form-hint">Select a matching fixed target for every item on both sides to calculate a combined target variance.</p>}
          <div className="table-wrap"><table><thead><tr><th>PERIOD</th><th>FIRST GROUP</th><th>SECOND GROUP</th><th>RESULT</th></tr></thead><tbody>{result.timeSeries.map((period) => <tr key={period.period}><td>{period.period}</td><td>{period.left}</td><td>{period.right}</td><td>{period.value ?? '—'}</td></tr>)}</tbody></table></div>
          {result.timeSeries.length === 0 && <p className="form-hint">No activity matched these selections and dates.</p>}
        </div>
      )}
    </section>
  )
}

function operatorSymbol(operator: Operator): string {
  return operator === 'add' ? '+' : operator === 'subtract' ? '−' : operator === 'multiply' ? '×' : '÷'
}

function dateOffset(days: number): string {
  const date = new Date()
  date.setDate(date.getDate() + days)
  return date.toISOString().slice(0, 10)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'An unexpected error occurred.'
}

import { useEffect, useState, type FormEvent } from 'react'
import { apiRequest } from './api'
import { BrandMark } from './BrandMark'
import { CombinedProductAnalysis } from './CombinedProductAnalysis'
import { GeoBoundaryPicker, type GeoBoundarySelection } from './GeoBoundaryPicker'
import { OrganizationDirectory } from './OrganizationDirectory'

type LeaderMetric = {
  id: string
  name: string
  unit: string
  active: boolean
  calculation?: {
    operator: 'add' | 'subtract' | 'multiply' | 'divide'
    operands: [{ metricId: string; productId: string }, { metricId: string; productId: string }]
  }
}
type LeaderUnit = {
  id: string
  name: string
  type: string
  parentUnitId?: string
  jurisdiction?: GeoBoundarySelection
  active: boolean
  leaderContacts?: Array<{ name?: string; email: string; phoneNumber?: string }>
}
type LeaderProduct = {
  id: string
  name: string
  description?: string
  active: boolean
}
type LeaderTarget = {
  id: string
  metricId: string
  productId?: string
  orgUnitId: string
  period: 'day' | 'week' | 'month' | 'quarter' | 'year'
  startDate: string
  endDate: string
  targetValue: number
  targetMode?: 'fixed' | 'percentage'
  referenceMetricId?: string
  referenceProductId?: string
  active: boolean
}
type PerformanceReport = {
  metric: { name: string; unit: string }
  summary: { value: number | null; matchedEvents: number; calculatedEvents: number; excludedEvents: number }
  timeSeries: Array<{ period: string; value: number; events: number }>
  calculation?: {
    kind: 'metric-operation' | 'percentage-of-reference'
    zeroReferencePeriods?: number
    missingReferencePeriods?: number
    zeroReferenceTotal?: boolean
  }
}

export function LeaderApp({
  apiUrl,
  email,
  onSignOut,
}: {
  apiUrl: string
  email: string
  onSignOut: () => void | Promise<void>
}) {
  const [metrics, setMetrics] = useState<LeaderMetric[]>([])
  const [products, setProducts] = useState<LeaderProduct[]>([])
  const [targets, setTargets] = useState<LeaderTarget[]>([])
  const [eligibleProductIds, setEligibleProductIds] = useState<string[]>([])
  const [units, setUnits] = useState<LeaderUnit[]>([])
  const [assignedUnitId, setAssignedUnitId] = useState('')
  const [childName, setChildName] = useState('')
  const [childType, setChildType] = useState('')
  const [childJurisdiction, setChildJurisdiction] = useState<GeoBoundarySelection>()
  const [inviteUnitId, setInviteUnitId] = useState('')
  const [leaderEmail, setLeaderEmail] = useState('')
  const [leaderName, setLeaderName] = useState('')
  const [leaderPhoneNumber, setLeaderPhoneNumber] = useState('')
  const [leaderContactAttempted, setLeaderContactAttempted] = useState(false)
  const [teamMessage, setTeamMessage] = useState('')
  const [teamSaving, setTeamSaving] = useState(false)
  const [metricId, setMetricId] = useState('')
  const [productId, setProductId] = useState('')
  const [targetPeriod, setTargetPeriod] = useState<LeaderTarget['period']>('month')
  const [targetMode, setTargetMode] = useState<'fixed' | 'percentage'>('fixed')
  const [referenceMetricId, setReferenceMetricId] = useState('')
  const [referenceProductId, setReferenceProductId] = useState('')
  const [targetStartDate, setTargetStartDate] = useState(() => dateOffset(0))
  const [targetEndDate, setTargetEndDate] = useState(() => dateOffset(30))
  const [targetValue, setTargetValue] = useState('')
  const [reportTargetId, setReportTargetId] = useState('')
  const [from, setFrom] = useState(() => dateOffset(-29))
  const [to, setTo] = useState(() => dateOffset(0))
  const [report, setReport] = useState<PerformanceReport>()
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState(false)

  useEffect(() => {
    let active = true
    void Promise.all([
      apiRequest<{ items: LeaderMetric[] }>(apiUrl, '/v1/leader/metrics'),
      apiRequest<{ assignedUnitId: string; items: LeaderUnit[] }>(apiUrl, '/v1/leader/org-units'),
      apiRequest<{ items: LeaderProduct[] }>(apiUrl, '/v1/leader/products'),
      apiRequest<{ items: LeaderTarget[]; eligibleProductIds: string[] }>(apiUrl, '/v1/leader/targets'),
    ]).then(([metricResult, unitResult, productResult, targetResult]) => {
      if (!active) return
      setMetrics(metricResult.items)
      setUnits(unitResult.items)
      setProducts(productResult.items)
      setTargets(targetResult.items)
      setEligibleProductIds(targetResult.eligibleProductIds)
      setAssignedUnitId(unitResult.assignedUnitId)
      setInviteUnitId(unitResult.items.find((unit) => unit.parentUnitId === unitResult.assignedUnitId)?.id ?? '')
      const firstActiveProduct = productResult.items.find((product) =>
        product.active && targetResult.eligibleProductIds.includes(product.id))
      const firstTargetableMetric = metricResult.items.find((metric) => metric.active &&
        (metric.calculation
          ? metric.calculation.operands.every((operand) => targetResult.eligibleProductIds.includes(operand.productId))
          : Boolean(firstActiveProduct)))
      setMetricId(firstTargetableMetric?.id ?? '')
      setProductId(firstActiveProduct?.id ?? '')
      setReferenceProductId(firstActiveProduct?.id ?? '')
      setReferenceMetricId(metricResult.items.find((metric) => metric.active && !metric.calculation)?.id ?? '')
      setError('')
    }).catch((reason: unknown) => {
      if (!active) return
      setError(errorMessage(reason))
    }).finally(() => {
      if (active) setLoading(false)
    })
    return () => { active = false }
  }, [apiUrl])

  const childUnits = units.filter((unit) => unit.parentUnitId === assignedUnitId)
  const targetableProducts = products.filter((product) =>
    product.active && eligibleProductIds.includes(product.id))
  const targetableMetrics = metrics.filter((metric) => metric.active &&
    (metric.calculation
      ? metric.calculation.operands.every((operand) => eligibleProductIds.includes(operand.productId))
      : targetableProducts.length > 0))
  const selectedReportTarget = targets.find((target) => target.id === reportTargetId)

  function selectReportTarget(id: string) {
    setReportTargetId(id)
    const target = targets.find((item) => item.id === id)
    if (!target) return
    setMetricId(target.metricId)
    setProductId(target.productId ?? '')
    setTargetMode(target.targetMode ?? 'fixed')
    setTargetValue(String(target.targetValue))
    setReferenceMetricId(target.referenceMetricId ?? '')
    setReferenceProductId(target.referenceProductId ?? '')
    setTargetPeriod(target.period)
    setTargetStartDate(target.startDate)
    setTargetEndDate(target.endDate)
    setFrom(target.startDate)
    setTo(target.endDate)
  }

  async function setTarget(event: FormEvent) {
    event.preventDefault()
    setTeamSaving(true)
    setError('')
    setTeamMessage('')
    try {
      const result = await apiRequest<{ item: LeaderTarget }>(apiUrl, '/v1/leader/targets', {
        method: 'POST',
        body: {
          metricId,
          ...(!metrics.find((metric) => metric.id === metricId)?.calculation ? { productId } : {}),
          period: targetPeriod,
          startDate: targetStartDate,
          endDate: targetEndDate,
          targetValue: Number(targetValue),
          targetMode,
          ...(targetMode === 'percentage' ? { referenceMetricId, referenceProductId } : {}),
        },
      })
      setTargets((current) => [...current, result.item])
      setReportTargetId(result.item.id)
      setTargetValue('')
      setTeamMessage('Target saved for your assigned organization unit.')
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setTeamSaving(false)
    }
  }

  async function createChildUnit(event: FormEvent) {
    event.preventDefault()
    setTeamSaving(true)
    setError('')
    setTeamMessage('')
    try {
      const result = await apiRequest<{ item: LeaderUnit }>(apiUrl, '/v1/leader/org-units', {
        method: 'POST',
        body: {
          name: childName,
          type: childType,
          ...(childJurisdiction ? { jurisdiction: childJurisdiction } : {}),
        },
      })
      setUnits((current) => [...current, result.item])
      setInviteUnitId(result.item.id)
      setChildName('')
      setChildType('')
      setChildJurisdiction(undefined)
      setTeamMessage(`${result.item.name} added beneath your assigned unit.`)
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setTeamSaving(false)
    }
  }

  async function inviteChildLeader(event: FormEvent) {
    event.preventDefault()
    setLeaderContactAttempted(true)
    setTeamSaving(true)
    setError('')
    setTeamMessage('')
    try {
      const result = await apiRequest<{ invitedLeader: string; message: string }>(
        apiUrl,
        `/v1/leader/org-units/${encodeURIComponent(inviteUnitId)}/leaders`,
        { method: 'POST', body: { leaderEmail, leaderName, leaderPhoneNumber } },
      )
      setUnits((current) => current.map((unit) => unit.id === inviteUnitId
        ? {
            ...unit,
            leaderContacts: [
              ...(unit.leaderContacts ?? []).filter((leader) =>
                leader.email.toLowerCase() !== result.invitedLeader.toLowerCase()),
              {
                email: result.invitedLeader,
                ...(leaderName.trim() ? { name: leaderName.trim() } : {}),
                ...(leaderPhoneNumber.trim() ? { phoneNumber: leaderPhoneNumber.trim() } : {}),
              },
            ],
          }
        : unit))
      setLeaderEmail('')
      setLeaderName('')
      setLeaderPhoneNumber('')
      setLeaderContactAttempted(false)
      setTeamMessage(result.message)
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setTeamSaving(false)
    }
  }

  async function runReport(event: FormEvent) {
    event.preventDefault()
    setRunning(true)
    setError('')
    try {
      const query = new URLSearchParams({ metricId, from, to, bucket: 'day', orgUnitId: assignedUnitId })
      if (productId && !selectedMetric?.calculation) query.set('productId', productId)
      if (targetMode === 'percentage' && referenceMetricId && referenceProductId) {
        query.set('referenceMetricId', referenceMetricId)
        query.set('referenceProductId', referenceProductId)
      }
      const result = await apiRequest<{ report: PerformanceReport }>(
        apiUrl,
        `/v1/leader/performance?${query.toString()}`,
      )
      setReport(result.report)
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setRunning(false)
    }
  }

  const selectedMetric = metrics.find((metric) => metric.id === metricId)
  const selectedReferenceMetric = metrics.find((metric) => metric.id === referenceMetricId)
  const assignedUnit = units.find((unit) => unit.id === assignedUnitId)
  const assignedUnitName = assignedUnit?.name ?? 'your assigned unit'
  const assignedJurisdiction = assignedUnit?.jurisdiction?.boundaryName

  return (
    <main className="leader-workspace">
      <header className="leader-topbar">
        <a className="brand" href="#" onClick={(event) => event.preventDefault()}><BrandMark /><span>Juu<span className="brand-period">.</span></span></a>
        <div><span className="connection-dot" /> Team leader workspace <button className="secondary-button" onClick={() => { void onSignOut() }}>Sign out</button></div>
      </header>
      <div className="leader-content">
        <p className="eyebrow">TEAM LEADER · {email}</p>
        <h1>Your team workspace</h1>
        <p className="subheading">Manage the next level beneath your assigned jurisdiction, set your own product targets, and review performance within your reporting scope.</p>
        <section className="surface leader-team">
          <p className="eyebrow">YOUR ASSIGNED JURISDICTION</p>
          <h2>{assignedUnitName}</h2>
          <p>{assignedUnit?.type}{assignedJurisdiction ? ` · ${assignedJurisdiction}` : ' · No geographic boundary assigned'} · Your targets are automatically tied to this unit. You cannot select another unit for your targets.</p>
        </section>
        <section className="surface leader-team">
          <OrganizationDirectory
            units={units}
            initialUnitId={assignedUnitId}
            title="Your reporting tree"
            description="Select your unit or a team beneath you to view its details. Only your assigned unit and its descendants are shown."
          />
        </section>
        <section className="surface leader-team">
          <p className="eyebrow">GROW YOUR TEAM</p>
          <h2>Create the next level beneath your unit</h2>
          <p>You can add direct child units under your assigned area and invite the leader for each one. That leader can build the next level beneath their unit. You cannot create or assign units elsewhere in the company.</p>
          <form className="stack-form" onSubmit={createChildUnit}>
            <div className="inline-fields">
              <label className="form-field"><span>Team or jurisdiction name</span><input value={childName} onChange={(event) => setChildName(event.target.value)} maxLength={128} placeholder="e.g. Mwea branch" required /></label>
              <label className="form-field"><span>Unit type</span><input value={childType} onChange={(event) => setChildType(event.target.value)} maxLength={64} placeholder="e.g. Branch team" required /></label>
            </div>
            <GeoBoundaryPicker value={childJurisdiction} onChange={setChildJurisdiction} />
            <button className="primary-button" disabled={teamSaving || loading || !assignedUnitId}>{teamSaving ? 'Saving…' : 'Add direct child unit'} <span>＋</span></button>
          </form>
          <form className="inline-fields leader-invite-form" onSubmit={inviteChildLeader}>
            <label className="form-field"><span>Unit to lead</span><select value={inviteUnitId} onChange={(event) => setInviteUnitId(event.target.value)} required><option value="">Choose one of your direct child units</option>{childUnits.map((unit) => <option key={unit.id} value={unit.id}>{unit.name}</option>)}</select></label>
            <label className="form-field"><span>Leader full name (optional)</span><input value={leaderName} onChange={(event) => setLeaderName(event.target.value)} maxLength={128} autoComplete="name" /></label>
            <label className="form-field"><span>Next-level leader email</span><input type="email" value={leaderEmail} onChange={(event) => setLeaderEmail(event.target.value)} maxLength={254} required /></label>
            <label className="form-field"><span>Leader phone number (optional)</span><input type="tel" value={leaderPhoneNumber} onChange={(event) => setLeaderPhoneNumber(event.target.value)} maxLength={16} pattern="[+][1-9][0-9]{1,14}" title="Use international format, for example +254711852707" placeholder="+254711852707" autoComplete="tel" /></label>
            <button className="secondary-button" disabled={teamSaving || childUnits.length === 0}>{teamSaving ? 'Sending…' : 'Invite next-level leader'} <span>→</span></button>
            {leaderContactAttempted && (!leaderName.trim() || !leaderPhoneNumber.trim()) && (
              <div className="callout-warning invite-contact-warning" role="alert">
                <strong>Contact details missing.</strong> The invitation will still be sent by email, but any blank name or phone number will not be available in the organization list.
              </div>
            )}
          </form>
          {teamMessage && <p className="success-message" role="status">{teamMessage}</p>}
        </section>
        <section className="surface leader-team">
          <p className="eyebrow">YOUR UNIT TARGETS</p>
          <h2>Set a target for {assignedUnitName}</h2>
          <p>Choose from products that your direct manager has targeted. Juu ties your target to your signed-in profile and assigned unit; your team can then target only products you target here.</p>
          {targetableProducts.length === 0 && (
            <div className="callout-warning" role="status">
              <strong>No products are available for targets yet.</strong> Your direct manager must set an active target for a product first.
            </div>
          )}
          <form className="stack-form" onSubmit={setTarget}>
            <div className="inline-fields">
              {!selectedMetric?.calculation
                ? <label className="form-field"><span>Product targeted by your manager</span><select value={productId} onChange={(event) => { setProductId(event.target.value); setReportTargetId('') }} required><option value="">Select a product</option>{targetableProducts.map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}</select></label>
                : <div className="callout-warning"><strong>Product scope is built in.</strong> This calculated metric already specifies its component products.</div>}
              <label className="form-field"><span>Company metric</span><select value={metricId} onChange={(event) => { setMetricId(event.target.value); setReportTargetId('') }} required><option value="">Select a metric</option>{targetableMetrics.map((metric) => <option key={metric.id} value={metric.id}>{metric.name} ({metric.unit})</option>)}</select></label>
            </div>
            <label className="form-field"><span>Target style</span><select value={targetMode} onChange={(event) => { setTargetMode(event.target.value as typeof targetMode); setReportTargetId('') }}><option value="fixed">Fixed value</option><option value="percentage">Percentage of another product metric</option></select></label>
            {targetMode === 'percentage' && <div className="inline-fields">
              <label className="form-field"><span>Reference product</span><select value={referenceProductId} onChange={(event) => { setReferenceProductId(event.target.value); setReportTargetId('') }} required><option value="">Select a product</option>{targetableProducts.map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}</select></label>
              <label className="form-field"><span>Reference metric</span><select value={referenceMetricId} onChange={(event) => { setReferenceMetricId(event.target.value); setReportTargetId('') }} required><option value="">Select a metric</option>{metrics.filter((metric) => metric.active && !metric.calculation).map((metric) => <option key={metric.id} value={metric.id}>{metric.name} ({metric.unit})</option>)}</select></label>
            </div>}
            <div className="inline-fields">
              <label className="form-field"><span>Reporting period</span><select value={targetPeriod} onChange={(event) => setTargetPeriod(event.target.value as LeaderTarget['period'])}><option value="day">Day</option><option value="week">Week</option><option value="month">Month</option><option value="quarter">Quarter</option><option value="year">Year</option></select></label>
              <label className="form-field"><span>{targetMode === 'percentage' ? 'Minimum share target (%)' : `Target value (${selectedMetric?.unit ?? 'metric unit'})`}</span><input type="number" min={targetMode === 'percentage' ? 0 : undefined} step="any" value={targetValue} onChange={(event) => { setTargetValue(event.target.value); setReportTargetId('') }} required /></label>
            </div>
            {targetMode === 'percentage' && selectedMetric && selectedReferenceMetric && selectedMetric.unit !== selectedReferenceMetric.unit && <div className="callout-warning" role="alert"><strong>Units must match.</strong> Percentage targets can only compare metrics with compatible units.</div>}
            <div className="inline-fields">
              <label className="form-field"><span>Start date</span><input type="date" value={targetStartDate} onChange={(event) => { setTargetStartDate(event.target.value); setReportTargetId('') }} required /></label>
              <label className="form-field"><span>End date</span><input type="date" value={targetEndDate} onChange={(event) => { setTargetEndDate(event.target.value); setReportTargetId('') }} required /></label>
            </div>
            <button className="primary-button" disabled={teamSaving || loading || !assignedUnitId || targetableProducts.length === 0 || targetableMetrics.length === 0 || targetMode === 'percentage' && (!referenceMetricId || !referenceProductId || selectedMetric?.unit !== selectedReferenceMetric?.unit)}>{teamSaving ? 'Saving…' : 'Set target for my unit'} <span>＋</span></button>
          </form>
          {targets.length > 0 && (
            <div className="resource-list">
              {targets.map((target) => {
                const product = products.find((entry) => entry.id === target.productId)
                const metric = metrics.find((entry) => entry.id === target.metricId)
                const referenceMetric = metrics.find((entry) => entry.id === target.referenceMetricId)
                const referenceProduct = products.find((entry) => entry.id === target.referenceProductId)
                return <div className="resource-row" key={target.id}>
                  <span className="resource-icon">◎</span>
                  <span className="resource-copy">
                    <strong>{target.productId ? product?.name ?? 'Product' : 'Combined products'} · {metric?.name ?? 'Metric'}: {target.targetValue}{target.targetMode === 'percentage' ? `% of ${referenceProduct?.name ?? 'reference product'} · ${referenceMetric?.name ?? 'reference metric'}` : ` ${metric?.unit ?? ''}`}</strong>
                    <small>{target.period} · {target.startDate} to {target.endDate} · {assignedUnitName}</small>
                    <code>{target.id}</code>
                  </span>
                </div>
              })}
            </div>
          )}
        </section>
        <form className="surface performance-filters" onSubmit={runReport}>
          <div className="inline-fields">
            <label className="form-field"><span>Saved target comparison</span><select value={reportTargetId} onChange={(event) => selectReportTarget(event.target.value)}><option value="">Use current metric and dates</option>{targets.filter((target) => target.active).map((target) => {
              const metric = metrics.find((item) => item.id === target.metricId)
              return <option key={target.id} value={target.id}>{metric?.name ?? 'Metric'} · {target.targetMode === 'percentage' ? `${target.targetValue}% share` : `${target.targetValue} ${metric?.unit ?? ''}`}</option>
            })}</select></label>
            <label className="form-field"><span>Metric</span><select value={metricId} onChange={(event) => { setMetricId(event.target.value); setReportTargetId('') }} required><option value="">Choose a metric</option>{metrics.map((metric) => <option key={metric.id} value={metric.id}>{metric.name} ({metric.unit})</option>)}</select></label>
            <label className="form-field"><span>Organization unit</span><input value={assignedUnitName} readOnly /></label>
            <label className="form-field"><span>From</span><input type="date" value={from} onChange={(event) => { setFrom(event.target.value); setReportTargetId('') }} required /></label>
            <label className="form-field"><span>To</span><input type="date" value={to} onChange={(event) => { setTo(event.target.value); setReportTargetId('') }} required /></label>
          </div>
          <button className="primary-button" disabled={loading || running || !metricId}>{running ? 'Loading…' : 'Run report'} <span>↗</span></button>
        </form>
        {loading && <div className="loading-state"><span className="spinner" /> Loading your assigned reporting scope…</div>}
        {error && <div className="error-banner" role="alert"><span>!</span>{error}</div>}
        {report && (
          <section className="surface performance-results">
            <div className="performance-total"><span className="eyebrow">TOTAL · {report.metric.name || selectedMetric?.name || 'METRIC'}</span><strong>{report.summary.value ?? '—'} <small>{report.metric.unit || selectedMetric?.unit}</small></strong><span>{report.calculation?.kind === 'metric-operation' ? `${report.summary.calculatedEvents} reporting periods calculated` : report.calculation?.kind === 'percentage-of-reference' ? `${report.summary.calculatedEvents} periods compared · ${report.calculation.zeroReferencePeriods ?? 0} zero-reference and ${report.calculation.missingReferencePeriods ?? 0} no-reference periods excluded` : `${report.summary.calculatedEvents} calculated of ${report.summary.matchedEvents} matching events`}</span>{report.calculation?.kind === 'percentage-of-reference' && <><small>Target threshold: at least {selectedReportTarget?.targetValue ?? (targetValue || '—')}%</small>{report.summary.value !== null && (selectedReportTarget || targetValue !== '') && <small>{report.summary.value >= (selectedReportTarget?.targetValue ?? Number(targetValue)) ? 'This reporting range meets the selected threshold.' : 'This reporting range is below the selected threshold.'}</small>}{report.summary.value === null && <small>{report.calculation.zeroReferenceTotal ? 'The aggregate reference value is zero; no percentage can be calculated.' : 'There are no comparable periods with reference data.'}</small>}</>}</div>
            <div className="table-wrap"><table><thead><tr><th>PERIOD</th><th>VALUE</th><th>EVENTS</th></tr></thead><tbody>{report.timeSeries.map((period) => <tr key={period.period}><td>{period.period}</td><td>{period.value}</td><td>{period.events}</td></tr>)}</tbody></table></div>
          </section>
        )}
        <CombinedProductAnalysis
          apiUrl={apiUrl}
          endpoint="/v1/leader/performance/combined"
          metrics={metrics}
          products={products}
          targets={targets}
          fixedOrgUnitId={assignedUnitId}
          fixedOrgUnitName={assignedUnitName}
        />
      </div>
    </main>
  )
}

function dateOffset(days: number): string {
  const date = new Date()
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.'
}

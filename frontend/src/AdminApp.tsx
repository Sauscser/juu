import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { apiRequest } from './api'
import { BrandMark } from './BrandMark'
import { CombinedProductAnalysis } from './CombinedProductAnalysis'
import { GeoBoundaryPicker, type GeoBoundarySelection } from './GeoBoundaryPicker'
import { OrganizationDirectory } from './OrganizationDirectory'

type Resource = 'products' | 'locations' | 'metrics' | 'targets' | 'org-units'
type CaptureMode = 'disabled' | 'optional' | 'required'
type FieldType = 'string' | 'number' | 'boolean'
type FieldRole = 'dimension' | 'measure' | 'pseudonymous_id'
type Aggregation = 'sum' | 'count' | 'average' | 'min' | 'max'
type Formula =
  | { type: 'field'; key: string }
  | { type: 'constant'; value: number }
  | { type: 'operation'; operator: 'add' | 'subtract' | 'multiply' | 'divide'; operands: [Formula, Formula] }
type EventField = {
  key: string
  label: string
  description: string
  type: FieldType
  role: FieldRole
  required: boolean
  unit?: string
  aggregation?: Aggregation
}

function formatKes(value: number): string {
  return new Intl.NumberFormat('en-KE', {
    style: 'currency',
    currency: 'KES',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value)
}
type EventType = { key: string; label: string; description: string; productIds?: string[]; fields: EventField[] }
type EventContract = {
  version: number
  standardFields: { senderLocation: CaptureMode; reportingLocation: CaptureMode }
  eventTypes: EventType[]
}
type Product = {
  id: string
  name: string
  description?: string
  createdBy?: {
    subject: string
    email?: string
    name?: string
    hierarchyLevel: 'company' | 'organization-unit'
    orgUnitId?: string
  }
  active: boolean
}
type Location = {
  id: string
  name: string
  description?: string
  kind: 'region' | 'point'
  parentLocationId?: string
  latitude?: number
  longitude?: number
  active: boolean
}
type Metric = {
  id: string
  name: string
  description: string
  unit: string
  direction: 'higher' | 'lower'
  eventType?: string
  formula?: Formula
  calculation?: {
    operator: 'add' | 'subtract' | 'multiply' | 'divide'
    operands: [{ metricId: string; productId: string }, { metricId: string; productId: string }]
  }
  aggregation?: 'sum' | 'average' | 'min' | 'max' | 'count'
  active: boolean
}
type Target = {
  id: string
  metricId: string
  productId?: string
  locationId?: string
  orgUnitId?: string
  period: 'day' | 'week' | 'month' | 'quarter' | 'year'
  startDate: string
  endDate: string
  targetValue: number
  targetMode?: 'fixed' | 'percentage'
  referenceMetricId?: string
  referenceProductId?: string
  warningThreshold?: number
  createdBy?: {
    subject: string
    email?: string
    name?: string
    hierarchyLevel: 'company' | 'organization-unit'
    orgUnitId?: string
  }
  active: boolean
}
type OrganizationUnit = {
  id: string
  name: string
  type: string
  parentUnitId?: string
  jurisdiction?: GeoBoundarySelection
  leaders?: string[]
  leaderContacts?: Array<{ name?: string; email: string; phoneNumber?: string }>
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
  }
}
type ConfigItem = (Product | Location | Metric | Target | OrganizationUnit) & { resource?: Resource }
type IntegrationKey = { integrationId: string; active: boolean; createdAt: string; revokedAt?: string }
type BillingSummary = {
  currency: 'KES'
  ratesConfigured: boolean
  paymentsConfigured: boolean
  billingEnabled: boolean
  rates?: { ingestionKesPer1000: number; presentationKesPer1000: number }
  nextRates?: {
    effectiveMonth: string
    ingestionKesPer1000: number
    presentationKesPer1000: number
  }
  currentMonth: {
    month: string
    ingestionCalls: number
    presentationCalls: number
    estimatedAmountKes: number | null
  }
  invoices: Array<{
    invoiceNumber: string
    month: string
    issuedAt: string
    dueAt: string
    ingestionCalls: number
    presentationCalls: number
    totalAmountKes: number
    paymentStatus: 'paid' | 'pending' | 'failed' | 'overdue' | 'unpaid' | 'no balance'
    paymentSource?: 'manual'
    paymentMethod?: string
    paymentReference?: string
    checkoutUrl?: string
  }>
}

const blankContract = (): EventContract => ({
  version: 0,
  standardFields: { senderLocation: 'optional', reportingLocation: 'disabled' },
  eventTypes: [],
})

const navigation: Array<{ id: string; label: string; group: string; disabled?: boolean }> = [
  { id: 'overview', label: 'Overview', group: 'Workspace' },
  { id: 'organization', label: 'Organization', group: 'Configure' },
  { id: 'products', label: 'Products', group: 'Configure' },
  { id: 'locations', label: 'Locations', group: 'Configure' },
  { id: 'contract', label: 'Event contract', group: 'Configure' },
  { id: 'metrics', label: 'Metrics', group: 'Configure' },
  { id: 'targets', label: 'Targets', group: 'Configure' },
  { id: 'integrations', label: 'Integration keys', group: 'Connect' },
  { id: 'developer', label: 'Developer guide', group: 'Connect' },
  { id: 'performance', label: 'Performance', group: 'Workspace' },
  { id: 'billing', label: 'Billing', group: 'Workspace' },
]

export function AdminApp({
  apiUrl,
  email,
  onSignOut,
}: {
  apiUrl: string
  email: string
  onSignOut: () => void | Promise<void>
}) {
  const [page, setPage] = useState(() => {
    if (new URLSearchParams(window.location.search).get('billing') === 'return') return 'billing'
    const state: unknown = window.history.state
    return isAdminNavigationState(state) ? state.juuAdminPage : 'overview'
  })
  const [canGoBack, setCanGoBack] = useState(() => {
    const state: unknown = window.history.state
    return isAdminNavigationState(state) && state.juuAdminDepth > 0
  })
  const [contract, setContract] = useState<EventContract>(blankContract)
  const [contractAvailable, setContractAvailable] = useState(false)
  const [contractError, setContractError] = useState('')
  const [companyName, setCompanyName] = useState('Loading company…')
  const [companyProfileError, setCompanyProfileError] = useState('')
  const [accountBilling, setAccountBilling] = useState<BillingSummary>()
  const [accountBillingError, setAccountBillingError] = useState('')
  const activePage = navigation.find((item) => item.id === page)
  const pendingInvoices = accountBilling?.invoices.filter((invoice) =>
    ['unpaid', 'pending', 'failed', 'overdue'].includes(invoice.paymentStatus) &&
    invoice.totalAmountKes > 0) ?? []
  const pendingInvoiceTotal = pendingInvoices.reduce(
    (total, invoice) => total + invoice.totalAmountKes,
    0,
  )

  const navigateTo = useCallback((nextPage: string) => {
    if (nextPage === page || !navigation.some((item) => item.id === nextPage)) return
    const state: unknown = window.history.state
    const depth = isAdminNavigationState(state) ? state.juuAdminDepth : 0
    window.history.pushState({ juuAdminPage: nextPage, juuAdminDepth: depth + 1 }, '')
    setPage(nextPage)
    setCanGoBack(true)
  }, [page])

  useEffect(() => {
    const state: unknown = window.history.state
    if (!isAdminNavigationState(state)) {
      window.history.replaceState({ juuAdminPage: page, juuAdminDepth: 0 }, '')
    }
    const handlePopState = (event: PopStateEvent) => {
      const nextState: unknown = event.state
      if (!isAdminNavigationState(nextState)) {
        setPage('overview')
        setCanGoBack(false)
        return
      }
      setPage(nextState.juuAdminPage)
      setCanGoBack(nextState.juuAdminDepth > 0)
    }
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [])

  useEffect(() => {
    let active = true
    void apiRequest<{ company: { name: string } }>(apiUrl, '/v1/admin/company-profile')
      .then(({ company }) => {
        if (!active) return
        setCompanyName(company.name)
        setCompanyProfileError('')
      })
      .catch((error: unknown) => {
        if (!active) return
        setCompanyProfileError(errorMessage(error))
        console.error('Unable to load the company profile', error)
      })
    return () => { active = false }
  }, [apiUrl])

  const loadAccountBilling = useCallback(async () => {
    try {
      const result = await apiRequest<BillingSummary>(apiUrl, '/v1/admin/billing')
      setAccountBilling(result)
      setAccountBillingError('')
    } catch (error) {
      setAccountBillingError(errorMessage(error))
      console.error('Unable to load the company billing summary', error)
    }
  }, [apiUrl])

  useEffect(() => {
    void loadAccountBilling()
  }, [page, loadAccountBilling])

  const loadContract = useCallback(async () => {
    try {
      const result = await apiRequest<{ contract: EventContract }>(apiUrl, '/v1/admin/event-contract')
      setContract(result.contract)
      setContractAvailable(true)
      setContractError('')
    } catch (error) {
      if (error instanceof Error && 'status' in error && error.status === 404) {
        setContract(blankContract())
        setContractAvailable(false)
        setContractError('')
        return
      }
      setContractError(errorMessage(error))
      throw error
    }
  }, [apiUrl])

  useEffect(() => {
    loadContract().catch((error: unknown) => {
      console.error('Unable to load the event contract', error)
    })
  }, [loadContract])

  async function logOut() {
    await onSignOut()
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#" onClick={(event) => { event.preventDefault(); navigateTo('overview') }}>
          <BrandMark />
          <span>Juu<span className="brand-period">.</span></span>
        </a>
        <div className="workspace-switcher">
          <span className="workspace-icon">C</span>
          <span><small>COMPANY WORKSPACE</small><strong>{companyProfileError ? 'Company unavailable' : companyName}</strong></span>
          <span className="chevron">⌄</span>
        </div>
        <nav aria-label="Main navigation">
          {['Workspace', 'Configure', 'Connect'].map((group) => (
            <div className="nav-group" key={group}>
              <p className="nav-caption">{group}</p>
              {navigation.filter((item) => item.group === group).map((item) => (
                <button
                  key={item.id}
                  className={`nav-item ${page === item.id ? 'selected' : ''}`}
                  disabled={item.disabled}
                  onClick={() => navigateTo(item.id)}
                >
                  <span className="nav-glyph">{navGlyph(item.id)}</span>
                  <span>{item.label}</span>
                  {item.disabled && <span className="soon-tag">Soon</span>}
                  {item.id === 'billing' && pendingInvoices.length > 0 && (
                    <span className="billing-nav-badge">{pendingInvoices.length}</span>
                  )}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="help-card">
            <span className="help-spark">✳</span>
            <strong>Need a hand?</strong>
            <span>Get started with the developer guide.</span>
            <button onClick={() => navigateTo('developer')}>View guide <span>↗</span></button>
          </div>
          <button
            className={`account-billing-summary${pendingInvoices.length ? ' has-pending-bills' : ''}`}
            onClick={() => navigateTo('billing')}
            title={accountBillingError ? `Billing summary unavailable: ${accountBillingError}` : 'Open company billing'}
          >
            <span className="account-billing-icon">$</span>
            <span>
              <strong>{accountBillingError
                ? 'Billing summary unavailable'
                : pendingInvoices.length
                  ? `${pendingInvoices.length} pending ${pendingInvoices.length === 1 ? 'bill' : 'bills'}`
                  : 'No pending bills'}</strong>
              <small>{accountBillingError
                ? 'Select to retry in Billing'
                : pendingInvoices.length
                  ? `KES ${formatKes(pendingInvoiceTotal)} outstanding`
                  : 'View usage and invoices'}</small>
            </span>
            {pendingInvoices.length > 0 && <span className="account-billing-count">{pendingInvoices.length}</span>}
          </button>
          <div className="account-row">
            <span className="avatar">{email.slice(0, 1).toUpperCase()}</span>
            <span className="account-email" title={email}>{email}</span>
            <button className="icon-button" aria-label="Sign out" title="Sign out" onClick={logOut}>↗</button>
          </div>
        </div>
      </aside>
      <main className="main-panel">
        <header className="topbar">
          <div className="topbar-navigation">
            {canGoBack && <button className="back-button" onClick={() => window.history.back()}><span aria-hidden="true">←</span> Back</button>}
            <div className="breadcrumbs"><span>Workspace</span><span>/</span><strong>{activePage?.label}</strong></div>
          </div>
          <div className="topbar-right"><span className="connection-dot" /> Secure company workspace</div>
        </header>
        <div className="page-content">
          {companyProfileError && <ErrorBanner message={`Unable to load the company profile: ${companyProfileError}`} />}
          {contractError && <ErrorBanner message={`Unable to load the event contract: ${contractError}`} />}
          {page === 'overview' && <Overview onNavigate={navigateTo} />}
          {page === 'products' && <ProductsPage apiUrl={apiUrl} onNavigate={navigateTo} />}
          {page === 'locations' && <LocationsPage apiUrl={apiUrl} />}
          {page === 'organization' && <OrganizationPage apiUrl={apiUrl} companyName={companyName} />}
          {page === 'contract' && (
            <ContractPage
              apiUrl={apiUrl}
              contract={contract}
              available={contractAvailable}
              onSaved={loadContract}
            />
          )}
          {page === 'metrics' && <MetricsPage apiUrl={apiUrl} contract={contract} onNavigate={navigateTo} />}
          {page === 'targets' && <TargetsPage apiUrl={apiUrl} />}
          {page === 'integrations' && <IntegrationKeysPage apiUrl={apiUrl} />}
          {page === 'developer' && <DeveloperGuide apiUrl={apiUrl} contract={contract} />}
          {page === 'performance' && <PerformancePage apiUrl={apiUrl} />}
          {page === 'billing' && <BillingPage apiUrl={apiUrl} />}
        </div>
        <footer className="footer"><span>Juu</span><span>Securely configured for your company</span><span>Need help? <button onClick={() => navigateTo('developer')}>Developer guide</button></span></footer>
      </main>
    </div>
  )
}

function Overview({ onNavigate }: { onNavigate: (page: string) => void }) {
  const steps = [
    { number: '01', title: 'Build your organization', copy: 'Set jurisdictions and leadership structure first. Each leader can create the next level beneath them.', page: 'organization', status: 'Start here' },
    { number: '02', title: 'Set up your products', copy: 'Add products to the shared company catalog. Each entry records the signed-in officer and their hierarchy level.', page: 'products', status: 'Next' },
    { number: '03', title: 'Describe your events', copy: 'Choose the values partner systems should send.', page: 'contract', status: 'Configure' },
    { number: '04', title: 'Define meaningful metrics', copy: 'Turn declared measures into business performance indicators.', page: 'metrics', status: 'Configure' },
    { number: '05', title: 'Set company targets', copy: 'Set the company-wide targets first; leaders cascade targets for selected products down their teams.', page: 'targets', status: 'Team' },
  ]
  return (
    <>
      <div className="welcome-row">
        <div><p className="eyebrow">COMPANY WORKSPACE</p><h1>Good to have you here.</h1><p className="subheading">Build the picture behind your business performance.</p></div>
        <div className="date-chip"><span className="date-icon">◷</span> Setup in progress</div>
      </div>
      <div className="hero-card">
        <div className="hero-copy">
          <span className="hero-kicker"><span /> YOUR PERFORMANCE, IN CONTEXT</span>
          <h2>Build your organization<br />before setting targets.</h2>
          <p>Start with your jurisdictions and leadership levels. The CEO invites the first-level leaders; each leader can build the next level within their own area.</p>
          <button className="primary-button" onClick={() => onNavigate('organization')}>Build your organization <span>→</span></button>
        </div>
        <div className="hero-art" aria-hidden="true">
          <div className="art-ring ring-one" /><div className="art-ring ring-two" />
          <div className="art-orbit orbit-one" /><div className="art-orbit orbit-two" />
          <span className="art-dot dot-one" /><span className="art-dot dot-two" /><span className="art-dot dot-three" />
          <div className="art-center"><span>u</span></div>
          <div className="art-label label-top">LEADERS <span>↗</span></div>
          <div className="art-label label-bottom">JURISDICTIONS <span>↗</span></div>
        </div>
      </div>
      <section className="setup-section">
        <div className="section-heading"><div><p className="eyebrow">YOUR FIRST STEPS</p><h2>Build your foundation</h2></div><span className="progress-label">5 steps <span>·</span> to get started</span></div>
        <div className="setup-grid">
          {steps.map((step) => (
            <button className="setup-card" key={step.number} onClick={() => onNavigate(step.page)}>
              <span className="step-number">{step.number}</span><span className="step-status">{step.status} <span>↗</span></span>
              <strong>{step.title}</strong><span className="step-copy">{step.copy}</span>
            </button>
          ))}
        </div>
      </section>
      <div className="privacy-note"><span className="privacy-icon">◈</span><span><strong>Your data stays yours.</strong> Juu uses the events your partner sends to provide company-level performance insights. Direct personal identifiers are not needed for map analysis.</span><button onClick={() => onNavigate('developer')}>How integrations work →</button></div>
    </>
  )
}

function ProductsPage({ apiUrl, onNavigate }: { apiUrl: string; onNavigate: (page: string) => void }) {
  const collection = useCollection<Product>(apiUrl, 'products')
  const orgUnits = useCollection<OrganizationUnit>(apiUrl, 'org-units')
  const organizationReady = orgUnits.items.some((unit) => unit.active)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [saving, setSaving] = useState(false)
  async function submit(event: FormEvent) {
    event.preventDefault()
    setSaving(true)
    try {
      await apiRequest(apiUrl, '/v1/admin/config/products', { method: 'POST', body: { name, description } })
      setName('')
      setDescription('')
      await collection.refresh()
    } catch (error) {
      collection.setError(errorMessage(error))
    } finally {
      setSaving(false)
    }
  }
  return (
    <ResourceLayout eyebrow="CONFIGURE" title="Products" intro="After building the organization structure, officers add products to one shared company catalog. Each product records the signed-in officer and their company or unit-level hierarchy scope." count={collection.items.length}>
      {!orgUnits.loading && !organizationReady && (
        <div className="callout-warning">
          <strong>Set up the organization first.</strong> Product entries are recorded against the signed-in officer's hierarchy. Add at least one active unit before creating products. <button onClick={() => onNavigate('organization')}>Build your organization →</button>
        </div>
      )}
      <div className="resource-grid">
        <section className="surface form-surface">
          <SectionTitle title="Add a product" copy="The catalog is shared company-wide; the backend records your signed-in profile and hierarchy level." />
          <form className="stack-form" onSubmit={submit}>
            <FormField label="Product name" required><input value={name} onChange={(event) => setName(event.target.value)} maxLength={128} placeholder="e.g. Money transfers" required /></FormField>
            <FormField label="Description"><textarea value={description} onChange={(event) => setDescription(event.target.value)} maxLength={512} rows={3} placeholder="What does this product do?" /></FormField>
            <button className="primary-button" disabled={saving || orgUnits.loading || !organizationReady}>{saving ? 'Adding…' : 'Add product'} <span>＋</span></button>
          </form>
        </section>
        <section className="surface list-surface">
          <SectionTitle title="Your products" copy="Use these IDs when partner systems send events." />
          <ResourceState loading={collection.loading || orgUnits.loading} error={collection.error || orgUnits.error} empty={!collection.items.length} emptyText="No products yet. Add your first one to get started." onRetry={() => { void collection.refresh(); void orgUnits.refresh() }} />
          <div className="resource-list">
            {collection.items.map((item) => (
              <ResourceRow
                key={item.id}
                title={item.name}
                subtitle={[
                  item.description || 'No description',
                  item.createdBy
                    ? `Added by ${item.createdBy.name || item.createdBy.email || 'company officer'} · ${
                      item.createdBy.hierarchyLevel === 'organization-unit'
                        ? orgUnits.items.find((unit) => unit.id === item.createdBy?.orgUnitId)?.name ?? 'assigned unit'
                        : 'company level'
                    }`
                    : undefined,
                ].filter(Boolean).join(' · ')}
                id={item.id}
                active={item.active}
                allowRestore
                onToggle={() => collection.toggle(item)}
              />
            ))}
          </div>
        </section>
      </div>
    </ResourceLayout>
  )
}

function LocationsPage({ apiUrl }: { apiUrl: string }) {
  const collection = useCollection<Location>(apiUrl, 'locations')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [kind, setKind] = useState<Location['kind']>('region')
  const [parentLocationId, setParentLocationId] = useState('')
  const [latitude, setLatitude] = useState('')
  const [longitude, setLongitude] = useState('')
  const [saving, setSaving] = useState(false)
  async function submit(event: FormEvent) {
    event.preventDefault()
    setSaving(true)
    const body = {
      name,
      description,
      kind,
      ...(parentLocationId ? { parentLocationId } : {}),
      ...(kind === 'point' ? { latitude: Number(latitude), longitude: Number(longitude) } : {}),
    }
    try {
      await apiRequest(apiUrl, '/v1/admin/config/locations', { method: 'POST', body })
      setName('')
      setDescription('')
      setParentLocationId('')
      setLatitude('')
      setLongitude('')
      await collection.refresh()
    } catch (error) {
      collection.setError(errorMessage(error))
    } finally {
      setSaving(false)
    }
  }
  return (
    <ResourceLayout eyebrow="CONFIGURE" title="Reporting locations" intro="Add the places used to group and compare your performance. Sender GPS is a separate, optional event field." count={collection.items.length}>
      <div className="resource-grid">
        <section className="surface form-surface">
          <SectionTitle title="Add a location" copy="Create a region or a point on the map." />
          <form className="stack-form" onSubmit={submit}>
            <FormField label="Location name" required><input value={name} onChange={(event) => setName(event.target.value)} maxLength={128} placeholder="e.g. Nairobi" required /></FormField>
            <FormField label="Type" required><select value={kind} onChange={(event) => setKind(event.target.value as Location['kind'])}><option value="region">Region</option><option value="point">Point</option></select></FormField>
            {kind === 'point' && <div className="inline-fields"><FormField label="Latitude" required><input type="number" min="-90" max="90" step="any" value={latitude} onChange={(event) => setLatitude(event.target.value)} required /></FormField><FormField label="Longitude" required><input type="number" min="-180" max="180" step="any" value={longitude} onChange={(event) => setLongitude(event.target.value)} required /></FormField></div>}
            {collection.items.some((item) => item.kind === 'region' && item.active) && <FormField label="Parent region"><select value={parentLocationId} onChange={(event) => setParentLocationId(event.target.value)}><option value="">No parent</option>{collection.items.filter((item) => item.kind === 'region' && item.active).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></FormField>}
            <FormField label="Description"><textarea value={description} onChange={(event) => setDescription(event.target.value)} maxLength={512} rows={3} placeholder="Optional context for your team" /></FormField>
            <button className="primary-button" disabled={saving}>{saving ? 'Adding…' : 'Add location'} <span>＋</span></button>
          </form>
        </section>
        <section className="surface list-surface">
          <SectionTitle title="Your locations" copy="Locations can be used to scope targets and group reports." />
          <ResourceState loading={collection.loading} error={collection.error} empty={!collection.items.length} emptyText="No reporting locations yet." onRetry={collection.refresh} />
          <div className="resource-list">{collection.items.map((item) => <ResourceRow key={item.id} title={item.name} subtitle={`${item.kind === 'region' ? 'Region' : `Point · ${item.latitude}, ${item.longitude}`}${item.parentLocationId ? ' · has parent region' : ''}`} id={item.id} active={item.active} allowRestore onToggle={() => collection.toggle(item)} />)}</div>
        </section>
      </div>
    </ResourceLayout>
  )
}

function ContractPage({ apiUrl, contract, available, onSaved }: { apiUrl: string; contract: EventContract; available: boolean; onSaved: () => Promise<void> }) {
  const products = useCollection<Product>(apiUrl, 'products')
  const [draft, setDraft] = useState<EventContract>(contract)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  useEffect(() => setDraft(contract), [contract])

  function updateEvent(index: number, values: Partial<EventType>) {
    setDraft((current) => ({ ...current, eventTypes: current.eventTypes.map((event, position) => position === index ? { ...event, ...values } : event) }))
  }
  function updateField(eventIndex: number, fieldIndex: number, values: Partial<EventField>) {
    setDraft((current) => ({
      ...current,
      eventTypes: current.eventTypes.map((event, index) => index === eventIndex
        ? { ...event, fields: event.fields.map((field, position) => position === fieldIndex ? { ...field, ...values } : field) }
        : event),
    }))
  }
  function toggleProduct(eventIndex: number, productId: string) {
    const event = draft.eventTypes[eventIndex]
    const productIds = new Set(event.productIds ?? [])
    if (productIds.has(productId)) productIds.delete(productId)
    else productIds.add(productId)
    updateEvent(eventIndex, { productIds: [...productIds] })
  }
  function addEvent() {
    setDraft((current) => ({ ...current, eventTypes: [...current.eventTypes, { key: '', label: '', description: '', fields: [] }] }))
  }
  function addField(eventIndex: number) {
    setDraft((current) => ({
      ...current,
      eventTypes: current.eventTypes.map((event, index) => index === eventIndex
        ? { ...event, fields: [...event.fields, { key: '', label: '', description: '', type: 'string', role: 'dimension', required: false }] }
        : event),
    }))
  }
  async function publish() {
    setError('')
    setMessage('')
    const missingProductLinks = draft.eventTypes
      .map((event, index) => event.productIds?.length ? undefined : `Event type ${index + 1} (${event.label || event.key || 'unnamed'}) must be linked to at least one product`)
      .filter((issue): issue is string => issue !== undefined)
    if (missingProductLinks.length > 0) {
      setError(missingProductLinks.join('; '))
      return
    }
    if (products.error) {
      setError(`Cannot validate product links: ${products.error}`)
      return
    }
    setSaving(true)
    try {
      const next = { ...draft, version: available ? contract.version + 1 : 1 }
      await apiRequest(apiUrl, '/v1/admin/event-contract', { method: 'PUT', body: next })
      await onSaved()
      setMessage(`Contract version ${next.version} is now active.`)
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setSaving(false)
    }
  }
  return (
    <ResourceLayout eyebrow="CONFIGURE" title="Event contract" intro="Tell your integration what business events and fields to send, and select which products can generate each event. Published versions are preserved so historical data keeps its meaning." count={draft.eventTypes.length} countLabel="event types">
      <div className="contract-notice"><span className="notice-icon">i</span><span><strong>Juu handles standard fields.</strong> Sender location is captured only when your partner app has permission. Your company does not receive sender names, phone numbers, or recipient identity in map views.</span></div>
      <section className="surface contract-surface">
        <div className="contract-heading"><div><SectionTitle title={available ? `Active version ${contract.version}` : 'Create your first contract'} copy="Define the values that give your performance reports meaning." /></div><span className="version-pill">{available ? `v${contract.version}` : 'Not published'}</span></div>
        <div className="capture-grid">
          <FormField label="Sender location"><select value={draft.standardFields.senderLocation} onChange={(event) => setDraft((current) => ({ ...current, standardFields: { ...current.standardFields, senderLocation: event.target.value as CaptureMode } }))}><option value="disabled">Disabled</option><option value="optional">Optional</option><option value="required">Required</option></select><small>GPS coordinates supplied by the partner app with user permission.</small></FormField>
          <FormField label="Reporting location"><select value={draft.standardFields.reportingLocation} onChange={(event) => setDraft((current) => ({ ...current, standardFields: { ...current.standardFields, reportingLocation: event.target.value as CaptureMode } }))}><option value="disabled">Disabled</option><option value="optional">Optional</option><option value="required">Required</option></select><small>Juu location ID assigned to the event by your partner.</small></FormField>
        </div>
        {draft.eventTypes.length === 0 && <div className="empty-inline">Add an event type to describe what the partner system should send.</div>}
        <div className="event-list">
          {draft.eventTypes.map((event, eventIndex) => (
            <article className="event-card" key={`event-${eventIndex}`}>
              <div className="event-card-heading"><span className="event-index">{String(eventIndex + 1).padStart(2, '0')}</span><strong>Event type</strong><button className="text-danger" onClick={() => setDraft((current) => ({ ...current, eventTypes: current.eventTypes.filter((_, index) => index !== eventIndex) }))}>Remove</button></div>
              <div className="inline-fields three-fields">
                <FormField label="Stable key" required><input value={event.key} onChange={(change) => updateEvent(eventIndex, { key: change.target.value })} placeholder="money_transfer" /></FormField>
                <FormField label="Display name" required><input value={event.label} onChange={(change) => updateEvent(eventIndex, { label: change.target.value })} placeholder="Money transfer" /></FormField>
                <FormField label="Description" required><input value={event.description} onChange={(change) => updateEvent(eventIndex, { description: change.target.value })} placeholder="A completed money transfer" /></FormField>
              </div>
              <div className="event-product-links">
                <strong>Products that use this event</strong>
                {products.loading && <small>Loading company products…</small>}
                {products.error && <ErrorBanner message={`Unable to load products: ${products.error}`} />}
                {!products.loading && !products.error && products.items.length === 0 && <small>Add a company product before linking an event type.</small>}
                <div className="event-product-options">
                  {products.items.map((product) => {
                    const selected = event.productIds?.includes(product.id) ?? false
                    return (
                      <label className={!product.active ? 'is-inactive' : ''} key={product.id}>
                        <input
                          type="checkbox"
                          checked={selected}
                          disabled={!product.active && !selected}
                          onChange={() => toggleProduct(eventIndex, product.id)}
                        />
                        <span>{product.name}{product.active ? '' : ' (inactive)'}</span>
                      </label>
                    )
                  })}
                </div>
                <small>Select every product that can legitimately generate this event. At least one active product is required.</small>
              </div>
              <div className="field-list-label"><span>Custom fields</span><span>Choose the type and display label your team will recognize.</span></div>
              {event.fields.map((field, fieldIndex) => (
                <div className="field-editor" key={`field-${fieldIndex}`}>
                  <input aria-label="Field stable key" value={field.key} onChange={(change) => updateField(eventIndex, fieldIndex, { key: change.target.value })} placeholder="API key (e.g. transfer_amount)" title="Stable field name sent by the integration" />
                  <input aria-label="Field display label" value={field.label} onChange={(change) => updateField(eventIndex, fieldIndex, { label: change.target.value })} placeholder="Display label (e.g. Transfer Amount)" title="Readable name shown to company users" />
                  <input aria-label="Field description" value={field.description} onChange={(change) => updateField(eventIndex, fieldIndex, { description: change.target.value })} placeholder="Describe this value" />
                  <select aria-label="Field type" value={field.type} onChange={(change) => {
                    const type = change.target.value as FieldType
                    updateField(eventIndex, fieldIndex, { type, role: type === 'number' ? 'measure' : type === 'string' ? 'dimension' : 'dimension', aggregation: type === 'number' ? 'sum' : undefined })
                  }}><option value="number">Number</option><option value="string">Text</option><option value="boolean">Yes / no</option></select>
                  <select aria-label="Field role" value={field.role} onChange={(change) => {
                    const role = change.target.value as FieldRole
                    let type = field.type
                    if (role === 'measure') type = 'number'
                    if (role === 'pseudonymous_id') type = 'string'
                    updateField(eventIndex, fieldIndex, { role, type, aggregation: role === 'measure' ? (field.aggregation ?? 'sum') : undefined })
                  }}><option value="measure">Measure</option><option value="dimension">Dimension</option><option value="pseudonymous_id">Pseudonymous ID</option></select>
                  <input aria-label="Unit or currency" value={field.unit ?? ''} onChange={(change) => updateField(eventIndex, fieldIndex, { unit: change.target.value || undefined })} placeholder="Unit" />
                  {field.role === 'measure' && <select aria-label="Aggregation" value={field.aggregation ?? 'sum'} onChange={(change) => updateField(eventIndex, fieldIndex, { aggregation: change.target.value as Aggregation })}><option value="sum">Sum</option><option value="count">Count</option><option value="average">Average</option><option value="min">Minimum</option><option value="max">Maximum</option></select>}
                  <label className="required-toggle"><input type="checkbox" checked={field.required} onChange={(change) => updateField(eventIndex, fieldIndex, { required: change.target.checked })} /> Required</label>
                  <button className="icon-button remove-field" aria-label="Remove field" title="Remove this custom field" onClick={() => updateEvent(eventIndex, { fields: event.fields.filter((_, index) => index !== fieldIndex) })}>×</button>
                </div>
              ))}
              <button className="small-outline" onClick={() => addField(eventIndex)}>＋ Add custom field</button>
            </article>
          ))}
        </div>
        <div className="contract-actions"><button className="secondary-button" onClick={addEvent}>＋ Add event type</button><button className="primary-button" onClick={publish} disabled={saving || products.loading || draft.eventTypes.length === 0 || products.items.filter((product) => product.active).length === 0}>{saving ? 'Publishing…' : 'Publish new version'} <span>→</span></button></div>
        {message && <p className="success-message" role="status">{message}</p>}
        {error && <ErrorBanner message={error} />}
      </section>
    </ResourceLayout>
  )
}

function MetricsPage({ apiUrl, contract, onNavigate }: { apiUrl: string; contract: EventContract; onNavigate: (page: string) => void }) {
  const collection = useCollection<Metric>(apiUrl, 'metrics')
  const products = useCollection<Product>(apiUrl, 'products')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [unit, setUnit] = useState('')
  const [direction, setDirection] = useState<Metric['direction']>('higher')
  const [aggregation, setAggregation] = useState<NonNullable<Metric['aggregation']>>('sum')
  const [eventType, setEventType] = useState('')
  const [operator, setOperator] = useState<'field' | 'add' | 'subtract' | 'multiply' | 'divide'>('field')
  const [left, setLeft] = useState('')
  const [right, setRight] = useState('')
  const [saving, setSaving] = useState(false)
  const selectedEvent = contract.eventTypes.find((item) => item.key === eventType)
  const measures = selectedEvent?.fields.filter((field) => field.type === 'number' && field.role === 'measure') ?? []
  const contractReady = contract.eventTypes.length > 0
  useEffect(() => {
    if (!eventType && contract.eventTypes[0]) setEventType(contract.eventTypes[0].key)
  }, [contract.eventTypes, eventType])
  useEffect(() => {
    if (measures.length && !measures.some((field) => field.key === left)) setLeft(measures[0].key)
    if (measures.length && !measures.some((field) => field.key === right)) setRight(measures[Math.min(1, measures.length - 1)].key)
  }, [measures, left, right])
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!left || (operator !== 'field' && !right)) {
      collection.setError('Choose the numeric measure fields for this formula.')
      return
    }
    const formula: Formula = operator === 'field'
      ? { type: 'field', key: left }
      : { type: 'operation', operator, operands: [{ type: 'field', key: left }, { type: 'field', key: right }] }
    setSaving(true)
    try {
      await apiRequest(apiUrl, '/v1/admin/config/metrics', { method: 'POST', body: { name, description, unit, direction, eventType, formula, aggregation } })
      setName('')
      setDescription('')
      setUnit('')
      await collection.refresh()
    } catch (error) {
      collection.setError(errorMessage(error))
    } finally {
      setSaving(false)
    }
  }
  return (
    <ResourceLayout eyebrow="CONFIGURE" title="Metrics" intro="Define the event-based measures your company can use in targets and performance reports." count={collection.items.length}>
      {!contractReady && <div className="callout-warning"><strong>Publish an event contract first.</strong> Metrics use its numeric measure fields. <button onClick={() => onNavigate('contract')}>Set up your contract →</button></div>}
      <div className="resource-grid">
        <section className="surface form-surface">
          <SectionTitle title="Define a metric" copy="Use a field directly or combine two fields." />
          <form className="stack-form" onSubmit={submit}>
            <FormField label="Metric name" required><input value={name} onChange={(event) => setName(event.target.value)} maxLength={128} placeholder="e.g. Net revenue" required /></FormField>
            <FormField label="What does it mean?" required><textarea value={description} onChange={(event) => setDescription(event.target.value)} maxLength={512} rows={2} placeholder="Explain what this metric tells your team." required /></FormField>
            <div className="inline-fields"><FormField label="Unit" required><input value={unit} onChange={(event) => setUnit(event.target.value)} maxLength={32} placeholder="KES, transactions…" required /></FormField><FormField label="Better when" required><select value={direction} onChange={(event) => setDirection(event.target.value as Metric['direction'])}><option value="higher">Higher</option><option value="lower">Lower</option></select></FormField></div>
            <FormField label="Aggregate event results" required><select value={aggregation} onChange={(event) => setAggregation(event.target.value as NonNullable<Metric['aggregation']>)}><option value="sum">Sum</option><option value="average">Average</option><option value="min">Minimum</option><option value="max">Maximum</option><option value="count">Count valid events</option></select></FormField>
            <FormField label="Event type" required><select value={eventType} onChange={(event) => setEventType(event.target.value)} disabled={!contractReady}><option value="">Select an event</option>{contract.eventTypes.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}</select></FormField>
            <div className="formula-block"><span className="formula-label">CALCULATION</span><div className="formula-fields"><select aria-label="Formula operation" value={operator} onChange={(event) => setOperator(event.target.value as typeof operator)}><option value="field">Use field</option><option value="add">Add</option><option value="subtract">Subtract</option><option value="multiply">Multiply</option><option value="divide">Divide</option></select><select aria-label="First measure field" value={left} onChange={(event) => setLeft(event.target.value)} disabled={!measures.length}><option value="">Choose a measure</option>{measures.map((field) => <option key={field.key} value={field.key}>{field.label}</option>)}</select>{operator !== 'field' && <><span className="formula-operator">{operatorSymbol(operator)}</span><select aria-label="Second measure field" value={right} onChange={(event) => setRight(event.target.value)} disabled={!measures.length}><option value="">Choose a measure</option>{measures.map((field) => <option key={field.key} value={field.key}>{field.label}</option>)}</select></>}</div><small>Only numeric fields marked as measures can be used.</small></div>
            <button className="primary-button" disabled={saving || !contractReady || !measures.length}>{saving ? 'Creating…' : 'Create metric'} <span>＋</span></button>
          </form>
        </section>
        <section className="surface list-surface">
          <SectionTitle title="Your metrics" copy="Metrics and their formula stay immutable after creation." />
          <ResourceState loading={collection.loading || products.loading} error={collection.error || products.error} empty={!collection.items.length} emptyText="Your metric definitions will appear here." onRetry={() => { void collection.refresh(); void products.refresh() }} />
          <div className="resource-list">{collection.items.map((item) => {
            const calculationDescription = item.calculation
              ? item.calculation.operands.map((operand) => {
                const component = collection.items.find((metric) => metric.id === operand.metricId)
                const product = products.items.find((entry) => entry.id === operand.productId)
                return `${product?.name ?? 'Product'} · ${component?.name ?? 'Metric'}`
              }).join(` ${operatorSymbol(item.calculation.operator)} `)
              : `${item.aggregation ?? 'sum'} · ${item.formula ? formulaLabel(item.formula, contract) : 'Event metric'}`
            return <ResourceRow key={item.id} title={item.name} subtitle={`${item.unit} · ${calculationDescription} · ${item.direction === 'higher' ? 'higher is better' : 'lower is better'}`} id={item.id} active={item.active} onToggle={() => collection.toggle(item)} />
          })}</div>
        </section>
      </div>
    </ResourceLayout>
  )
}

function OrganizationPage({ apiUrl, companyName }: { apiUrl: string; companyName: string }) {
  const collection = useCollection<OrganizationUnit>(apiUrl, 'org-units')
  const [name, setName] = useState('')
  const [unitType, setUnitType] = useState('')
  const [parentUnitId, setParentUnitId] = useState('')
  const [jurisdiction, setJurisdiction] = useState<GeoBoundarySelection>()
  const [showJurisdictionPicker, setShowJurisdictionPicker] = useState(false)
  const [leaderEmail, setLeaderEmail] = useState('')
  const [leaderName, setLeaderName] = useState('')
  const [leaderPhoneNumber, setLeaderPhoneNumber] = useState('')
  const [leaderContactAttempted, setLeaderContactAttempted] = useState(false)
  const [leaderUnitId, setLeaderUnitId] = useState('')
  const [recentlyCreatedUnitId, setRecentlyCreatedUnitId] = useState('')
  const [recentlyInvitedLeaderEmail, setRecentlyInvitedLeaderEmail] = useState('')
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')

  useEffect(() => {
    const unassignedUnits = collection.items.filter((unit) =>
      unit.active && !unit.leaderContacts?.length && !unit.leaders?.length)
    if (!leaderUnitId && unassignedUnits.length) {
      setLeaderUnitId(unassignedUnits.find((unit) => unit.id === recentlyCreatedUnitId)?.id ?? unassignedUnits[0].id)
    } else if (leaderUnitId && !unassignedUnits.some((unit) => unit.id === leaderUnitId)) {
      setLeaderUnitId(unassignedUnits[0]?.id ?? '')
    }
  }, [collection.items, leaderUnitId, recentlyCreatedUnitId])

  async function createUnit(event: FormEvent) {
    event.preventDefault()
    setSaving(true)
    collection.setError('')
    setMessage('')
    try {
      const result = await apiRequest<{ item: OrganizationUnit }>(apiUrl, '/v1/admin/config/org-units', {
        method: 'POST',
        body: {
          name,
          type: unitType,
          ...(parentUnitId ? { parentUnitId } : {}),
          ...(jurisdiction ? { jurisdiction } : {}),
        },
      })
      setName('')
      setUnitType('')
      setParentUnitId('')
      setJurisdiction(undefined)
      setShowJurisdictionPicker(false)
      await collection.refresh()
      setRecentlyCreatedUnitId(result.item.id)
      setLeaderUnitId(result.item.id)
      setMessage(`${result.item.name} created. It is selected below for a leader invitation.`)
    } catch (error) {
      collection.setError(errorMessage(error))
    } finally {
      setSaving(false)
    }
  }

  async function inviteLeader(event: FormEvent) {
    event.preventDefault()
    setLeaderContactAttempted(true)
    setSaving(true)
    collection.setError('')
    setMessage('')
    try {
      const result = await apiRequest<{ invitedLeader: string; message: string }>(
        apiUrl,
        `/v1/admin/org-units/${encodeURIComponent(leaderUnitId)}/leaders`,
        { method: 'POST', body: { leaderEmail, leaderName, leaderPhoneNumber } },
      )
      setLeaderEmail('')
      setLeaderName('')
      setLeaderPhoneNumber('')
      setLeaderContactAttempted(false)
      setRecentlyInvitedLeaderEmail(result.invitedLeader.toLowerCase())
      setRecentlyCreatedUnitId('')
      await collection.refresh()
      setMessage(result.message)
    } catch (error) {
      collection.setError(errorMessage(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <ResourceLayout eyebrow="CONFIGURE" title="Organization & jurisdictions" intro="Build nested team accountability for your company. Leaders sign in with their own account and can only report on their unit and its descendants." count={collection.items.length} countLabel="units">
      <div className="resource-grid">
        <section className="surface form-surface">
          <SectionTitle title="Add an organization unit" copy="Use as many levels of teams or regions as your company needs." />
          <form className="stack-form" onSubmit={createUnit}>
            <div className="optional-jurisdiction">
              <div className="optional-jurisdiction-heading">
                <span>
                  <strong>Geographical jurisdiction <small>Optional</small></strong>
                  <small>Add this only if the unit is responsible for a defined place. You can leave it blank for non-geographic teams.</small>
                </span>
                {jurisdiction ? (
                  <div className="optional-jurisdiction-actions">
                    <button type="button" className="text-button" onClick={() => setShowJurisdictionPicker((open) => !open)}>
                      {showJurisdictionPicker ? 'Close map' : 'Change'}
                    </button>
                    <button type="button" className="text-button" onClick={() => { setJurisdiction(undefined); setShowJurisdictionPicker(false) }}>
                      Remove
                    </button>
                  </div>
                ) : (
                  <button type="button" className="secondary-button" onClick={() => setShowJurisdictionPicker((open) => !open)}>
                    {showJurisdictionPicker ? 'Skip jurisdiction' : 'Add jurisdiction'}
                  </button>
                )}
              </div>
              {jurisdiction && (
                <p className="optional-jurisdiction-selection">
                  Selected: <strong>{jurisdiction.boundaryName}</strong>
                  <small>
                    {jurisdiction.boundaryLevel === 'CONTINENT'
                      ? 'Continent'
                      : jurisdiction.boundaryLevel === 'COUNTRY'
                        ? `Country${jurisdiction.continent ? ` · ${jurisdiction.continent}` : ''}`
                        : `${jurisdiction.boundaryCanonical ?? jurisdiction.boundaryLevel}${jurisdiction.countryName ? ` · ${jurisdiction.countryName}` : ''}`}
                  </small>
                </p>
              )}
              {showJurisdictionPicker && (
                <GeoBoundaryPicker
                  value={jurisdiction}
                  onChange={(selection) => {
                    setJurisdiction(selection)
                    if (selection) setShowJurisdictionPicker(false)
                  }}
                />
              )}
            </div>
            <FormField label="Unit name" required><input value={name} onChange={(event) => setName(event.target.value)} maxLength={128} placeholder="e.g. Mwea team" required /></FormField>
            <FormField label="Unit type" required><input value={unitType} onChange={(event) => setUnitType(event.target.value)} maxLength={64} placeholder="e.g. County director, sales team" required /></FormField>
            <FormField label="Parent unit"><select value={parentUnitId} onChange={(event) => setParentUnitId(event.target.value)}><option value="">Top-level unit</option>{collection.items.filter((unit) => unit.active).map((unit) => <option key={unit.id} value={unit.id}>{unit.name}</option>)}</select></FormField>
            <button className="primary-button" disabled={saving}>{saving ? 'Saving…' : 'Add unit'} <span>＋</span></button>
          </form>
        </section>
        <section className="surface list-surface">
          <SectionTitle title="Your organization" copy="Select a unit to see its reporting line, jurisdiction, and invited leader contact details." />
          <ResourceState loading={collection.loading} error={collection.error} empty={!collection.items.length} emptyText="No organization units yet. Add a top-level team or jurisdiction." onRetry={collection.refresh} />
          {!collection.loading && !collection.error && collection.items.length > 0 && (
            <OrganizationDirectory
              units={collection.items}
              initialUnitId={collection.items.find((unit) => !unit.parentUnitId)?.id}
              highlightedUnitId={recentlyCreatedUnitId}
              highlightedLeaderEmail={recentlyInvitedLeaderEmail}
              title="Company reporting tree"
              description="Choose any team at any level to view its details."
            />
          )}
          {message && <p className="success-message" role="status">{message}</p>}
        </section>
      </div>
      <section className="surface invite-leader">
        <SectionTitle
          title="Invite a team leader"
          copy={`Invitations are for ${companyName} and are linked to this company automatically. The leader's email is required; name and phone number are optional contact details.`}
        />
        <form className="inline-fields" onSubmit={inviteLeader}>
          <FormField label="Organization unit without an invited leader" required><select value={leaderUnitId} onChange={(event) => setLeaderUnitId(event.target.value)} required><option value="">Choose an unassigned unit</option>{collection.items.filter((unit) => unit.active && !unit.leaderContacts?.length && !unit.leaders?.length).map((unit) => <option key={unit.id} value={unit.id}>{unit.name}{unit.id === recentlyCreatedUnitId ? ' · just created' : ''}</option>)}</select></FormField>
          <FormField label="Leader full name (optional)"><input value={leaderName} onChange={(event) => setLeaderName(event.target.value)} maxLength={128} autoComplete="name" /></FormField>
          <FormField label="Leader email" required><input type="email" value={leaderEmail} onChange={(event) => setLeaderEmail(event.target.value)} maxLength={254} required /></FormField>
          <FormField label="Leader phone number (optional)"><input type="tel" value={leaderPhoneNumber} onChange={(event) => setLeaderPhoneNumber(event.target.value)} maxLength={16} pattern="[+][1-9][0-9]{1,14}" title="Use international format, for example +254711852707" placeholder="+254711852707" autoComplete="tel" /></FormField>
          {!collection.items.some((unit) => unit.active && !unit.leaderContacts?.length && !unit.leaders?.length) && (
            <p className="form-hint invite-leader-empty">All active organization units already have an invited leader. Create another unit to invite a new leader.</p>
          )}
          <button className="primary-button" disabled={saving || !leaderUnitId}>{saving ? 'Sending…' : 'Send invitation'} <span>→</span></button>
          {leaderContactAttempted && (!leaderName.trim() || !leaderPhoneNumber.trim()) && (
            <div className="callout-warning invite-contact-warning" role="alert">
              <strong>Contact details missing.</strong> The invitation will still be sent by email, but any blank name or phone number will not be available in the organization list.
            </div>
          )}
        </form>
      </section>
    </ResourceLayout>
  )
}

function PerformancePage({ apiUrl }: { apiUrl: string }) {
  const metrics = useCollection<Metric>(apiUrl, 'metrics')
  const products = useCollection<Product>(apiUrl, 'products')
  const units = useCollection<OrganizationUnit>(apiUrl, 'org-units')
  const targets = useCollection<Target>(apiUrl, 'targets')
  const [metricId, setMetricId] = useState('')
  const [orgUnitId, setOrgUnitId] = useState('')
  const [from, setFrom] = useState(() => dateOffset(-29))
  const [to, setTo] = useState(() => dateOffset(0))
  const [report, setReport] = useState<PerformanceReport>()
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    if (!metricId && metrics.items.some((metric) => metric.active)) {
      setMetricId(metrics.items.find((metric) => metric.active)?.id ?? '')
    }
  }, [metrics.items, metricId])

  async function runReport(event: FormEvent) {
    event.preventDefault()
    setLoading(true)
    setError('')
    try {
      const query = new URLSearchParams({ metricId, from, to, bucket: 'day' })
      if (orgUnitId) query.set('orgUnitId', orgUnitId)
      const result = await apiRequest<{ report: PerformanceReport }>(
        apiUrl,
        `/v1/admin/performance?${query.toString()}`,
      )
      setReport(result.report)
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setLoading(false)
    }
  }

  const selectedMetric = metrics.items.find((metric) => metric.id === metricId)
  return (
    <ResourceLayout eyebrow="WORKSPACE" title="Performance" intro="Compare measured activity over time, optionally limited to a team and its descendants." count={report?.summary.matchedEvents ?? 0} countLabel={report?.calculation?.kind === 'metric-operation' ? 'calculated periods' : 'matched events'}>
      <form className="surface performance-filters" onSubmit={runReport}>
        <div className="inline-fields">
          <FormField label="Metric" required><select value={metricId} onChange={(event) => setMetricId(event.target.value)} required><option value="">Choose a metric</option>{metrics.items.filter((metric) => metric.active).map((metric) => <option key={metric.id} value={metric.id}>{metric.name} ({metric.unit})</option>)}</select></FormField>
          <FormField label="Organization unit"><select value={orgUnitId} onChange={(event) => setOrgUnitId(event.target.value)}><option value="">Entire company</option>{units.items.filter((unit) => unit.active).map((unit) => <option key={unit.id} value={unit.id}>{unit.name}</option>)}</select></FormField>
          <FormField label="From" required><input type="date" value={from} onChange={(event) => setFrom(event.target.value)} required /></FormField>
          <FormField label="To" required><input type="date" value={to} onChange={(event) => setTo(event.target.value)} required /></FormField>
        </div>
        <button className="primary-button" disabled={loading || !metricId}>{loading ? 'Loading…' : 'Run report'} <span>↗</span></button>
      </form>
      {error && <ErrorBanner message={error} />}
      {(metrics.error || products.error || units.error || targets.error) && <ErrorBanner message={metrics.error || products.error || units.error || targets.error} />}
      {report && (
        <section className="surface performance-results">
          <div className="performance-total"><span className="eyebrow">TOTAL · {report.metric.name || selectedMetric?.name || 'METRIC'}</span><strong>{report.summary.value ?? '—'} <small>{report.metric.unit || selectedMetric?.unit}</small></strong><span>{report.calculation?.kind === 'metric-operation' ? `${report.summary.calculatedEvents} reporting periods calculated` : report.calculation?.kind === 'percentage-of-reference' ? `${report.summary.calculatedEvents} periods compared · ${report.calculation.zeroReferencePeriods ?? 0} zero-reference periods and ${report.calculation.missingReferencePeriods ?? 0} periods without reference data excluded` : `${report.summary.calculatedEvents} calculated of ${report.summary.matchedEvents} matching events`}</span></div>
          <div className="table-wrap"><table><thead><tr><th>PERIOD</th><th>VALUE</th><th>EVENTS</th></tr></thead><tbody>{report.timeSeries.map((period) => <tr key={period.period}><td>{period.period}</td><td>{period.value}</td><td>{period.events}</td></tr>)}</tbody></table></div>
        </section>
      )}
      {!report && !error && <div className="empty-state"><span className="empty-mark">↗</span><p>Choose a metric and date range to view your company's performance.</p></div>}
      <CombinedProductAnalysis
        apiUrl={apiUrl}
        endpoint="/v1/admin/performance/combined"
        metrics={metrics.items}
        products={products.items}
        targets={targets.items}
        organizationUnits={units.items}
      />
    </ResourceLayout>
  )
}

function BillingPage({ apiUrl }: { apiUrl: string }) {
  const [billing, setBilling] = useState<BillingSummary>()
  const [loading, setLoading] = useState(true)
  const [downloading, setDownloading] = useState('')
  const [error, setError] = useState('')

  const refresh = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      setBilling(await apiRequest<BillingSummary>(apiUrl, '/v1/admin/billing'))
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setLoading(false)
    }
  }, [apiUrl])

  useEffect(() => { void refresh() }, [refresh])

  async function downloadInvoice(month: string) {
    setDownloading(month)
    setError('')
    try {
      const result = await apiRequest<{ filename: string; contentBase64: string }>(
        apiUrl,
        `/v1/admin/billing/invoices/${encodeURIComponent(month)}/pdf`,
      )
      const bytes = Uint8Array.from(atob(result.contentBase64), (character) => character.charCodeAt(0))
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }))
      const link = document.createElement('a')
      link.href = url
      link.download = result.filename
      link.click()
      URL.revokeObjectURL(url)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setDownloading('')
    }
  }

  async function payInvoice(invoice: BillingSummary['invoices'][number]) {
    if (invoice.checkoutUrl) {
      window.location.assign(invoice.checkoutUrl)
      return
    }
    setDownloading(invoice.month)
    setError('')
    try {
      const result = await apiRequest<{ checkoutUrl: string }>(
        apiUrl,
        `/v1/admin/billing/invoices/${encodeURIComponent(invoice.month)}/checkout`,
        { method: 'POST' },
      )
      window.location.assign(result.checkoutUrl)
    } catch (cause) {
      setError(errorMessage(cause))
      setDownloading('')
    }
  }

  async function refreshPaymentStatus(month: string) {
    setDownloading(month)
    setError('')
    try {
      await apiRequest<{ paymentStatus: string }>(
        apiUrl,
        `/v1/admin/billing/invoices/${encodeURIComponent(month)}/payment-status`,
      )
      await refresh()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setDownloading('')
    }
  }

  return (
    <ResourceLayout eyebrow="WORKSPACE" title="Billing & usage" intro="Review monthly charges for accepted partner data calls and successful performance presentation reads. Company setup and configuration are not billable. Invoices are due after a seven-day grace period; pay through Pesapal using the methods enabled for Juu's account." count={billing?.invoices.length ?? 0} countLabel="invoices">
      {error && <ErrorBanner message={error} />}
      {loading && <div className="surface executive-empty">Loading billing usage…</div>}
      {!loading && billing && (
        <>
          {!billing.ratesConfigured && (
            <div className="callout-warning">
              <strong>Billing rates are not active.</strong>
              Billable data ingestion and performance presentations are paused until Juu configures rates. No free allowance is applied.
            </div>
          )}
          {!billing.paymentsConfigured && (
            <div className="callout-warning">
              <strong>Online payment is not configured.</strong>
              Billable usage remains paused until Juu configures the Pesapal payment account.
            </div>
          )}
          {billing.paymentsConfigured && !billing.billingEnabled && (
            <div className="callout-warning">
              <strong>Billing is not enabled.</strong>
              Rates and payment setup may be saved, but billable usage remains paused until Juu explicitly enables billing after verifying its payment setup.
            </div>
          )}
          {billing.rates && (
            <div className="surface billing-rate-notice">
              <strong>Current rates</strong>
              <span>Accepted partner data: {formatKes(billing.rates.ingestionKesPer1000)} per 1,000 calls</span>
              <span>Performance presentations: {formatKes(billing.rates.presentationKesPer1000)} per 1,000 successful reads</span>
              {billing.nextRates && (
                <small>Rates change on {billing.nextRates.effectiveMonth}: data {formatKes(billing.nextRates.ingestionKesPer1000)} / 1,000; presentations {formatKes(billing.nextRates.presentationKesPer1000)} / 1,000.</small>
              )}
            </div>
          )}
          {billing.invoices.some((invoice) => invoice.paymentStatus === 'overdue') && (
            <div className="callout-warning">
              <strong>Billable usage is paused.</strong>
              Settle overdue invoices to resume accepted data calls and performance presentations. Billing and setup remain available.
            </div>
          )}
          <section className="billing-summary-grid">
            <article className="surface billing-summary-card">
              <span className="eyebrow">CURRENT MONTH · {billing.currentMonth.month}</span>
              <strong>{billing.currentMonth.estimatedAmountKes === null
                ? 'Rates pending'
                : formatKes(billing.currentMonth.estimatedAmountKes)}</strong>
              <small>Estimated usage charges to date</small>
            </article>
            <article className="surface billing-summary-card">
              <span className="eyebrow">ACCEPTED PARTNER DATA</span>
              <strong>{billing.currentMonth.ingestionCalls.toLocaleString()}</strong>
              <small>Unique accepted event submissions</small>
            </article>
            <article className="surface billing-summary-card">
              <span className="eyebrow">PERFORMANCE PRESENTATIONS</span>
              <strong>{billing.currentMonth.presentationCalls.toLocaleString()}</strong>
              <small>Successful report reads</small>
            </article>
          </section>
          <section className="surface key-table">
            <div className="table-title">
              <SectionTitle title="Monthly invoices" copy="Invoices become available after each calendar month closes. Usage rates are set by Juu and no free usage allowance applies." />
              <button className="secondary-button" onClick={() => { void refresh() }} disabled={loading}>Refresh</button>
            </div>
            {!billing.invoices.length
              ? <p className="muted-copy">No closed billing periods with billable usage yet.</p>
              : (
                <div className="table-wrap">
                  <table>
                    <thead><tr><th>PERIOD</th><th>DATA CALLS</th><th>PRESENTATION READS</th><th>AMOUNT DUE</th><th>STATUS</th><th /></tr></thead>
                    <tbody>{billing.invoices.map((invoice) => (
                      <tr key={invoice.invoiceNumber}>
                        <td>{invoice.month}</td>
                        <td>{invoice.ingestionCalls.toLocaleString()}</td>
                        <td>{invoice.presentationCalls.toLocaleString()}</td>
                        <td>{formatKes(invoice.totalAmountKes)}</td>
                        <td><span className={`status-pill ${invoice.paymentStatus === 'paid' || invoice.paymentStatus === 'no balance' ? 'active' : 'inactive'}`}><span />{invoice.paymentStatus === 'no balance' ? 'No balance' : invoice.paymentStatus}</span>{invoice.paymentSource === 'manual' && <small className="billing-due-date">Recorded by Juu{invoice.paymentMethod ? ` · ${invoice.paymentMethod}` : ''}{invoice.paymentReference ? ` · ${invoice.paymentReference}` : ''}</small>}{invoice.paymentStatus !== 'paid' && invoice.paymentStatus !== 'no balance' && <small className="billing-due-date">Due {formatDate(invoice.dueAt)}</small>}</td>
                        <td className="billing-actions">
                          {invoice.paymentStatus !== 'paid' && invoice.paymentStatus !== 'no balance' && billing.paymentsConfigured && (
                            <button className="primary-button" disabled={downloading === invoice.month} onClick={() => { void payInvoice(invoice) }}>{downloading === invoice.month ? 'Opening…' : invoice.checkoutUrl ? 'Continue payment' : 'Pay invoice'}</button>
                          )}
                          {invoice.paymentStatus !== 'paid' && invoice.paymentStatus !== 'no balance' && !billing.paymentsConfigured && (
                            <span className="billing-contact-copy">Contact Juu to arrange payment.</span>
                          )}
                          {(invoice.paymentStatus === 'pending' || invoice.paymentStatus === 'failed') && (
                            <button className="secondary-button" disabled={downloading === invoice.month} onClick={() => { void refreshPaymentStatus(invoice.month) }}>Refresh status</button>
                          )}
                          <button className="secondary-button" disabled={downloading === invoice.month} onClick={() => { void downloadInvoice(invoice.month) }}>{downloading === invoice.month ? 'Preparing…' : 'Download PDF'}</button>
                        </td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
              )}
          </section>
        </>
      )}
    </ResourceLayout>
  )
}

function TargetsPage({ apiUrl }: { apiUrl: string }) {
  const collection = useCollection<Target>(apiUrl, 'targets')
  const metrics = useCollection<Metric>(apiUrl, 'metrics')
  const products = useCollection<Product>(apiUrl, 'products')
  const locations = useCollection<Location>(apiUrl, 'locations')
  const orgUnits = useCollection<OrganizationUnit>(apiUrl, 'org-units')
  const [eligibleProductIds, setEligibleProductIds] = useState<string[]>([])
  const [eligibilityError, setEligibilityError] = useState('')
  useEffect(() => {
    let active = true
    void apiRequest<{ eligibleProductIds: string[] }>(apiUrl, '/v1/admin/config/targets')
      .then((result) => {
        if (active) {
          setEligibleProductIds(result.eligibleProductIds)
          setEligibilityError('')
        }
      })
      .catch((error: unknown) => {
        if (active) setEligibilityError(errorMessage(error))
      })
    return () => { active = false }
  }, [apiUrl])
  const lookupsLoading = metrics.loading || products.loading || locations.loading || orgUnits.loading
  return (
    <ResourceLayout eyebrow="WORKSPACE" title="Company targets" intro="Set the company-wide direction for products you created. Team leaders can set targets only for products targeted by their direct manager." count={collection.items.length}>
      <section className="surface leader-team">
        <SectionTitle title="Set a company-wide target" copy="Targets you create here apply to the whole company and determine which products the top-level team leaders may target." />
        {eligibilityError && <ErrorBanner message={`Unable to load products available for company targets: ${eligibilityError}`} />}
        {!eligibleProductIds.length && !eligibilityError && !products.loading && (
          <div className="callout-warning" role="status">
            <strong>No eligible products yet.</strong> Create an active product in this company workspace before setting its company target.
          </div>
        )}
        <CompanyTargetForm
          apiUrl={apiUrl}
          metrics={metrics.items}
          products={products.items.filter((product) => product.active && eligibleProductIds.includes(product.id))}
          saving={collection.loading || lookupsLoading}
          onSaved={async () => { await collection.refresh() }}
          onError={(message) => collection.setError(message)}
        />
      </section>
      <section className="surface list-surface">
        <SectionTitle title="Company target register" copy="Targets are tied to their creator, product and metric, and the organization unit they apply to. Company-wide targets have no specific unit." />
        <ResourceState
          loading={collection.loading || lookupsLoading}
          error={collection.error || metrics.error || products.error || locations.error || orgUnits.error}
          empty={!collection.items.length}
          emptyText="No targets have been created yet. Start by setting company-wide product targets above."
          onRetry={() => { void collection.refresh(); void metrics.refresh(); void products.refresh(); void locations.refresh(); void orgUnits.refresh() }}
        />
        <div className="resource-list">{collection.items.map((item) => {
          const metric = metrics.items.find((entry) => entry.id === item.metricId)
          const referenceMetric = metrics.items.find((entry) => entry.id === item.referenceMetricId)
          const referenceProduct = products.items.find((entry) => entry.id === item.referenceProductId)
          const product = products.items.find((entry) => entry.id === item.productId)
          const location = locations.items.find((entry) => entry.id === item.locationId)
          const orgUnit = orgUnits.items.find((entry) => entry.id === item.orgUnitId)
          const creator = item.createdBy?.name || item.createdBy?.email || 'Officer'
          return (
            <div className={`resource-row ${item.active ? '' : 'is-inactive'}`} key={item.id}>
              <span className="resource-icon">◎</span>
              <span className="resource-copy">
                <strong>{item.productId ? product?.name ?? 'Product' : 'Combined products'} · {metric?.name ?? 'Metric'} · {item.targetValue}{item.targetMode === 'percentage' ? `% of ${referenceProduct?.name ?? 'reference product'} · ${referenceMetric?.name ?? 'reference metric'}` : ` ${metric?.unit ?? ''}`}</strong>
                <small>{orgUnit?.name ?? (item.createdBy?.hierarchyLevel === 'company' ? 'Company-wide' : 'Organization unit')} · {creator} · {item.period} · {item.startDate} to {item.endDate}{location ? ` · ${location.name}` : ''}</small>
                <code>{item.id}</code>
              </span>
              <span className={`status-pill ${item.active ? 'active' : 'inactive'}`}><span />{item.active ? 'Active' : 'Inactive'}</span>
            </div>
          )
        })}</div>
      </section>
    </ResourceLayout>
  )
}

function CompanyTargetForm({
  apiUrl,
  metrics,
  products,
  saving,
  onSaved,
  onError,
}: {
  apiUrl: string
  metrics: Metric[]
  products: Product[]
  saving: boolean
  onSaved: () => Promise<void>
  onError: (message: string) => void
}) {
  const [metricId, setMetricId] = useState('')
  const [productId, setProductId] = useState('')
  const [period, setPeriod] = useState<Target['period']>('month')
  const [targetMode, setTargetMode] = useState<'fixed' | 'percentage'>('fixed')
  const [referenceMetricId, setReferenceMetricId] = useState('')
  const [referenceProductId, setReferenceProductId] = useState('')
  const [targetValue, setTargetValue] = useState('')
  const [startDate, setStartDate] = useState(() => dateOffset(0))
  const [endDate, setEndDate] = useState(() => dateOffset(30))
  const [submitting, setSubmitting] = useState(false)
  const selectedMetric = metrics.find((metric) => metric.id === metricId)
  const selectedReferenceMetric = metrics.find((metric) => metric.id === referenceMetricId)
  const eligibleMetrics = metrics.filter((metric) => metric.active &&
    (metric.calculation
      ? metric.calculation.operands.every((operand) => products.some((product) => product.id === operand.productId))
      : true))

  useEffect(() => {
    if (!productId && products.length) setProductId(products[0].id)
    if (productId && !products.some((product) => product.id === productId)) {
      setProductId(products[0]?.id ?? '')
    }
  }, [productId, products])
  useEffect(() => {
    if (!eligibleMetrics.some((metric) => metric.id === metricId)) {
      setMetricId(eligibleMetrics[0]?.id ?? '')
    }
    if (!metrics.some((metric) => metric.id === referenceMetricId && metric.active && !metric.calculation)) {
      setReferenceMetricId(metrics.find((metric) => metric.active && !metric.calculation)?.id ?? '')
    }
    if (!products.some((product) => product.id === referenceProductId)) {
      setReferenceProductId(products[0]?.id ?? '')
    }
  }, [eligibleMetrics, metricId, metrics, products, referenceMetricId, referenceProductId])

  async function submit(event: FormEvent) {
    event.preventDefault()
    setSubmitting(true)
    onError('')
    try {
      await apiRequest(apiUrl, '/v1/admin/config/targets', {
        method: 'POST',
        body: {
          metricId,
          ...(!selectedMetric?.calculation ? { productId } : {}),
          period,
          startDate,
          endDate,
          targetValue: Number(targetValue),
          targetMode,
          ...(targetMode === 'percentage' ? { referenceMetricId, referenceProductId } : {}),
        },
      })
      setTargetValue('')
      await onSaved()
    } catch (error) {
      onError(errorMessage(error))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form className="stack-form" onSubmit={(event) => { void submit(event) }}>
      <div className="inline-fields">
        {!selectedMetric?.calculation && <FormField label="Product" required><select value={productId} onChange={(event) => setProductId(event.target.value)} required><option value="">Select a product</option>{products.map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}</select></FormField>}
        <FormField label="Metric" required><select value={metricId} onChange={(event) => setMetricId(event.target.value)} required><option value="">Select a metric</option>{eligibleMetrics.map((metric) => <option key={metric.id} value={metric.id}>{metric.name} ({metric.unit})</option>)}</select></FormField>
      </div>
      <FormField label="Target style"><select value={targetMode} onChange={(event) => setTargetMode(event.target.value as typeof targetMode)}><option value="fixed">Fixed value</option><option value="percentage">Percentage of another product metric</option></select></FormField>
      {targetMode === 'percentage' && <div className="inline-fields">
        <FormField label="Reference product" required><select value={referenceProductId} onChange={(event) => setReferenceProductId(event.target.value)} required><option value="">Select a product</option>{products.map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}</select></FormField>
        <FormField label="Reference metric" required><select value={referenceMetricId} onChange={(event) => setReferenceMetricId(event.target.value)} required><option value="">Select a metric</option>{metrics.filter((metric) => metric.active && !metric.calculation).map((metric) => <option key={metric.id} value={metric.id}>{metric.name} ({metric.unit})</option>)}</select></FormField>
      </div>}
      <div className="inline-fields">
        <FormField label="Reporting period"><select value={period} onChange={(event) => setPeriod(event.target.value as Target['period'])}><option value="day">Day</option><option value="week">Week</option><option value="month">Month</option><option value="quarter">Quarter</option><option value="year">Year</option></select></FormField>
        <FormField label={targetMode === 'percentage' ? 'Minimum share target (%)' : `Target value (${selectedMetric?.unit ?? 'metric unit'})`} required><input type="number" min={targetMode === 'percentage' ? 0 : undefined} step="any" value={targetValue} onChange={(event) => setTargetValue(event.target.value)} required /></FormField>
      </div>
      <div className="inline-fields">
        <FormField label="Start date" required><input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} required /></FormField>
        <FormField label="End date" required><input type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} required /></FormField>
      </div>
      {targetMode === 'percentage' && selectedMetric && selectedReferenceMetric && selectedMetric.unit !== selectedReferenceMetric.unit && (
        <div className="callout-warning" role="alert"><strong>Units must match.</strong> Percentage targets can only compare metrics with compatible units.</div>
      )}
      <button className="primary-button" disabled={saving || submitting || !products.length || !eligibleMetrics.length || targetMode === 'percentage' && (!referenceMetricId || !referenceProductId || selectedMetric?.unit !== selectedReferenceMetric?.unit)}>
        {submitting ? 'Saving…' : 'Set company target'} <span>＋</span>
      </button>
    </form>
  )
}

function IntegrationKeysPage({ apiUrl }: { apiUrl: string }) {
  const [keys, setKeys] = useState<IntegrationKey[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [newKey, setNewKey] = useState('')
  const [busy, setBusy] = useState(false)
  const refresh = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const result = await apiRequest<{ integrationKeys: IntegrationKey[] }>(apiUrl, '/v1/admin/integration-keys')
      setKeys(result.integrationKeys)
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setLoading(false)
    }
  }, [apiUrl])
  useEffect(() => { refresh().catch((reason: unknown) => setError(errorMessage(reason))) }, [refresh])
  async function createKey() {
    setBusy(true)
    setError('')
    setNewKey('')
    try {
      const result = await apiRequest<{ integrationId: string; key: string; warning: string }>(apiUrl, '/v1/admin/integration-keys', { method: 'POST' })
      setNewKey(result.key)
      await refresh()
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusy(false)
    }
  }
  async function revoke(key: IntegrationKey) {
    if (!window.confirm('Revoke this integration key? Events sent with it will be rejected.')) return
    setBusy(true)
    setError('')
    try {
      await apiRequest(apiUrl, `/v1/admin/integration-keys/${encodeURIComponent(key.integrationId)}`, { method: 'DELETE' })
      await refresh()
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusy(false)
    }
  }
  return (
    <ResourceLayout eyebrow="CONNECT" title="Integration keys" intro="Create credentials for a trusted partner server to send events into your company workspace." count={keys.filter((key) => key.active).length} countLabel="active keys">
      <div className="key-warning"><span className="notice-icon">!</span><div><strong>Keep keys on trusted servers only.</strong><p>Never place an integration key in a browser, Android app, or iPhone app. The key is shown once when created. Use a server-side secret manager and revoke keys immediately if they may have been exposed.</p></div></div>
      {error && <ErrorBanner message={error} />}
      {newKey && <section className="surface one-time-key"><span className="eyebrow">COPY THIS KEY NOW · IT WILL NOT BE SHOWN AGAIN</span><code>{newKey}</code><button className="secondary-button" onClick={() => navigator.clipboard.writeText(newKey).catch(() => setError('Clipboard access failed. Select and copy the key manually.'))}>Copy key</button><button className="icon-button" aria-label="Dismiss key" onClick={() => setNewKey('')}>×</button></section>}
      <section className="surface key-table">
        <div className="table-title"><SectionTitle title="Your credentials" copy="Rotate credentials by creating a replacement, updating your partner server, then revoking the old key." /><button className="primary-button" onClick={createKey} disabled={busy}>{busy ? 'Working…' : 'Create integration key'} <span>＋</span></button></div>
        <ResourceState loading={loading} error={error} empty={!keys.length} emptyText="No integration keys yet." onRetry={refresh} />
        {!!keys.length && <div className="table-wrap"><table><thead><tr><th>STATUS</th><th>CREATED</th><th>INTEGRATION ID</th><th /></tr></thead><tbody>{keys.map((key) => <tr key={key.integrationId}><td><span className={`status-pill ${key.active ? 'active' : 'inactive'}`}><span />{key.active ? 'Active' : 'Revoked'}</span></td><td>{formatDate(key.createdAt)}</td><td><code>{key.integrationId}</code></td><td>{key.active && <button className="text-danger" disabled={busy} onClick={() => revoke(key)}>Revoke</button>}</td></tr>)}</tbody></table></div>}
      </section>
    </ResourceLayout>
  )
}

function DeveloperGuide({ apiUrl, contract }: { apiUrl: string; contract: EventContract }) {
  const [copyError, setCopyError] = useState('')
  const sample = JSON.stringify({
    contractVersion: contract.version || 1,
    eventId: 'partner-transaction-123',
    eventType: contract.eventTypes[0]?.key ?? 'money_transfer',
    occurredAt: new Date().toISOString(),
    productId: '01234567-89ab-4cde-8fab-0123456789ab',
    fields: contract.eventTypes[0]?.fields.length
      ? Object.fromEntries(contract.eventTypes[0].fields.map((field) => [field.key, field.type === 'number' ? 1500 : field.type === 'boolean' ? true : 'example']))
      : { amount: 1500 },
  }, null, 2)
  return (
    <ResourceLayout eyebrow="CONNECT" title="Developer guide" intro="Connect your existing partner backend. Your users do not need to open Juu or change how they transact." count={contract.eventTypes.length} countLabel="event types configured">
      <div className="guide-grid">
        <section className="surface guide-main">
          <SectionTitle title="Send events from your server" copy="The API accepts partner-server requests authenticated with an integration key." />
          <div className="guide-step"><span>1</span><div><strong>Read the active contract</strong><p>Use the admin event-contract API to get the current version and declared fields.</p><code>GET {apiUrl}/v1/admin/event-contract</code></div></div>
          <div className="guide-step"><span>2</span><div><strong>Map existing values</strong><p>Juu-generated product, reporting-location, and organization-unit IDs come from your company admin. Include the optional <code>orgUnitId</code> on an event when your trusted backend can identify the responsible team. Use the stable custom-field keys from the contract.</p></div></div>
          <div className="guide-step"><span>3</span><div><strong>Submit each event</strong><p>Send completed business events from your trusted server—not a public mobile or browser client.</p><pre>{`POST ${apiUrl}/v1/events\nContent-Type: application/json\nx-uppy-api-key: <server-side secret>\n\n${sample}`}</pre></div></div>
          <div className="guide-step"><span>4</span><div><strong>Handle the response</strong><p>A successful event returns <code>202</code>. A repeated event ID returns <code>409</code>; invalid contract data returns <code>422</code>.</p></div></div>
        </section>
        <aside className="surface guide-side">
          <span className="guide-side-icon">◈</span><p className="eyebrow">PRIVACY BY DESIGN</p><h3>Only send what analysis needs.</h3><p>GPS is an optional standard field. The partner app must obtain permission and supply it. Do not send names, phone numbers, recipient identity, or other direct identifiers for map views.</p>
          <div className="guide-divider" /><strong>SDKs are on the roadmap</strong><p>Android, iOS, and web SDKs will follow a secure short-lived credential design. This API key is only for trusted server integrations.</p>
        </aside>
      </div>
      <div className="api-url-card"><span className="api-url-mark">↗</span><span><strong>API base URL</strong><small>Use this base URL for your backend integration.</small></span><code>{apiUrl}</code><button className="secondary-button" onClick={() => navigator.clipboard.writeText(apiUrl).then(() => setCopyError('')).catch(() => setCopyError('Clipboard access failed. Select and copy the URL manually.'))}>Copy</button></div>
      {copyError && <p className="copy-error" role="alert">{copyError}</p>}
    </ResourceLayout>
  )
}

function ComingSoon() {
  return <div className="coming-soon"><span className="coming-icon">↗</span><p className="eyebrow">NEXT UP</p><h1>Performance reporting is in progress.</h1><p>Your company configuration is the foundation. Once the metric calculation and reporting APIs are ready, this is where you’ll explore product trends, target deviations, combined comparisons, clusters, and aggregated map views.</p><span className="status-pill inactive"><span /> Not available yet</span></div>
}

function ResourceLayout({ eyebrow, title, intro, count, countLabel = 'items', children }: { eyebrow: string; title: string; intro: string; count: number; countLabel?: string; children: ReactNode }) {
  return <><div className="resource-heading"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p className="subheading">{intro}</p></div><div className="count-card"><strong>{count}</strong><span>{countLabel}</span></div></div>{children}</>
}

function useCollection<T extends ConfigItem>(apiUrl: string, resource: Resource) {
  const [items, setItems] = useState<T[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const refresh = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      let cursor: string | undefined
      const all: T[] = []
      do {
        const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''
        const result = await apiRequest<{ items: T[]; nextCursor?: string }>(apiUrl, `/v1/admin/config/${resource}${query}`)
        all.push(...result.items)
        cursor = result.nextCursor
      } while (cursor)
      setItems(all)
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setLoading(false)
    }
  }, [apiUrl, resource])
  useEffect(() => { refresh().catch((reason: unknown) => setError(errorMessage(reason))) }, [refresh])
  const toggle = useCallback(async (item: T) => {
    if (item.active && !window.confirm(`Deactivate “${itemName(item)}”? Existing data will be retained.`)) return
    setError('')
    try {
      if (!item.active) {
        let body: Record<string, unknown>
        if (resource === 'products' && 'description' in item) {
          body = { name: item.name, description: item.description, active: true }
        } else if (resource === 'locations' && 'kind' in item) {
          body = {
            name: item.name,
            description: item.description,
            kind: item.kind,
            parentLocationId: item.parentLocationId,
            latitude: item.latitude,
            longitude: item.longitude,
            active: true,
          }
        } else if (resource === 'org-units' && 'type' in item) {
          body = {
            name: item.name,
            type: item.type,
            parentUnitId: item.parentUnitId,
            jurisdiction: item.jurisdiction,
            active: true,
          }
        } else {
          throw new Error('Metrics and targets are immutable. Create a replacement definition instead.')
        }
        await apiRequest(apiUrl, `/v1/admin/config/${resource}/${encodeURIComponent(item.id)}`, { method: 'PUT', body })
      } else {
        await apiRequest(apiUrl, `/v1/admin/config/${resource}/${encodeURIComponent(item.id)}`, { method: 'DELETE' })
      }
      await refresh()
    } catch (reason) {
      setError(errorMessage(reason))
    }
  }, [apiUrl, refresh, resource])
  return { items, loading, error, setError, refresh, toggle }
}

function ResourceState({ loading, error, empty, emptyText, onRetry }: { loading: boolean; error: string; empty: boolean; emptyText: string; onRetry: () => void }) {
  if (loading) return <div className="loading-state"><span className="spinner" /> Loading your company data…</div>
  if (error) return <div className="inline-error"><ErrorBanner message={error} /><button className="text-button" onClick={onRetry}>Try again</button></div>
  if (empty) return <div className="empty-state"><span className="empty-mark">＋</span><p>{emptyText}</p></div>
  return null
}

function ResourceRow({ title, subtitle, id, active, allowRestore = false, onToggle }: { title: string; subtitle: string; id: string; active: boolean; allowRestore?: boolean; onToggle: () => void }) {
  return <div className={`resource-row ${active ? '' : 'is-inactive'}`}><span className="resource-icon">{title.slice(0, 1).toUpperCase()}</span><span className="resource-copy"><strong>{title}</strong><small>{subtitle}</small><code>{id}</code></span><span className={`status-pill ${active ? 'active' : 'inactive'}`}><span />{active ? 'Active' : 'Inactive'}</span>{(active || allowRestore) && <button className={active ? 'text-danger' : 'text-button'} onClick={onToggle}>{active ? 'Deactivate' : 'Restore'}</button>}</div>
}

function SectionTitle({ title, copy }: { title: string; copy: string }) {
  return <div className="section-title"><h2>{title}</h2><p>{copy}</p></div>
}

function FormField({ label, required, children }: { label: string; required?: boolean; children: ReactNode }) {
  return <label className="form-field"><span>{label}{required && <i> *</i>}</span>{children}</label>
}

function ErrorBanner({ message }: { message: string }) {
  return <div className="error-banner" role="alert"><span>!</span>{message}</div>
}

function operatorSymbol(operator: string) {
  return ({ add: '+', subtract: '−', multiply: '×', divide: '÷' } as Record<string, string>)[operator] ?? operator
}

function formulaLabel(formula: Formula, contract: EventContract): string {
  if (formula.type === 'field') {
    return contract.eventTypes.flatMap((event) => event.fields).find((field) => field.key === formula.key)?.label ?? formula.key
  }
  if (formula.type === 'constant') return String(formula.value)
  return `${formulaLabel(formula.operands[0], contract)} ${operatorSymbol(formula.operator)} ${formulaLabel(formula.operands[1], contract)}`
}

function itemName(item: ConfigItem): string {
  return 'name' in item ? item.name : 'Target'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.'
}

function formatDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(date)
}

function dateOffset(days: number): string {
  const date = new Date()
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

function navGlyph(page: string): string {
  return ({
    overview: '⌂',
    products: '◫',
    locations: '⌖',
    organization: '⌂',
    contract: '⌘',
    metrics: '↗',
    targets: '◎',
    integrations: '⌁',
    developer: '</>',
    performance: '▤',
    billing: 'KSh',
  } as Record<string, string>)[page] ?? '·'
}

function isAdminNavigationState(value: unknown): value is { juuAdminPage: string; juuAdminDepth: number } {
  if (typeof value !== 'object' || value === null ||
    !('juuAdminPage' in value) || !('juuAdminDepth' in value)) return false
  return typeof value.juuAdminPage === 'string' &&
    navigation.some((item) => item.id === value.juuAdminPage) &&
    typeof value.juuAdminDepth === 'number' &&
    Number.isInteger(value.juuAdminDepth) &&
    value.juuAdminDepth >= 0
}

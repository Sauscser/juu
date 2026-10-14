import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { apiRequest } from './api'
import { BrandMark } from './BrandMark'

type Company = {
  companyId: string
  name: string
  status: 'active' | 'suspended'
  createdAt: string
  updatedAt?: string
  ceoName?: string
  ceoEmail?: string
  ceoPhoneNumber?: string
}

type BillingRateSettings = {
  configured: boolean
  paymentsConfigured: boolean
  billingEnabled: boolean
  current?: { ingestionKesPer1000: number; presentationKesPer1000: number }
  next?: {
    effectiveMonth: string
    ingestionKesPer1000: number
    presentationKesPer1000: number
  }
}

type ExecutiveCompanyBilling = {
  invoices: Array<{
    invoiceNumber: string
    month: string
    totalAmountKes: number
    paymentStatus: 'paid' | 'pending' | 'failed' | 'overdue' | 'unpaid' | 'no balance'
    paymentSource?: 'manual'
    paidAt?: string
    paymentMethod?: string
    paymentReference?: string
  }>
}

type ExecutiveOutstandingInvoice = {
  companyId: string
  companyName: string
  invoiceNumber: string
  month: string
  dueAt: string
  totalAmountKes: number
  paymentStatus: 'pending' | 'failed' | 'overdue' | 'unpaid'
}

export function ExecutiveApp({
  apiUrl,
  email,
  onSignOut,
}: {
  apiUrl: string
  email: string
  onSignOut: () => void | Promise<void>
}) {
  const [companies, setCompanies] = useState<Company[]>([])
  const [name, setName] = useState('')
  const [adminEmail, setAdminEmail] = useState('')
  const [adminName, setAdminName] = useState('')
  const [adminPhoneNumber, setAdminPhoneNumber] = useState('')
  const [createContactAttempted, setCreateContactAttempted] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [adminEmails, setAdminEmails] = useState<Record<string, string>>({})
  const [adminNames, setAdminNames] = useState<Record<string, string>>({})
  const [adminPhones, setAdminPhones] = useState<Record<string, string>>({})
  const [adminContactAttempts, setAdminContactAttempts] = useState<Record<string, boolean>>({})
  const [statusReasons, setStatusReasons] = useState<Record<string, string>>({})
  const [companyBilling, setCompanyBilling] = useState<Record<string, ExecutiveCompanyBilling>>({})
  const [billingCompanyId, setBillingCompanyId] = useState('')
  const [billingLoadingCompanyId, setBillingLoadingCompanyId] = useState('')
  const [paymentMethods, setPaymentMethods] = useState<Record<string, string>>({})
  const [paymentReferences, setPaymentReferences] = useState<Record<string, string>>({})

  const loadCompanies = useCallback(async () => {
    setLoading(true)
    try {
      const result = await apiRequest<{ companies: Company[] }>(apiUrl, '/v1/executive/companies')
      setCompanies(result.companies)
      setError('')
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setLoading(false)
    }
  }, [apiUrl])

  useEffect(() => {
    void loadCompanies()
  }, [loadCompanies])

  async function createCompany(event: FormEvent) {
    event.preventDefault()
    setCreateContactAttempted(true)
    setSaving(true)
    setError('')
    setMessage('')
    try {
      const result = await apiRequest<{ message: string }>(
        apiUrl,
        '/v1/executive/companies',
        { method: 'POST', body: { companyName: name, adminEmail, adminName, adminPhoneNumber } },
      )
      setName('')
      setAdminEmail('')
      setAdminName('')
      setAdminPhoneNumber('')
      setCreateContactAttempted(false)
      setMessage(result.message)
      await loadCompanies()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setSaving(false)
    }
  }

  async function inviteAdmin(event: FormEvent, company: Company) {
    event.preventDefault()
    const emailToInvite = adminEmails[company.companyId]?.trim()
    const nameToInvite = adminNames[company.companyId]?.trim()
    const phoneToInvite = adminPhones[company.companyId]?.trim()
    if (!emailToInvite) return
    setAdminContactAttempts((current) => ({ ...current, [company.companyId]: true }))
    setSaving(true)
    setError('')
    setMessage('')
    try {
      const result = await apiRequest<{ message: string }>(
        apiUrl,
        `/v1/executive/companies/${encodeURIComponent(company.companyId)}/admins`,
        { method: 'POST', body: {
          adminEmail: emailToInvite,
          adminName: nameToInvite,
          adminPhoneNumber: phoneToInvite,
        } },
      )
      setAdminEmails((current) => ({ ...current, [company.companyId]: '' }))
      setAdminNames((current) => ({ ...current, [company.companyId]: '' }))
      setAdminPhones((current) => ({ ...current, [company.companyId]: '' }))
      setAdminContactAttempts((current) => ({ ...current, [company.companyId]: false }))
      setMessage(result.message)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setSaving(false)
    }
  }

  async function changeStatus(event: FormEvent, company: Company) {
    event.preventDefault()
    const reason = statusReasons[company.companyId]?.trim()
    if (!reason) return
    const nextStatus = company.status === 'active' ? 'suspended' : 'active'
    if (!window.confirm(`${nextStatus === 'suspended' ? 'Suspend' : 'Reactivate'} ${company.name}?`)) {
      return
    }
    setSaving(true)
    setError('')
    setMessage('')
    try {
      const result = await apiRequest<{ changed: boolean }>(
        apiUrl,
        `/v1/executive/companies/${encodeURIComponent(company.companyId)}/status`,
        { method: 'PUT', body: { status: nextStatus, reason } },
      )
      setStatusReasons((current) => ({ ...current, [company.companyId]: '' }))
      setMessage(result.changed ? `${company.name} is now ${nextStatus}.` : `${company.name} is already ${nextStatus}.`)
      await loadCompanies()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setSaving(false)
    }
  }

  async function toggleCompanyBilling(company: Company) {
    if (billingCompanyId === company.companyId) {
      setBillingCompanyId('')
      return
    }
    setBillingCompanyId(company.companyId)
    if (companyBilling[company.companyId]) return
    setBillingLoadingCompanyId(company.companyId)
    setError('')
    try {
      const result = await apiRequest<ExecutiveCompanyBilling>(
        apiUrl,
        `/v1/executive/companies/${encodeURIComponent(company.companyId)}/billing`,
      )
      setCompanyBilling((current) => ({ ...current, [company.companyId]: result }))
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBillingLoadingCompanyId('')
    }
  }

  async function refreshCompanyBilling(company: Company) {
    setBillingLoadingCompanyId(company.companyId)
    setError('')
    try {
      const result = await apiRequest<ExecutiveCompanyBilling>(
        apiUrl,
        `/v1/executive/companies/${encodeURIComponent(company.companyId)}/billing`,
      )
      setCompanyBilling((current) => ({ ...current, [company.companyId]: result }))
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBillingLoadingCompanyId('')
    }
  }

  async function markInvoicePaid(
    event: FormEvent,
    company: Company,
    month: string,
  ) {
    event.preventDefault()
    const method = paymentMethods[`${company.companyId}#${month}`]
    if (!method || !window.confirm(`Record the ${month} invoice for ${company.name} as paid by ${method}?`)) {
      return
    }
    setSaving(true)
    setError('')
    setMessage('')
    try {
      await apiRequest<{ paymentStatus: string }>(
        apiUrl,
        `/v1/executive/companies/${encodeURIComponent(company.companyId)}/billing/invoices/${encodeURIComponent(month)}/mark-paid`,
        {
          method: 'POST',
          body: {
            method,
            reference: paymentReferences[`${company.companyId}#${month}`] ?? '',
          },
        },
      )
      setMessage(`${company.name}'s ${month} invoice has been recorded as paid.`)
      await refreshCompanyBilling(company)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="executive-shell">
      <header className="executive-topbar">
        <a className="brand" href="#">
          <BrandMark />
          <span>Juu<span className="brand-period">.</span></span>
        </a>
        <span className="executive-role">PLATFORM EXECUTIVE</span>
        <div className="executive-account">
          <span title={email}>{email}</span>
          <button className="secondary-button" onClick={() => { void onSignOut() }}>Sign out</button>
        </div>
      </header>
      <main className="executive-content">
        <div className="welcome-row">
          <div>
            <p className="eyebrow">JUU PLATFORM</p>
            <h1>Executive dashboard</h1>
            <p className="subheading">Create company profiles, invite each company’s CEO, and manage company access.</p>
          </div>
          <span className="executive-count">{companies.length} companies</span>
        </div>

        {error && <div className="executive-alert executive-alert-error" role="alert">{error}</div>}
        {message && <div className="executive-alert executive-alert-success" role="status">{message}</div>}

        <BillingRatesPanel apiUrl={apiUrl} />
        <ExecutiveBillingOverview apiUrl={apiUrl} companies={companies} />

        <section className="surface executive-create">
          <div>
            <p className="eyebrow">ONBOARDING</p>
            <h2>Create a company and invite its CEO</h2>
            <p>The company name is saved once. The CEO’s email is required; name and phone number are optional contact details.</p>
          </div>
          <form className="executive-create-form" onSubmit={createCompany}>
            <label>
              Company name
              <input value={name} onChange={(event) => setName(event.target.value)} maxLength={128} required />
            </label>
            <label>
              CEO full name (optional)
              <input value={adminName} onChange={(event) => setAdminName(event.target.value)} maxLength={128} autoComplete="name" />
            </label>
            <label>
              Company CEO email
              <input type="email" value={adminEmail} onChange={(event) => setAdminEmail(event.target.value)} maxLength={254} required />
            </label>
            <label>
              CEO phone number (optional)
              <input type="tel" value={adminPhoneNumber} onChange={(event) => setAdminPhoneNumber(event.target.value)} maxLength={16} pattern="[+][1-9][0-9]{1,14}" title="Use international format, for example +254711852707" placeholder="+254711852707" autoComplete="tel" />
            </label>
            {createContactAttempted && (!adminName.trim() || !adminPhoneNumber.trim()) && (
              <div className="callout-warning executive-contact-warning" role="alert">
                <strong>Contact details missing.</strong> The CEO invitation will still be sent by email, but any blank name or phone number will not be available in the company directory.
              </div>
            )}
            <button className="primary-button" disabled={saving}>{saving ? 'Creating…' : 'Create company & invite CEO'}</button>
          </form>
        </section>

        <section className="executive-company-section">
          <div className="executive-section-heading">
            <div><p className="eyebrow">COMPANY DIRECTORY</p><h2>Company workspaces</h2></div>
            <button className="secondary-button" onClick={() => { void loadCompanies() }} disabled={loading}>Refresh</button>
          </div>
          {loading && <div className="surface executive-empty">Loading company workspaces…</div>}
          {!loading && companies.length === 0 && !error && (
            <div className="surface executive-empty">No companies yet. Create the first company workspace above.</div>
          )}
          {!loading && companies.map((company) => (
            <article className="surface executive-company" key={company.companyId}>
              <div className="executive-company-heading">
                <div>
                  <h3>{company.name}</h3>
                  <code>{company.companyId}</code>
                </div>
                <span className={`executive-status ${company.status}`}>{company.status}</span>
              </div>
              <p className="executive-created">Created {new Date(company.createdAt).toLocaleDateString()}</p>
              {(company.ceoName || company.ceoEmail || company.ceoPhoneNumber) && (
                <p className="executive-created">
                  CEO: {company.ceoName ?? company.ceoEmail ?? 'Contact details not provided'}{company.ceoName && company.ceoEmail ? ` · ${company.ceoEmail}` : ''}{company.ceoPhoneNumber ? ` · ${company.ceoPhoneNumber}` : ''}
                </p>
              )}
              <div className="executive-actions">
                <div className="executive-billing-actions">
                  <button
                    className="secondary-button"
                    onClick={() => { void toggleCompanyBilling(company) }}
                    disabled={billingLoadingCompanyId === company.companyId}
                  >
                    {billingLoadingCompanyId === company.companyId
                      ? 'Loading invoices…'
                      : billingCompanyId === company.companyId
                        ? 'Hide invoices'
                        : 'View billing'}
                  </button>
                  {billingCompanyId === company.companyId && (
                    <div className="executive-invoice-list">
                      <div className="executive-invoice-heading">
                        <strong>Company invoices</strong>
                        <button
                          className="secondary-button"
                          onClick={() => { void refreshCompanyBilling(company) }}
                          disabled={billingLoadingCompanyId === company.companyId}
                        >
                          Refresh
                        </button>
                      </div>
                      {billingLoadingCompanyId === company.companyId && !companyBilling[company.companyId]
                        ? <p className="executive-created">Loading billing records…</p>
                        : !companyBilling[company.companyId]?.invoices.length
                          ? <p className="executive-created">No invoices are available for this company yet.</p>
                          : companyBilling[company.companyId].invoices.map((invoice) => {
                            const key = `${company.companyId}#${invoice.month}`
                            return (
                              <div className="executive-invoice-row" key={invoice.invoiceNumber}>
                                <div>
                                  <strong>{invoice.month} · KES {invoice.totalAmountKes.toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong>
                                  <span>{invoice.paymentStatus}{invoice.paymentSource === 'manual' && invoice.paymentMethod ? ` · paid manually by ${invoice.paymentMethod}` : ''}{invoice.paymentReference ? ` · ${invoice.paymentReference}` : ''}</span>
                                </div>
                                {invoice.paymentStatus !== 'paid' && invoice.paymentStatus !== 'no balance' && (
                                  <form className="executive-mark-paid-form" onSubmit={(event) => { void markInvoicePaid(event, company, invoice.month) }}>
                                    <label>
                                      Payment method
                                      <select
                                        value={paymentMethods[key] ?? ''}
                                        onChange={(event) => setPaymentMethods((current) => ({ ...current, [key]: event.target.value }))}
                                        required
                                      >
                                        <option value="">Select method</option>
                                        <option value="bank transfer">Bank transfer</option>
                                        <option value="mobile money">Mobile money</option>
                                        <option value="cash">Cash</option>
                                        <option value="other">Other</option>
                                      </select>
                                    </label>
                                    <label>
                                      Reference (optional)
                                      <input
                                        value={paymentReferences[key] ?? ''}
                                        onChange={(event) => setPaymentReferences((current) => ({ ...current, [key]: event.target.value }))}
                                        maxLength={128}
                                        placeholder="Transaction or receipt ID"
                                      />
                                    </label>
                                    <button className="secondary-button" disabled={saving}>Record paid</button>
                                  </form>
                                )}
                              </div>
                            )
                          })}
                    </div>
                  )}
                </div>
                {company.status === 'active' && (
                  <form className="executive-inline-form" onSubmit={(event) => { void inviteAdmin(event, company) }}>
                    <label>
                      Admin full name (optional)
                      <input
                        value={adminNames[company.companyId] ?? ''}
                        onChange={(event) => setAdminNames((current) => ({ ...current, [company.companyId]: event.target.value }))}
                        maxLength={128}
                        autoComplete="name"
                      />
                    </label>
                    <label>
                      Admin email
                      <input
                        type="email"
                        value={adminEmails[company.companyId] ?? ''}
                        onChange={(event) => setAdminEmails((current) => ({ ...current, [company.companyId]: event.target.value }))}
                        maxLength={254}
                        required
                      />
                    </label>
                    <label>
                      Admin phone number (optional)
                      <input
                        type="tel"
                        value={adminPhones[company.companyId] ?? ''}
                        onChange={(event) => setAdminPhones((current) => ({ ...current, [company.companyId]: event.target.value }))}
                        maxLength={16}
                        pattern="[+][1-9][0-9]{1,14}"
                        title="Use international format, for example +254711852707"
                        placeholder="+254711852707"
                        autoComplete="tel"
                      />
                    </label>
                    {adminContactAttempts[company.companyId] &&
                      (!adminNames[company.companyId]?.trim() || !adminPhones[company.companyId]?.trim()) && (
                        <div className="callout-warning executive-contact-warning" role="alert">
                          <strong>Contact details missing.</strong> The invitation will still be sent by email, but any blank name or phone number will not be available in the company directory.
                        </div>
                      )}
                    <button className="secondary-button" disabled={saving}>Send invitation</button>
                  </form>
                )}
                <form className="executive-inline-form executive-status-form" onSubmit={(event) => { void changeStatus(event, company) }}>
                  <label>
                    Reason for {company.status === 'active' ? 'suspension' : 'reactivation'}
                    <input
                      value={statusReasons[company.companyId] ?? ''}
                      onChange={(event) => setStatusReasons((current) => ({ ...current, [company.companyId]: event.target.value }))}
                      maxLength={512}
                      required
                    />
                  </label>
                  <button
                    className={company.status === 'active' ? 'danger-button' : 'secondary-button'}
                    disabled={saving}
                  >
                    {company.status === 'active' ? 'Suspend company' : 'Reactivate company'}
                  </button>
                </form>
              </div>
            </article>
          ))}
        </section>
        <p className="executive-footnote">Company status changes and invitations are recorded in the company audit history. The invited CEO administers their company workspace and can invite team leaders. Suspension blocks company-admin API access and new event ingestion; it does not delete company data.</p>
      </main>
    </div>
  )
}

function ExecutiveBillingOverview({
  apiUrl,
  companies,
}: {
  apiUrl: string
  companies: Company[]
}) {
  const [invoices, setInvoices] = useState<ExecutiveOutstandingInvoice[]>([])
  const [nextCursor, setNextCursor] = useState<string>()
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [savingInvoice, setSavingInvoice] = useState('')
  const [methods, setMethods] = useState<Record<string, string>>({})
  const [references, setReferences] = useState<Record<string, string>>({})
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const totalOutstanding = invoices.reduce((total, invoice) => total + invoice.totalAmountKes, 0)

  const loadInvoices = useCallback(async (cursor?: string, append = false) => {
    if (append) setLoadingMore(true)
    else setLoading(true)
    setError('')
    try {
      const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''
      const result = await apiRequest<{
        invoices: ExecutiveOutstandingInvoice[]
        nextCursor?: string
      }>(apiUrl, `/v1/executive/billing${query}`)
      setInvoices((current) => append ? [...current, ...result.invoices] : result.invoices)
      setNextCursor(result.nextCursor)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setLoading(false)
      setLoadingMore(false)
    }
  }, [apiUrl])

  useEffect(() => { void loadInvoices() }, [loadInvoices])

  async function markPaid(event: FormEvent, invoice: ExecutiveOutstandingInvoice) {
    event.preventDefault()
    const key = `${invoice.companyId}#${invoice.month}`
    const method = methods[key]
    if (!method || !window.confirm(`Record the ${invoice.month} invoice for ${invoice.companyName} as paid by ${method}?`)) {
      return
    }
    setSavingInvoice(key)
    setError('')
    setMessage('')
    try {
      await apiRequest<{ paymentStatus: string }>(
        apiUrl,
        `/v1/executive/companies/${encodeURIComponent(invoice.companyId)}/billing/invoices/${encodeURIComponent(invoice.month)}/mark-paid`,
        {
          method: 'POST',
          body: { method, reference: references[key] ?? '' },
        },
      )
      setMessage(`${invoice.companyName}'s ${invoice.month} invoice has been recorded as paid.`)
      await loadInvoices()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setSavingInvoice('')
    }
  }

  return (
    <section className="surface executive-billing-overview">
      <div className="executive-section-heading">
        <div>
          <p className="eyebrow">BILLING CONTROL</p>
          <h2>Outstanding company invoices</h2>
          <p>Review balances across company workspaces and record payments received outside Juu.</p>
        </div>
        <button className="secondary-button" onClick={() => { void loadInvoices() }} disabled={loading || loadingMore}>
          Refresh invoices
        </button>
      </div>
      {error && <div className="executive-alert executive-alert-error" role="alert">{error}</div>}
      {message && <div className="executive-alert executive-alert-success" role="status">{message}</div>}
      <div className="executive-billing-summary">
        <strong>KES {totalOutstanding.toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong>
        <span>{invoices.length} outstanding {invoices.length === 1 ? 'invoice' : 'invoices'} loaded{nextCursor ? ' · more companies available' : ''}</span>
      </div>
      {loading && <p className="executive-empty">Loading outstanding invoices…</p>}
      {!loading && invoices.length === 0 && (
        <p className="executive-empty">No outstanding invoices{nextCursor ? ' in this batch' : ''}.</p>
      )}
      {invoices.map((invoice) => {
        const key = `${invoice.companyId}#${invoice.month}`
        return (
          <div className="executive-aggregate-invoice" key={key}>
            <div className="executive-aggregate-invoice-heading">
              <strong>{invoice.companyName}</strong>
              <span>{invoice.month} · KES {invoice.totalAmountKes.toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
              <span className={`executive-status ${invoice.paymentStatus}`}>{invoice.paymentStatus}</span>
            </div>
            <form className="executive-mark-paid-form" onSubmit={(event) => { void markPaid(event, invoice) }}>
              <label>
                Payment method
                <select
                  value={methods[key] ?? ''}
                  onChange={(event) => setMethods((current) => ({ ...current, [key]: event.target.value }))}
                  required
                >
                  <option value="">Select method</option>
                  <option value="bank transfer">Bank transfer</option>
                  <option value="mobile money">Mobile money</option>
                  <option value="cash">Cash</option>
                  <option value="other">Other</option>
                </select>
              </label>
              <label>
                Reference (optional)
                <input
                  value={references[key] ?? ''}
                  onChange={(event) => setReferences((current) => ({ ...current, [key]: event.target.value }))}
                  maxLength={128}
                  placeholder="Transaction or receipt ID"
                />
              </label>
              <button className="secondary-button" disabled={savingInvoice !== ''}>
                {savingInvoice === key ? 'Recording…' : 'Record paid'}
              </button>
            </form>
          </div>
        )
      })}
      {nextCursor && !loading && (
        <button
          className="secondary-button executive-load-more"
          onClick={() => { void loadInvoices(nextCursor, true) }}
          disabled={loadingMore}
        >
          {loadingMore ? 'Loading companies…' : 'Load invoices for more companies'}
        </button>
      )}
      <p className="executive-billing-note">
        {companies.length} company workspaces are currently listed in the directory. This oversight list only includes issued invoices with a balance; current-month usage is not yet invoiced.
      </p>
    </section>
  )
}

function BillingRatesPanel({ apiUrl }: { apiUrl: string }) {
  const [settings, setSettings] = useState<BillingRateSettings>()
  const [ingestionRate, setIngestionRate] = useState('')
  const [presentationRate, setPresentationRate] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  const refresh = useCallback(async () => {
    setError('')
    try {
      const result = await apiRequest<BillingRateSettings>(apiUrl, '/v1/executive/billing-rates')
      setSettings(result)
      const editableRates = result.next ?? result.current
      setIngestionRate(editableRates ? editableRates.ingestionKesPer1000.toFixed(2) : '')
      setPresentationRate(editableRates ? editableRates.presentationKesPer1000.toFixed(2) : '')
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setLoading(false)
    }
  }, [apiUrl])

  useEffect(() => { void refresh() }, [refresh])

  async function saveRates(event: FormEvent) {
    event.preventDefault()
    setSaving(true)
    setError('')
    setMessage('')
    try {
      const result = await apiRequest<{
        effectiveMonth: string
        scheduled: boolean
        paymentsConfigured: boolean
        billingEnabled: boolean
      }>(
        apiUrl,
        '/v1/executive/billing-rates',
        {
          method: 'PUT',
          body: {
            ingestionKesPer1000: Number(ingestionRate),
            presentationKesPer1000: Number(presentationRate),
          },
        },
      )
      setMessage(result.scheduled
        ? `New rates are scheduled to take effect ${result.effectiveMonth}. Current-month usage keeps its existing rates.`
        : result.billingEnabled
          ? `Billing is active at these rates from ${result.effectiveMonth}.`
          : `Rates are saved from ${result.effectiveMonth}; billable usage remains paused until Pesapal is configured and billing is explicitly enabled.`)
      await refresh()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="surface billing-rates-panel">
      <div>
        <p className="eyebrow">PLATFORM PRICING · KES</p>
        <h2>Usage rates</h2>
        <p>Set charges per 1,000 billable calls, including AWS usage, salaries, power, rent, support, and profit. Initial rates apply immediately once Pesapal is configured; later changes take effect next calendar month. There is no free allowance, and setup/configuration actions are never metered.</p>
        {settings && !settings.paymentsConfigured && (
          <div className="callout-warning">
            <strong>Pesapal is not configured.</strong>
            Rate settings can be saved, but billable usage remains paused until deployment credentials and the Pesapal IPN are configured.
          </div>
        )}
        {settings?.paymentsConfigured && !settings.billingEnabled && (
          <div className="callout-warning">
            <strong>Billing is not enabled for this deployment.</strong>
            Verify the Pesapal account and checkout in sandbox, then explicitly enable billing in the deployment configuration.
          </div>
        )}
        {settings?.current && (
          <p className="billing-current-rates">
            Current: data calls KES {settings.current.ingestionKesPer1000.toFixed(2)} / 1,000 · presentation reads KES {settings.current.presentationKesPer1000.toFixed(2)} / 1,000
          </p>
        )}
        {settings?.next && (
          <p className="billing-current-rates">
            Scheduled {settings.next.effectiveMonth}: data calls KES {settings.next.ingestionKesPer1000.toFixed(2)} / 1,000 · presentation reads KES {settings.next.presentationKesPer1000.toFixed(2)} / 1,000
          </p>
        )}
        {error && <div className="executive-alert executive-alert-error" role="alert">{error}</div>}
        {message && <div className="executive-alert executive-alert-success" role="status">{message}</div>}
      </div>
      <form className="executive-rate-form" onSubmit={(event) => { void saveRates(event) }}>
        <label>
          Accepted partner data calls · KES per 1,000
          <input type="number" min="0.01" max="1000000" step="0.01" value={ingestionRate} onChange={(event) => setIngestionRate(event.target.value)} required />
        </label>
        <label>
          Performance presentation reads · KES per 1,000
          <input type="number" min="0.01" max="1000000" step="0.01" value={presentationRate} onChange={(event) => setPresentationRate(event.target.value)} required />
        </label>
        <button className="primary-button" disabled={saving || loading}>{saving ? 'Saving…' : loading ? 'Loading rates…' : settings?.configured ? 'Schedule rate change' : 'Save billing rates'}</button>
      </form>
    </section>
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

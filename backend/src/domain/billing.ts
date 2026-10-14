export interface BillingRates {
  ingestionKesPer1000Cents: number
  presentationKesPer1000Cents: number
}

export interface BillingUsage {
  month: string
  ingestionCalls: number
  presentationCalls: number
  ingestionKesPer1000Cents: number
  presentationKesPer1000Cents: number
}

export interface BillingInvoice {
  invoiceNumber: string
  companyName: string
  month: string
  issuedAt: string
  dueAt: string
  ingestionCalls: number
  presentationCalls: number
  ingestionKesPer1000: number
  presentationKesPer1000: number
  ingestionAmountCents: number
  presentationAmountCents: number
  totalAmountCents: number
}

export type ManualPaymentMethod = 'bank transfer' | 'cash' | 'mobile money' | 'other'

export function validateManualPayment(input: unknown): string[] {
  if (!isRecord(input)) return ['Payment details must be an object']
  const errors: string[] = []
  if (input.method !== 'bank transfer' && input.method !== 'cash' &&
    input.method !== 'mobile money' && input.method !== 'other') {
    errors.push('method must be bank transfer, cash, mobile money, or other')
  }
  if (input.reference !== undefined &&
    (typeof input.reference !== 'string' || input.reference.trim().length > 128)) {
    errors.push('reference must be a string of at most 128 characters')
  }
  return errors
}

export function validateBillingRates(input: unknown): string[] {
  if (!isRecord(input)) return ['Billing rates must be an object']
  const errors: string[] = []
  for (const key of ['ingestionKesPer1000', 'presentationKesPer1000'] as const) {
    const value = input[key]
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 ||
      value > 1_000_000 || Math.abs(value * 100 - Math.round(value * 100)) > 1e-7) {
      errors.push(`${key} must be a positive KES amount with at most two decimal places`)
    }
  }
  return errors
}

export function toBillingRates(input: {
  ingestionKesPer1000: number
  presentationKesPer1000: number
}): BillingRates {
  return {
    ingestionKesPer1000Cents: Math.round(input.ingestionKesPer1000 * 100),
    presentationKesPer1000Cents: Math.round(input.presentationKesPer1000 * 100),
  }
}

export function currentBillingMonth(date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'Africa/Nairobi',
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(date)
  const year = parts.find((part) => part.type === 'year')?.value
  const month = parts.find((part) => part.type === 'month')?.value
  if (!year || !month) throw new Error('Could not determine the Kenya billing month')
  return `${year}-${month}`
}

export function createBillingInvoice(
  companyId: string,
  companyName: string,
  usage: BillingUsage,
  issuedAt = new Date().toISOString(),
): BillingInvoice {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(usage.month) ||
    !Number.isSafeInteger(usage.ingestionCalls) || usage.ingestionCalls < 0 ||
    !Number.isSafeInteger(usage.presentationCalls) || usage.presentationCalls < 0 ||
    !Number.isSafeInteger(usage.ingestionKesPer1000Cents) || usage.ingestionKesPer1000Cents <= 0 ||
    !Number.isSafeInteger(usage.presentationKesPer1000Cents) || usage.presentationKesPer1000Cents <= 0) {
    throw new Error('Cannot invoice malformed monthly billing usage')
  }
  const ingestionAmountCents = amountCents(
    usage.ingestionCalls,
    usage.ingestionKesPer1000Cents,
  )
  const presentationAmountCents = amountCents(
    usage.presentationCalls,
    usage.presentationKesPer1000Cents,
  )
  if (ingestionAmountCents + presentationAmountCents > Number.MAX_SAFE_INTEGER) {
    throw new Error('Invoice amount exceeds the supported KES precision')
  }
  const [year, month] = usage.month.split('-')
  const dueAt = new Date(new Date(issuedAt).getTime() + 7 * 24 * 60 * 60 * 1000).toISOString()
  return {
    invoiceNumber: `JUU-${companyId}-${year}${month}`,
    companyName,
    month: usage.month,
    issuedAt,
    dueAt,
    ingestionCalls: usage.ingestionCalls,
    presentationCalls: usage.presentationCalls,
    ingestionKesPer1000: usage.ingestionKesPer1000Cents / 100,
    presentationKesPer1000: usage.presentationKesPer1000Cents / 100,
    ingestionAmountCents,
    presentationAmountCents,
    totalAmountCents: ingestionAmountCents + presentationAmountCents,
  }
}

export function createInvoicePdf(invoice: BillingInvoice): string {
  const lines = [
    'Juu monthly invoice',
    `Invoice number: ${invoice.invoiceNumber}`,
    `Company: ${invoice.companyName}`,
    `Billing period: ${invoice.month}`,
    `Issued: ${nairobiDate(invoice.issuedAt)}`,
    `Payment due: ${nairobiDate(invoice.dueAt)}`,
    '',
    'Billable usage',
    `Accepted partner data calls: ${invoice.ingestionCalls} at KES ${formatKes(invoice.ingestionKesPer1000)} per 1,000`,
    `Performance presentation reads: ${invoice.presentationCalls} at KES ${formatKes(invoice.presentationKesPer1000)} per 1,000`,
    '',
    `Data calls: KES ${formatCents(invoice.ingestionAmountCents)}`,
    `Presentation reads: KES ${formatCents(invoice.presentationAmountCents)}`,
    `TOTAL DUE: KES ${formatCents(invoice.totalAmountCents)}`,
    '',
    'No free usage allowance applies. Company setup and configuration are not billable.',
    "Pay through Pesapal in Juu Billing using the methods enabled for Juu's account; contact Juu if checkout is unavailable.",
  ]
  const content = [
    'BT',
    ...lines.flatMap((line) => wrapPdfLine(line)).map((line, index) =>
      `/F1 ${index === 0 ? 18 : 10} Tf 1 0 0 1 50 ${750 - index * 32} Tm (${pdfText(line)}) Tj`),
    'ET',
  ].join('\n')
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(content, 'ascii')} >>\nstream\n${content}\nendstream`,
  ]
  let document = '%PDF-1.4\n'
  const offsets = [0]
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(document, 'ascii'))
    document += `${index + 1} 0 obj\n${object}\nendobj\n`
  })
  const xrefOffset = Buffer.byteLength(document, 'ascii')
  document += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets.slice(1)) {
    document += `${String(offset).padStart(10, '0')} 00000 n \n`
  }
  document += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return document
}

export function formatCents(cents: number): string {
  return (cents / 100).toFixed(2)
}

export function invoicePaymentStatus(
  item: Record<string, unknown>,
  dueAt: string,
  now: Date,
): 'paid' | 'pending' | 'failed' | 'overdue' | 'unpaid' {
  if (item.paidAt !== undefined || item.paymentStatus === 'paid') return 'paid'
  if (new Date(dueAt) <= now) return 'overdue'
  if (item.paymentStatus === 'pending') return 'pending'
  if (item.paymentStatus === 'failed') return 'failed'
  return 'unpaid'
}

function formatKes(centsPerThousand: number): string {
  return (centsPerThousand / 100).toFixed(2)
}

function amountCents(calls: number, rateCentsPer1000: number): number {
  if (!Number.isSafeInteger(calls) || calls < 0 ||
    !Number.isSafeInteger(rateCentsPer1000) || rateCentsPer1000 <= 0) {
    throw new Error('Cannot calculate an invoice from invalid usage or rates')
  }
  const amount = (BigInt(calls) * BigInt(rateCentsPer1000) + 500n) / 1000n
  if (amount > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('Invoice amount exceeds the supported KES precision')
  }
  return Number(amount)
}

function wrapPdfLine(value: string): string[] {
  const maximumLength = 88
  const lines: string[] = []
  for (let start = 0; start < value.length; start += maximumLength) {
    lines.push(value.slice(start, start + maximumLength))
  }
  return lines.length ? lines : ['']
}

function nairobiDate(value: string): string {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'Africa/Nairobi',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(value))
  const year = parts.find((part) => part.type === 'year')?.value
  const month = parts.find((part) => part.type === 'month')?.value
  const day = parts.find((part) => part.type === 'day')?.value
  if (!year || !month || !day) throw new Error('Could not format the invoice issue date')
  return `${year}-${month}-${day}`
}

function pdfText(value: string): string {
  return value.normalize('NFKD').replace(/[^\x20-\x7E]/g, '?').replace(/[\\()]/g, '\\$&')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

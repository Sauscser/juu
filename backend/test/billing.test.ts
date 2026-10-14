import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createBillingInvoice,
  createInvoicePdf,
  currentBillingMonth,
  invoicePaymentStatus,
  toBillingRates,
  validateManualPayment,
  validateBillingRates,
} from '../src/domain/billing'

test('billing rates require positive KES values with at most two decimals', () => {
  assert.deepEqual(validateBillingRates({
    ingestionKesPer1000: 12.5,
    presentationKesPer1000: 3.25,
  }), [])
  assert.ok(validateBillingRates({
    ingestionKesPer1000: 0,
    presentationKesPer1000: 1.001,
  }).length > 0)
  assert.ok(validateBillingRates(null).length > 0)
})

test('billing records use Kenya calendar months and retain fractional KES rates', () => {
  assert.equal(currentBillingMonth(new Date('2026-12-31T20:59:00.000Z')), '2026-12')
  assert.equal(currentBillingMonth(new Date('2026-12-31T21:00:00.000Z')), '2027-01')
  assert.deepEqual(toBillingRates({
    ingestionKesPer1000: 12.5,
    presentationKesPer1000: 3.25,
  }), {
    ingestionKesPer1000Cents: 1250,
    presentationKesPer1000Cents: 325,
  })
})

test('invoice amounts are calculated per 1,000 billable calls and exported as a PDF', () => {
  const invoice = createBillingInvoice('company-1', 'Example Ltd', {
    month: '2026-09',
    ingestionCalls: 2500,
    presentationCalls: 500,
    ingestionKesPer1000Cents: 1200,
    presentationKesPer1000Cents: 400,
  }, '2026-10-01T00:00:00.000Z')

  assert.equal(invoice.ingestionAmountCents, 3000)
  assert.equal(invoice.presentationAmountCents, 200)
  assert.equal(invoice.totalAmountCents, 3200)
  assert.equal(invoice.dueAt, '2026-10-08T00:00:00.000Z')
  const pdf = createInvoicePdf(invoice)
  assert.ok(pdf.startsWith('%PDF-1.4'))
  assert.ok(pdf.includes('Accepted partner data calls'))
  assert.ok(pdf.includes('TOTAL DUE: KES 32.00'))
  assert.ok(pdf.includes('Payment due: 2026-10-08'))
  assert.ok(pdf.endsWith('%%EOF\n'))
})

test('invoice payment status observes the seven-day due date and keeps paid invoices settled', () => {
  const dueAt = '2026-10-08T00:00:00.000Z'
  const beforeDue = new Date('2026-10-07T23:59:59.999Z')
  const afterDue = new Date(dueAt)

  assert.equal(invoicePaymentStatus({}, dueAt, beforeDue), 'unpaid')
  assert.equal(invoicePaymentStatus({ paymentStatus: 'pending' }, dueAt, beforeDue), 'pending')
  assert.equal(invoicePaymentStatus({ paymentStatus: 'failed' }, dueAt, beforeDue), 'failed')
  assert.equal(invoicePaymentStatus({ paymentStatus: 'pending' }, dueAt, afterDue), 'overdue')
  assert.equal(invoicePaymentStatus({ paidAt: '2026-10-07T12:00:00.000Z' }, dueAt, afterDue), 'paid')
})

test('manual payment details require a supported method and validate optional references', () => {
  assert.deepEqual(validateManualPayment({ method: 'cash' }), [])
  assert.deepEqual(validateManualPayment({ method: 'mobile money', reference: 'MPESA-123' }), [])
  assert.ok(validateManualPayment({ method: 'Pesapal' }).length > 0)
  assert.ok(validateManualPayment({ method: 'cash', reference: 'x'.repeat(129) }).length > 0)
})

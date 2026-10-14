import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider'
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb'
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager'
import {
  isRecord,
  isValidatedEventContract,
  isValidatedPartnerEvent,
  validateContract,
  validatePartnerEvent,
  type EventContract,
  type PartnerEvent,
} from './domain/event-contract'
import {
  isConfigurationResource,
  isLocationInput,
  isMetricCalculation,
  isMetricExpression,
  isMetricInput,
  isOrganizationUnitInput,
  isProductInput,
  isTargetInput,
  validateLocation,
  validateMetric,
  validateOrganizationUnit,
  validateProduct,
  validateTarget,
  type ConfigurationResource,
  type MetricAggregation,
  type MetricCalculation,
  type ProductInput,
  type ReportingLocationInput,
  type MetricDefinitionInput,
  type TargetInput,
} from './domain/configuration'
import { getCompanyAdminId, getCompanyLeaderSubject } from './domain/company-admin'
import { areTargetProductsEligible, isTargetSetByManager } from './domain/target-scope'
import { isUppyExecutive } from './domain/executive'
import { optionalContactValue, validateInviteeContact } from './domain/contact'
import {
  createBillingInvoice,
  createInvoicePdf,
  currentBillingMonth,
  invoicePaymentStatus,
  toBillingRates,
  validateManualPayment,
  validateBillingRates,
  type BillingRates,
  type BillingUsage,
} from './domain/billing'
import {
  getUnitSubtreeIds,
  isActiveDirectChildUnit,
  type OrganizationUnit,
  type OrganizationUnitJurisdiction,
} from './domain/organization'
import {
  combinePerformanceReports,
  createPerformanceCalculator,
  percentageOfReference,
  type PerformanceBucket,
  type PerformanceEvent,
  type PerformanceMetric,
  type PerformanceReport,
} from './domain/performance'

const tableName = process.env.TABLE_NAME
if (!tableName) throw new Error('TABLE_NAME environment variable is required')
const userPoolId = process.env.USER_POOL_ID
if (!userPoolId) throw new Error('USER_POOL_ID environment variable is required')

const cognito = new CognitoIdentityProviderClient({})
const secrets = new SecretsManagerClient({})
const database = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
})

function isBillingEnabled(): boolean {
  return process.env.BILLING_ENABLED === 'true' && Boolean(process.env.PESAPAL_SECRET_ARN)
}

type OfficerAttribution = {
  subject: string
  email?: string
  name?: string
  hierarchyLevel: 'company' | 'organization-unit'
  orgUnitId?: string
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const method = event.requestContext.http.method
  const path = event.rawPath

  if (method === 'GET' && path === '/v1/health') {
    return json(200, { status: 'ok' })
  }

  if (method === 'GET' && path === '/v1/billing/pesapal/ipn') {
    return handlePesapalIpn(event)
  }

  if (path.startsWith('/v1/executive/')) {
    if (!isUppyExecutive(getJwtClaims(event))) {
      return json(403, { error: 'Uppy Executive access is required' })
    }
    if (path === '/v1/executive/companies' && method === 'GET') {
      return listCompanies(event.queryStringParameters?.cursor)
    }
    if (path === '/v1/executive/companies' && method === 'POST') {
      return createCompanyAndInviteAdmin(event.body, getJwtClaims(event))
    }
    if (path === '/v1/executive/billing-rates' && method === 'GET') {
      return getExecutiveBillingRates()
    }
    if (path === '/v1/executive/billing-rates' && method === 'PUT') {
      return putExecutiveBillingRates(event.body, getJwtClaims(event))
    }
    if (path === '/v1/executive/billing' && method === 'GET') {
      return listExecutiveBilling(event.queryStringParameters?.cursor)
    }
    const executiveBillingMatch =
      /^\/v1\/executive\/companies\/([^/]+)\/billing(?:\/invoices\/(\d{4}-\d{2})\/mark-paid)?$/.exec(path)
    if (executiveBillingMatch && method === 'GET' && !executiveBillingMatch[2]) {
      return getExecutiveCompanyBilling(executiveBillingMatch[1])
    }
    if (executiveBillingMatch && method === 'POST' && executiveBillingMatch[2]) {
      return markExecutiveInvoicePaid(
        executiveBillingMatch[1],
        executiveBillingMatch[2],
        event.body,
        getJwtClaims(event),
      )
    }
    const companyMatch = /^\/v1\/executive\/companies\/([^/]+)\/(status|admins)$/.exec(path)
    if (companyMatch && (companyMatch[2] === 'status' ? method === 'PUT' : method === 'POST')) {
      return companyMatch[2] === 'status'
        ? updateCompanyStatus(companyMatch[1], event.body, getJwtClaims(event))
        : inviteCompanyAdmin(companyMatch[1], event.body, getJwtClaims(event))
    }
    return json(404, { error: 'Executive route not found' })
  }

  if (path.startsWith('/v1/admin/')) {
    const companyId = getAdminCompanyId(event)
    if (!companyId) return json(403, { error: 'Company administrator access is required' })
    const company = await database.send(new GetCommand({
      TableName: tableName,
      Key: { pk: `COMPANY#${companyId}`, sk: 'PROFILE' },
      ProjectionExpression: '#name, #status',
      ExpressionAttributeNames: { '#name': 'name', '#status': 'status' },
    }))
    if (!company.Item) return json(403, { error: 'Company workspace not found' })

    if (path === '/v1/admin/company-profile' && method === 'GET') {
      if (typeof company.Item.name !== 'string' || company.Item.name.trim().length === 0) {
        return json(500, { error: 'Company profile has no valid name' })
      }
      return json(200, { company: { name: company.Item.name } })
    }
    if (path === '/v1/admin/billing' && method === 'GET') {
      return getCompanyBilling(companyId, company.Item.name)
    }
    const invoiceMatch = /^\/v1\/admin\/billing\/invoices\/(\d{4}-\d{2})\/pdf$/.exec(path)
    if (invoiceMatch && method === 'GET') {
      return getCompanyInvoicePdf(companyId, company.Item.name, invoiceMatch[1])
    }
    const invoicePaymentMatch =
      /^\/v1\/admin\/billing\/invoices\/(\d{4}-\d{2})\/(checkout|payment-status)$/.exec(path)
    if (invoicePaymentMatch && invoicePaymentMatch[2] === 'checkout' && method === 'POST') {
      const claims = getJwtClaims(event)
      return startInvoicePayment(
        companyId,
        company.Item.name,
        invoicePaymentMatch[1],
        isRecord(claims) && typeof claims.email === 'string' ? claims.email : undefined,
      )
    }
    if (invoicePaymentMatch && invoicePaymentMatch[2] === 'payment-status' && method === 'GET') {
      return refreshInvoicePaymentStatus(companyId, invoicePaymentMatch[1])
    }
    if (company.Item.status !== 'active') {
      return json(403, { error: 'This company workspace is inactive or suspended' })
    }
    if (path === '/v1/admin/event-contract' && method === 'GET') {
      return getContract(companyId)
    }
    if (path === '/v1/admin/event-contract' && method === 'PUT') {
      return putContract(companyId, event.body, event.requestContext.requestId)
    }
    if (path === '/v1/admin/performance/combined' && method === 'POST') {
      return runBillablePresentation(companyId, () => getCombinedPerformance(companyId, event.body))
    }
    if (path === '/v1/admin/performance' && method === 'GET') {
      return runBillablePresentation(
        companyId,
        () => getPerformance(companyId, event.queryStringParameters ?? {}),
      )
    }
    const leaderInvite = /^\/v1\/admin\/org-units\/([^/]+)\/leaders$/.exec(path)
    if (leaderInvite && method === 'POST') {
      return inviteOrganizationLeader(companyId, leaderInvite[1], event.body, getJwtClaims(event))
    }
    if (path.startsWith('/v1/admin/config/')) {
      return handleConfiguration(
        companyId,
        method,
        path,
        event.queryStringParameters?.cursor,
        event.body,
        getJwtClaims(event),
      )
    }
    if (path === '/v1/admin/integration-keys' && method === 'POST') {
      return createIntegrationKey(companyId)
    }
    if (path === '/v1/admin/integration-keys' && method === 'GET') {
      return listIntegrationKeys(companyId)
    }
    if (path.startsWith('/v1/admin/integration-keys/') && method === 'DELETE') {
      return revokeIntegrationKey(companyId, event.pathParameters?.integrationId)
    }
    return json(404, { error: 'Route not found' })
  }

  if ((path === '/v1/leader/performance' || path === '/v1/leader/performance/combined') &&
    (method === 'GET' || method === 'POST')) {
    const scope = await resolveCompanyLeaderScope(event)
    if (!scope) return json(403, { error: 'Company leader access is required' })
    const company = await database.send(new GetCommand({
      TableName: tableName,
      Key: { pk: `COMPANY#${scope.companyId}`, sk: 'PROFILE' },
      ProjectionExpression: '#status',
      ExpressionAttributeNames: { '#status': 'status' },
    }))
    if (!company.Item || company.Item.status !== 'active') {
      return json(403, { error: 'This company workspace is inactive or suspended' })
    }
    if (path === '/v1/leader/performance/combined') {
      if (method !== 'POST') return json(405, { error: 'Method not allowed' })
      return runBillablePresentation(
        scope.companyId,
        () => getCombinedPerformance(scope.companyId, event.body, scope.orgUnitId, true),
      )
    }
    if (method !== 'GET') return json(405, { error: 'Method not allowed' })
    return runBillablePresentation(
      scope.companyId,
      () => getPerformance(scope.companyId, event.queryStringParameters ?? {}, scope.orgUnitId),
    )
  }
  if (path === '/v1/leader/products' && method === 'GET') {
    const scope = await resolveCompanyLeaderScope(event)
    if (!scope) return json(403, { error: 'Company leader access is required' })
    const company = await database.send(new GetCommand({
      TableName: tableName,
      Key: { pk: `COMPANY#${scope.companyId}`, sk: 'PROFILE' },
      ProjectionExpression: '#status',
      ExpressionAttributeNames: { '#status': 'status' },
    }))
    if (!company.Item || company.Item.status !== 'active') {
      return json(403, { error: 'This company workspace is inactive or suspended' })
    }
    const assignedUnit = await database.send(new GetCommand({
      TableName: tableName,
      Key: {
        pk: `COMPANY#${scope.companyId}`,
        sk: configSortKey('org-units', scope.orgUnitId),
      },
      ProjectionExpression: '#active, #parentUnitId',
      ExpressionAttributeNames: { '#active': 'active', '#parentUnitId': 'parentUnitId' },
    }))
    if (assignedUnit.Item?.active !== true) {
      return json(403, { error: 'Your assigned organization unit is inactive or unavailable' })
    }
    return listConfiguration(scope.companyId, 'products', event.queryStringParameters?.cursor)
  }
  if (path === '/v1/leader/targets' && (method === 'GET' || method === 'POST')) {
    const scope = await resolveCompanyLeaderScope(event)
    if (!scope) return json(403, { error: 'Company leader access is required' })
    const company = await database.send(new GetCommand({
      TableName: tableName,
      Key: { pk: `COMPANY#${scope.companyId}`, sk: 'PROFILE' },
      ProjectionExpression: '#status',
      ExpressionAttributeNames: { '#status': 'status' },
    }))
    if (!company.Item || company.Item.status !== 'active') {
      return json(403, { error: 'This company workspace is inactive or suspended' })
    }
    const assignedUnit = await database.send(new GetCommand({
      TableName: tableName,
      Key: {
        pk: `COMPANY#${scope.companyId}`,
        sk: configSortKey('org-units', scope.orgUnitId),
      },
      ProjectionExpression: '#active, #parentUnitId',
      ExpressionAttributeNames: { '#active': 'active', '#parentUnitId': 'parentUnitId' },
    }))
    if (assignedUnit.Item?.active !== true) {
      return json(403, { error: 'Your assigned organization unit is inactive or unavailable' })
    }
    if (method === 'GET') {
      const subject = getCompanyLeaderSubject(getJwtClaims(event))
      if (!subject) return json(403, { error: 'Company leader access is required' })
      return listLeaderTargets(
        scope.companyId,
        scope.orgUnitId,
        subject,
        event.queryStringParameters?.cursor,
        typeof assignedUnit.Item.parentUnitId === 'string' ? assignedUnit.Item.parentUnitId : undefined,
      )
    }
    const parsed = parseBody(event.body)
    if (!parsed.ok) return parsed.response
    if (!isRecord(parsed.value)) return json(400, { error: 'Target request must be an object' })
    const errors: string[] = []
    rejectUnknownKeys(
      parsed.value,
      [
        'metricId',
        'productId',
        'period',
        'startDate',
        'endDate',
        'targetValue',
        'targetMode',
        'referenceMetricId',
        'referenceProductId',
        'warningThreshold',
      ],
      'target',
      errors,
    )
    if (typeof parsed.value.metricId !== 'string') errors.push('metricId is required')
    if (parsed.value.productId !== undefined && typeof parsed.value.productId !== 'string') {
      errors.push('productId must be a string')
    }
    if (parsed.value.productId === undefined && typeof parsed.value.metricId === 'string' &&
      isResourceId(parsed.value.metricId)) {
      const metric = await database.send(new GetCommand({
        TableName: tableName,
        Key: { pk: `COMPANY#${scope.companyId}`, sk: configSortKey('metrics', parsed.value.metricId) },
        ProjectionExpression: '#calculation',
        ExpressionAttributeNames: { '#calculation': 'calculation' },
      }))
      if (!metric.Item || metric.Item.calculation === undefined) errors.push('productId is required for an event-derived metric')
    }
    errors.push(...validateTarget(parsed.value))
    if (errors.length > 0) return json(400, { error: 'Invalid target request', details: [...new Set(errors)] })
    const allowedProductIds = await getLeaderTargetProductScope(
      scope.companyId,
      typeof assignedUnit.Item.parentUnitId === 'string' ? assignedUnit.Item.parentUnitId : undefined,
    )
    const requestedProductIds = await getTargetProductIds(scope.companyId, parsed.value)
    if (!areTargetProductsEligible(requestedProductIds, allowedProductIds)) {
      return json(403, {
        error: 'Targets may only use products that have an active target from your direct manager',
      })
    }
    const creator = getOfficerAttribution(getJwtClaims(event), scope.orgUnitId)
    if (!creator) return json(403, { error: 'A valid signed-in officer profile is required to set a target' })
    return createConfiguration(
      scope.companyId,
      'targets',
      JSON.stringify({ ...parsed.value, orgUnitId: scope.orgUnitId }),
      creator,
    )
  }
  if (path === '/v1/leader/org-units' && method === 'POST') {
    const scope = await resolveCompanyLeaderScope(event)
    if (!scope) return json(403, { error: 'Company leader access is required' })
    const company = await database.send(new GetCommand({
      TableName: tableName,
      Key: { pk: `COMPANY#${scope.companyId}`, sk: 'PROFILE' },
      ProjectionExpression: '#status',
      ExpressionAttributeNames: { '#status': 'status' },
    }))
    if (!company.Item || company.Item.status !== 'active') {
      return json(403, { error: 'This company workspace is inactive or suspended' })
    }
    const assignedUnit = await database.send(new GetCommand({
      TableName: tableName,
      Key: {
        pk: `COMPANY#${scope.companyId}`,
        sk: configSortKey('org-units', scope.orgUnitId),
      },
      ProjectionExpression: '#active',
      ExpressionAttributeNames: { '#active': 'active' },
    }))
    if (assignedUnit.Item?.active !== true) {
      return json(403, { error: 'Your assigned organization unit is inactive or unavailable' })
    }
    const parsed = parseBody(event.body)
    if (!parsed.ok) return parsed.response
    if (!isRecord(parsed.value)) return json(400, { error: 'Child unit request must be an object' })
    const errors: string[] = []
    rejectUnknownKeys(parsed.value, ['name', 'type', 'jurisdiction'], 'organizationUnit', errors)
    const childUnit = {
      ...parsed.value,
      parentUnitId: scope.orgUnitId,
    }
    errors.push(...validateOrganizationUnit(childUnit))
    if (errors.length > 0) return json(400, { error: 'Invalid child unit request', details: [...new Set(errors)] })
    return createConfiguration(scope.companyId, 'org-units', JSON.stringify(childUnit))
  }
  const leaderInvite = /^\/v1\/leader\/org-units\/([^/]+)\/leaders$/.exec(path)
  if (leaderInvite && method === 'POST') {
    const scope = await resolveCompanyLeaderScope(event)
    if (!scope) return json(403, { error: 'Company leader access is required' })
    const company = await database.send(new GetCommand({
      TableName: tableName,
      Key: { pk: `COMPANY#${scope.companyId}`, sk: 'PROFILE' },
      ProjectionExpression: '#status',
      ExpressionAttributeNames: { '#status': 'status' },
    }))
    if (!company.Item || company.Item.status !== 'active') {
      return json(403, { error: 'This company workspace is inactive or suspended' })
    }
    const childUnitId = leaderInvite[1]
    if (!isResourceId(childUnitId)) return json(400, { error: 'A valid organization unit ID is required' })
    const units = await loadOrganizationUnits(scope.companyId)
    if (!isActiveDirectChildUnit(units, scope.orgUnitId, childUnitId)) {
      return json(403, { error: 'You may invite leaders only to an active unit directly beneath your assigned unit' })
    }
    return inviteOrganizationLeader(scope.companyId, childUnitId, event.body, getJwtClaims(event))
  }
  if ((path === '/v1/leader/org-units' || path === '/v1/leader/metrics') && method === 'GET') {
    const scope = await resolveCompanyLeaderScope(event)
    if (!scope) return json(403, { error: 'Company leader access is required' })
    const company = await database.send(new GetCommand({
      TableName: tableName,
      Key: { pk: `COMPANY#${scope.companyId}`, sk: 'PROFILE' },
      ProjectionExpression: '#status',
      ExpressionAttributeNames: { '#status': 'status' },
    }))
    if (!company.Item || company.Item.status !== 'active') {
      return json(403, { error: 'This company workspace is inactive or suspended' })
    }
    const assignedUnit = await database.send(new GetCommand({
      TableName: tableName,
      Key: {
        pk: `COMPANY#${scope.companyId}`,
        sk: configSortKey('org-units', scope.orgUnitId),
      },
      ProjectionExpression: '#active',
      ExpressionAttributeNames: { '#active': 'active' },
    }))
    if (assignedUnit.Item?.active !== true) {
      return json(403, { error: 'Your assigned organization unit is inactive or unavailable' })
    }
    if (path === '/v1/leader/metrics') return listLeaderMetrics(scope.companyId)
    const units = await loadOrganizationUnits(scope.companyId)
    const allowedIds = new Set(getUnitSubtreeIds(units, scope.orgUnitId))
    const leadersByUnit = await loadLeaderContactsByUnit(scope.companyId)
    return json(200, {
      assignedUnitId: scope.orgUnitId,
      items: units.filter((unit) => allowedIds.has(unit.id)).map((unit) => ({
        id: unit.id,
        name: unit.name,
        type: unit.type,
        parentUnitId: unit.parentUnitId,
        jurisdiction: unit.jurisdiction,
        active: unit.active,
        leaderContacts: leadersByUnit.get(unit.id) ?? [],
      })),
    })
  }

  if (path === '/v1/events' && method === 'POST') {
    return ingestEvent(event)
  }
  return json(404, { error: 'Route not found' })
}

async function getExecutiveBillingRates(): Promise<APIGatewayProxyResultV2> {
  const record = await readBillingRateRecord()
  const month = currentBillingMonth()
  const current = record ? effectiveBillingRates(record, month) : undefined
  const nextEffectiveMonth = record?.nextEffectiveMonth
  const next = record && typeof nextEffectiveMonth === 'string' && nextEffectiveMonth > month
    ? effectiveBillingRates(record, nextEffectiveMonth)
    : undefined
  return json(200, {
    configured: Boolean(current),
    paymentsConfigured: Boolean(process.env.PESAPAL_SECRET_ARN),
    billingEnabled: isBillingEnabled(),
    current: current ? {
      ingestionKesPer1000: current.ingestionKesPer1000Cents / 100,
      presentationKesPer1000: current.presentationKesPer1000Cents / 100,
    } : undefined,
    next: next && nextEffectiveMonth ? {
      effectiveMonth: nextEffectiveMonth,
      ingestionKesPer1000: next.ingestionKesPer1000Cents / 100,
      presentationKesPer1000: next.presentationKesPer1000Cents / 100,
    } : undefined,
  })
}

async function putExecutiveBillingRates(
  body: string | undefined,
  claims: unknown,
): Promise<APIGatewayProxyResultV2> {
  const parsed = parseBody(body)
  if (!parsed.ok) return parsed.response
  if (!isRecord(parsed.value)) return json(400, { error: 'Billing rates must be an object' })
  const errors: string[] = []
  rejectUnknownKeys(
    parsed.value,
    ['ingestionKesPer1000', 'presentationKesPer1000'],
    'billingRates',
    errors,
  )
  errors.push(...validateBillingRates(parsed.value))
  if (errors.length > 0) return json(400, { error: 'Invalid billing rates', details: errors })

  if (typeof parsed.value.ingestionKesPer1000 !== 'number' ||
    typeof parsed.value.presentationKesPer1000 !== 'number') {
    return json(400, { error: 'Both billing rates are required' })
  }
  const rates = toBillingRates({
    ingestionKesPer1000: parsed.value.ingestionKesPer1000,
    presentationKesPer1000: parsed.value.presentationKesPer1000,
  })
  const now = new Date().toISOString()
  const actor = isRecord(claims) ? {
    ...(typeof claims.sub === 'string' ? { subject: claims.sub } : {}),
    ...(typeof claims.email === 'string' ? { email: claims.email } : {}),
  } : {}
  const record = await readBillingRateRecord()
  const historyKey = { pk: 'PLATFORM#BILLING', sk: `RATE_CHANGE#${now}#${randomUUID()}` }

  if (!record) {
    const item = {
      pk: 'PLATFORM#BILLING',
      sk: 'RATES',
      activeIngestionKesPer1000Cents: rates.ingestionKesPer1000Cents,
      activePresentationKesPer1000Cents: rates.presentationKesPer1000Cents,
      revision: 1,
      updatedAt: now,
      updatedBy: actor,
    }
    try {
      await database.send(new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: tableName,
              Item: item,
              ConditionExpression: 'attribute_not_exists(pk)',
            },
          },
          {
            Put: {
              TableName: tableName,
              Item: {
                ...historyKey,
                kind: 'BILLING_RATE_CHANGE',
                effectiveMonth: currentBillingMonth(),
                ingestionKesPer1000Cents: rates.ingestionKesPer1000Cents,
                presentationKesPer1000Cents: rates.presentationKesPer1000Cents,
                actor,
                createdAt: now,
              },
              ConditionExpression: 'attribute_not_exists(pk)',
            },
          },
        ],
      }))
    } catch (error) {
      if (isConditionalConflict(error)) {
        return json(409, { error: 'Billing rates changed concurrently; reload and try again' })
      }
      throw error
    }
    return json(200, {
      configured: true,
      paymentsConfigured: Boolean(process.env.PESAPAL_SECRET_ARN),
      billingEnabled: isBillingEnabled(),
      effectiveMonth: currentBillingMonth(),
      scheduled: false,
    })
  }

  const currentMonth = currentBillingMonth()
  const currentRates = effectiveBillingRates(record, currentMonth)
  const effectiveMonth = nextBillingMonth(currentMonth)
  const revision = record.revision
  try {
    await database.send(new TransactWriteCommand({
      TransactItems: [
        {
          Update: {
            TableName: tableName,
            Key: { pk: 'PLATFORM#BILLING', sk: 'RATES' },
            UpdateExpression: [
              'SET #activeIngestion = :activeIngestion',
              '#activePresentation = :activePresentation',
              '#nextIngestion = :nextIngestion',
              '#nextPresentation = :nextPresentation',
              '#nextMonth = :nextMonth',
              '#updatedAt = :now',
              '#updatedBy = :actor',
              '#revision = #revision + :one',
            ].join(', '),
            ConditionExpression: '#revision = :revision',
            ExpressionAttributeNames: {
              '#activeIngestion': 'activeIngestionKesPer1000Cents',
              '#activePresentation': 'activePresentationKesPer1000Cents',
              '#nextIngestion': 'nextIngestionKesPer1000Cents',
              '#nextPresentation': 'nextPresentationKesPer1000Cents',
              '#nextMonth': 'nextEffectiveMonth',
              '#updatedAt': 'updatedAt',
              '#updatedBy': 'updatedBy',
              '#revision': 'revision',
            },
            ExpressionAttributeValues: {
              ':activeIngestion': currentRates.ingestionKesPer1000Cents,
              ':activePresentation': currentRates.presentationKesPer1000Cents,
              ':nextIngestion': rates.ingestionKesPer1000Cents,
              ':nextPresentation': rates.presentationKesPer1000Cents,
              ':nextMonth': effectiveMonth,
              ':now': now,
              ':actor': actor,
              ':revision': revision,
              ':one': 1,
            },
          },
        },
        {
          Put: {
            TableName: tableName,
            Item: {
              ...historyKey,
              kind: 'BILLING_RATE_CHANGE',
              effectiveMonth,
              ingestionKesPer1000Cents: rates.ingestionKesPer1000Cents,
              presentationKesPer1000Cents: rates.presentationKesPer1000Cents,
              actor,
              createdAt: now,
            },
            ConditionExpression: 'attribute_not_exists(pk)',
          },
        },
      ],
    }))
  } catch (error) {
    if (isConditionalConflict(error)) {
      return json(409, { error: 'Billing rates changed concurrently; reload and try again' })
    }
    throw error
  }
  return json(200, {
    configured: true,
    paymentsConfigured: Boolean(process.env.PESAPAL_SECRET_ARN),
    billingEnabled: isBillingEnabled(),
    effectiveMonth,
    scheduled: true,
  })
}

async function getCompanyBilling(
  companyId: string,
  companyName: unknown,
): Promise<APIGatewayProxyResultV2> {
  if (typeof companyName !== 'string' || companyName.trim().length === 0) {
    throw new Error('Company profile has no valid name for billing')
  }
  const month = currentBillingMonth()
  const rateRecord = await readBillingRateRecord()
  const rates = rateRecord ? effectiveBillingRates(rateRecord, month) : undefined
  const nextEffectiveMonth = rateRecord?.nextEffectiveMonth
  const scheduledRates = rateRecord && typeof nextEffectiveMonth === 'string' &&
    nextEffectiveMonth > month
    ? effectiveBillingRates(rateRecord, nextEffectiveMonth)
    : undefined
  const nextRates = scheduledRates && nextEffectiveMonth ? {
    effectiveMonth: nextEffectiveMonth,
    ingestionKesPer1000: scheduledRates.ingestionKesPer1000Cents / 100,
    presentationKesPer1000: scheduledRates.presentationKesPer1000Cents / 100,
  } : undefined
  const result = await database.send(new QueryCommand({
    TableName: tableName,
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
    ExpressionAttributeValues: {
      ':pk': `COMPANY#${companyId}`,
      ':prefix': 'BILLING#',
    },
    ScanIndexForward: false,
    Limit: 120,
  }))
  const usages = (result.Items ?? []).map((item) => ({ item, usage: readBillingUsage(item) }))
  const current = usages.find(({ usage }) => usage.month === month)?.usage
  const currentUsage = current ?? {
    month,
    ingestionCalls: 0,
    presentationCalls: 0,
    ingestionKesPer1000Cents: rates?.ingestionKesPer1000Cents ?? 0,
    presentationKesPer1000Cents: rates?.presentationKesPer1000Cents ?? 0,
  }
  const now = new Date()
  const invoices = usages
    .filter(({ usage }) => usage.month < month)
    .map(({ item, usage }) => {
      const invoice = createBillingInvoice(
        companyId,
        companyName,
        usage,
        invoiceIssueDate(usage.month),
      )
      const paymentStatus = invoice.totalAmountCents === 0
        ? 'no balance' as const
        : invoicePaymentStatus(item, invoice.dueAt, now)
      return {
        invoiceNumber: invoice.invoiceNumber,
        month: invoice.month,
        issuedAt: invoice.issuedAt,
        dueAt: invoice.dueAt,
        ingestionCalls: invoice.ingestionCalls,
        presentationCalls: invoice.presentationCalls,
        totalAmountKes: invoice.totalAmountCents / 100,
        paymentStatus,
        ...(item.paymentSource === 'manual' ? {
          paymentSource: 'manual',
          paidAt: typeof item.paidAt === 'string' ? item.paidAt : undefined,
          paymentMethod: typeof item.manualPaymentMethod === 'string' ? item.manualPaymentMethod : undefined,
          paymentReference: typeof item.manualPaymentReference === 'string'
            ? item.manualPaymentReference
            : undefined,
        } : {}),
        ...(paymentStatus === 'pending' && typeof item.paymentCheckoutUrl === 'string'
          ? { checkoutUrl: item.paymentCheckoutUrl }
          : {}),
      }
    })
  return json(200, {
    currency: 'KES',
    currentMonth: {
      month,
      ingestionCalls: currentUsage.ingestionCalls,
      presentationCalls: currentUsage.presentationCalls,
      estimatedAmountKes: rates ? createBillingInvoice(
        companyId,
        companyName,
        currentUsage,
        invoiceIssueDate(month),
      ).totalAmountCents / 100 : null,
    },
    ratesConfigured: Boolean(rates),
    paymentsConfigured: Boolean(process.env.PESAPAL_SECRET_ARN),
    billingEnabled: isBillingEnabled(),
    rates: rates ? {
      ingestionKesPer1000: rates.ingestionKesPer1000Cents / 100,
      presentationKesPer1000: rates.presentationKesPer1000Cents / 100,
    } : undefined,
    nextRates,
    invoices,
  })
}

async function getExecutiveCompanyBilling(
  companyId: string,
): Promise<APIGatewayProxyResultV2> {
  if (!isResourceId(companyId)) return json(400, { error: 'A valid company ID is required' })
  const profile = await database.send(new GetCommand({
    TableName: tableName,
    Key: { pk: `COMPANY#${companyId}`, sk: 'PROFILE' },
    ProjectionExpression: '#name',
    ExpressionAttributeNames: { '#name': 'name' },
  }))
  if (!profile.Item) return json(404, { error: 'Company not found' })
  return getCompanyBilling(companyId, profile.Item.name)
}

async function markExecutiveInvoicePaid(
  companyId: string,
  month: string,
  body: string | undefined,
  claims: unknown,
): Promise<APIGatewayProxyResultV2> {
  if (!isResourceId(companyId)) return json(400, { error: 'A valid company ID is required' })
  if (!validClosedBillingMonth(month)) {
    return json(400, { error: 'Only a closed YYYY-MM invoice can be marked paid' })
  }
  const parsed = parseBody(body)
  if (!parsed.ok) return parsed.response
  if (!isRecord(parsed.value)) return json(400, { error: 'Payment details must be an object' })
  const errors: string[] = []
  rejectUnknownKeys(parsed.value, ['method', 'reference'], 'payment', errors)
  errors.push(...validateManualPayment(parsed.value))
  if (errors.length > 0) return json(400, { error: 'Invalid manual payment details', details: errors })

  const method = parsed.value.method
  if (typeof method !== 'string') return json(400, { error: 'A payment method is required' })
  const reference = typeof parsed.value.reference === 'string'
    ? parsed.value.reference.trim()
    : ''
  const item = await getCompanyBillingItem(companyId, month)
  if (!item) return json(404, { error: 'No billable usage exists for this invoice period' })
  const usage = readBillingUsage(item)
  const invoice = createBillingInvoice(companyId, '', usage, invoiceIssueDate(month))
  if (invoice.totalAmountCents <= 0) {
    return json(409, { error: 'This invoice has no payable balance' })
  }
  if (item.paidAt !== undefined || item.paymentStatus === 'paid') {
    return json(409, { error: 'This invoice is already marked paid' })
  }
  if (item.paymentStatus === 'pending' || item.checkoutState === 'initiating') {
    return json(409, {
      error: 'This invoice has a pending Pesapal checkout; verify or resolve that payment before recording another payment',
    })
  }

  const actor = getAuditActor(claims)
  const now = new Date().toISOString()
  const auditKey = `AUDIT#${now}#${randomUUID()}`
  try {
    await database.send(new TransactWriteCommand({
      TransactItems: [
        {
          Update: {
            TableName: tableName,
            Key: { pk: `COMPANY#${companyId}`, sk: `BILLING#${month}` },
            UpdateExpression: 'SET #paymentStatus = :paid, #paidAt = :now, #paymentSource = :source, #method = :method, #reference = :reference, #paidBySubject = :subject, #paidByEmail = :email, #updatedAt = :now',
            ConditionExpression: 'attribute_not_exists(#paidAt) AND (attribute_not_exists(#paymentStatus) OR #paymentStatus <> :pending) AND (attribute_not_exists(#checkoutState) OR #checkoutState <> :initiating)',
            ExpressionAttributeNames: {
              '#paymentStatus': 'paymentStatus',
              '#paidAt': 'paidAt',
              '#checkoutState': 'checkoutState',
              '#paymentSource': 'paymentSource',
              '#method': 'manualPaymentMethod',
              '#reference': 'manualPaymentReference',
              '#paidBySubject': 'paidBySubject',
              '#paidByEmail': 'paidByEmail',
              '#updatedAt': 'updatedAt',
            },
            ExpressionAttributeValues: {
              ':paid': 'paid',
              ':pending': 'pending',
              ':initiating': 'initiating',
              ':source': 'manual',
              ':method': method,
              ':reference': reference,
              ':subject': actor.subject ?? '',
              ':email': actor.email ?? '',
              ':now': now,
            },
          },
        },
        {
          Put: {
            TableName: tableName,
            Item: createAuditItem(
              companyId,
              auditKey,
              actor,
              'INVOICE_MARKED_PAID_MANUALLY',
              {
                invoiceNumber: invoice.invoiceNumber,
                month,
                amountKes: invoice.totalAmountCents / 100,
                method,
                ...(reference ? { reference } : {}),
              },
              now,
            ),
            ConditionExpression: 'attribute_not_exists(pk)',
          },
        },
      ],
    }))
  } catch (error) {
    if (isConditionalConflict(error)) {
      return json(409, { error: 'Invoice payment status changed concurrently; reload and retry' })
    }
    throw error
  }
  return json(200, {
    invoiceNumber: invoice.invoiceNumber,
    paymentStatus: 'paid',
    paymentSource: 'manual',
    paidAt: now,
  })
}

async function getCompanyInvoicePdf(
  companyId: string,
  companyName: unknown,
  month: string,
): Promise<APIGatewayProxyResultV2> {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    return json(400, { error: 'Invoice month must use YYYY-MM format' })
  }
  if (month >= currentBillingMonth()) {
    return json(409, { error: 'Invoices are available after the billing month closes' })
  }
  if (typeof companyName !== 'string' || companyName.trim().length === 0) {
    throw new Error('Company profile has no valid name for billing')
  }
  const result = await database.send(new GetCommand({
    TableName: tableName,
    Key: { pk: `COMPANY#${companyId}`, sk: `BILLING#${month}` },
  }))
  if (!result.Item) return json(404, { error: 'No billable usage exists for this invoice period' })
  const invoice = createBillingInvoice(
    companyId,
    companyName,
    readBillingUsage(result.Item),
    invoiceIssueDate(month),
  )
  return json(200, {
    filename: `${invoice.invoiceNumber}.pdf`,
    contentBase64: Buffer.from(createInvoicePdf(invoice), 'ascii').toString('base64'),
  })
}

async function startInvoicePayment(
  companyId: string,
  companyName: unknown,
  month: string,
  email: string | undefined,
): Promise<APIGatewayProxyResultV2> {
  if (!validClosedBillingMonth(month)) {
    return json(400, { error: 'Payment can only be started for a closed YYYY-MM billing period' })
  }
  if (typeof companyName !== 'string' || !companyName.trim() || !email) {
    return json(400, { error: 'A valid company name and signed-in admin email are required for checkout' })
  }
  const usageItem = await getCompanyBillingItem(companyId, month)
  if (!usageItem) return json(404, { error: 'No billable usage exists for this invoice period' })
  const usage = readBillingUsage(usageItem)
  const invoice = createBillingInvoice(companyId, companyName, usage, invoiceIssueDate(month))
  if (invoice.totalAmountCents <= 0) {
    return json(409, { error: 'This invoice has no payable balance' })
  }
  if (usageItem.paidAt !== undefined || usageItem.paymentStatus === 'paid') {
    return json(409, { error: 'This invoice is already paid' })
  }
  if (usageItem.paymentStatus === 'pending' &&
    typeof usageItem.paymentCheckoutUrl === 'string' &&
    typeof usageItem.paymentTrackingId === 'string') {
    return json(200, {
      checkoutUrl: usageItem.paymentCheckoutUrl,
      paymentStatus: 'pending',
      invoiceNumber: invoice.invoiceNumber,
    })
  }
  const config = await getPesapalConfig()
  if (!config) return json(503, { error: 'Pesapal checkout is not configured for this deployment' })

  const attempts = typeof usageItem.paymentAttempts === 'number' &&
    Number.isSafeInteger(usageItem.paymentAttempts) && usageItem.paymentAttempts >= 0
    ? usageItem.paymentAttempts
    : 0
  if (attempts >= 99) return json(409, { error: 'The maximum payment retry count has been reached; contact Juu' })
  const merchantReference = `${invoice.invoiceNumber}-${attempts + 1}`
  const now = new Date().toISOString()
  try {
    await database.send(new UpdateCommand({
      TableName: tableName,
      Key: { pk: `COMPANY#${companyId}`, sk: `BILLING#${month}` },
      UpdateExpression: 'SET #checkoutState = :initiating, #paymentAttempts = :attempts, #paymentReference = :reference, #checkoutStartedAt = :now REMOVE #paymentStatus, #checkoutUrl, #trackingId',
      ConditionExpression: 'attribute_not_exists(#paidAt) AND (attribute_not_exists(#checkoutState) OR #checkoutState <> :initiating)',
      ExpressionAttributeNames: {
        '#checkoutState': 'checkoutState',
        '#paymentAttempts': 'paymentAttempts',
        '#paymentReference': 'paymentReference',
        '#checkoutStartedAt': 'checkoutStartedAt',
        '#paymentStatus': 'paymentStatus',
        '#checkoutUrl': 'paymentCheckoutUrl',
        '#trackingId': 'paymentTrackingId',
        '#paidAt': 'paidAt',
      },
      ExpressionAttributeValues: {
        ':initiating': 'initiating',
        ':attempts': attempts + 1,
        ':reference': merchantReference,
        ':now': now,
      },
    }))
  } catch (error) {
    if (isConditionalConflict(error)) {
      return json(409, { error: 'Payment checkout is already being prepared or this invoice has just been paid' })
    }
    throw error
  }

  try {
    const order = await submitPesapalOrder(config, invoice, merchantReference, email)
    await database.send(new UpdateCommand({
      TableName: tableName,
      Key: { pk: `COMPANY#${companyId}`, sk: `BILLING#${month}` },
      UpdateExpression: 'SET #checkoutState = :ready, #paymentStatus = :pending, #checkoutUrl = :url, #trackingId = :trackingId, #updatedAt = :now',
      ConditionExpression: '#paymentReference = :reference AND attribute_not_exists(#paidAt)',
      ExpressionAttributeNames: {
        '#checkoutState': 'checkoutState',
        '#paymentStatus': 'paymentStatus',
        '#checkoutUrl': 'paymentCheckoutUrl',
        '#trackingId': 'paymentTrackingId',
        '#paymentReference': 'paymentReference',
        '#updatedAt': 'updatedAt',
        '#paidAt': 'paidAt',
      },
      ExpressionAttributeValues: {
        ':ready': 'ready',
        ':pending': 'pending',
        ':url': order.redirectUrl,
        ':trackingId': order.trackingId,
        ':reference': merchantReference,
        ':now': new Date().toISOString(),
      },
    }))
    return json(200, {
      checkoutUrl: order.redirectUrl,
      paymentStatus: 'pending',
      invoiceNumber: invoice.invoiceNumber,
    })
  } catch (error) {
    try {
      await database.send(new UpdateCommand({
        TableName: tableName,
        Key: { pk: `COMPANY#${companyId}`, sk: `BILLING#${month}` },
        UpdateExpression: 'SET #checkoutState = :failed, #updatedAt = :now',
        ConditionExpression: '#paymentReference = :reference AND attribute_not_exists(#paidAt)',
        ExpressionAttributeNames: {
          '#checkoutState': 'checkoutState',
          '#updatedAt': 'updatedAt',
          '#paymentReference': 'paymentReference',
          '#paidAt': 'paidAt',
        },
        ExpressionAttributeValues: {
          ':failed': 'failed',
          ':reference': merchantReference,
          ':now': new Date().toISOString(),
        },
      }))
    } catch (updateError) {
      throw new AggregateError(
        [error, updateError],
        'Pesapal checkout failed and the billing record could not be released for retry',
      )
    }
    throw error
  }
}

async function refreshInvoicePaymentStatus(
  companyId: string,
  month: string,
): Promise<APIGatewayProxyResultV2> {
  if (!validClosedBillingMonth(month)) {
    return json(400, { error: 'Payment status is available only for a closed YYYY-MM billing period' })
  }
  const usageItem = await getCompanyBillingItem(companyId, month)
  if (!usageItem) return json(404, { error: 'No billable usage exists for this invoice period' })
  if (usageItem.paidAt !== undefined || usageItem.paymentStatus === 'paid') {
    return json(200, { paymentStatus: 'paid' })
  }
  if (typeof usageItem.paymentTrackingId !== 'string' ||
    typeof usageItem.paymentReference !== 'string') {
    return json(409, { error: 'No Pesapal payment is available to verify for this invoice' })
  }
  const outcome = await verifyPesapalPayment(
    companyId,
    month,
    usageItem.paymentTrackingId,
    usageItem.paymentReference,
  )
  return json(200, { paymentStatus: outcome })
}

async function handlePesapalIpn(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  const trackingId = queryParameter(event, 'OrderTrackingId')
  const merchantReference = queryParameter(event, 'OrderMerchantReference')
  const notificationType = queryParameter(event, 'OrderNotificationType') ?? 'IPNCHANGE'
  if (!trackingId || !merchantReference) {
    return json(400, { error: 'Pesapal notification is missing its order identifiers' })
  }
  const parsedReference = /^JUU-([0-9a-f-]{36})-(\d{4})(\d{2})-\d{1,2}$/i.exec(merchantReference)
  if (!parsedReference) return json(400, { error: 'Pesapal merchant reference is invalid' })
  const companyId = parsedReference[1]
  const month = `${parsedReference[2]}-${parsedReference[3]}`
  const usageItem = await getCompanyBillingItem(companyId, month)
  if (!usageItem || usageItem.paymentReference !== merchantReference ||
    usageItem.paymentTrackingId !== trackingId) {
    return json(404, { error: 'Pesapal order does not match an active Juu invoice' })
  }
  await verifyPesapalPayment(companyId, month, trackingId, merchantReference)
  return json(200, {
    orderNotificationType: notificationType,
    orderTrackingId: trackingId,
    orderMerchantReference: merchantReference,
    status: 200,
  })
}

async function verifyPesapalPayment(
  companyId: string,
  month: string,
  trackingId: string,
  merchantReference: string,
): Promise<'paid' | 'failed' | 'pending'> {
  const usageItem = await getCompanyBillingItem(companyId, month)
  if (!usageItem || usageItem.paymentTrackingId !== trackingId ||
    usageItem.paymentReference !== merchantReference) {
    throw new Error('Pesapal order no longer matches the Juu invoice record')
  }
  if (usageItem.paidAt !== undefined || usageItem.paymentStatus === 'paid') return 'paid'
  const config = await getPesapalConfig()
  if (!config) throw new Error('Pesapal checkout is not configured for this deployment')
  const token = await getPesapalToken(config)
  const statusUrl = new URL(`${config.baseUrl}/api/Transactions/GetTransactionStatus`)
  statusUrl.searchParams.set('orderTrackingId', trackingId)
  const remote = await pesapalRequest(statusUrl, {
    method: 'GET',
    headers: { authorization: `Bearer ${token}` },
  }, 'transaction status')
  if (!isRecord(remote) || !Number.isInteger(remote.status_code)) {
    throw new Error('Pesapal returned an invalid transaction status')
  }
  if (remote.status_code === 1) {
    const invoice = createBillingInvoice(
      companyId,
      '',
      readBillingUsage(usageItem),
      invoiceIssueDate(month),
    )
    const amount = typeof remote.amount === 'number'
      ? remote.amount
      : typeof remote.amount === 'string'
        ? Number(remote.amount)
        : Number.NaN
    if (remote.currency !== 'KES' || !Number.isFinite(amount) ||
      Math.round(amount * 100) !== invoice.totalAmountCents) {
      throw new Error('Pesapal reports a completed payment that does not match the KES invoice amount')
    }
    await database.send(new UpdateCommand({
      TableName: tableName,
      Key: { pk: `COMPANY#${companyId}`, sk: `BILLING#${month}` },
      UpdateExpression: 'SET #paymentStatus = :paid, #paidAt = if_not_exists(#paidAt, :now), #paymentConfirmation = :confirmation, #updatedAt = :now',
      ConditionExpression: '#paymentTrackingId = :trackingId AND #paymentReference = :reference AND attribute_not_exists(#paidAt)',
      ExpressionAttributeNames: {
        '#paymentStatus': 'paymentStatus',
        '#paidAt': 'paidAt',
        '#paymentConfirmation': 'paymentConfirmationCode',
        '#updatedAt': 'updatedAt',
        '#paymentTrackingId': 'paymentTrackingId',
        '#paymentReference': 'paymentReference',
      },
      ExpressionAttributeValues: {
        ':paid': 'paid',
        ':now': new Date().toISOString(),
        ':confirmation': typeof remote.confirmation_code === 'string' ? remote.confirmation_code : '',
        ':trackingId': trackingId,
        ':reference': merchantReference,
      },
    }))
    return 'paid'
  }
  if (remote.status_code === 2) {
    await database.send(new UpdateCommand({
      TableName: tableName,
      Key: { pk: `COMPANY#${companyId}`, sk: `BILLING#${month}` },
      UpdateExpression: 'SET #paymentStatus = :failed, #updatedAt = :now',
      ConditionExpression: '#paymentTrackingId = :trackingId AND #paymentReference = :reference AND attribute_not_exists(#paidAt)',
      ExpressionAttributeNames: {
        '#paymentStatus': 'paymentStatus',
        '#updatedAt': 'updatedAt',
        '#paymentTrackingId': 'paymentTrackingId',
        '#paymentReference': 'paymentReference',
        '#paidAt': 'paidAt',
      },
      ExpressionAttributeValues: {
        ':failed': 'failed',
        ':now': new Date().toISOString(),
        ':trackingId': trackingId,
        ':reference': merchantReference,
      },
    }))
    return 'failed'
  }
  return 'pending'
}

type PesapalConfig = {
  consumerKey: string
  consumerSecret: string
  notificationId: string
  callbackUrl: string
  baseUrl: string
}

async function getPesapalConfig(): Promise<PesapalConfig | undefined> {
  const secretArn = process.env.PESAPAL_SECRET_ARN
  const callbackUrl = process.env.PESAPAL_CALLBACK_URL
  const baseUrl = process.env.PESAPAL_BASE_URL
  if (!secretArn) return undefined
  if (!callbackUrl || !baseUrl ||
    (baseUrl !== 'https://pay.pesapal.com/v3' &&
      baseUrl !== 'https://cybqa.pesapal.com/pesapalv3')) {
    throw new Error('Pesapal deployment configuration is invalid')
  }
  const result = await secrets.send(new GetSecretValueCommand({ SecretId: secretArn }))
  if (typeof result.SecretString !== 'string') {
    throw new Error('Pesapal Secrets Manager value must be a JSON string')
  }
  let secret: unknown
  try {
    secret = JSON.parse(result.SecretString) as unknown
  } catch (error) {
    throw new Error('Pesapal Secrets Manager value is not valid JSON', { cause: error })
  }
  if (!isRecord(secret) || typeof secret.consumerKey !== 'string' ||
    !secret.consumerKey || typeof secret.consumerSecret !== 'string' ||
    !secret.consumerSecret || typeof secret.notificationId !== 'string' ||
    !secret.notificationId) {
    throw new Error('Pesapal secret must include consumerKey, consumerSecret, and notificationId')
  }
  return {
    consumerKey: secret.consumerKey,
    consumerSecret: secret.consumerSecret,
    notificationId: secret.notificationId,
    callbackUrl,
    baseUrl,
  }
}

async function submitPesapalOrder(
  config: PesapalConfig,
  invoice: ReturnType<typeof createBillingInvoice>,
  merchantReference: string,
  email: string,
): Promise<{ trackingId: string; redirectUrl: string }> {
  const token = await getPesapalToken(config)
  const response = await pesapalRequest(new URL(`${config.baseUrl}/api/Transactions/SubmitOrderRequest`), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      id: merchantReference,
      currency: 'KES',
      amount: invoice.totalAmountCents / 100,
      description: `Juu invoice ${invoice.invoiceNumber} for ${invoice.month}`,
      callback_url: config.callbackUrl,
      notification_id: config.notificationId,
      billing_address: { email_address: email },
    }),
  }, 'order submission')
  if (!isRecord(response) || typeof response.order_tracking_id !== 'string' ||
    typeof response.redirect_url !== 'string' ||
    response.merchant_reference !== merchantReference) {
    throw new Error('Pesapal returned an invalid checkout order')
  }
  const redirectUrl = new URL(response.redirect_url)
  if (redirectUrl.origin !== new URL(config.baseUrl).origin || redirectUrl.protocol !== 'https:') {
    throw new Error('Pesapal returned a checkout URL outside its configured payment origin')
  }
  return { trackingId: response.order_tracking_id, redirectUrl: redirectUrl.toString() }
}

async function getPesapalToken(config: PesapalConfig): Promise<string> {
  const result = await pesapalRequest(new URL(`${config.baseUrl}/api/Auth/RequestToken`), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      consumer_key: config.consumerKey,
      consumer_secret: config.consumerSecret,
    }),
  }, 'authentication')
  if (!isRecord(result) || typeof result.token !== 'string' || !result.token) {
    throw new Error('Pesapal authentication response did not contain an access token')
  }
  return result.token
}

async function pesapalRequest(
  url: URL,
  options: RequestInit,
  operation: string,
): Promise<unknown> {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(12_000) })
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`Pesapal ${operation} failed with HTTP ${response.status}`)
  }
  try {
    return JSON.parse(text) as unknown
  } catch (error) {
    throw new Error(`Pesapal ${operation} returned invalid JSON`, { cause: error })
  }
}

async function getCompanyBillingItem(
  companyId: string,
  month: string,
): Promise<Record<string, unknown> | undefined> {
  const result = await database.send(new GetCommand({
    TableName: tableName,
    Key: { pk: `COMPANY#${companyId}`, sk: `BILLING#${month}` },
  }))
  return result.Item
}

function queryParameter(event: APIGatewayProxyEventV2, requestedName: string): string | undefined {
  const parameters = event.queryStringParameters
  if (!parameters) return undefined
  const match = Object.entries(parameters).find(([name]) =>
    name.toLowerCase() === requestedName.toLowerCase())
  return match?.[1]
}

function validClosedBillingMonth(month: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(month) && month < currentBillingMonth()
}

async function runBillablePresentation(
  companyId: string,
  createResponse: () => Promise<APIGatewayProxyResultV2>,
): Promise<APIGatewayProxyResultV2> {
  const month = currentBillingMonth()
  const rates = await getBillingRatesForMonth(month)
  if (!rates || !isBillingEnabled()) {
    return json(503, { error: 'Juu billing rates and Pesapal payment setup must be configured before performance presentations are available' })
  }
  const overdueInvoice = await findOverdueInvoice(companyId)
  if (overdueInvoice) {
    return json(402, {
      error: `Billable usage is paused because invoice ${overdueInvoice.invoiceNumber} is overdue`,
      invoiceNumber: overdueInvoice.invoiceNumber,
      dueAt: overdueInvoice.dueAt,
    })
  }
  const response = await createResponse()
  if (typeof response === 'string') throw new Error('Performance endpoint returned an invalid response')
  if (response.statusCode !== 200) return response
  await database.send(new UpdateCommand({
    TableName: tableName,
    Key: { pk: `COMPANY#${companyId}`, sk: `BILLING#${month}` },
    UpdateExpression: [
      'SET #ingestionRate = if_not_exists(#ingestionRate, :ingestionRate)',
      '#presentationRate = if_not_exists(#presentationRate, :presentationRate)',
      '#updatedAt = :updatedAt',
      'ADD #presentationCalls :one',
    ].join(' '),
    ConditionExpression: '(attribute_not_exists(#ingestionRate) OR #ingestionRate = :ingestionRate) AND (attribute_not_exists(#presentationRate) OR #presentationRate = :presentationRate)',
    ExpressionAttributeNames: {
      '#ingestionRate': 'ingestionKesPer1000Cents',
      '#presentationRate': 'presentationKesPer1000Cents',
      '#presentationCalls': 'presentationCalls',
      '#updatedAt': 'updatedAt',
    },
    ExpressionAttributeValues: {
      ':ingestionRate': rates.ingestionKesPer1000Cents,
      ':presentationRate': rates.presentationKesPer1000Cents,
      ':updatedAt': new Date().toISOString(),
      ':one': 1,
    },
  }))
  return response
}

async function findOverdueInvoice(
  companyId: string,
  now = new Date(),
): Promise<{ invoiceNumber: string; dueAt: string } | undefined> {
  const month = currentBillingMonth(now)
  const result = await database.send(new QueryCommand({
    TableName: tableName,
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
    ExpressionAttributeValues: {
      ':pk': `COMPANY#${companyId}`,
      ':prefix': 'BILLING#',
    },
    ScanIndexForward: false,
    Limit: 120,
  }))
  for (const item of result.Items ?? []) {
    const usage = readBillingUsage(item)
    if (usage.month >= month || item.paidAt !== undefined) continue
    const invoice = createBillingInvoice(
      companyId,
      '',
      usage,
      invoiceIssueDate(usage.month),
    )
    if (invoice.totalAmountCents === 0 || new Date(invoice.dueAt) > now) continue
    return { invoiceNumber: invoice.invoiceNumber, dueAt: invoice.dueAt }
  }
  return undefined
}

async function getBillingRatesForMonth(month: string): Promise<BillingRates | undefined> {
  const record = await readBillingRateRecord()
  return record ? effectiveBillingRates(record, month) : undefined
}

async function readBillingRateRecord(): Promise<Record<string, unknown> | undefined> {
  const result = await database.send(new GetCommand({
    TableName: tableName,
    Key: { pk: 'PLATFORM#BILLING', sk: 'RATES' },
  }))
  if (!result.Item) return undefined
  const item: Record<string, unknown> = result.Item
  if (!isPositiveInteger(item.activeIngestionKesPer1000Cents) ||
    !isPositiveInteger(item.activePresentationKesPer1000Cents) ||
    !isPositiveInteger(item.revision)) {
    throw new Error('Stored platform billing rates are malformed')
  }
  if (item.nextEffectiveMonth !== undefined &&
    (typeof item.nextEffectiveMonth !== 'string' ||
      !/^\d{4}-(0[1-9]|1[0-2])$/.test(item.nextEffectiveMonth) ||
      !isPositiveInteger(item.nextIngestionKesPer1000Cents) ||
      !isPositiveInteger(item.nextPresentationKesPer1000Cents))) {
    throw new Error('Stored scheduled billing rates are malformed')
  }
  return item
}

function effectiveBillingRates(record: Record<string, unknown>, month: string): BillingRates {
  if (typeof record.nextEffectiveMonth === 'string' && record.nextEffectiveMonth <= month) {
    const ingestionKesPer1000Cents = record.nextIngestionKesPer1000Cents
    const presentationKesPer1000Cents = record.nextPresentationKesPer1000Cents
    if (!isPositiveInteger(ingestionKesPer1000Cents) ||
      !isPositiveInteger(presentationKesPer1000Cents)) {
      throw new Error('Stored scheduled billing rates are malformed')
    }
    return {
      ingestionKesPer1000Cents,
      presentationKesPer1000Cents,
    }
  }
  const ingestionKesPer1000Cents = record.activeIngestionKesPer1000Cents
  const presentationKesPer1000Cents = record.activePresentationKesPer1000Cents
  if (!isPositiveInteger(ingestionKesPer1000Cents) ||
    !isPositiveInteger(presentationKesPer1000Cents)) {
    throw new Error('Stored active billing rates are malformed')
  }
  return {
    ingestionKesPer1000Cents,
    presentationKesPer1000Cents,
  }
}

function readBillingUsage(item: Record<string, unknown>): BillingUsage {
  const month = typeof item.sk === 'string' ? item.sk.slice('BILLING#'.length) : ''
  if (!/^BILLING#\d{4}-(0[1-9]|1[0-2])$/.test(String(item.sk)) ||
    !isNonNegativeInteger(item.ingestionCalls) ||
    !isNonNegativeInteger(item.presentationCalls) ||
    !isPositiveInteger(item.ingestionKesPer1000Cents) ||
    !isPositiveInteger(item.presentationKesPer1000Cents)) {
    throw new Error('Stored company billing usage is malformed')
  }
  return {
    month,
    ingestionCalls: item.ingestionCalls,
    presentationCalls: item.presentationCalls,
    ingestionKesPer1000Cents: item.ingestionKesPer1000Cents,
    presentationKesPer1000Cents: item.presentationKesPer1000Cents,
  }
}

function invoiceIssueDate(month: string): string {
  const [year, monthNumber] = month.split('-').map(Number)
  const nextMonth = new Date(Date.UTC(year, monthNumber - 1, 1, -3))
  return nextMonth.toISOString()
}

function nextBillingMonth(month: string): string {
  const [year, monthNumber] = month.split('-').map(Number)
  return currentBillingMonth(new Date(Date.UTC(year, monthNumber, 1)))
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

async function listCompanies(cursor: string | undefined): Promise<APIGatewayProxyResultV2> {
    let exclusiveStartKey: Record<string, unknown> | undefined
    if (cursor) {
      try {
        const decoded: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
        if (!isRecord(decoded) || decoded.pk !== 'COMPANY_DIRECTORY' ||
          typeof decoded.sk !== 'string' || !/^COMPANY#[0-9a-f-]{36}$/i.test(decoded.sk)) {
          return json(400, { error: 'Invalid company pagination cursor' })
        }
        exclusiveStartKey = { pk: decoded.pk, sk: decoded.sk }
      } catch {
        return json(400, { error: 'Invalid company pagination cursor' })
      }
    }

    const result = await database.send(new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: {
        ':pk': 'COMPANY_DIRECTORY',
        ':prefix': 'COMPANY#',
      },
      ProjectionExpression: '#companyId, #name, #status, #createdAt, #updatedAt, #ceoName, #ceoEmail, #ceoPhoneNumber',
      ExpressionAttributeNames: {
        '#companyId': 'companyId',
        '#name': 'name',
        '#status': 'status',
        '#createdAt': 'createdAt',
        '#updatedAt': 'updatedAt',
        '#ceoName': 'ceoName',
        '#ceoEmail': 'ceoEmail',
        '#ceoPhoneNumber': 'ceoPhoneNumber',
      },
      Limit: 100,
      ExclusiveStartKey: exclusiveStartKey,
    }))
    return json(200, {
      companies: result.Items ?? [],
      nextCursor: result.LastEvaluatedKey
        ? Buffer.from(JSON.stringify(result.LastEvaluatedKey), 'utf8').toString('base64url')
        : undefined,
    })
  }

async function listExecutiveBilling(cursor: string | undefined): Promise<APIGatewayProxyResultV2> {
  let exclusiveStartKey: Record<string, unknown> | undefined
  if (cursor) {
    try {
      const decoded: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
      if (!isRecord(decoded) || decoded.pk !== 'COMPANY_DIRECTORY' ||
        typeof decoded.sk !== 'string' || !/^COMPANY#[0-9a-f-]{36}$/i.test(decoded.sk)) {
        return json(400, { error: 'Invalid billing pagination cursor' })
      }
      exclusiveStartKey = { pk: decoded.pk, sk: decoded.sk }
    } catch {
      return json(400, { error: 'Invalid billing pagination cursor' })
    }
  }

  const directory = await database.send(new QueryCommand({
    TableName: tableName,
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
    ExpressionAttributeValues: { ':pk': 'COMPANY_DIRECTORY', ':prefix': 'COMPANY#' },
    ProjectionExpression: '#companyId, #name',
    ExpressionAttributeNames: { '#companyId': 'companyId', '#name': 'name' },
    Limit: 25,
    ExclusiveStartKey: exclusiveStartKey,
  }))
  const month = currentBillingMonth()
  const now = new Date()
  const companyInvoices = await Promise.all((directory.Items ?? []).map(async (company) => {
    if (typeof company.companyId !== 'string' || typeof company.name !== 'string') {
      throw new Error('Company directory contains a malformed billing record')
    }
    const usages = await database.send(new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: {
        ':pk': `COMPANY#${company.companyId}`,
        ':prefix': 'BILLING#',
      },
      ScanIndexForward: false,
      Limit: 120,
    }))
    return (usages.Items ?? []).flatMap((item) => {
      const usage = readBillingUsage(item)
      if (usage.month >= month) return []
      const invoice = createBillingInvoice(
        company.companyId as string,
        company.name as string,
        usage,
        invoiceIssueDate(usage.month),
      )
      if (invoice.totalAmountCents === 0) return []
      const paymentStatus = invoicePaymentStatus(item, invoice.dueAt, now)
      if (paymentStatus === 'paid') return []
      return [{
        companyId: company.companyId,
        companyName: company.name,
        invoiceNumber: invoice.invoiceNumber,
        month: invoice.month,
        dueAt: invoice.dueAt,
        totalAmountKes: invoice.totalAmountCents / 100,
        paymentStatus,
      }]
    })
  }))
  return json(200, {
    invoices: companyInvoices.flat().sort((left, right) =>
      right.month.localeCompare(left.month) || left.companyName.localeCompare(right.companyName)),
    nextCursor: directory.LastEvaluatedKey
      ? Buffer.from(JSON.stringify(directory.LastEvaluatedKey), 'utf8').toString('base64url')
      : undefined,
  })
}

async function createCompanyAndInviteAdmin(
    body: string | undefined,
    claims: unknown,
  ): Promise<APIGatewayProxyResultV2> {
    const parsed = parseBody(body)
    if (!parsed.ok) return parsed.response
    if (!isRecord(parsed.value)) return json(400, { error: 'Company request must be an object' })
    const errors: string[] = []
    rejectUnknownKeys(parsed.value, ['companyName', 'adminEmail', 'adminName', 'adminPhoneNumber'], 'company', errors)
    validateText(parsed.value.companyName, 'companyName', errors, 128)
    validateAdminEmail(parsed.value.adminEmail, errors)
    errors.push(...validateInviteeContact(parsed.value.adminName, parsed.value.adminPhoneNumber, 'adminName', 'adminPhoneNumber'))
    if (errors.length > 0) return json(400, { error: 'Invalid company request', details: errors })

    const companyId = randomUUID()
    const now = new Date().toISOString()
    const auditKey = `AUDIT#${now}#${randomUUID()}`
    const companyName = (parsed.value.companyName as string).trim()
    const adminEmail = (parsed.value.adminEmail as string).trim().toLowerCase()
    const adminName = optionalContactValue(parsed.value.adminName)
    const adminPhoneNumber = optionalContactValue(parsed.value.adminPhoneNumber)
    const actor = getAuditActor(claims)
    const companyItem = {
      pk: `COMPANY#${companyId}`,
      sk: 'PROFILE',
      kind: 'COMPANY_PROFILE',
      companyId,
      name: companyName,
      ...(adminName ? { ceoName: adminName } : {}),
      ceoEmail: adminEmail,
      ...(adminPhoneNumber ? { ceoPhoneNumber: adminPhoneNumber } : {}),
      status: 'active',
      revision: 1,
      createdAt: now,
      updatedAt: now,
    }
    const directoryItem = {
      pk: 'COMPANY_DIRECTORY',
      sk: `COMPANY#${companyId}`,
      kind: 'COMPANY_DIRECTORY_ITEM',
      companyId,
      name: companyName,
      ...(adminName ? { ceoName: adminName } : {}),
      ceoEmail: adminEmail,
      ...(adminPhoneNumber ? { ceoPhoneNumber: adminPhoneNumber } : {}),
      status: 'active',
      createdAt: now,
      updatedAt: now,
    }

    await database.send(new TransactWriteCommand({
      TransactItems: [
        { Put: { TableName: tableName, Item: companyItem, ConditionExpression: 'attribute_not_exists(pk)' } },
        { Put: { TableName: tableName, Item: directoryItem, ConditionExpression: 'attribute_not_exists(pk)' } },
        {
          Put: {
            TableName: tableName,
            Item: createAuditItem(companyId, auditKey, actor, 'COMPANY_CREATED', {
              companyName,
              initialAdminEmail: adminEmail,
            }, now),
            ConditionExpression: 'attribute_not_exists(pk)',
          },
        },
      ],
    }))

    try {
      await createCognitoCompanyAdmin(companyId, adminEmail, adminName, adminPhoneNumber)
    } catch (error) {
      try {
        await database.send(new TransactWriteCommand({
          TransactItems: [
            { Delete: { TableName: tableName, Key: { pk: companyItem.pk, sk: companyItem.sk } } },
            { Delete: { TableName: tableName, Key: { pk: directoryItem.pk, sk: directoryItem.sk } } },
            { Delete: { TableName: tableName, Key: { pk: companyItem.pk, sk: auditKey } } },
          ],
        }))
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          'Company invitation failed and company rollback was incomplete',
        )
      }
      throw error
    }

    return json(201, {
      company: { companyId, name: companyName, status: 'active', createdAt: now },
      invitedAdmin: adminEmail,
      message: 'Company created and admin invitation sent',
    })
  }

async function inviteCompanyAdmin(
    companyId: string | undefined,
    body: string | undefined,
    claims: unknown,
  ): Promise<APIGatewayProxyResultV2> {
    if (!companyId || !isResourceId(companyId)) {
      return json(400, { error: 'A valid company ID is required' })
    }
    const parsed = parseBody(body)
    if (!parsed.ok) return parsed.response
    if (!isRecord(parsed.value)) return json(400, { error: 'Admin invitation must be an object' })
    const errors: string[] = []
    rejectUnknownKeys(parsed.value, ['adminEmail', 'adminName', 'adminPhoneNumber'], 'invitation', errors)
    validateAdminEmail(parsed.value.adminEmail, errors)
    errors.push(...validateInviteeContact(parsed.value.adminName, parsed.value.adminPhoneNumber, 'adminName', 'adminPhoneNumber'))
    if (errors.length > 0) return json(400, { error: 'Invalid admin invitation', details: errors })

    const profile = await database.send(new GetCommand({
      TableName: tableName,
      Key: { pk: `COMPANY#${companyId}`, sk: 'PROFILE' },
      ProjectionExpression: '#name, #status',
      ExpressionAttributeNames: { '#name': 'name', '#status': 'status' },
    }))
    if (!profile.Item) return json(404, { error: 'Company not found' })
    if (profile.Item.status !== 'active') {
      return json(409, { error: 'Admins cannot be invited while a company is suspended' })
    }

    const adminEmail = (parsed.value.adminEmail as string).trim().toLowerCase()
    const adminName = optionalContactValue(parsed.value.adminName)
    const adminPhoneNumber = optionalContactValue(parsed.value.adminPhoneNumber)
    await createCognitoCompanyAdmin(companyId, adminEmail, adminName, adminPhoneNumber)
    const now = new Date().toISOString()
    const auditKey = `AUDIT#${now}#${randomUUID()}`
    try {
      await database.send(new PutCommand({
        TableName: tableName,
        Item: createAuditItem(
          companyId,
          auditKey,
          getAuditActor(claims),
          'COMPANY_ADMIN_INVITED',
          { adminEmail },
          now,
        ),
        ConditionExpression: 'attribute_not_exists(pk)',
      }))
    } catch (error) {
      try {
        await cognito.send(new AdminDeleteUserCommand({ UserPoolId: userPoolId, Username: adminEmail }))
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          'Admin invitation audit failed and the Cognito user rollback was incomplete',
        )
      }
      throw error
    }
    return json(201, { companyId, invitedAdmin: adminEmail, message: 'Company admin invitation sent' })
  }

async function updateCompanyStatus(
    companyId: string | undefined,
    body: string | undefined,
    claims: unknown,
  ): Promise<APIGatewayProxyResultV2> {
    if (!companyId || !isResourceId(companyId)) {
      return json(400, { error: 'A valid company ID is required' })
    }
    const parsed = parseBody(body)
    if (!parsed.ok) return parsed.response
    if (!isRecord(parsed.value)) return json(400, { error: 'Company status request must be an object' })
    const errors: string[] = []
    rejectUnknownKeys(parsed.value, ['status', 'reason'], 'status', errors)
    if (parsed.value.status !== 'active' && parsed.value.status !== 'suspended') {
      errors.push('status must be active or suspended')
    }
    validateText(parsed.value.reason, 'reason', errors, 512)
    if (errors.length > 0) return json(400, { error: 'Invalid company status request', details: errors })

    const companyKey = { pk: `COMPANY#${companyId}`, sk: 'PROFILE' }
    const directoryKey = { pk: 'COMPANY_DIRECTORY', sk: `COMPANY#${companyId}` }
    const profile = await database.send(new GetCommand({ TableName: tableName, Key: companyKey }))
    if (!profile.Item) return json(404, { error: 'Company not found' })
    const previousStatus = profile.Item.status
    if (previousStatus !== 'active' && previousStatus !== 'suspended') {
      throw new Error(`Company ${companyId} has an invalid stored status`)
    }
    const status = parsed.value.status
    if (previousStatus === status) return json(200, { companyId, status, changed: false })

    const now = new Date().toISOString()
    const auditKey = `AUDIT#${now}#${randomUUID()}`
    const reason = (parsed.value.reason as string).trim()
    try {
      await database.send(new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: tableName,
              Key: companyKey,
              UpdateExpression: 'SET #status = :next, updatedAt = :now, revision = if_not_exists(revision, :zero) + :one',
              ConditionExpression: '#status = :previous',
              ExpressionAttributeNames: { '#status': 'status' },
              ExpressionAttributeValues: {
                ':next': status,
                ':previous': previousStatus,
                ':now': now,
                ':zero': 0,
                ':one': 1,
              },
            },
          },
          {
            Update: {
              TableName: tableName,
              Key: directoryKey,
              UpdateExpression: 'SET #status = :next, updatedAt = :now',
              ConditionExpression: 'attribute_exists(pk) AND #status = :previous',
              ExpressionAttributeNames: { '#status': 'status' },
              ExpressionAttributeValues: {
                ':next': status,
                ':previous': previousStatus,
                ':now': now,
              },
            },
          },
          {
            Put: {
              TableName: tableName,
              Item: createAuditItem(
                companyId,
                auditKey,
                getAuditActor(claims),
                status === 'suspended' ? 'COMPANY_SUSPENDED' : 'COMPANY_REACTIVATED',
                { previousStatus, status, reason },
                now,
              ),
              ConditionExpression: 'attribute_not_exists(pk)',
            },
          },
        ],
      }))
    } catch (error) {
      if (isConditionalConflict(error)) {
        return json(409, { error: 'Company status changed concurrently; reload and retry' })
      }
      throw error
    }
    return json(200, { companyId, status, changed: true })
  }

async function createCognitoCompanyAdmin(
  companyId: string,
  email: string,
  name?: string,
  phoneNumber?: string,
): Promise<void> {
    let created = false
    try {
      await cognito.send(new AdminCreateUserCommand({
        UserPoolId: userPoolId,
        Username: email,
        DesiredDeliveryMediums: ['EMAIL'],
        UserAttributes: [
          { Name: 'email', Value: email },
          ...(name ? [{ Name: 'name', Value: name }] : []),
          ...(phoneNumber ? [{ Name: 'phone_number', Value: phoneNumber }] : []),
          { Name: 'custom:company_id', Value: companyId },
        ],
      }))
      created = true
      await cognito.send(new AdminAddUserToGroupCommand({
        UserPoolId: userPoolId,
        Username: email,
        GroupName: 'CompanyAdmin',
      }))
    } catch (error) {
      if (!created) throw error
      try {
        await cognito.send(new AdminDeleteUserCommand({ UserPoolId: userPoolId, Username: email }))
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], 'Company admin invitation failed and Cognito rollback was incomplete')
      }
      throw error
    }
  }

  async function createCognitoCompanyLeader(
    companyId: string,
    email: string,
    name?: string,
    phoneNumber?: string,
  ): Promise<string> {
    let created = false
    try {
      const createdUser = await cognito.send(new AdminCreateUserCommand({
        UserPoolId: userPoolId,
        Username: email,
        DesiredDeliveryMediums: ['EMAIL'],
        UserAttributes: [
          { Name: 'email', Value: email },
          ...(name ? [{ Name: 'name', Value: name }] : []),
          ...(phoneNumber ? [{ Name: 'phone_number', Value: phoneNumber }] : []),
          { Name: 'custom:company_id', Value: companyId },
        ],
      }))
      created = true
      const subject = createdUser.User?.Attributes?.find((attribute) => attribute.Name === 'sub')?.Value
      if (!subject || !/^[0-9a-f-]{36}$/i.test(subject)) {
        throw new Error('Cognito did not return a valid subject for the invited company leader')
      }
      await cognito.send(new AdminAddUserToGroupCommand({
        UserPoolId: userPoolId,
        Username: email,
        GroupName: 'CompanyLeader',
      }))
      return subject
    } catch (error) {
      if (!created) throw error
      try {
        await cognito.send(new AdminDeleteUserCommand({ UserPoolId: userPoolId, Username: email }))
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          'Company leader invitation failed and Cognito rollback was incomplete',
        )
      }
      throw error
    }
  }

  function createAuditItem(
    companyId: string,
    sortKey: string,
    actor: { subject?: string; email?: string },
    action: string,
    details: Record<string, unknown>,
    createdAt: string,
  ): Record<string, unknown> {
    return {
      pk: `COMPANY#${companyId}`,
      sk: sortKey,
      kind: 'EXECUTIVE_AUDIT',
      actorSubject: actor.subject,
      actorEmail: actor.email,
      action,
      details,
      createdAt,
    }
  }

function getAuditActor(claims: unknown): { subject?: string; email?: string } {
    if (!isRecord(claims)) throw new Error('Authenticated JWT claims are missing')
    return {
      subject: typeof claims.sub === 'string' ? claims.sub : undefined,
      email: typeof claims.email === 'string' ? claims.email : undefined,
    }
  }

function validateAdminEmail(value: unknown, errors: string[]): void {
    if (typeof value !== 'string' || value.trim().length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())) {
      errors.push('adminEmail must be a valid email address')
    }
  }

async function getContract(companyId: string): Promise<APIGatewayProxyResultV2> {
  const active = await database.send(new GetCommand({
    TableName: tableName,
    Key: { pk: `COMPANY#${companyId}`, sk: 'CONTRACT#ACTIVE' },
  }))
  if (!active.Item) return json(404, { error: 'No event contract is configured' })

  const contract = await database.send(new GetCommand({
    TableName: tableName,
    Key: { pk: `COMPANY#${companyId}`, sk: `CONTRACT#${active.Item.version}` },
  }))
  if (!contract.Item) throw new Error(`Active contract ${active.Item.version} is missing`)

  return json(200, { contract: contract.Item.definition })
}

async function putContract(
  companyId: string,
  body: string | undefined,
  requestId: string,
): Promise<APIGatewayProxyResultV2> {
  const parsed = parseBody(body)
  if (!parsed.ok) return parsed.response
  const errors = validateContract(parsed.value, { requireProductAssociations: true })
  if (errors.length > 0) return json(400, { error: 'Invalid event contract', details: errors, requestId })
  if (!isValidatedEventContract(parsed.value)) {
    throw new Error('Validated event contract failed its type guard')
  }
  const contract: EventContract = parsed.value
  const productIds = [...new Set(contract.eventTypes.flatMap((eventType) => eventType.productIds ?? []))]
  for (const productId of productIds) {
    const product = await database.send(new GetCommand({
      TableName: tableName,
      Key: { pk: `COMPANY#${companyId}`, sk: `CONFIG#PRODUCT#${productId}` },
      ProjectionExpression: '#active',
      ExpressionAttributeNames: { '#active': 'active' },
    }))
    if (product.Item?.active !== true) {
      return json(400, {
        error: 'Invalid event contract',
        details: [`Product ${productId} must refer to an active product in this company`],
        requestId,
      })
    }
  }

  const active = await database.send(new GetCommand({
    TableName: tableName,
    Key: { pk: `COMPANY#${companyId}`, sk: 'CONTRACT#ACTIVE' },
  }))
  if (active.Item && contract.version <= active.Item.version) {
    return json(409, { error: 'Contract version must be greater than the active version', requestId })
  }

  try {
    await database.send(new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: tableName,
            Item: {
              pk: `COMPANY#${companyId}`,
              sk: `CONTRACT#${contract.version}`,
              kind: 'EVENT_CONTRACT',
              version: contract.version,
              definition: contract,
              createdAt: new Date().toISOString(),
            },
            ConditionExpression: 'attribute_not_exists(pk)',
          },
        },
        {
          Put: {
            TableName: tableName,
            Item: {
              pk: `COMPANY#${companyId}`,
              sk: 'CONTRACT#ACTIVE',
              kind: 'ACTIVE_EVENT_CONTRACT',
              version: contract.version,
            },
            ConditionExpression: 'attribute_not_exists(#version) OR #version < :version',
            ExpressionAttributeNames: { '#version': 'version' },
            ExpressionAttributeValues: { ':version': contract.version },
          },
        },
      ],
    }))
  } catch (error) {
    if (isConditionalConflict(error)) {
      return json(409, {
        error: 'Contract version must be unique and greater than the active version',
        requestId,
      })
    }
    throw error
  }
  return json(201, { contract })
}

async function createIntegrationKey(companyId: string): Promise<APIGatewayProxyResultV2> {
  const integrationId = randomUUID()
  const key = `uppy_live_${randomBytes(32).toString('base64url')}`
  const credentialHash = hashKey(key)

  await database.send(new TransactWriteCommand({
    TransactItems: [
      {
        Put: {
          TableName: tableName,
          Item: {
            pk: `COMPANY#${companyId}`,
            sk: `INTEGRATION#${integrationId}`,
            kind: 'INTEGRATION_KEY',
            integrationId,
            credentialHash,
            active: true,
            createdAt: new Date().toISOString(),
          },
          ConditionExpression: 'attribute_not_exists(pk)',
        },
      },
      {
        Put: {
          TableName: tableName,
          Item: {
            pk: `CREDENTIAL#${credentialHash}`,
            sk: 'LOOKUP',
            kind: 'INTEGRATION_CREDENTIAL',
            companyId,
            integrationId,
            active: true,
          },
          ConditionExpression: 'attribute_not_exists(pk)',
        },
      },
    ],
  }))

  return json(201, {
    integrationId,
    key,
    warning: 'Copy this key now. It will not be shown again.',
  })
}

async function listIntegrationKeys(companyId: string): Promise<APIGatewayProxyResultV2> {
  const result = await database.send(new QueryCommand({
    TableName: tableName,
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
    ExpressionAttributeValues: {
      ':pk': `COMPANY#${companyId}`,
      ':prefix': 'INTEGRATION#',
    },
    ProjectionExpression: '#id, #active, #created, #revoked',
    ExpressionAttributeNames: {
      '#id': 'integrationId',
      '#active': 'active',
      '#created': 'createdAt',
      '#revoked': 'revokedAt',
    },
  }))

  return json(200, { integrationKeys: result.Items ?? [] })
}

async function getPerformance(
  companyId: string,
  parameters: Record<string, string | undefined>,
  leaderRootId?: string,
  metricDepth = 0,
  eventCache: Map<string, PerformanceEvent[]> = new Map(),
): Promise<APIGatewayProxyResultV2> {
  const metricId = parameters.metricId
  const from = parameters.from
  const to = parameters.to
  const bucket = parameters.bucket ?? 'day'
  if (metricDepth > 2) {
    return json(409, { error: 'Calculated metric references exceed the supported nesting depth' })
  }
  if (!metricId || !isResourceId(metricId)) {
    return json(400, { error: 'metricId must be a valid Uppy metric ID' })
  }
  if (!isDateOnly(from) || !isDateOnly(to) || from > to) {
    return json(400, { error: 'from and to must be valid YYYY-MM-DD dates with from on or before to' })
  }
  if (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`) >
    89 * 24 * 60 * 60 * 1000) {
    return json(400, { error: 'Performance reports are limited to 90 calendar days per request' })
  }
  if (bucket !== 'day' && bucket !== 'week' && bucket !== 'month') {
    return json(400, { error: 'bucket must be day, week, or month' })
  }
  const productId = parameters.productId
  const locationId = parameters.locationId
  const referenceMetricId = parameters.referenceMetricId
  const referenceProductId = parameters.referenceProductId
  if ((referenceMetricId === undefined) !== (referenceProductId === undefined)) {
    return json(400, { error: 'referenceMetricId and referenceProductId must be provided together' })
  }
  if (referenceMetricId !== undefined && !isResourceId(referenceMetricId)) {
    return json(400, { error: 'referenceMetricId must be a valid Uppy metric ID' })
  }
  if (referenceProductId !== undefined && !isResourceId(referenceProductId)) {
    return json(400, { error: 'referenceProductId must be a valid Uppy product ID' })
  }
  const requestedUnitId = parameters.orgUnitId
  if (productId !== undefined && !isResourceId(productId)) {
    return json(400, { error: 'productId must be a valid Uppy product ID' })
  }
  if (locationId !== undefined && !isResourceId(locationId)) {
    return json(400, { error: 'locationId must be a valid Uppy location ID' })
  }
  if (requestedUnitId !== undefined && !isResourceId(requestedUnitId)) {
    return json(400, { error: 'orgUnitId must be a valid organization unit ID' })
  }
  let orgUnitIds: string[] | undefined
  if (leaderRootId || requestedUnitId) {
    const units = await loadOrganizationUnits(companyId)
    const rootId = leaderRootId ?? requestedUnitId
    const root = units.find((unit) => unit.id === rootId && unit.active)
    if (!root) return json(leaderRootId ? 403 : 404, { error: 'Active organization unit not found' })
    if (leaderRootId && requestedUnitId &&
      !getUnitSubtreeIds(units, leaderRootId).includes(requestedUnitId)) {
      return json(403, { error: 'You cannot view performance outside your assigned organization unit' })
    }
    orgUnitIds = getUnitSubtreeIds(units, requestedUnitId ?? leaderRootId!)
  }

  const metricResult = await database.send(new GetCommand({
    TableName: tableName,
    Key: { pk: `COMPANY#${companyId}`, sk: configSortKey('metrics', metricId) },
  }))
  const metricItem = metricResult.Item
  if (!metricItem) return json(404, { error: 'Metric not found' })
  if (metricItem.active !== true) return json(409, { error: 'Metric is inactive' })

  if (metricItem.calculation !== undefined) {
    if (productId !== undefined) {
      return json(400, { error: 'productId is not used for calculated metrics; their component products are part of the metric definition' })
    }
    if (!isMetricCalculation(metricItem.calculation) ||
      typeof metricItem.name !== 'string' || typeof metricItem.unit !== 'string' ||
      (metricItem.direction !== 'higher' && metricItem.direction !== 'lower')) {
      throw new Error(`Stored calculated metric ${metricId} is invalid`)
    }
    const [leftOperand, rightOperand] = metricItem.calculation.operands
    const leftResponse = await getPerformance(companyId, {
      metricId: leftOperand.metricId,
      from,
      to,
      bucket,
      productId: leftOperand.productId,
      locationId,
      orgUnitId: requestedUnitId,
    }, leaderRootId, metricDepth + 1, eventCache)
    if (typeof leftResponse === 'string') throw new Error('Metric component calculation returned an invalid response')
    if (leftResponse.statusCode !== 200) return leftResponse
    const leftReport = readPerformanceResponse(leftResponse)
    const rightResponse = await getPerformance(companyId, {
      metricId: rightOperand.metricId,
      from,
      to,
      bucket,
      productId: rightOperand.productId,
      locationId,
      orgUnitId: requestedUnitId,
    }, leaderRootId, metricDepth + 1, eventCache)
    if (typeof rightResponse === 'string') throw new Error('Metric component calculation returned an invalid response')
    if (rightResponse.statusCode !== 200) return rightResponse
    const rightReport = readPerformanceResponse(rightResponse)
    if (leftReport.metric.unit !== rightReport.metric.unit &&
      ['add', 'subtract'].includes(metricItem.calculation.operator)) {
      throw new Error(`Stored calculated metric ${metricId} combines incompatible units`)
    }
    const report = combinePerformanceReports(
      leftReport,
      rightReport,
      metricItem.calculation.operator,
      { id: metricId, name: metricItem.name, unit: metricItem.unit, direction: metricItem.direction },
    )
    if (!referenceMetricId || !referenceProductId) return json(200, { report })
    return comparePerformanceWithReference(
      companyId,
      report,
      referenceMetricId,
      referenceProductId,
      { from, to, bucket, locationId, orgUnitId: requestedUnitId },
      leaderRootId,
      metricDepth,
      eventCache,
    )
  }

  if (metricItem.contractVersion === undefined) {
    return json(409, {
      error: 'This metric is not pinned to an event-contract version; create a replacement metric to generate a report',
    })
  }
  const aggregation = metricItem.aggregation ?? 'sum'
  if (typeof metricItem.id !== 'string' || typeof metricItem.name !== 'string' ||
    typeof metricItem.unit !== 'string' ||
    (metricItem.direction !== 'higher' && metricItem.direction !== 'lower') ||
    typeof metricItem.eventType !== 'string' ||
    typeof metricItem.contractVersion !== 'number' ||
    !Number.isSafeInteger(metricItem.contractVersion) || metricItem.contractVersion < 1 ||
    !isMetricExpression(metricItem.formula) || !isMetricAggregation(aggregation)) {
    throw new Error(`Stored metric ${metricId} is invalid`)
  }
  const metric: PerformanceMetric = {
    id: metricItem.id,
    contractVersion: metricItem.contractVersion,
    name: metricItem.name,
    unit: metricItem.unit,
    direction: metricItem.direction,
    eventType: metricItem.eventType,
    formula: metricItem.formula,
    aggregation,
  }

  const calculator = createPerformanceCalculator(metric, {
    from,
    to,
    bucket: bucket as PerformanceBucket,
    productId,
    locationId,
    orgUnitIds,
  })
  const cacheKey = `${from}:${to}`
  let events = eventCache.get(cacheKey)
  if (!events) {
    const maximumEvents = 5000
    const maximumQueryPages = 20
    let exclusiveStartKey: Record<string, unknown> | undefined
    let scannedEvents = 0
    let queryPages = 0
    events = []
    do {
      queryPages += 1
      const result = await database.send(new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: 'pk = :pk AND sk BETWEEN :from AND :to',
        ExpressionAttributeValues: {
          ':pk': `COMPANY#${companyId}`,
          ':from': `EVENT#${from}T00:00:00.000Z`,
          ':to': `EVENT#${to}T23:59:59.999Z\uffff`,
        },
        ProjectionExpression: '#contractVersion, #eventType, #occurredAt, #productId, #locationId, #orgUnitId, #location, #fields',
        ExpressionAttributeNames: {
          '#contractVersion': 'contractVersion',
          '#eventType': 'eventType',
          '#occurredAt': 'occurredAt',
          '#productId': 'productId',
          '#locationId': 'locationId',
          '#orgUnitId': 'orgUnitId',
          '#location': 'location',
          '#fields': 'fields',
        },
        Limit: Math.min(250, maximumEvents + 1 - scannedEvents),
        ExclusiveStartKey: exclusiveStartKey,
      }))
      if (typeof result.ScannedCount !== 'number') {
        throw new Error('DynamoDB did not return the performance query scan count')
      }
      scannedEvents += result.ScannedCount
      if (scannedEvents > maximumEvents ||
        (result.LastEvaluatedKey &&
          (scannedEvents === maximumEvents || queryPages === maximumQueryPages))) {
        return json(413, {
          error: 'This report exceeds its event or query-page limit; narrow the date range and retry',
        })
      }
      events.push(...(result.Items ?? []).map(readPerformanceEvent))
      exclusiveStartKey = result.LastEvaluatedKey
    } while (exclusiveStartKey)
    eventCache.set(cacheKey, events)
  }
  for (const event of events) calculator.addEvent(event)

  const report = calculator.report()
  if (!referenceMetricId || !referenceProductId) return json(200, { report })
  return comparePerformanceWithReference(
    companyId,
    report,
    referenceMetricId,
    referenceProductId,
    { from, to, bucket, locationId, orgUnitId: requestedUnitId },
    leaderRootId,
    metricDepth,
    eventCache,
  )
}

async function getCombinedPerformance(
  companyId: string,
  body: string | undefined,
  leaderRootId?: string,
  leaderRequest = false,
): Promise<APIGatewayProxyResultV2> {
  const parsed = parseBody(body)
  if (!parsed.ok) return parsed.response
  if (!isRecord(parsed.value)) return json(400, { error: 'Combined performance request must be an object' })
  const input = parsed.value
  const from = input.from
  const to = input.to
  const bucket = input.bucket ?? 'day'
  const operator = input.operator
  if (typeof from !== 'string' || typeof to !== 'string' ||
    !isDateOnly(from) || !isDateOnly(to) || from > to) {
    return json(400, { error: 'from and to must be valid YYYY-MM-DD dates with from on or before to' })
  }
  if (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`) >
    89 * 24 * 60 * 60 * 1000) {
    return json(400, { error: 'Performance reports are limited to 90 calendar days per request' })
  }
  if (bucket !== 'day' && bucket !== 'week' && bucket !== 'month') {
    return json(400, { error: 'bucket must be day, week, or month' })
  }
  if (operator !== 'add' && operator !== 'subtract' && operator !== 'multiply' && operator !== 'divide') {
    return json(400, { error: 'operator must be add, subtract, multiply, or divide' })
  }
  if (leaderRequest && input.orgUnitId !== undefined) {
    return json(400, { error: 'Leader combined reports always use the assigned organization scope' })
  }
  const requestedUnitId = input.orgUnitId
  if (requestedUnitId !== undefined &&
    (typeof requestedUnitId !== 'string' || !isResourceId(requestedUnitId))) {
    return json(400, { error: 'orgUnitId must be a valid organization unit ID' })
  }
  const readSelections = (value: unknown, side: string) => {
    if (!Array.isArray(value) || value.length === 0 || value.length > 20) {
      return { error: `Each group must contain between 1 and 20 metric/product selections` }
    }
    const selections: Array<{ metricId: string; productId: string }> = []
    for (const item of value) {
      if (!isRecord(item) || typeof item.metricId !== 'string' ||
        typeof item.productId !== 'string' || !isResourceId(item.metricId) ||
        !isResourceId(item.productId)) {
        return { error: `Every ${side} selection must include a valid metricId and productId` }
      }
      selections.push({ metricId: item.metricId, productId: item.productId })
    }
    return { selections }
  }
  const left = readSelections(input.left, 'first-group')
  if ('error' in left) return json(400, { error: left.error })
  const right = readSelections(input.right, 'second-group')
  if ('error' in right) return json(400, { error: right.error })

  const eventCache = new Map<string, PerformanceEvent[]>()
  const reports: PerformanceReport[] = []
  for (const selection of [...left.selections, ...right.selections]) {
    const response = await getPerformance(companyId, {
      metricId: selection.metricId,
      productId: selection.productId,
      from,
      to,
      bucket,
      ...(requestedUnitId ? { orgUnitId: requestedUnitId } : {}),
    }, leaderRootId, 0, eventCache)
    if (typeof response === 'string') throw new Error('Combined metric calculation returned an invalid response')
    if (response.statusCode !== 200) return response
    reports.push(readPerformanceResponse(response))
  }
  const leftReports = reports.slice(0, left.selections.length)
  const rightReports = reports.slice(left.selections.length)
  const leftUnit = leftReports[0].metric.unit
  const rightUnit = rightReports[0].metric.unit
  if (leftReports.some((report) => report.metric.unit !== leftUnit) ||
    rightReports.some((report) => report.metric.unit !== rightUnit)) {
    return json(400, { error: 'Metrics within each group must use the same unit' })
  }
  if ((operator === 'add' || operator === 'subtract') && leftUnit !== rightUnit) {
    return json(400, { error: 'Addition and subtraction require both groups to use the same unit' })
  }
  return json(200, { reports })
}

async function comparePerformanceWithReference(
  companyId: string,
  primaryReport: PerformanceReport,
  referenceMetricId: string,
  referenceProductId: string,
  options: {
    from: string
    to: string
    bucket: string
    locationId?: string
    orgUnitId?: string
  },
  leaderRootId: string | undefined,
  metricDepth: number,
  eventCache: Map<string, PerformanceEvent[]>,
): Promise<APIGatewayProxyResultV2> {
  const referenceResponse = await getPerformance(companyId, {
    metricId: referenceMetricId,
    from: options.from,
    to: options.to,
    bucket: options.bucket,
    productId: referenceProductId,
    locationId: options.locationId,
    orgUnitId: options.orgUnitId,
  }, leaderRootId, metricDepth + 1, eventCache)
  if (typeof referenceResponse === 'string') throw new Error('Reference metric calculation returned an invalid response')
  if (referenceResponse.statusCode !== 200) return referenceResponse
  const referenceReport = readPerformanceResponse(referenceResponse)
  if (primaryReport.metric.unit !== referenceReport.metric.unit) {
    return json(400, { error: 'Percentage comparisons require metrics with compatible units' })
  }
  return json(200, {
    report: percentageOfReference(
      primaryReport,
      referenceReport,
      referenceMetricId,
      referenceProductId,
    ),
  })
}

function readPerformanceResponse(response: APIGatewayProxyResultV2): PerformanceReport {
  if (typeof response === 'string' || !('body' in response) || typeof response.body !== 'string') {
    throw new Error('Performance calculation returned an invalid response')
  }
  const parsed: unknown = JSON.parse(response.body)
  if (!isRecord(parsed) || !isPerformanceReport(parsed.report)) {
    throw new Error('Performance calculation returned an invalid report')
  }
  return parsed.report
}

function isPerformanceReport(value: unknown): value is PerformanceReport {
  return isRecord(value) &&
    isRecord(value.metric) &&
    typeof value.metric.id === 'string' &&
    typeof value.metric.name === 'string' &&
    typeof value.metric.unit === 'string' &&
    isRecord(value.range) &&
    isRecord(value.summary) &&
    (value.summary.value === null || typeof value.summary.value === 'number') &&
    typeof value.summary.matchedEvents === 'number' &&
    typeof value.summary.calculatedEvents === 'number' &&
    typeof value.summary.excludedEvents === 'number' &&
    Array.isArray(value.timeSeries) &&
    value.timeSeries.every((period) => isRecord(period) &&
      typeof period.period === 'string' && typeof period.value === 'number' &&
      typeof period.events === 'number')
}

async function loadOrganizationUnits(companyId: string): Promise<OrganizationUnit[]> {
  const units: OrganizationUnit[] = []
  let exclusiveStartKey: Record<string, unknown> | undefined
  do {
    const result = await database.send(new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: {
        ':pk': `COMPANY#${companyId}`,
        ':prefix': configPrefix('org-units'),
      },
      ExclusiveStartKey: exclusiveStartKey,
    }))
    for (const item of result.Items ?? []) {
      if (typeof item.id !== 'string' || typeof item.name !== 'string' ||
        typeof item.unitType !== 'string' ||
        item.parentUnitId !== undefined && typeof item.parentUnitId !== 'string') {
        throw new Error('Stored organization unit is malformed')
      }
      if (item.jurisdiction !== undefined && !isOrganizationUnitJurisdiction(item.jurisdiction)) {
        throw new Error('Stored organization unit jurisdiction is malformed')
      }
      units.push({
        id: item.id,
        name: item.name,
        type: item.unitType,
        parentUnitId: typeof item.parentUnitId === 'string' ? item.parentUnitId : undefined,
        active: item.active === true,
        ...(item.jurisdiction ? { jurisdiction: item.jurisdiction } : {}),
      })
    }
    exclusiveStartKey = result.LastEvaluatedKey
  } while (exclusiveStartKey)
  return units
}

async function loadLeaderContactsByUnit(
  companyId: string,
): Promise<Map<string, Array<{ name?: string; email: string; phoneNumber?: string }>>> {
  const leadersByUnit = new Map<string, Array<{ name?: string; email: string; phoneNumber?: string }>>()
  let exclusiveStartKey: Record<string, unknown> | undefined
  do {
    const result = await database.send(new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: { ':pk': `COMPANY#${companyId}`, ':prefix': 'LEADER#' },
      ProjectionExpression: '#email, #orgUnitId, #name, #phoneNumber',
      ExpressionAttributeNames: {
        '#email': 'email',
        '#orgUnitId': 'orgUnitId',
        '#name': 'name',
        '#phoneNumber': 'phoneNumber',
      },
      ExclusiveStartKey: exclusiveStartKey,
    }))
    for (const leader of result.Items ?? []) {
      if (typeof leader.email !== 'string' || typeof leader.orgUnitId !== 'string') {
        throw new Error('Stored company leader assignment is malformed')
      }
      const contacts = leadersByUnit.get(leader.orgUnitId) ?? []
      contacts.push({
        email: leader.email,
        ...(typeof leader.name === 'string' ? { name: leader.name } : {}),
        ...(typeof leader.phoneNumber === 'string' ? { phoneNumber: leader.phoneNumber } : {}),
      })
      leadersByUnit.set(leader.orgUnitId, contacts)
    }
    exclusiveStartKey = result.LastEvaluatedKey
  } while (exclusiveStartKey)
  return leadersByUnit
}

async function listLeaderMetrics(companyId: string): Promise<APIGatewayProxyResultV2> {
  const result = await database.send(new QueryCommand({
    TableName: tableName,
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
    ExpressionAttributeValues: {
      ':pk': `COMPANY#${companyId}`,
      ':prefix': configPrefix('metrics'),
    },
  }))
  return json(200, {
    items: (result.Items ?? []).filter((item) => item.active === true).map(toPublicConfiguration),
  })
}

async function inviteOrganizationLeader(
  companyId: string,
  orgUnitId: string,
  body: string | undefined,
  claims: unknown,
): Promise<APIGatewayProxyResultV2> {
  if (!isResourceId(orgUnitId)) return json(400, { error: 'A valid organization unit ID is required' })
  const unit = await database.send(new GetCommand({
    TableName: tableName,
    Key: { pk: `COMPANY#${companyId}`, sk: configSortKey('org-units', orgUnitId) },
  }))
  if (!unit.Item || unit.Item.active !== true) return json(404, { error: 'Active organization unit not found' })

  const parsed = parseBody(body)
  if (!parsed.ok) return parsed.response
  if (!isRecord(parsed.value)) return json(400, { error: 'Leader invitation must be an object' })
  const errors: string[] = []
  rejectUnknownKeys(parsed.value, ['leaderEmail', 'leaderName', 'leaderPhoneNumber'], 'invitation', errors)
  validateAdminEmail(parsed.value.leaderEmail, errors)
  errors.push(...validateInviteeContact(parsed.value.leaderName, parsed.value.leaderPhoneNumber, 'leaderName', 'leaderPhoneNumber'))
  if (errors.length > 0) return json(400, { error: 'Invalid leader invitation', details: errors })

  const email = (parsed.value.leaderEmail as string).trim().toLowerCase()
  const name = optionalContactValue(parsed.value.leaderName)
  const phoneNumber = optionalContactValue(parsed.value.leaderPhoneNumber)
  const subject = await createCognitoCompanyLeader(companyId, email, name, phoneNumber)
  const now = new Date().toISOString()
  const auditKey = `AUDIT#${now}#${randomUUID()}`
  try {
    await database.send(new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: tableName,
            Item: {
              pk: `COMPANY#${companyId}`,
              sk: `LEADER#${encodeURIComponent(email)}`,
              kind: 'COMPANY_LEADER',
              email,
              ...(name ? { name } : {}),
              ...(phoneNumber ? { phoneNumber } : {}),
              subject,
              orgUnitId,
              createdAt: now,
            },
            ConditionExpression: 'attribute_not_exists(pk)',
          },
        },
        {
          Put: {
            TableName: tableName,
            Item: {
              pk: `LEADER#${subject}`,
              sk: 'ASSIGNMENT',
              kind: 'COMPANY_LEADER_ASSIGNMENT',
              companyId,
              orgUnitId,
              email,
              ...(name ? { name } : {}),
              ...(phoneNumber ? { phoneNumber } : {}),
              createdAt: now,
            },
            ConditionExpression: 'attribute_not_exists(pk)',
          },
        },
        {
          Put: {
            TableName: tableName,
            Item: createAuditItem(
              companyId,
              auditKey,
              getAuditActor(claims),
              'COMPANY_LEADER_INVITED',
              { email, orgUnitId, subject },
              now,
            ),
            ConditionExpression: 'attribute_not_exists(pk)',
          },
        },
      ],
    }))
  } catch (error) {
    try {
      await cognito.send(new AdminDeleteUserCommand({ UserPoolId: userPoolId, Username: email }))
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], 'Leader invitation failed and Cognito rollback was incomplete')
    }
    if (isConditionalConflict(error)) return json(409, { error: 'This leader already has a company assignment' })
    throw error
  }
  return json(201, { invitedLeader: email, orgUnitId, message: 'Team leader invitation sent' })
}

async function revokeIntegrationKey(
  companyId: string,
  integrationId: string | undefined,
): Promise<APIGatewayProxyResultV2> {
  if (!integrationId || !/^[0-9a-f-]{36}$/i.test(integrationId)) {
    return json(400, { error: 'A valid integrationId is required' })
  }

  const record = await database.send(new GetCommand({
    TableName: tableName,
    Key: { pk: `COMPANY#${companyId}`, sk: `INTEGRATION#${integrationId}` },
  }))
  if (!record.Item) return json(404, { error: 'Integration key not found' })
  if (!record.Item.active) return json(200, { integrationId, active: false })

  try {
    await database.send(new TransactWriteCommand({
      TransactItems: [
        {
          Update: {
            TableName: tableName,
            Key: { pk: `COMPANY#${companyId}`, sk: `INTEGRATION#${integrationId}` },
            UpdateExpression: 'SET #active = :false, revokedAt = :revokedAt',
            ConditionExpression: '#active = :true',
            ExpressionAttributeNames: { '#active': 'active' },
            ExpressionAttributeValues: {
              ':false': false,
              ':true': true,
              ':revokedAt': new Date().toISOString(),
            },
          },
        },
        {
          Update: {
            TableName: tableName,
            Key: { pk: `CREDENTIAL#${record.Item.credentialHash}`, sk: 'LOOKUP' },
            UpdateExpression: 'SET #active = :false',
            ConditionExpression: '#active = :true',
            ExpressionAttributeNames: { '#active': 'active' },
            ExpressionAttributeValues: { ':false': false, ':true': true },
          },
        },
      ],
    }))
  } catch (error) {
    if (isConditionalConflict(error)) {
      return json(409, { error: 'Integration key changed; reload the key list and retry' })
    }
    throw error
  }
  return json(200, { integrationId, active: false })
}

async function ingestEvent(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const suppliedKey = event.headers['x-uppy-api-key']
  if (!suppliedKey) return json(401, { error: 'x-uppy-api-key header is required' })

  const credentials = await database.send(new GetCommand({
    TableName: tableName,
    Key: { pk: `CREDENTIAL#${hashKey(suppliedKey)}`, sk: 'LOOKUP' },
    ConsistentRead: true,
  }))
  if (!credentials.Item || credentials.Item.active !== true) {
    return json(401, { error: 'Invalid or revoked integration key' })
  }

  const parsed = parseBody(event.body)
  if (!parsed.ok) return parsed.response
  if (!isRecord(parsed.value) || !Number.isSafeInteger(parsed.value.contractVersion)) {
    return json(400, { error: 'A valid contractVersion is required' })
  }
  if (typeof credentials.Item.companyId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(credentials.Item.companyId)) {
    throw new Error('Integration credential has an invalid company assignment')
  }
  const companyId = credentials.Item.companyId
  const company = await database.send(new GetCommand({
    TableName: tableName,
    Key: { pk: `COMPANY#${companyId}`, sk: 'PROFILE' },
    ProjectionExpression: '#status',
    ExpressionAttributeNames: { '#status': 'status' },
  }))
  if (!company.Item || company.Item.status !== 'active') {
    return json(403, { error: 'This company workspace is inactive or suspended' })
  }
  const contractRecord = await database.send(new GetCommand({
    TableName: tableName,
    Key: {
      pk: `COMPANY#${companyId}`,
      sk: `CONTRACT#${parsed.value.contractVersion}`,
    },
  }))
  if (!contractRecord.Item) return json(422, { error: 'Unknown event contract version' })

  const contractDefinition: unknown = contractRecord.Item.definition
  const contractErrors = validateContract(contractDefinition)
  if (contractErrors.length > 0 || !isValidatedEventContract(contractDefinition)) {
    throw new Error(`Stored event contract is invalid: ${contractErrors.join('; ')}`)
  }
  const contract: EventContract = contractDefinition
  const errors = validatePartnerEvent(parsed.value, contract)
  if (errors.length > 0) return json(422, { error: 'Event does not match its contract', details: errors })
  if (!isValidatedPartnerEvent(parsed.value, contract)) {
    throw new Error('Validated event failed its type guard')
  }
  const partnerEvent: PartnerEvent = parsed.value
  const occurredAt = new Date(partnerEvent.occurredAt).toISOString()

  const product = await database.send(new GetCommand({
    TableName: tableName,
    Key: { pk: `COMPANY#${companyId}`, sk: `CONFIG#PRODUCT#${partnerEvent.productId}` },
  }))
  if (!product.Item || product.Item.active !== true) {
    return json(422, { error: 'productId must refer to an active product in this company' })
  }
  if (partnerEvent.locationId) {
    const location = await database.send(new GetCommand({
      TableName: tableName,
      Key: { pk: `COMPANY#${companyId}`, sk: `CONFIG#LOCATION#${partnerEvent.locationId}` },
    }))
    if (!location.Item || location.Item.active !== true) {
      return json(422, { error: 'locationId must refer to an active reporting location in this company' })
    }
  }
  if (partnerEvent.orgUnitId) {
    const unit = await database.send(new GetCommand({
      TableName: tableName,
      Key: { pk: `COMPANY#${companyId}`, sk: configSortKey('org-units', partnerEvent.orgUnitId) },
    }))
    if (!unit.Item || unit.Item.active !== true) {
      return json(422, { error: 'orgUnitId must refer to an active organization unit in this company' })
    }
  }

  const billingMonth = currentBillingMonth()
  const billingRates = await getBillingRatesForMonth(billingMonth)
  if (!billingRates || !isBillingEnabled()) {
    return json(503, { error: 'Juu billing rates and Pesapal payment setup must be configured before event ingestion is available' })
  }
  const overdueInvoice = await findOverdueInvoice(companyId)
  if (overdueInvoice) {
    return json(402, {
      error: `Billable usage is paused because invoice ${overdueInvoice.invoiceNumber} is overdue`,
      invoiceNumber: overdueInvoice.invoiceNumber,
      dueAt: overdueInvoice.dueAt,
    })
  }
  const billingKey = { pk: `COMPANY#${companyId}`, sk: `BILLING#${billingMonth}` }
  const billingTimestamp = new Date().toISOString()
  try {
    await database.send(new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: tableName,
            Item: {
              pk: `COMPANY#${companyId}`,
              sk: `EVENT_ID#${partnerEvent.eventId}`,
              kind: 'EVENT_IDEMPOTENCY',
              eventId: partnerEvent.eventId,
              occurredAt,
            },
            ConditionExpression: 'attribute_not_exists(pk)',
          },
        },
        {
          Put: {
            TableName: tableName,
            Item: {
              pk: `COMPANY#${companyId}`,
              sk: `EVENT#${occurredAt}#${partnerEvent.eventId}`,
              kind: 'PARTNER_EVENT',
              ...partnerEvent,
              occurredAt,
              receivedAt: new Date().toISOString(),
            },
          },
        },
        {
          Update: {
            TableName: tableName,
            Key: billingKey,
            UpdateExpression: [
              'SET #ingestionRate = if_not_exists(#ingestionRate, :ingestionRate)',
              '#presentationRate = if_not_exists(#presentationRate, :presentationRate)',
              '#updatedAt = :updatedAt',
              'ADD #ingestionCalls :one',
            ].join(' '),
            ConditionExpression: '(attribute_not_exists(#ingestionRate) OR #ingestionRate = :ingestionRate) AND (attribute_not_exists(#presentationRate) OR #presentationRate = :presentationRate)',
            ExpressionAttributeNames: {
              '#ingestionRate': 'ingestionKesPer1000Cents',
              '#presentationRate': 'presentationKesPer1000Cents',
              '#ingestionCalls': 'ingestionCalls',
              '#updatedAt': 'updatedAt',
            },
            ExpressionAttributeValues: {
              ':ingestionRate': billingRates.ingestionKesPer1000Cents,
              ':presentationRate': billingRates.presentationKesPer1000Cents,
              ':updatedAt': billingTimestamp,
              ':one': 1,
            },
          },
        },
      ],
    }))
  } catch (error) {
    if (isConditionalConflict(error)) {
      return json(409, { error: 'An event with this eventId has already been received' })
    }
    throw error
  }

  return json(202, { accepted: true, eventId: partnerEvent.eventId })
}

async function handleConfiguration(
  companyId: string,
  method: string,
  path: string,
  cursor: string | undefined,
  body: string | undefined,
  claims: unknown,
): Promise<APIGatewayProxyResultV2> {
  const match = /^\/v1\/admin\/config\/([^/]+)(?:\/([^/]+))?$/.exec(path)
  if (!match || !isConfigurationResource(match[1])) {
    return json(404, { error: 'Configuration route not found' })
  }

  const resource = match[1]
  const id = match[2]
  if (!id && method === 'GET') {
    const companyAdminSubject = resource === 'targets' && isRecord(claims) &&
      typeof claims.sub === 'string' ? claims.sub : undefined
    return listConfiguration(companyId, resource, cursor, companyAdminSubject)
  }
  if (!id && method === 'POST') {
    if (resource === 'targets') {
      const parsed = parseBody(body)
      if (!parsed.ok) return parsed.response
      if (!isRecord(parsed.value)) return json(400, { error: 'Target request must be an object' })
      const errors = validateTarget(parsed.value)
      if (parsed.value.orgUnitId !== undefined) {
        errors.push('Company targets must be scoped to the whole company, not an organization unit')
      }
      if (errors.length > 0) return json(400, { error: 'Invalid target request', details: errors })
      const subject = isRecord(claims) && typeof claims.sub === 'string' ? claims.sub : undefined
      if (!subject) return json(403, { error: 'A valid signed-in company administrator is required to set company targets' })
      const productIds = await getTargetProductIds(companyId, parsed.value)
      const ownedProductIds = await getCompanyAdminProductIds(companyId, subject)
      if (!areTargetProductsEligible(productIds, ownedProductIds)) {
        return json(403, { error: 'Company targets may only use products created by this company administrator' })
      }
      const creator = getOfficerAttribution(claims)
      if (!creator) return json(403, { error: 'A valid signed-in company administrator is required to set company targets' })
      return createConfiguration(companyId, resource, body, creator)
    }
    if (resource !== 'products') return createConfiguration(companyId, resource, body)
    const units = await loadOrganizationUnits(companyId)
    if (!units.some((unit) => unit.active)) {
      return json(409, { error: 'Create an active organization unit before adding products' })
    }
    const creator = getOfficerAttribution(claims)
    if (!creator) return json(403, { error: 'A valid signed-in officer profile is required to add a product' })
    return createConfiguration(companyId, resource, body, creator)
  }
  if (id && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    return json(400, { error: 'A valid resource ID is required' })
  }
  if (id && method === 'GET') return getConfiguration(companyId, resource, id)
  if (id && method === 'PUT' && (resource === 'metrics' || resource === 'targets')) {
    return json(409, {
      error: `${resource} definitions are immutable; deactivate the old definition and create a new one to preserve reporting history`,
    })
  }
  if (id && method === 'PUT') return updateConfiguration(companyId, resource, id, body)
  if (id && method === 'DELETE') return deactivateConfiguration(companyId, resource, id)
  return json(405, { error: 'Method not allowed for this configuration route' })
}

async function listConfiguration(
  companyId: string,
  resource: ConfigurationResource,
  cursor: string | undefined,
  companyAdminSubject?: string,
): Promise<APIGatewayProxyResultV2> {
  const prefix = configPrefix(resource)
  let exclusiveStartKey: Record<string, unknown> | undefined
  if (cursor) {
    let sortKey: string
    try {
      sortKey = Buffer.from(cursor, 'base64url').toString('utf8')
    } catch {
      return json(400, { error: 'Invalid pagination cursor' })
    }
    if (!sortKey.startsWith(prefix) || sortKey.length <= prefix.length) {
      return json(400, { error: 'Invalid pagination cursor' })
    }
    exclusiveStartKey = { pk: `COMPANY#${companyId}`, sk: sortKey }
  }

  const result = await database.send(new QueryCommand({
    TableName: tableName,
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
    ExpressionAttributeValues: {
      ':pk': `COMPANY#${companyId}`,
      ':prefix': prefix,
    },
    Limit: 100,
    ExclusiveStartKey: exclusiveStartKey,
  }))
  const items = (result.Items ?? []).map(toPublicConfiguration)
  if (resource === 'org-units') {
    const leadersByUnit = await loadLeaderContactsByUnit(companyId)
    for (const item of items) {
      if (typeof item.id === 'string') {
        const contacts = leadersByUnit.get(item.id) ?? []
        item.leaders = contacts.map((contact) => contact.email)
        item.leaderContacts = contacts
      }
    }
  }
  return json(200, {
    items,
    ...(resource === 'targets' && companyAdminSubject
      ? { eligibleProductIds: [...await getCompanyAdminProductIds(companyId, companyAdminSubject)] }
      : {}),
    nextCursor: result.LastEvaluatedKey
      ? Buffer.from(String(result.LastEvaluatedKey.sk), 'utf8').toString('base64url')
      : undefined,
  })
}

async function listLeaderTargets(
  companyId: string,
  orgUnitId: string,
  subject: string,
  cursor: string | undefined,
  parentUnitId?: string,
): Promise<APIGatewayProxyResultV2> {
  const prefix = configPrefix('targets')
  let exclusiveStartKey: Record<string, unknown> | undefined
  if (cursor) {
    let sortKey: string
    try {
      sortKey = Buffer.from(cursor, 'base64url').toString('utf8')
    } catch {
      return json(400, { error: 'Invalid pagination cursor' })
    }
    if (!sortKey.startsWith(prefix) || sortKey.length <= prefix.length) {
      return json(400, { error: 'Invalid pagination cursor' })
    }
    exclusiveStartKey = { pk: `COMPANY#${companyId}`, sk: sortKey }
  }

  const items: Array<Record<string, unknown>> = []
  let lastEvaluatedKey: Record<string, unknown> | undefined
  let pagesRead = 0
  do {
    const result = await database.send(new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: {
        ':pk': `COMPANY#${companyId}`,
        ':prefix': prefix,
      },
      Limit: 100,
      ExclusiveStartKey: exclusiveStartKey,
    }))
    pagesRead += 1
    for (const item of result.Items ?? []) {
      const owner = isRecord(item.createdBy) ? item.createdBy : undefined
      if (item.orgUnitId !== orgUnitId || owner?.subject !== subject) continue
      items.push(toPublicConfiguration(item))
      if (items.length === 100) {
        lastEvaluatedKey = { pk: item.pk, sk: item.sk }
        break
      }
    }
    if (items.length === 100) break
    lastEvaluatedKey = result.LastEvaluatedKey
    exclusiveStartKey = result.LastEvaluatedKey
  } while (exclusiveStartKey && pagesRead < 20)

  return json(200, {
    items,
    eligibleProductIds: [...await getLeaderTargetProductScope(companyId, parentUnitId)],
    nextCursor: lastEvaluatedKey
      ? Buffer.from(String(lastEvaluatedKey.sk), 'utf8').toString('base64url')
      : undefined,
  })
}

async function getCompanyAdminProductIds(companyId: string, subject: string): Promise<Set<string>> {
  const productIds = new Set<string>()
  let exclusiveStartKey: Record<string, unknown> | undefined
  do {
    const result = await database.send(new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: {
        ':pk': `COMPANY#${companyId}`,
        ':prefix': configPrefix('products'),
      },
      ProjectionExpression: '#id, #active, #createdBy',
      ExpressionAttributeNames: {
        '#id': 'id',
        '#active': 'active',
        '#createdBy': 'createdBy',
      },
      ExclusiveStartKey: exclusiveStartKey,
    }))
    for (const product of result.Items ?? []) {
      if (typeof product.id === 'string' && product.active === true &&
        isRecord(product.createdBy) && product.createdBy.subject === subject) {
        productIds.add(product.id)
      }
    }
    exclusiveStartKey = result.LastEvaluatedKey
  } while (exclusiveStartKey)
  return productIds
}

async function getLeaderTargetProductScope(
  companyId: string,
  managerUnitId?: string,
): Promise<Set<string>> {
  const productIds = new Set<string>()
  if (managerUnitId) {
    const managerUnit = await database.send(new GetCommand({
      TableName: tableName,
      Key: { pk: `COMPANY#${companyId}`, sk: configSortKey('org-units', managerUnitId) },
      ProjectionExpression: '#active',
      ExpressionAttributeNames: { '#active': 'active' },
    }))
    if (managerUnit.Item?.active !== true) return productIds
  }
  let exclusiveStartKey: Record<string, unknown> | undefined
  do {
    const result = await database.send(new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: {
        ':pk': `COMPANY#${companyId}`,
        ':prefix': configPrefix('targets'),
      },
      ExclusiveStartKey: exclusiveStartKey,
    }))
    for (const target of result.Items ?? []) {
      if (!isTargetSetByManager(target, managerUnitId)) continue
      for (const productId of await getTargetProductIds(companyId, target, false)) productIds.add(productId)
    }
    exclusiveStartKey = result.LastEvaluatedKey
  } while (exclusiveStartKey)
  const activeProducts = await Promise.all([...productIds].map(async (productId) => {
    const result = await database.send(new GetCommand({
      TableName: tableName,
      Key: { pk: `COMPANY#${companyId}`, sk: configSortKey('products', productId) },
      ProjectionExpression: '#active',
      ExpressionAttributeNames: { '#active': 'active' },
    }))
    return result.Item?.active === true ? productId : undefined
  }))
  return new Set(activeProducts.filter((productId): productId is string => productId !== undefined))
}

async function getTargetProductIds(
  companyId: string,
  target: Record<string, unknown>,
  includeReferenceProduct = true,
): Promise<string[]> {
  const productIds = new Set<string>()
  if (typeof target.productId === 'string') productIds.add(target.productId)
  else if (typeof target.metricId === 'string' && isResourceId(target.metricId)) {
    const metric = await database.send(new GetCommand({
      TableName: tableName,
      Key: { pk: `COMPANY#${companyId}`, sk: configSortKey('metrics', target.metricId) },
      ProjectionExpression: '#calculation',
      ExpressionAttributeNames: { '#calculation': 'calculation' },
    }))
    const calculation = metric.Item?.calculation
    if (isRecord(calculation) && Array.isArray(calculation.operands)) {
      for (const operand of calculation.operands) {
        if (isRecord(operand) && typeof operand.productId === 'string') {
          productIds.add(operand.productId)
        }
      }
    }
  }
  if (includeReferenceProduct && typeof target.referenceProductId === 'string') {
    productIds.add(target.referenceProductId)
  }
  return [...productIds]
}

async function getConfiguration(
  companyId: string,
  resource: ConfigurationResource,
  id: string,
): Promise<APIGatewayProxyResultV2> {
  const result = await database.send(new GetCommand({
    TableName: tableName,
    Key: { pk: `COMPANY#${companyId}`, sk: configSortKey(resource, id) },
  }))
  if (!result.Item) return json(404, { error: 'Configuration item not found' })
  return json(200, { item: toPublicConfiguration(result.Item) })
}

async function createConfiguration(
  companyId: string,
  resource: ConfigurationResource,
  body: string | undefined,
  productCreator?: OfficerAttribution,
): Promise<APIGatewayProxyResultV2> {
  const parsed = parseBody(body)
  if (!parsed.ok) return parsed.response
  const id = randomUUID()
  const prepared = await prepareConfiguration(companyId, resource, id, parsed.value, true)
  if (!prepared.ok) return prepared.response

  const now = new Date().toISOString()
  const item = {
    pk: `COMPANY#${companyId}`,
    sk: configSortKey(resource, id),
    kind: 'COMPANY_CONFIGURATION',
    resource,
    id,
    ...prepared.value,
    ...((resource === 'products' || resource === 'targets') && productCreator
      ? { createdBy: productCreator }
      : {}),
    revision: 1,
    createdAt: now,
    updatedAt: now,
  }
  await database.send(new TransactWriteCommand({
    TransactItems: [{
      Put: {
        TableName: tableName,
        Item: item,
        ConditionExpression: 'attribute_not_exists(pk)',
      },
    }],
  }))
  return json(201, { item: toPublicConfiguration(item) })
}

async function updateConfiguration(
  companyId: string,
  resource: ConfigurationResource,
  id: string,
  body: string | undefined,
): Promise<APIGatewayProxyResultV2> {
  const existing = await database.send(new GetCommand({
    TableName: tableName,
    Key: { pk: `COMPANY#${companyId}`, sk: configSortKey(resource, id) },
  }))
  if (!existing.Item) return json(404, { error: 'Configuration item not found' })

  const parsed = parseBody(body)
  if (!parsed.ok) return parsed.response
  const prepared = await prepareConfiguration(
    companyId,
    resource,
    id,
    parsed.value,
    existing.Item.active === true,
  )
  if (!prepared.ok) return prepared.response

  const item = {
    pk: `COMPANY#${companyId}`,
    sk: configSortKey(resource, id),
    kind: 'COMPANY_CONFIGURATION',
    resource,
    id,
    ...prepared.value,
    ...(resource === 'products' && isRecord(existing.Item.createdBy)
      ? { createdBy: existing.Item.createdBy }
      : {}),
    active: typeof prepared.value.active === 'boolean'
      ? prepared.value.active
      : existing.Item.active === true,
    revision: typeof existing.Item.revision === 'number' && Number.isSafeInteger(existing.Item.revision)
      ? existing.Item.revision + 1
      : 2,
    createdAt: existing.Item.createdAt,
    updatedAt: new Date().toISOString(),
  }
  try {
    await database.send(new TransactWriteCommand({
      TransactItems: [{
        Put: {
          TableName: tableName,
          Item: item,
          ConditionExpression: 'attribute_exists(pk) AND revision = :revision',
          ExpressionAttributeValues: { ':revision': existing.Item.revision ?? 1 },
        },
      }],
    }))
  } catch (error) {
    if (isConditionalConflict(error)) {
      return json(409, { error: 'Configuration changed while updating; reload and retry' })
    }
    throw error
  }
  return json(200, { item: toPublicConfiguration(item) })
}

async function deactivateConfiguration(
  companyId: string,
  resource: ConfigurationResource,
  id: string,
): Promise<APIGatewayProxyResultV2> {
  let result
  try {
    result = await database.send(new UpdateCommand({
      TableName: tableName,
      Key: { pk: `COMPANY#${companyId}`, sk: configSortKey(resource, id) },
      UpdateExpression: 'SET #active = :inactive, updatedAt = :updatedAt, revision = revision + :one',
      ConditionExpression: 'attribute_exists(pk) AND #resource = :resource AND #active = :active',
      ExpressionAttributeNames: { '#active': 'active', '#resource': 'resource' },
      ExpressionAttributeValues: {
        ':inactive': false,
        ':active': true,
        ':updatedAt': new Date().toISOString(),
        ':one': 1,
        ':resource': resource,
      },
      ReturnValues: 'ALL_NEW',
    }))
  } catch (error) {
    if (isConditionalConflict(error)) return json(404, { error: 'Active configuration item not found' })
    throw error
  }
  if (!result.Attributes) return json(404, { error: 'Active configuration item not found' })
  return json(200, { item: toPublicConfiguration(result.Attributes) })
}

type PreparedConfiguration =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; response: APIGatewayProxyResultV2 }

async function prepareConfiguration(
  companyId: string,
  resource: ConfigurationResource,
  id: string,
  input: unknown,
  defaultActive: boolean,
): Promise<PreparedConfiguration> {
  if (resource === 'products') {
    const errors = validateProduct(input)
    if (errors.length > 0) return invalidConfiguration(errors)
    if (!isProductInput(input)) throw new Error('Validated product failed its type guard')
    return {
      ok: true,
      value: {
        name: input.name.trim(),
        description: input.description?.trim(),
        active: input.active ?? defaultActive,
      },
    }
  }

  if (resource === 'org-units') {
    const errors = validateOrganizationUnit(input)
    if (errors.length > 0) return invalidConfiguration(errors)
    if (!isOrganizationUnitInput(input)) throw new Error('Validated organization unit failed its type guard')
    if (input.parentUnitId) {
      if (input.parentUnitId === id) {
        return invalidConfiguration(['An organization unit cannot be its own parent'])
      }
      if (getUnitSubtreeIds(await loadOrganizationUnits(companyId), id).includes(input.parentUnitId)) {
        return invalidConfiguration(['parentUnitId cannot be a descendant of this organization unit'])
      }
      const parent = await database.send(new GetCommand({
        TableName: tableName,
        Key: { pk: `COMPANY#${companyId}`, sk: configSortKey('org-units', input.parentUnitId) },
      }))
      if (!parent.Item || parent.Item.active !== true) {
        return invalidConfiguration(['parentUnitId must refer to an active organization unit in this company'])
      }
    }
    return {
      ok: true,
      value: {
        name: input.name.trim(),
        unitType: input.type.trim(),
        parentUnitId: input.parentUnitId,
        jurisdiction: input.jurisdiction,
        active: input.active ?? defaultActive,
      },
    }
  }

  if (resource === 'locations') {
    const errors = validateLocation(input)
    if (errors.length > 0) return invalidConfiguration(errors)
    if (!isLocationInput(input)) throw new Error('Validated location failed its type guard')
    if (input.parentLocationId) {
      if (input.parentLocationId === id) {
        return invalidConfiguration(['A location cannot be its own parent'])
      }

      const parent = await database.send(new GetCommand({
        TableName: tableName,
        Key: {
          pk: `COMPANY#${companyId}`,
          sk: configSortKey('locations', input.parentLocationId),
        },
      }))
      if (!parent.Item || parent.Item.active !== true || parent.Item.locationKind !== 'region') {
        return invalidConfiguration(['parentLocationId must refer to an active region in this company'])
      }
    }
    return {
      ok: true,
      value: {
        name: input.name.trim(),
        description: input.description?.trim(),
        locationKind: input.kind,
        parentLocationId: input.parentLocationId,
        latitude: input.latitude,
        longitude: input.longitude,
        active: input.active ?? defaultActive,
      },
    }
  }

  if (resource === 'metrics') {
    if (isRecord(input) && input.calculation !== undefined) {
      const errors = validateMetric(input)
      if (errors.length > 0) return invalidConfiguration(errors)
      if (!isMetricInput(input) || !input.calculation) {
        throw new Error('Validated calculated metric failed its type guard')
      }
      const operands: MetricCalculation['operands'] = [
        { ...input.calculation.operands[0] },
        { ...input.calculation.operands[1] },
      ]
      let firstUnit: string | undefined
      for (const [index, operand] of input.calculation.operands.entries()) {
        const component = await database.send(new GetCommand({
          TableName: tableName,
          Key: { pk: `COMPANY#${companyId}`, sk: configSortKey('metrics', operand.metricId) },
        }))
        const componentItem = component.Item
        if (!componentItem || componentItem.active !== true) {
          return invalidConfiguration([`calculation.operands[${index}].metricId must refer to an active metric in this company`])
        }
        if (componentItem.calculation !== undefined) {
          return invalidConfiguration([`calculation.operands[${index}].metricId must refer to an event-derived metric`])
        }
        if (typeof componentItem.unit !== 'string' ||
          typeof componentItem.contractVersion !== 'number' ||
          !Number.isSafeInteger(componentItem.contractVersion) || componentItem.contractVersion < 1 ||
          typeof componentItem.eventType !== 'string' || !isMetricExpression(componentItem.formula)) {
          throw new Error(`Stored component metric ${operand.metricId} is invalid`)
        }
        const componentContract = await database.send(new GetCommand({
          TableName: tableName,
          Key: {
            pk: `COMPANY#${companyId}`,
            sk: `CONTRACT#${componentItem.contractVersion}`,
          },
        }))
        if (!componentContract.Item) {
          throw new Error(`Component metric ${operand.metricId} references a missing event contract`)
        }
        const definition: unknown = componentContract.Item.definition
        const contractErrors = validateContract(definition)
        if (contractErrors.length > 0 || !isValidatedEventContract(definition)) {
          throw new Error(`Component metric ${operand.metricId} references an invalid event contract`)
        }
        const componentEvent = definition.eventTypes.find((eventType) =>
          eventType.key === componentItem.eventType)
        if (!componentEvent) throw new Error(`Component metric ${operand.metricId} references a missing event type`)
        if (componentEvent.productIds && !componentEvent.productIds.includes(operand.productId)) {
          return invalidConfiguration([
            `calculation.operands[${index}].productId is not linked to its metric's event type`,
          ])
        }
        const product = await database.send(new GetCommand({
          TableName: tableName,
          Key: { pk: `COMPANY#${companyId}`, sk: configSortKey('products', operand.productId) },
        }))
        if (!product.Item || product.Item.active !== true) {
          return invalidConfiguration([`calculation.operands[${index}].productId must refer to an active product in this company`])
        }
        if (index === 0 && typeof componentItem.unit === 'string') firstUnit = componentItem.unit
        if (index === 1 && ['add', 'subtract'].includes(input.calculation.operator) &&
          firstUnit !== componentItem.unit) {
          return invalidConfiguration(['Both calculated metric operands must use the same unit for addition or subtraction'])
        }
      }
      if (['add', 'subtract'].includes(input.calculation.operator) &&
        firstUnit !== input.unit.trim()) {
        return invalidConfiguration([
          'The calculated metric unit must match the component unit for addition or subtraction',
        ])
      }
      return {
        ok: true,
        value: {
          name: input.name.trim(),
          description: input.description.trim(),
          unit: input.unit.trim(),
          direction: input.direction,
          calculation: { operator: input.calculation.operator, operands },
          active: input.active ?? defaultActive,
        },
      }
    }

    const active = await database.send(new GetCommand({
      TableName: tableName,
      Key: { pk: `COMPANY#${companyId}`, sk: 'CONTRACT#ACTIVE' },
    }))
    if (!active.Item) return { ok: false, response: json(409, { error: 'Publish an event contract before defining metrics' }) }
    const contractRecord = await database.send(new GetCommand({
      TableName: tableName,
      Key: { pk: `COMPANY#${companyId}`, sk: `CONTRACT#${active.Item.version}` },
    }))
    if (!contractRecord.Item) throw new Error(`Active contract ${active.Item.version} is missing`)
    const contractDefinition: unknown = contractRecord.Item.definition
    const contractErrors = validateContract(contractDefinition)
    if (contractErrors.length > 0 || !isValidatedEventContract(contractDefinition)) {
      throw new Error(`Stored event contract is invalid: ${contractErrors.join('; ')}`)
    }
    const errors = validateMetric(input, contractDefinition)
    if (errors.length > 0) return invalidConfiguration(errors)
    if (!isMetricInput(input)) throw new Error('Validated metric failed its type guard')
    return {
      ok: true,
      value: {
        contractVersion: contractDefinition.version,
        name: input.name.trim(),
        description: input.description.trim(),
        unit: input.unit.trim(),
        direction: input.direction,
        eventType: input.eventType,
        formula: input.formula,
        aggregation: input.aggregation ?? 'sum',
        active: input.active ?? defaultActive,
      },
    }
  }

  const targetErrors = validateTarget(input)
  if (targetErrors.length > 0) return invalidConfiguration(targetErrors)
  if (!isTargetInput(input)) throw new Error('Validated target failed its type guard')

  const metric = await database.send(new GetCommand({
    TableName: tableName,
    Key: { pk: `COMPANY#${companyId}`, sk: configSortKey('metrics', input.metricId) },
  }))
  if (!metric.Item || metric.Item.active !== true) {
    return invalidConfiguration(['metricId must refer to an active metric in this company'])
  }
  if (metric.Item.calculation !== undefined && input.productId !== undefined) {
    return invalidConfiguration([
      'Calculated metrics define their component products and must not include productId',
    ])
  }
  if (input.targetMode === 'percentage') {
    const referenceMetric = await database.send(new GetCommand({
      TableName: tableName,
      Key: { pk: `COMPANY#${companyId}`, sk: configSortKey('metrics', input.referenceMetricId!) },
    }))
    if (!referenceMetric.Item || referenceMetric.Item.active !== true) {
      return invalidConfiguration(['referenceMetricId must refer to an active metric in this company'])
    }
    if (referenceMetric.Item.calculation !== undefined) {
      return invalidConfiguration(['referenceMetricId must refer to a product-bound event-derived metric'])
    }
    if (typeof metric.Item.unit !== 'string' || metric.Item.unit !== referenceMetric.Item.unit) {
      return invalidConfiguration(['Percentage targets require the primary and reference metrics to use the same unit'])
    }
    const referenceProduct = await database.send(new GetCommand({
      TableName: tableName,
      Key: { pk: `COMPANY#${companyId}`, sk: configSortKey('products', input.referenceProductId!) },
    }))
    if (!referenceProduct.Item || referenceProduct.Item.active !== true) {
      return invalidConfiguration(['referenceProductId must refer to an active product in this company'])
    }
  }
  if (input.productId) {
    const product = await database.send(new GetCommand({
      TableName: tableName,
      Key: { pk: `COMPANY#${companyId}`, sk: configSortKey('products', input.productId) },
    }))
    if (!product.Item || product.Item.active !== true) {
      return invalidConfiguration(['productId must refer to an active product in this company'])
    }
  }
  if (input.locationId) {
    const location = await database.send(new GetCommand({
      TableName: tableName,
      Key: { pk: `COMPANY#${companyId}`, sk: configSortKey('locations', input.locationId) },
    }))
    if (!location.Item || location.Item.active !== true) {
      return invalidConfiguration(['locationId must refer to an active location in this company'])
    }
  }
  if (input.orgUnitId) {
    const unit = await database.send(new GetCommand({
      TableName: tableName,
      Key: { pk: `COMPANY#${companyId}`, sk: configSortKey('org-units', input.orgUnitId) },
    }))
    if (!unit.Item || unit.Item.active !== true) {
      return invalidConfiguration(['orgUnitId must refer to an active organization unit in this company'])
    }
  }
  return {
    ok: true,
    value: {
      metricId: input.metricId,
      productId: input.productId,
      locationId: input.locationId,
      orgUnitId: input.orgUnitId,
      period: input.period,
      startDate: input.startDate,
      endDate: input.endDate,
      targetValue: input.targetValue,
      targetMode: input.targetMode ?? 'fixed',
      referenceMetricId: input.referenceMetricId,
      referenceProductId: input.referenceProductId,
      warningThreshold: input.warningThreshold,
      active: input.active ?? defaultActive,
    },
  }
}

function configPrefix(resource: ConfigurationResource): string {
  return `CONFIG#${resource === 'org-units' ? 'ORG-UNIT' : resource.slice(0, -1).toUpperCase()}#`
}

function isDateOnly(value: string | undefined): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}

function isResourceId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

function isMetricAggregation(value: unknown): value is MetricAggregation {
  return value === 'sum' || value === 'average' || value === 'min' ||
    value === 'max' || value === 'count'
}

function readPerformanceEvent(item: Record<string, unknown>): PerformanceEvent {
  if (typeof item.contractVersion !== 'number' || !Number.isSafeInteger(item.contractVersion) ||
    typeof item.eventType !== 'string' ||
    typeof item.occurredAt !== 'string' ||
    typeof item.productId !== 'string' || !isRecord(item.fields) ||
    item.locationId !== undefined && typeof item.locationId !== 'string' ||
    item.orgUnitId !== undefined && typeof item.orgUnitId !== 'string') {
    throw new Error('Stored partner event is malformed')
  }
  let location: PerformanceEvent['location']
  if (item.location !== undefined) {
    if (!isRecord(item.location) ||
      typeof item.location.latitude !== 'number' || !Number.isFinite(item.location.latitude) ||
      item.location.latitude < -90 || item.location.latitude > 90 ||
      typeof item.location.longitude !== 'number' || !Number.isFinite(item.location.longitude) ||
      item.location.longitude < -180 || item.location.longitude > 180) {
      throw new Error('Stored partner event contains an invalid sender location')
    }
    location = { latitude: item.location.latitude, longitude: item.location.longitude }
  }
  return {
    contractVersion: item.contractVersion,
    eventType: item.eventType,
    occurredAt: item.occurredAt,
    productId: item.productId,
    ...(typeof item.locationId === 'string' ? { locationId: item.locationId } : {}),
    ...(typeof item.orgUnitId === 'string' ? { orgUnitId: item.orgUnitId } : {}),
    location,
    fields: item.fields,
  }
}

function configSortKey(resource: ConfigurationResource, id: string): string {
  return `${configPrefix(resource)}${id}`
}

function isOrganizationUnitJurisdiction(value: unknown): value is OrganizationUnitJurisdiction {
  if (!isRecord(value) ||
    (value.provider !== 'geoBoundaries' && value.provider !== 'naturalEarth') ||
    typeof value.boundaryId !== 'string' || typeof value.boundaryName !== 'string' ||
    !(value.boundaryLevel === 'CONTINENT' || value.boundaryLevel === 'COUNTRY' ||
      /^ADM[0-5]$/.test(String(value.boundaryLevel)))) return false
  return ['boundaryCanonical', 'countryCode', 'countryName', 'continent']
    .every((key) => value[key] === undefined || typeof value[key] === 'string')
}

function toPublicConfiguration(
  item: Record<string, unknown>,
): Record<string, unknown> {
  const { pk: _pk, sk: _sk, kind: _kind, ...publicItem } = item
  if (typeof publicItem.locationKind === 'string') {
    publicItem.kind = publicItem.locationKind
    delete publicItem.locationKind
  }
  if (publicItem.resource === 'org-units' && typeof publicItem.unitType === 'string') {
    publicItem.type = publicItem.unitType
    delete publicItem.unitType
  }
  return publicItem
}

function invalidConfiguration(errors: string[]): PreparedConfiguration {
  return { ok: false, response: json(400, { error: 'Invalid configuration', details: errors }) }
}

function getAdminCompanyId(event: APIGatewayProxyEventV2): string | undefined {
  return getCompanyAdminId(getJwtClaims(event))
}

function getOfficerAttribution(claims: unknown, orgUnitId?: string): OfficerAttribution | undefined {
  if (!isRecord(claims) || typeof claims.sub !== 'string' ||
    !/^[0-9a-f-]{36}$/i.test(claims.sub)) return undefined
  return {
    subject: claims.sub,
    ...(typeof claims.email === 'string' ? { email: claims.email } : {}),
    ...(typeof claims.name === 'string' ? { name: claims.name } : {}),
    hierarchyLevel: orgUnitId ? 'organization-unit' : 'company',
    ...(orgUnitId ? { orgUnitId } : {}),
  }
}

async function resolveCompanyLeaderScope(
  event: APIGatewayProxyEventV2,
): Promise<{ companyId: string; orgUnitId: string } | undefined> {
  const subject = getCompanyLeaderSubject(getJwtClaims(event))
  if (!subject) return undefined
  const assignment = await database.send(new GetCommand({
    TableName: tableName,
    Key: { pk: `LEADER#${subject}`, sk: 'ASSIGNMENT' },
    ConsistentRead: true,
  }))
  if (assignment.Item?.kind !== 'COMPANY_LEADER_ASSIGNMENT' ||
    typeof assignment.Item.companyId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(assignment.Item.companyId) ||
    typeof assignment.Item.orgUnitId !== 'string' ||
    !isResourceId(assignment.Item.orgUnitId)) return undefined
  return { companyId: assignment.Item.companyId, orgUnitId: assignment.Item.orgUnitId }
}

function getJwtClaims(event: APIGatewayProxyEventV2): unknown {
  const context: unknown = event.requestContext
  if (!isRecord(context) || !isRecord(context.authorizer) ||
    !isRecord(context.authorizer.jwt)) return undefined
  return context.authorizer.jwt.claims
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: string[],
  label: string,
  errors: string[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) errors.push(`${label}.${key} is not supported`)
  }
}

function validateText(
  value: unknown,
  label: string,
  errors: string[],
  maximumLength: number,
): void {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maximumLength) {
    errors.push(`${label} must be a non-empty string of at most ${maximumLength} characters`)
  }
}

function parseBody(body: string | undefined):
  | { ok: true; value: unknown }
  | { ok: false; response: APIGatewayProxyResultV2 } {
  if (!body) return { ok: false, response: json(400, { error: 'Request body is required' }) }
  if (Buffer.byteLength(body, 'utf8') > 350 * 1024) {
    return { ok: false, response: json(413, { error: 'Request body cannot exceed 350 KiB' }) }
  }
  try {
    return { ok: true, value: JSON.parse(body) as unknown }
  } catch {
    return { ok: false, response: json(400, { error: 'Request body must be valid JSON' }) }
  }
}

function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex')
}

function isConditionalConflict(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('name' in error)) return false
  const name = error.name
  if (name === 'ConditionalCheckFailedException') return true
  if (name !== 'TransactionCanceledException' || !('CancellationReasons' in error)) return false
  const reasons = error.CancellationReasons
  return Array.isArray(reasons) && reasons.some((reason) =>
    typeof reason === 'object' &&
    reason !== null &&
    'Code' in reason &&
    reason.Code === 'ConditionalCheckFailed',
  )
}

function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
    body: JSON.stringify(body),
  }
}

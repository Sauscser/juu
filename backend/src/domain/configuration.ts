import {
  isRecord,
  type EventContract,
} from './event-contract'
import type { OrganizationUnitJurisdiction } from './organization'

export type Product = {
  id: string
  name: string
  description?: string
  active: boolean
}

export type ReportingLocation = {
  id: string
  name: string
  description?: string
  kind: 'region' | 'point'
  parentLocationId?: string
  latitude?: number
  longitude?: number
  active: boolean
}

export type MetricExpression =
  | { type: 'field'; key: string }
  | { type: 'constant'; value: number }
  | {
      type: 'operation'
      operator: 'add' | 'subtract' | 'multiply' | 'divide'
      operands: [MetricExpression, MetricExpression]
    }

export type MetricAggregation = 'sum' | 'average' | 'min' | 'max' | 'count'

export type MetricCalculation = {
  operator: 'add' | 'subtract' | 'multiply' | 'divide'
  operands: [
    { metricId: string; productId: string },
    { metricId: string; productId: string },
  ]
}

export type MetricDefinition = {
  id: string
  contractVersion?: number
  name: string
  description: string
  unit: string
  direction: 'higher' | 'lower'
  eventType?: string
  formula?: MetricExpression
  aggregation?: MetricAggregation
  calculation?: MetricCalculation
  active: boolean
}

export type TargetPeriod = 'day' | 'week' | 'month' | 'quarter' | 'year'

export type Target = {
  id: string
  metricId: string
  productId?: string
  locationId?: string
  orgUnitId?: string
  period: TargetPeriod
  startDate: string
  endDate: string
  targetValue: number
  targetMode?: 'fixed' | 'percentage'
  referenceMetricId?: string
  referenceProductId?: string
  warningThreshold?: number
  active: boolean
}

export type ProductInput = Omit<Product, 'id' | 'active'> & { active?: boolean }
export type ReportingLocationInput = Omit<ReportingLocation, 'id' | 'active'> & { active?: boolean }
export type MetricDefinitionInput = Omit<MetricDefinition, 'id' | 'active' | 'contractVersion'> & {
  active?: boolean
}
export type TargetInput = Omit<Target, 'id' | 'active'> & { active?: boolean }
export type OrganizationUnitInput = {
  name: string
  type: string
  parentUnitId?: string
  active?: boolean
  jurisdiction?: OrganizationUnitJurisdiction
}
export type ConfigurationResource = 'products' | 'locations' | 'metrics' | 'targets' | 'org-units'

export function validateOrganizationUnit(input: unknown): string[] {
  if (!isRecord(input)) return ['Organization unit must be an object']
  const errors: string[] = []
  rejectUnknownKeys(input, ['name', 'type', 'parentUnitId', 'active', 'jurisdiction'], 'organizationUnit', errors)
  validateText(input.name, 'name', errors, 128)
  validateText(input.type, 'type', errors, 64)
  if (input.parentUnitId !== undefined) validateId(input.parentUnitId, 'parentUnitId', errors)
  validateOptionalBoolean(input.active, 'active', errors)
  if (input.jurisdiction !== undefined) {
    if (!isRecord(input.jurisdiction)) {
      errors.push('jurisdiction must be an object')
    } else {
      rejectUnknownKeys(
        input.jurisdiction,
        [
          'provider',
          'boundaryId',
          'boundaryName',
          'boundaryLevel',
          'boundaryCanonical',
          'countryCode',
          'countryName',
          'continent',
        ],
        'jurisdiction',
        errors,
      )
      validateText(input.jurisdiction.boundaryId, 'jurisdiction.boundaryId', errors, 128)
      validateText(input.jurisdiction.boundaryName, 'jurisdiction.boundaryName', errors, 128)
      const level = input.jurisdiction.boundaryLevel
      if (level === 'CONTINENT' || level === 'COUNTRY') {
        if (input.jurisdiction.provider !== 'naturalEarth') {
          errors.push(`jurisdiction.provider must be naturalEarth for ${String(level)} selections`)
        }
      } else if (typeof level !== 'string' || !/^ADM[0-5]$/.test(level)) {
        errors.push('jurisdiction.boundaryLevel must be CONTINENT, COUNTRY, or a supported level from ADM0 to ADM5')
      } else if (input.jurisdiction.provider !== 'geoBoundaries') {
        errors.push('jurisdiction.provider must be geoBoundaries for administrative boundary selections')
      }
      if (input.jurisdiction.provider !== 'geoBoundaries' && input.jurisdiction.provider !== 'naturalEarth') {
        errors.push('jurisdiction.provider must be geoBoundaries or naturalEarth')
      }
      validateOptionalText(input.jurisdiction.boundaryCanonical, 'jurisdiction.boundaryCanonical', errors, 128)
      validateOptionalText(input.jurisdiction.countryName, 'jurisdiction.countryName', errors, 128)
      validateOptionalText(input.jurisdiction.continent, 'jurisdiction.continent', errors, 64)
      if (input.jurisdiction.countryCode !== undefined &&
        (typeof input.jurisdiction.countryCode !== 'string' || !/^[A-Z]{3}$/.test(input.jurisdiction.countryCode))) {
        errors.push('jurisdiction.countryCode must be a three-letter uppercase ISO code')
      }
    }
  }
  return errors
}

export function validateProduct(input: unknown): string[] {
  if (!isRecord(input)) return ['Product must be an object']
  const errors: string[] = []
  rejectUnknownKeys(input, ['name', 'description', 'active'], 'product', errors)
  validateText(input.name, 'name', errors, 128)
  validateOptionalText(input.description, 'description', errors, 512)
  validateOptionalBoolean(input.active, 'active', errors)
  return errors
}

export function validateLocation(input: unknown): string[] {
  if (!isRecord(input)) return ['Location must be an object']
  const errors: string[] = []
  rejectUnknownKeys(
    input,
    ['name', 'description', 'kind', 'parentLocationId', 'latitude', 'longitude', 'active'],
    'location',
    errors,
  )
  validateText(input.name, 'name', errors, 128)
  validateOptionalText(input.description, 'description', errors, 512)
  if (input.kind !== 'region' && input.kind !== 'point') {
    errors.push('kind must be region or point')
  }
  if (input.parentLocationId !== undefined) {
    validateId(input.parentLocationId, 'parentLocationId', errors)
  }
  const hasLatitude = input.latitude !== undefined
  const hasLongitude = input.longitude !== undefined
  if (hasLatitude !== hasLongitude) {
    errors.push('latitude and longitude must be provided together')
  }
  if (input.kind === 'point' && !hasLatitude) {
    errors.push('point locations require latitude and longitude')
  }
  if (hasLatitude && (!isFiniteNumber(input.latitude) || input.latitude < -90 || input.latitude > 90)) {
    errors.push('latitude must be between -90 and 90')
  }
  if (hasLongitude && (!isFiniteNumber(input.longitude) || input.longitude < -180 || input.longitude > 180)) {
    errors.push('longitude must be between -180 and 180')
  }
  validateOptionalBoolean(input.active, 'active', errors)
  return errors
}

export function validateMetric(
  input: unknown,
  contract?: EventContract,
): string[] {
  if (!isRecord(input)) return ['Metric must be an object']
  const errors: string[] = []
  rejectUnknownKeys(
    input,
    ['name', 'description', 'unit', 'direction', 'eventType', 'formula', 'aggregation', 'calculation', 'active'],
    'metric',
    errors,
  )
  validateText(input.name, 'name', errors, 128)
  validateText(input.description, 'description', errors, 512)
  validateText(input.unit, 'unit', errors, 32)
  if (input.direction !== 'higher' && input.direction !== 'lower') {
    errors.push('direction must be higher or lower')
  }
  validateOptionalBoolean(input.active, 'active', errors)

  if (input.calculation !== undefined) {
    rejectUnknownKeys(input, ['name', 'description', 'unit', 'direction', 'calculation', 'active'], 'metric', errors)
    if (!isMetricCalculation(input.calculation)) {
      errors.push('calculation must combine exactly two product-specific metric references')
    } else {
      rejectUnknownKeys(input.calculation, ['operator', 'operands'], 'calculation', errors)
      for (const [index, operand] of input.calculation.operands.entries()) {
        rejectUnknownKeys(operand, ['metricId', 'productId'], `calculation.operands[${index}]`, errors)
        validateId(operand.metricId, `calculation.operands[${index}].metricId`, errors)
        validateId(operand.productId, `calculation.operands[${index}].productId`, errors)
      }
    }
    return errors
  }

  if (input.aggregation !== undefined &&
    !['sum', 'average', 'min', 'max', 'count'].includes(String(input.aggregation))) {
    errors.push('aggregation must be sum, average, min, max, or count')
  }
  validateText(input.eventType, 'eventType', errors, 64)
  if (!contract) {
    errors.push('An active event contract is required for an event-derived metric')
    return errors
  }
  const eventType = contract.eventTypes.find((candidate) => candidate.key === input.eventType)
  if (!eventType) {
    errors.push('eventType must refer to an event type in the active contract')
    return errors
  }

  const measureFields = new Set(
    eventType.fields.filter((field) => field.type === 'number' && field.role === 'measure')
      .map((field) => field.key),
  )
  validateFormula(input.formula, measureFields, 'formula', errors, 1, { count: 0 })
  return errors
}

export function validateTarget(input: unknown): string[] {
  if (!isRecord(input)) return ['Target must be an object']
  const errors: string[] = []
  rejectUnknownKeys(
    input,
    [
      'metricId',
      'productId',
      'locationId',
      'orgUnitId',
      'period',
      'startDate',
      'endDate',
      'targetValue',
      'targetMode',
      'referenceMetricId',
      'referenceProductId',
      'warningThreshold',
      'active',
    ],
    'target',
    errors,
  )
  validateId(input.metricId, 'metricId', errors)
  if (input.productId !== undefined) validateId(input.productId, 'productId', errors)
  if (input.locationId !== undefined) validateId(input.locationId, 'locationId', errors)
  if (input.orgUnitId !== undefined) validateId(input.orgUnitId, 'orgUnitId', errors)
  if (!['day', 'week', 'month', 'quarter', 'year'].includes(String(input.period))) {
    errors.push('period must be day, week, month, quarter, or year')
  }
  if (!isDateOnly(input.startDate)) errors.push('startDate must be a YYYY-MM-DD date')
  if (!isDateOnly(input.endDate)) errors.push('endDate must be a YYYY-MM-DD date')
  if (isDateOnly(input.startDate) && isDateOnly(input.endDate) && input.startDate > input.endDate) {
    errors.push('startDate must be on or before endDate')
  }
  if (!isFiniteNumber(input.targetValue)) errors.push('targetValue must be a finite number')
  if (input.targetMode !== undefined && input.targetMode !== 'fixed' && input.targetMode !== 'percentage') {
    errors.push('targetMode must be fixed or percentage')
  }
  if (input.targetMode === 'percentage') {
    if (!isFiniteNumber(input.targetValue) || input.targetValue < 0) {
      errors.push('percentage targetValue must be a non-negative finite percentage')
    }
    validateId(input.referenceMetricId, 'referenceMetricId', errors)
    validateId(input.referenceProductId, 'referenceProductId', errors)
  } else if (input.referenceMetricId !== undefined || input.referenceProductId !== undefined) {
    errors.push('referenceMetricId and referenceProductId are only supported for percentage targets')
  }
  if (input.warningThreshold !== undefined && !isFiniteNumber(input.warningThreshold)) {
    errors.push('warningThreshold must be a finite number')
  }
  validateOptionalBoolean(input.active, 'active', errors)
  return errors
}

export function isConfigurationResource(value: string): value is ConfigurationResource {
  return value === 'products' || value === 'locations' || value === 'metrics' ||
    value === 'targets' || value === 'org-units'
}

export function isMetricExpression(input: unknown): input is MetricExpression {
  return isRecord(input) &&
    (input.type === 'field' && typeof input.key === 'string' ||
      input.type === 'constant' && typeof input.value === 'number' ||
      input.type === 'operation' &&
        (input.operator === 'add' || input.operator === 'subtract' ||
          input.operator === 'multiply' || input.operator === 'divide') &&
        Array.isArray(input.operands) &&
        input.operands.length === 2 &&
        isMetricExpression(input.operands[0]) &&
        isMetricExpression(input.operands[1]))
}

export function isMetricCalculation(input: unknown): input is MetricCalculation {
  return isRecord(input) &&
    ['add', 'subtract', 'multiply', 'divide'].includes(String(input.operator)) &&
    Array.isArray(input.operands) &&
    input.operands.length === 2 &&
    input.operands.every((operand) => isRecord(operand) &&
      typeof operand.metricId === 'string' && typeof operand.productId === 'string')
}

export function isProductInput(input: unknown): input is ProductInput {
  return isRecord(input) &&
    typeof input.name === 'string' &&
    (input.description === undefined || typeof input.description === 'string') &&
    (input.active === undefined || typeof input.active === 'boolean')
}

export function isLocationInput(input: unknown): input is ReportingLocationInput {
  return isRecord(input) &&
    typeof input.name === 'string' &&
    (input.description === undefined || typeof input.description === 'string') &&
    (input.kind === 'region' || input.kind === 'point') &&
    (input.parentLocationId === undefined || typeof input.parentLocationId === 'string') &&
    (input.latitude === undefined || typeof input.latitude === 'number') &&
    (input.longitude === undefined || typeof input.longitude === 'number') &&
    (input.active === undefined || typeof input.active === 'boolean')
}

export function isMetricInput(input: unknown): input is MetricDefinitionInput {
  return isRecord(input) &&
    typeof input.name === 'string' &&
    typeof input.description === 'string' &&
    typeof input.unit === 'string' &&
    (input.direction === 'higher' || input.direction === 'lower') &&
    (input.calculation !== undefined
      ? isMetricCalculation(input.calculation)
      : typeof input.eventType === 'string' && isMetricExpression(input.formula)) &&
    (input.active === undefined || typeof input.active === 'boolean')
}

export function isTargetInput(input: unknown): input is TargetInput {
  return isRecord(input) &&
    typeof input.metricId === 'string' &&
    (input.productId === undefined || typeof input.productId === 'string') &&
    (input.locationId === undefined || typeof input.locationId === 'string') &&
    (input.orgUnitId === undefined || typeof input.orgUnitId === 'string') &&
    (input.period === 'day' || input.period === 'week' || input.period === 'month' ||
      input.period === 'quarter' || input.period === 'year') &&
    typeof input.startDate === 'string' &&
    typeof input.endDate === 'string' &&
    typeof input.targetValue === 'number' &&
    (input.targetMode === undefined || input.targetMode === 'fixed' || input.targetMode === 'percentage') &&
    (input.referenceMetricId === undefined || typeof input.referenceMetricId === 'string') &&
    (input.referenceProductId === undefined || typeof input.referenceProductId === 'string') &&
    (input.warningThreshold === undefined || typeof input.warningThreshold === 'number') &&
    (input.active === undefined || typeof input.active === 'boolean')
}

export function isOrganizationUnitInput(input: unknown): input is OrganizationUnitInput {
  return isRecord(input) &&
    typeof input.name === 'string' &&
    typeof input.type === 'string' &&
    (input.parentUnitId === undefined || typeof input.parentUnitId === 'string') &&
    (input.active === undefined || typeof input.active === 'boolean')
}

function validateFormula(
  value: unknown,
  measureFields: Set<string>,
  label: string,
  errors: string[],
  depth: number,
  nodes: { count: number },
): void {
  nodes.count += 1
  if (depth > 8 || nodes.count > 31) {
    errors.push(`${label} exceeds the supported formula complexity`)
    return
  }
  if (!isRecord(value)) {
    errors.push(`${label} must be a formula object`)
    return
  }

  if (value.type === 'field') {
    rejectUnknownKeys(value, ['type', 'key'], label, errors)
    validateText(value.key, `${label}.key`, errors, 64)
    if (typeof value.key === 'string' && !measureFields.has(value.key)) {
      errors.push(`${label}.key must refer to a numeric measure field in the selected event type`)
    }
    return
  }
  if (value.type === 'constant') {
    rejectUnknownKeys(value, ['type', 'value'], label, errors)
    if (!isFiniteNumber(value.value)) errors.push(`${label}.value must be a finite number`)
    return
  }
  if (value.type === 'operation') {
    rejectUnknownKeys(value, ['type', 'operator', 'operands'], label, errors)
    if (!['add', 'subtract', 'multiply', 'divide'].includes(String(value.operator))) {
      errors.push(`${label}.operator is unsupported`)
    }
    if (!Array.isArray(value.operands) || value.operands.length !== 2) {
      errors.push(`${label}.operands must contain exactly two expressions`)
      return
    }
    validateFormula(value.operands[0], measureFields, `${label}.operands[0]`, errors, depth + 1, nodes)
    validateFormula(value.operands[1], measureFields, `${label}.operands[1]`, errors, depth + 1, nodes)
    return
  }
  errors.push(`${label}.type must be field, constant, or operation`)
}

function validateId(value: unknown, label: string, errors: string[]): void {
  if (typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    errors.push(`${label} must be a valid resource ID`)
  }
}

function validateText(value: unknown, label: string, errors: string[], maxLength: number): void {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength) {
    errors.push(`${label} must be a non-empty string of at most ${maxLength} characters`)
  }
}

function validateOptionalText(
  value: unknown,
  label: string,
  errors: string[],
  maxLength: number,
): void {
  if (value !== undefined && (typeof value !== 'string' || value.length > maxLength)) {
    errors.push(`${label} must be a string of at most ${maxLength} characters`)
  }
}

function validateOptionalBoolean(value: unknown, label: string, errors: string[]): void {
  if (value !== undefined && typeof value !== 'boolean') {
    errors.push(`${label} must be boolean`)
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isDateOnly(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
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

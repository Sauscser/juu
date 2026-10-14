export type FieldType = 'string' | 'number' | 'boolean'
export type FieldRole = 'dimension' | 'measure' | 'pseudonymous_id'
export type Aggregation = 'sum' | 'count' | 'average' | 'min' | 'max'

export interface CustomFieldDefinition {
  key: string
  label: string
  description: string
  type: FieldType
  role: FieldRole
  required: boolean
  unit?: string
  aggregation?: Aggregation
}

export interface EventTypeDefinition {
  key: string
  label: string
  description: string
  productIds?: string[]
  fields: CustomFieldDefinition[]
}

export type StandardCaptureMode = 'disabled' | 'optional' | 'required'

export interface StandardEventFields {
  senderLocation?: StandardCaptureMode
  reportingLocation?: StandardCaptureMode
}

export interface EventContract {
  version: number
  standardFields?: StandardEventFields
  eventTypes: EventTypeDefinition[]
}

export interface EventLocation {
  latitude: number
  longitude: number
  accuracyMeters?: number
}

export interface PartnerEvent {
  contractVersion: number
  eventId: string
  eventType: string
  occurredAt: string
  productId: string
  locationId?: string
  orgUnitId?: string
  location?: EventLocation
  fields: Record<string, unknown>
}

const keyPattern = /^[a-z][a-z0-9_]{0,63}$/
const reservedFieldKeys = new Set([
  'contract_version',
  'event_id',
  'event_type',
  'occurred_at',
  'product_id',
  'location_id',
  'location',
])
const fieldTypes = new Set<FieldType>(['string', 'number', 'boolean'])
const fieldRoles = new Set<FieldRole>(['dimension', 'measure', 'pseudonymous_id'])
const aggregations = new Set<Aggregation>(['sum', 'count', 'average', 'min', 'max'])
const maxEventTypes = 50
const maxFieldsPerEventType = 50
const maxFieldsPerContract = 250
const maxEventBytes = 350 * 1024
const resourceIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function validateContract(
  input: unknown,
  options: { requireProductAssociations?: boolean } = {},
): string[] {
  if (!isRecord(input)) return ['Contract must be an object']

  const errors: string[] = []
  rejectUnknownKeys(input, ['version', 'standardFields', 'eventTypes'], 'contract', errors)
  if (!isPositiveInteger(input.version)) errors.push('version must be a positive integer')
  if (input.standardFields !== undefined) {
    if (!isRecord(input.standardFields)) {
      errors.push('standardFields must be an object')
    } else {
      rejectUnknownKeys(
        input.standardFields,
        ['senderLocation', 'reportingLocation'],
        'standardFields',
        errors,
      )
      for (const key of ['senderLocation', 'reportingLocation']) {
        const mode = input.standardFields[key]
        if (mode !== undefined && mode !== 'disabled' && mode !== 'optional' && mode !== 'required') {
          errors.push(`standardFields.${key} must be disabled, optional, or required`)
        }
      }
    }
  }
  if (!Array.isArray(input.eventTypes) || input.eventTypes.length === 0) {
    errors.push('eventTypes must contain at least one event type')
    return errors
  }
  if (input.eventTypes.length > maxEventTypes) {
    errors.push(`eventTypes cannot contain more than ${maxEventTypes} entries`)
  }

  const eventKeys = new Set<string>()
  let totalFields = 0
  for (const [index, eventType] of input.eventTypes.entries()) {
    const prefix = `eventTypes[${index}]`
    if (!isRecord(eventType)) {
      errors.push(`${prefix} must be an object`)
      continue
    }
    rejectUnknownKeys(eventType, ['key', 'label', 'description', 'productIds', 'fields'], prefix, errors)
    if (!isKey(eventType.key)) errors.push(`${prefix}.key must be a lowercase stable key`)
    else if (eventKeys.has(eventType.key)) errors.push(`${prefix}.key is duplicated`)
    else eventKeys.add(eventType.key)
    validateText(eventType.label, `${prefix}.label`, errors)
    validateText(eventType.description, `${prefix}.description`, errors)
    if (eventType.productIds === undefined) {
      if (options.requireProductAssociations) {
        errors.push(`${prefix}.productIds must include at least one active product`)
      }
    } else if (!Array.isArray(eventType.productIds) || eventType.productIds.length === 0) {
      errors.push(`${prefix}.productIds must include at least one product`)
    } else {
      const productIds = new Set<string>()
      for (const [productIndex, productId] of eventType.productIds.entries()) {
        if (typeof productId !== 'string' || !resourceIdPattern.test(productId)) {
          errors.push(`${prefix}.productIds[${productIndex}] must be a valid product ID`)
        } else if (productIds.has(productId)) {
          errors.push(`${prefix}.productIds contains a duplicate product ID`)
        } else {
          productIds.add(productId)
        }
      }
    }
    if (!Array.isArray(eventType.fields)) {
      errors.push(`${prefix}.fields must be an array`)
      continue
    }
    if (eventType.fields.length > maxFieldsPerEventType) {
      errors.push(`${prefix}.fields cannot contain more than ${maxFieldsPerEventType} entries`)
    }

    const fieldKeys = new Set<string>()
    for (const [fieldIndex, field] of eventType.fields.entries()) {
      totalFields += 1
      const fieldPrefix = `${prefix}.fields[${fieldIndex}]`
      if (!isRecord(field)) {
        errors.push(`${fieldPrefix} must be an object`)
        continue
      }
      rejectUnknownKeys(
        field,
        ['key', 'label', 'description', 'type', 'role', 'required', 'unit', 'aggregation'],
        fieldPrefix,
        errors,
      )
      if (!isKey(field.key) || reservedFieldKeys.has(String(field.key))) {
        errors.push(`${fieldPrefix}.key must be a non-reserved lowercase stable key`)
      } else if (fieldKeys.has(field.key)) {
        errors.push(`${fieldPrefix}.key is duplicated`)
      } else {
        fieldKeys.add(field.key)
      }
      validateText(field.label, `${fieldPrefix}.label`, errors)
      validateText(field.description, `${fieldPrefix}.description`, errors)
      if (!fieldTypes.has(field.type as FieldType)) errors.push(`${fieldPrefix}.type is unsupported`)
      if (!fieldRoles.has(field.role as FieldRole)) errors.push(`${fieldPrefix}.role is unsupported`)
      if (typeof field.required !== 'boolean') errors.push(`${fieldPrefix}.required must be boolean`)
      if (field.unit !== undefined && (typeof field.unit !== 'string' || field.unit.length > 32)) {
        errors.push(`${fieldPrefix}.unit must be a string of at most 32 characters`)
      }
      if (field.aggregation !== undefined && !aggregations.has(field.aggregation as Aggregation)) {
        errors.push(`${fieldPrefix}.aggregation is unsupported`)
      }
      if (field.role === 'measure' && field.type !== 'number') {
        errors.push(`${fieldPrefix} measure fields must use the number type`)
      }
      if (field.role === 'pseudonymous_id' && field.type !== 'string') {
        errors.push(`${fieldPrefix} pseudonymous_id fields must use the string type`)
      }
      if (field.role === 'measure' && field.aggregation === undefined) {
        errors.push(`${fieldPrefix} measure fields must define an aggregation`)
      }
      if (field.role !== 'measure' && field.aggregation !== undefined) {
        errors.push(`${fieldPrefix} only measure fields can define an aggregation`)
      }
    }
  }
  if (totalFields > maxFieldsPerContract) {
    errors.push(`Contract cannot contain more than ${maxFieldsPerContract} custom fields`)
  }
  return errors
}

export function validatePartnerEvent(
  input: unknown,
  contract: EventContract,
): string[] {
  if (!isRecord(input)) return ['Event must be an object']
  if (Buffer.byteLength(JSON.stringify(input), 'utf8') > maxEventBytes) {
    return [`Event payload cannot exceed ${maxEventBytes} bytes`]
  }

  const errors: string[] = []
  rejectUnknownKeys(
    input,
    [
      'contractVersion',
      'eventId',
      'eventType',
      'occurredAt',
      'productId',
      'locationId',
      'orgUnitId',
      'location',
      'fields',
    ],
    'event',
    errors,
  )
  if (input.contractVersion !== contract.version) {
    errors.push('contractVersion does not match the selected contract')
  }
  validateText(input.eventId, 'eventId', errors, 128)
  validateText(input.eventType, 'eventType', errors, 64)
  if (typeof input.productId !== 'string' || !resourceIdPattern.test(input.productId)) {
    errors.push('productId must be a valid Uppy product ID')
  }
  if (input.locationId !== undefined &&
    (typeof input.locationId !== 'string' || !resourceIdPattern.test(input.locationId))) {
    errors.push('locationId must be a valid Uppy location ID')
  }
  if (input.orgUnitId !== undefined &&
    (typeof input.orgUnitId !== 'string' || !resourceIdPattern.test(input.orgUnitId))) {
    errors.push('orgUnitId must be a valid company organization unit ID')
  }
  const senderLocationMode = contract.standardFields?.senderLocation ?? 'optional'
  const reportingLocationMode = contract.standardFields?.reportingLocation ?? 'optional'
  if (senderLocationMode === 'required' && input.location === undefined) {
    errors.push('location is required by the event contract')
  }
  if (senderLocationMode === 'disabled' && input.location !== undefined) {
    errors.push('location is disabled by the event contract')
  }
  if (reportingLocationMode === 'required' && input.locationId === undefined) {
    errors.push('locationId is required by the event contract')
  }
  if (reportingLocationMode === 'disabled' && input.locationId !== undefined) {
    errors.push('locationId is disabled by the event contract')
  }
  if (typeof input.occurredAt !== 'string' || !isValidDate(input.occurredAt)) {
    errors.push('occurredAt must be a valid ISO 8601 timestamp')
  }

  if (input.location !== undefined) {
    if (!isRecord(input.location)) {
      errors.push('location must be an object')
    } else {
      rejectUnknownKeys(
        input.location,
        ['latitude', 'longitude', 'accuracyMeters'],
        'location',
        errors,
      )
      if (!isFiniteNumber(input.location.latitude) || input.location.latitude < -90 || input.location.latitude > 90) {
        errors.push('location.latitude must be between -90 and 90')
      }
      if (!isFiniteNumber(input.location.longitude) || input.location.longitude < -180 || input.location.longitude > 180) {
        errors.push('location.longitude must be between -180 and 180')
      }
      if (input.location.accuracyMeters !== undefined &&
        (!isFiniteNumber(input.location.accuracyMeters) || input.location.accuracyMeters < 0)) {
        errors.push('location.accuracyMeters must be a non-negative number')
      }
    }
  }

  const eventType = contract.eventTypes.find((candidate) => candidate.key === input.eventType)
  if (!eventType) {
    errors.push('eventType is not defined by the selected contract')
    return errors
  }
  if (eventType.productIds && !eventType.productIds.includes(String(input.productId))) {
    errors.push('productId is not associated with this eventType')
  }

  if (!isRecord(input.fields)) {
    errors.push('fields must be an object')
    return errors
  }

  const definitions = new Map(eventType.fields.map((field) => [field.key, field]))
  for (const field of eventType.fields) {
    const value = input.fields[field.key]
    if (value === undefined || value === null) {
      if (field.required) errors.push(`fields.${field.key} is required`)
      continue
    }
    if (typeof value !== field.type ||
      (field.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value)))) {
      errors.push(`fields.${field.key} must be ${field.type}`)
    }
    if (field.type === 'string' && typeof value === 'string' && value.length > 4096) {
      errors.push(`fields.${field.key} cannot exceed 4096 characters`)
    }
  }
  for (const key of Object.keys(input.fields)) {
    if (!definitions.has(key)) errors.push(`fields.${key} is not defined by the event contract`)
  }

  return errors
}

export function isValidatedEventContract(input: unknown): input is EventContract {
  return validateContract(input).length === 0
}

export function isValidatedPartnerEvent(
  input: unknown,
  contract: EventContract,
): input is PartnerEvent {
  return validatePartnerEvent(input, contract).length === 0
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isKey(value: unknown): value is string {
  return typeof value === 'string' && keyPattern.test(value)
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isValidDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value))
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

function validateText(value: unknown, label: string, errors: string[], maxLength = 256): void {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength) {
    errors.push(`${label} must be a non-empty string of at most ${maxLength} characters`)
  }
}

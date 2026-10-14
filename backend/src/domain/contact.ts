export function validateInviteeContact(
  name: unknown,
  phoneNumber: unknown,
  nameField: string,
  phoneField: string,
): string[] {
  const errors: string[] = []
  if (name !== undefined && (typeof name !== 'string' || name.trim().length > 128)) {
    errors.push(`${nameField} must be a string of at most 128 characters`)
  }
  if (phoneNumber !== undefined && typeof phoneNumber !== 'string') {
    errors.push(`${phoneField} must be a string`)
  } else if (typeof phoneNumber === 'string' && phoneNumber.trim() !== '' &&
    !/^[+][1-9]\d{1,14}$/.test(phoneNumber.trim())) {
    errors.push(`${phoneField} must use international format, for example +254712345678`)
  }
  return errors
}

export function optionalContactValue(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  return value.trim() || undefined
}

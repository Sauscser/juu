import { fetchAuthSession } from 'aws-amplify/auth'

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly requestId?: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export async function apiRequest<T>(
  apiUrl: string,
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const session = await fetchAuthSession()
  const token = session.tokens?.idToken?.toString()
  if (!token) throw new Error('Your sign-in session has expired. Sign in again to continue.')

  const response = await fetch(`${apiUrl}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      authorization: token,
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  })

  const text = await response.text()
  let result: unknown
  try {
    result = text ? JSON.parse(text) as unknown : undefined
  } catch {
    const requestId = response.headers.get('x-amzn-requestid') ?? undefined
    console.error('Juu API returned an unreadable response', {
      method: options.method ?? 'GET',
      path: new URL(path, apiUrl).pathname,
      status: response.status,
      requestId,
    })
    throw new ApiError(`Juu returned an unreadable response (${response.status}).`, response.status, requestId)
  }

  if (!response.ok) {
    const message = isRecord(result) && typeof result.error === 'string'
      ? result.error
      : `The request failed (${response.status}).`
    const details = isRecord(result) && Array.isArray(result.details)
      ? result.details.filter((detail): detail is string => typeof detail === 'string')
      : []
    const requestId = isRecord(result) && typeof result.requestId === 'string'
      ? result.requestId
      : response.headers.get('x-amzn-requestid') ?? response.headers.get('x-amz-apigw-id') ?? undefined
    const diagnostic = {
      method: options.method ?? 'GET',
      path: new URL(path, apiUrl).pathname,
      status: response.status,
      message,
      details,
      requestId,
    }
    console.error('Juu API request failed', diagnostic)
    const detailMessage = details.length > 0 ? `: ${details.join('; ')}` : ''
    const requestMessage = requestId ? `, request ID: ${requestId}` : ''
    throw new ApiError(
      `${message}${detailMessage} (HTTP ${response.status}${requestMessage})`,
      response.status,
      requestId,
    )
  }
  return result as T
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

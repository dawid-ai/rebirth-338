import type { ApiErrorBody } from '@reborn/studio-core/api'

export const VERSION = '2.0.0-dev'

/** Process exit codes. Scripts can branch on these. */
export const EXIT = {
  ok: 0,
  generic: 1,
  usage: 2,
  notRunning: 3,
  conflict: 4,
  auth: 5,
} as const

export type ExitCode = (typeof EXIT)[keyof typeof EXIT]

export type ErrorCode = ApiErrorBody['error']['code'] | 'usage' | 'not_running'

export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: ExitCode = EXIT.generic,
    readonly code: ErrorCode = 'internal',
    readonly hint?: string,
  ) {
    super(message)
    this.name = 'CliError'
  }
}

export const usageError = (message: string, hint?: string) => new CliError(message, EXIT.usage, 'usage', hint)

export const notRunningError = (detail?: string) =>
  new CliError(`RE:BORN is not running${detail ? ` (${detail})` : ''}.`, EXIT.notRunning, 'not_running', 'Start the RE:BORN desktop app, then try again. If it is running, pass --api-file or set REBORN_API_FILE.')

const API_EXIT: Record<ApiErrorBody['error']['code'], ExitCode> = {
  unauthorized: EXIT.auth,
  forbidden: EXIT.auth,
  invalid: EXIT.generic,
  not_found: EXIT.generic,
  conflict: EXIT.conflict,
  unavailable: EXIT.generic,
  internal: EXIT.generic,
}

const API_HINT: Partial<Record<ApiErrorBody['error']['code'], string>> = {
  unauthorized: 'The token in api.json was rejected. Restart RE:BORN to write a fresh api.json.',
  forbidden: 'This action needs the write token. Drop --read-only, or ask the user to allow it in RE:BORN.',
  conflict: 'The project changed since you read it. Read it again and retry.',
}

/** Converts an HTTP error body from the local service into a CliError. */
export function apiError(status: number, body: unknown): CliError {
  const error = isApiErrorBody(body) ? body.error : null
  if (!error) return new CliError(`RE:BORN answered with HTTP ${status}.`, status === 401 || status === 403 ? EXIT.auth : EXIT.generic)
  return new CliError(error.message, API_EXIT[error.code] ?? EXIT.generic, error.code, API_HINT[error.code])
}

function isApiErrorBody(value: unknown): value is ApiErrorBody {
  if (!value || typeof value !== 'object') return false
  const error = (value as { error?: unknown }).error
  return !!error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string' && typeof (error as { message?: unknown }).message === 'string'
}

export const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

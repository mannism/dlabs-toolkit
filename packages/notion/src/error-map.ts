/**
 * Error mapping for @diabolicallabs/notion.
 *
 * Maps @notionhq/client SDK errors to the @diabolicallabs/notion named error taxonomy.
 * The SDK throws APIResponseError (with a code field from APIErrorCode enum) for HTTP errors
 * and RequestTimeoutError for timeout events.
 *
 * Never include config.apiKey or the Authorization header in mapped error messages.
 *
 * Reference: https://github.com/makenotion/notion-sdk-js/blob/main/src/errors.ts
 */

import { APIErrorCode, ClientErrorCode, isNotionClientError } from '@notionhq/client';
import {
  NotionAuthError,
  NotionConflictError,
  NotionNotFoundError,
  NotionRateLimitError,
  NotionUnavailableError,
  NotionValidationError,
} from './types.js';

// APIErrorCode values from the SDK — covers all documented Notion error codes.
// We import from the SDK enum to stay in sync with SDK updates.

// HTTP status → error code groupings (mirrors Notion docs + Tom research §6)
const AUTH_CODES = new Set<string>([
  APIErrorCode.Unauthorized,
  APIErrorCode.RestrictedResource,
  'invalid_grant',
]);

const VALIDATION_CODES = new Set<string>([
  APIErrorCode.ValidationError,
  APIErrorCode.InvalidJSON,
  APIErrorCode.InvalidRequestURL,
  APIErrorCode.InvalidRequest,
  'missing_version',
]);

const NOT_FOUND_CODES = new Set<string>([APIErrorCode.ObjectNotFound]);

const RATE_LIMIT_CODES = new Set<string>([APIErrorCode.RateLimited]);

const CONFLICT_CODES = new Set<string>([APIErrorCode.ConflictError]);

const UNAVAILABLE_CODES = new Set<string>([
  APIErrorCode.InternalServerError,
  APIErrorCode.ServiceUnavailable,
  'bad_gateway',
  'gateway_timeout',
  'database_connection_unavailable',
]);

/**
 * Check whether an error code maps to a retryable / temporary server-side error.
 * Used in the conflict-retry loop — only 409 gets bespoke retry.
 */
export function isConflictCode(code: string): boolean {
  return CONFLICT_CODES.has(code);
}

/**
 * Map an unknown thrown value (from the SDK or from our own code) to one of the
 * named NotionError subclasses. Redacts the Authorization header and never
 * includes api keys in the message.
 */
export function mapSdkError(
  err: unknown
):
  | NotionAuthError
  | NotionNotFoundError
  | NotionValidationError
  | NotionRateLimitError
  | NotionConflictError
  | NotionUnavailableError {
  // SDK-typed error — inspect code and map to named class
  if (isNotionClientError(err)) {
    const code = 'code' in err ? String(err.code) : 'unknown';
    const message = err.message ?? 'Notion API error';

    // Client-side timeout from the SDK
    if (code === ClientErrorCode.RequestTimeout) {
      return new NotionUnavailableError(`Notion request timed out: ${message}`, code, err);
    }

    if (AUTH_CODES.has(code)) {
      return new NotionAuthError(`Notion auth error: ${message}`, code, err);
    }

    if (VALIDATION_CODES.has(code)) {
      return new NotionValidationError(`Notion validation error: ${message}`, code, err);
    }

    if (NOT_FOUND_CODES.has(code)) {
      return new NotionNotFoundError(`Notion resource not found: ${message}`, code, err);
    }

    if (RATE_LIMIT_CODES.has(code)) {
      return new NotionRateLimitError(`Notion rate limit exceeded: ${message}`, code, err);
    }

    if (CONFLICT_CODES.has(code)) {
      return new NotionConflictError(`Notion conflict error: ${message}`, code, err);
    }

    if (UNAVAILABLE_CODES.has(code)) {
      return new NotionUnavailableError(`Notion service unavailable: ${message}`, code, err);
    }

    // Unknown SDK error code — default to unavailable (conservative)
    return new NotionUnavailableError(`Notion API error [${code}]: ${message}`, code, err);
  }

  // Non-SDK error (network, etc.) — wrap as unavailable
  if (err instanceof Error) {
    return new NotionUnavailableError(
      `Notion request failed: ${err.message}`,
      'network_error',
      err
    );
  }

  return new NotionUnavailableError('Notion request failed: unknown error', 'unknown', err);
}

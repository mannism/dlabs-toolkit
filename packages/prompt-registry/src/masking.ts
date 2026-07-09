/**
 * Sensitivity masking helpers — admin-standard §S6 ("is_sensitive: mask in UI")
 * applied to prompt bodies specifically. Prompt text is not a secret in the
 * API-key sense (admins are expected to read and diff it in the eventual
 * admin Prompts UI per admin-standard §S7), but it MUST be maskable for
 * contexts where full bodies shouldn't appear — audit-log list views,
 * Slack/webhook notifications, error messages, third-party log aggregators.
 *
 * This package's own internal logging never calls maskPromptBody() because it
 * never logs raw content in the first place (see logger.ts's security
 * invariant) — this helper exists for consumers building their own audit UI
 * or notification surface on top of history()/get().
 */

import { createHash } from 'node:crypto';

/** Number of leading characters kept unmasked in maskPromptBody()'s default preview mode. */
const PREVIEW_CHARS = 60;

export type MaskMode = 'full' | 'preview' | 'hash';

/**
 * Masks a prompt body for display in a lower-trust context (audit log list
 * view, notification payload, error message).
 *
 * - 'full'    — entirely redacted: `[REDACTED prompt body, 1284 chars]`
 * - 'preview' — first 60 chars + redaction marker + length (default)
 * - 'hash'    — content-addressed marker only, useful for diff-changed-or-not
 *               checks without ever transmitting the body (e.g. webhook payloads)
 */
export function maskPromptBody(content: string, mode: MaskMode = 'preview'): string {
  const byteLength = Buffer.byteLength(content, 'utf8');

  if (mode === 'full') {
    return `[REDACTED prompt body, ${byteLength} bytes]`;
  }

  if (mode === 'hash') {
    const hash = createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 12);
    return `[prompt body sha256:${hash}, ${byteLength} bytes]`;
  }

  const preview = content.slice(0, PREVIEW_CHARS).replace(/\s+/g, ' ').trim();
  const truncated = content.length > PREVIEW_CHARS ? '…' : '';
  return `${preview}${truncated} [${byteLength} bytes total, masked]`;
}

/**
 * Never-log guard for connection-level secrets (connection strings, API keys,
 * tokens). Consumers constructing a PostgresPromptStorageAdapter from a raw
 * connection string should pass it through here before it can reach any log
 * call — strips credentials from a postgres:// URL, leaving host/db visible
 * for debugging. Returns the input unchanged if it does not parse as a URL
 * (fails safe: unrecognized strings are treated as opaque and NOT logged by
 * any call site in this package regardless).
 */
export function redactConnectionString(value: string): string {
  try {
    const url = new URL(value);
    if (url.username || url.password) {
      url.username = '***';
      url.password = '***';
    }
    return url.toString();
  } catch {
    return '[unparseable connection string, redacted]';
  }
}

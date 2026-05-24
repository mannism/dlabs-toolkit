/**
 * Smoke tests for @diabolicallabs/notifier-core public exports.
 * Verifies all exports are present and correctly shaped.
 */

import { describe, expect, it } from 'vitest';
import {
  computeJitter,
  PlatformAuthError,
  PlatformError,
  PlatformNotFoundError,
  PlatformRateLimitError,
  PlatformUnavailableError,
  PlatformValidationError,
  retryWithJitter,
} from './index.js';

describe('@diabolicallabs/notifier-core', () => {
  it('exports retryWithJitter as a function', () => {
    expect(typeof retryWithJitter).toBe('function');
  });

  it('exports computeJitter as a function', () => {
    expect(typeof computeJitter).toBe('function');
  });

  it('exports all error classes', () => {
    expect(typeof PlatformError).toBe('function');
    expect(typeof PlatformAuthError).toBe('function');
    expect(typeof PlatformNotFoundError).toBe('function');
    expect(typeof PlatformRateLimitError).toBe('function');
    expect(typeof PlatformValidationError).toBe('function');
    expect(typeof PlatformUnavailableError).toBe('function');
  });

  it('error classes have correct inheritance', () => {
    const err = new PlatformAuthError('test', 'slack', 'invalid_auth');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(PlatformError);
    expect(err).toBeInstanceOf(PlatformAuthError);
  });
});

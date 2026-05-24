/**
 * Unit tests for @diabolicallabs/slack error taxonomy.
 */

import { PlatformError } from '@diabolicallabs/notifier-core';
import { describe, expect, it } from 'vitest';
import {
  SlackAuthError,
  SlackChannelNotFoundError,
  SlackError,
  SlackRateLimitError,
  SlackUnavailableError,
  SlackValidationError,
} from './types.js';

describe('SlackError (base)', () => {
  it('sets platform to slack and message/code', () => {
    const err = new SlackError('something went wrong', 'generic_error');
    expect(err.platform).toBe('slack');
    expect(err.message).toBe('something went wrong');
    expect(err.code).toBe('generic_error');
    expect(err.name).toBe('SlackError');
  });

  it('extends PlatformError', () => {
    const err = new SlackError('msg', 'code');
    expect(err).toBeInstanceOf(PlatformError);
  });
});

describe('SlackAuthError', () => {
  it('sets platform to slack and is instanceof PlatformError', () => {
    const err = new SlackAuthError('invalid_auth', 'invalid_auth');
    expect(err.platform).toBe('slack');
    expect(err).toBeInstanceOf(PlatformError);
    expect(err.name).toBe('SlackAuthError');
  });
});

describe('SlackChannelNotFoundError', () => {
  it('sets platform to slack', () => {
    const err = new SlackChannelNotFoundError('channel not found', 'channel_not_found');
    expect(err.platform).toBe('slack');
    expect(err.name).toBe('SlackChannelNotFoundError');
  });
});

describe('SlackRateLimitError', () => {
  it('sets kind and retryAfterMs', () => {
    const err = new SlackRateLimitError('rate limited', 'ratelimited', 'exceeded', 5000);
    expect(err.kind).toBe('exceeded');
    expect(err.retryAfterMs).toBe(5000);
    expect(err.platform).toBe('slack');
    expect(err.name).toBe('SlackRateLimitError');
  });

  it('supports unavailable kind with null retryAfterMs', () => {
    const err = new SlackRateLimitError('redis down', 'unavailable', 'unavailable', null);
    expect(err.kind).toBe('unavailable');
    expect(err.retryAfterMs).toBeNull();
  });
});

describe('SlackValidationError', () => {
  it('sets platform to slack', () => {
    const err = new SlackValidationError('invalid_arguments', 'invalid_arguments');
    expect(err.platform).toBe('slack');
    expect(err.name).toBe('SlackValidationError');
  });
});

describe('SlackUnavailableError', () => {
  it('sets platform to slack', () => {
    const err = new SlackUnavailableError('service unavailable', '503');
    expect(err.platform).toBe('slack');
    expect(err.name).toBe('SlackUnavailableError');
  });
});

describe('inheritance chain', () => {
  it('all error classes extend PlatformError and Error', () => {
    const errors = [
      new SlackError('a', 'b'),
      new SlackAuthError('a', 'b'),
      new SlackChannelNotFoundError('a', 'b'),
      new SlackRateLimitError('a', 'b', 'exceeded', null),
      new SlackValidationError('a', 'b'),
      new SlackUnavailableError('a', 'b'),
    ];
    for (const err of errors) {
      expect(err).toBeInstanceOf(PlatformError);
      expect(err).toBeInstanceOf(Error);
    }
  });
});

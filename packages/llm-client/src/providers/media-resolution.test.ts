/**
 * Unit tests for media-resolution.ts — resolveMediaResolution() and toPartMediaResolution().
 * Pure functions, no SDK mocking needed (mirrors the reasoning-effort.test.ts convention).
 *
 * Test coverage:
 * - resolveMediaResolution(): call-level overrides config-level, undefined when both unset,
 *   low/medium/high map to the MediaResolution enum, bad_request on 'ultra_high'.
 * - toPartMediaResolution(): all four levels map to the PartMediaResolutionLevel enum.
 */

import { MediaResolution, PartMediaResolutionLevel } from '@google/genai';
import { describe, expect, it } from 'vitest';
import { LlmError } from '../types.js';
import { resolveMediaResolution, toPartMediaResolution } from './media-resolution.js';

describe('resolveMediaResolution: call-level overrides config-level', () => {
  it('returns the call-level value when both config and call levels are set', () => {
    expect(resolveMediaResolution('low', 'high')).toBe(MediaResolution.MEDIA_RESOLUTION_HIGH);
  });

  it('falls back to config-level when call-level is unset', () => {
    expect(resolveMediaResolution('medium', undefined)).toBe(
      MediaResolution.MEDIA_RESOLUTION_MEDIUM
    );
  });
});

describe('resolveMediaResolution: returns undefined when both unset', () => {
  it('returns undefined when neither config nor call level is set', () => {
    expect(resolveMediaResolution(undefined, undefined)).toBeUndefined();
  });
});

describe('resolveMediaResolution: maps low/medium/high to MediaResolution enum members', () => {
  it.each([
    ['low', MediaResolution.MEDIA_RESOLUTION_LOW],
    ['medium', MediaResolution.MEDIA_RESOLUTION_MEDIUM],
    ['high', MediaResolution.MEDIA_RESOLUTION_HIGH],
  ] as const)("maps '%s' to %s", (level, expected) => {
    expect(resolveMediaResolution(undefined, level)).toBe(expected);
    expect(resolveMediaResolution(level, undefined)).toBe(expected);
  });
});

describe('resolveMediaResolution: throws bad_request on ultra_high', () => {
  it('throws when call-level is ultra_high', () => {
    expect(() => resolveMediaResolution(undefined, 'ultra_high')).toThrow(LlmError);
  });

  it('throws when config-level is ultra_high (and call-level is unset)', () => {
    expect(() => resolveMediaResolution('ultra_high', undefined)).toThrow(LlmError);
  });

  it('error carries kind bad_request, retryable false, provider gemini, and names the per-block alternative', () => {
    try {
      resolveMediaResolution(undefined, 'ultra_high');
      expect.unreachable('resolveMediaResolution should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(LlmError);
      const e = err as LlmError;
      expect(e.kind).toBe('bad_request');
      expect(e.retryable).toBe(false);
      expect(e.provider).toBe('gemini');
      expect(e.message).toContain('ultra_high');
      expect(e.message).toContain('content block');
    }
  });
});

describe('toPartMediaResolution: maps all four levels to PartMediaResolutionLevel', () => {
  it.each([
    ['low', PartMediaResolutionLevel.MEDIA_RESOLUTION_LOW],
    ['medium', PartMediaResolutionLevel.MEDIA_RESOLUTION_MEDIUM],
    ['high', PartMediaResolutionLevel.MEDIA_RESOLUTION_HIGH],
    ['ultra_high', PartMediaResolutionLevel.MEDIA_RESOLUTION_ULTRA_HIGH],
  ] as const)("maps '%s' to { level: %s }", (level, expected) => {
    expect(toPartMediaResolution(level)).toEqual({ level: expected });
  });
});

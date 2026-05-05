/**
 * Placeholder test for @diabolicallabs/agent-sdk.
 *
 * Full unit test coverage ships in Week 4 alongside the instrumentClient
 * implementation. This file exists to:
 *  1. Satisfy passWithNoTests: false in vitest config (CI fails without a test file)
 *  2. Verify the package's public exports are present at the module level
 *
 * Coverage gate: 80% applies to src/ — stubs have minimal coverage by design.
 * Week 4 will bring coverage up to gate on real implementation.
 */

import { describe, expect, it } from 'vitest';
import { instrumentClient } from './index.js';

describe('@diabolicallabs/agent-sdk', () => {
  it('exports instrumentClient as a function', () => {
    expect(typeof instrumentClient).toBe('function');
  });

  it('instrumentClient throws not-implemented before Week 4', () => {
    // The stub throws — this is expected behaviour documented in sdk.ts
    expect(() => {
      instrumentClient(
        // Minimal shape cast — we only care that the function throws
        {} as Parameters<typeof instrumentClient>[0],
        {} as Parameters<typeof instrumentClient>[1]
      );
    }).toThrow('not yet implemented');
  });
});

/**
 * Manual integration test script for @diabolicallabs/llm-client.
 *
 * Tests all three methods (complete, stream, structured) against real Anthropic
 * and OpenAI APIs. This script is NOT run in CI — it is run manually before
 * raising a PR that changes provider implementations.
 *
 * Prerequisites:
 *   ANTHROPIC_API_KEY — must be set
 *   OPENAI_API_KEY    — must be set
 *
 * Run with:
 *   pnpm tsx scripts/integration-test.ts
 *
 * Exit codes:
 *   0 — all tests passed
 *   1 — one or more tests failed (errors printed to stderr)
 */

import { createClientFromEnv } from '../packages/llm-client/src/index.js';
import { z } from 'zod';

// Colour helpers for terminal output
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';

function pass(label: string, detail: string): void {
  console.log(`${GREEN}✓${RESET} ${BOLD}${label}${RESET} — ${detail}`);
}

function fail(label: string, err: unknown): void {
  console.error(`${RED}✗${RESET} ${BOLD}${label}${RESET}`);
  console.error('  Error:', err instanceof Error ? err.message : String(err));
}

function section(name: string): void {
  console.log(`\n${YELLOW}━━━ ${name} ━━━${RESET}`);
}

// Zod schema for structured() test
const PersonSchema = z.object({
  name: z.string(),
  occupation: z.string(),
  city: z.string(),
});
type Person = z.infer<typeof PersonSchema>;

// Track failures
let failureCount = 0;

async function runTest(label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    fail(label, err);
    failureCount++;
  }
}

async function main(): Promise<void> {
  console.log(`${BOLD}dlabs-toolkit — Integration Test${RESET}`);
  console.log('Testing @diabolicallabs/llm-client against real APIs\n');

  // ───────────────────────────────────────────────────────────────────────────
  // ANTHROPIC
  // ───────────────────────────────────────────────────────────────────────────
  section('Anthropic — claude-3-5-haiku-20241022');

  const anthropic = createClientFromEnv('anthropic', 'claude-3-5-haiku-20241022', {
    maxTokens: 256,
    maxRetries: 2,
  });

  await runTest('anthropic.complete()', async () => {
    const start = Date.now();
    const result = await anthropic.complete([
      { role: 'user', content: 'Reply with exactly: "dlabs-toolkit integration test passed"' },
    ]);
    const latency = Date.now() - start;
    if (!result.content.toLowerCase().includes('dlabs-toolkit')) {
      throw new Error(`Unexpected content: ${result.content.slice(0, 100)}`);
    }
    pass(
      'anthropic.complete()',
      `content=${result.content.slice(0, 60).replace(/\n/g, ' ')} | ` +
      `tokens=${result.usage.inputTokens}in/${result.usage.outputTokens}out | ` +
      `latency=${latency}ms`
    );
  });

  await runTest('anthropic.stream()', async () => {
    const start = Date.now();
    const tokens: string[] = [];
    let finalUsage = undefined;

    for await (const chunk of anthropic.stream([
      { role: 'user', content: 'Count from 1 to 5, one number per line.' },
    ])) {
      if (chunk.usage !== undefined) {
        finalUsage = chunk.usage;
      } else {
        tokens.push(chunk.token);
      }
    }

    const content = tokens.join('');
    if (!content.includes('1') || !content.includes('5')) {
      throw new Error(`Stream content missing expected numbers: ${content.slice(0, 100)}`);
    }
    pass(
      'anthropic.stream()',
      `chunks=${tokens.length} | content=${content.slice(0, 40).replace(/\n/g, ' ')} | ` +
      `tokens=${finalUsage?.inputTokens ?? '?'}in/${finalUsage?.outputTokens ?? '?'}out | ` +
      `latency=${Date.now() - start}ms`
    );
  });

  await runTest('anthropic.structured()', async () => {
    const start = Date.now();
    const result = await anthropic.structured<Person>(
      [{ role: 'user', content: 'Return a JSON object with name, occupation, and city for a fictional person.' }],
      PersonSchema
    );
    if (!result.data.name || !result.data.occupation || !result.data.city) {
      throw new Error(`Incomplete person object: ${JSON.stringify(result.data)}`);
    }
    pass(
      'anthropic.structured()',
      `data=${JSON.stringify(result.data)} | ` +
      `tokens=${result.usage.inputTokens}in/${result.usage.outputTokens}out | ` +
      `latency=${Date.now() - start}ms`
    );
  });

  // ───────────────────────────────────────────────────────────────────────────
  // OPENAI
  // ───────────────────────────────────────────────────────────────────────────
  section('OpenAI — gpt-4o-mini');

  const openai = createClientFromEnv('openai', 'gpt-4o-mini', {
    maxTokens: 256,
    maxRetries: 2,
  });

  await runTest('openai.complete()', async () => {
    const start = Date.now();
    const result = await openai.complete([
      { role: 'user', content: 'Reply with exactly: "dlabs-toolkit integration test passed"' },
    ]);
    const latency = Date.now() - start;
    if (!result.content.toLowerCase().includes('dlabs-toolkit')) {
      throw new Error(`Unexpected content: ${result.content.slice(0, 100)}`);
    }
    pass(
      'openai.complete()',
      `content=${result.content.slice(0, 60).replace(/\n/g, ' ')} | ` +
      `tokens=${result.usage.inputTokens}in/${result.usage.outputTokens}out | ` +
      `latency=${latency}ms`
    );
  });

  await runTest('openai.stream()', async () => {
    const start = Date.now();
    const tokens: string[] = [];
    let finalUsage = undefined;

    for await (const chunk of openai.stream([
      { role: 'user', content: 'Count from 1 to 5, one number per line.' },
    ])) {
      if (chunk.usage !== undefined) {
        finalUsage = chunk.usage;
      } else {
        tokens.push(chunk.token);
      }
    }

    const content = tokens.join('');
    if (!content.includes('1') || !content.includes('5')) {
      throw new Error(`Stream content missing expected numbers: ${content.slice(0, 100)}`);
    }
    pass(
      'openai.stream()',
      `chunks=${tokens.length} | content=${content.slice(0, 40).replace(/\n/g, ' ')} | ` +
      `tokens=${finalUsage?.inputTokens ?? '?'}in/${finalUsage?.outputTokens ?? '?'}out | ` +
      `latency=${Date.now() - start}ms`
    );
  });

  await runTest('openai.structured()', async () => {
    const start = Date.now();
    const result = await openai.structured<Person>(
      [{ role: 'user', content: 'Return a JSON object with name, occupation, and city for a fictional person.' }],
      PersonSchema
    );
    if (!result.data.name || !result.data.occupation || !result.data.city) {
      throw new Error(`Incomplete person object: ${JSON.stringify(result.data)}`);
    }
    pass(
      'openai.structured()',
      `data=${JSON.stringify(result.data)} | ` +
      `tokens=${result.usage.inputTokens}in/${result.usage.outputTokens}out | ` +
      `latency=${Date.now() - start}ms`
    );
  });

  // ───────────────────────────────────────────────────────────────────────────
  // STUB VERIFICATION
  // ───────────────────────────────────────────────────────────────────────────
  section('Stub provider verification');

  await runTest('gemini stub throws not-yet-implemented', async () => {
    // createClientFromEnv for gemini throws if GOOGLE_AI_API_KEY is not set.
    // We create via createClient directly to avoid the env check.
    const { createClient } = await import('../packages/llm-client/src/index.js');
    const gemini = createClient({ provider: 'gemini', model: 'gemini-2.5-flash', apiKey: 'stub' });
    try {
      await gemini.complete([{ role: 'user', content: 'hi' }]);
      throw new Error('Expected stub to throw');
    } catch (err) {
      if (err instanceof Error && err.message.includes('not yet implemented')) {
        pass('gemini stub', 'throws "not yet implemented" as expected');
      } else {
        throw err;
      }
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // RESULTS
  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n' + '─'.repeat(60));
  if (failureCount === 0) {
    console.log(`${GREEN}${BOLD}All integration tests passed.${RESET}`);
    process.exit(0);
  } else {
    console.error(`${RED}${BOLD}${failureCount} integration test(s) failed.${RESET}`);
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error('Unhandled error in integration test:', err);
  process.exit(1);
});

/**
 * Manual integration test script for @diabolicallabs/llm-client.
 *
 * Tests all three methods (complete, stream, structured) against real Anthropic,
 * OpenAI, Gemini, and DeepSeek APIs. This script is NOT run in CI — it is run
 * manually before raising a PR that changes provider implementations.
 *
 * Prerequisites:
 *   ANTHROPIC_API_KEY  — must be set
 *   OPENAI_API_KEY     — must be set
 *   GOOGLE_AI_API_KEY  — required for Gemini tests (skipped if absent)
 *   DEEPSEEK_API_KEY   — required for DeepSeek tests (skipped if absent)
 *
 * Run with:
 *   pnpm tsx scripts/integration-test.ts
 *
 * Exit codes:
 *   0 — all tests passed (or skipped)
 *   1 — one or more tests failed (errors printed to stderr)
 */

import { z } from 'zod';
import { createClientFromEnv } from '../packages/llm-client/src/index.js';
import type { LlmUsage } from '../packages/llm-client/src/types.js';

// Color helpers for terminal output
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[34m';
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';

function pass(label: string, detail: string): void {
  console.log(`${GREEN}✓${RESET} ${BOLD}${label}${RESET} — ${detail}`);
}

function fail(label: string, err: unknown): void {
  console.error(`${RED}✗${RESET} ${BOLD}${label}${RESET}`);
  console.error('  Error:', err instanceof Error ? err.message : String(err));
}

function skip(label: string, reason: string): void {
  console.log(`${BLUE}~${RESET} ${BOLD}${label}${RESET} — ${reason}`);
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

// Track failures and skips
let failureCount = 0;
let skipCount = 0;

async function runTest(label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    fail(label, err);
    failureCount++;
  }
}

function skipSection(label: string, reason: string): void {
  skip(`${label}.complete()`, reason);
  skip(`${label}.stream()`, reason);
  skip(`${label}.structured()`, reason);
  skipCount += 3;
}

async function main(): Promise<void> {
  console.log(`${BOLD}dlabs-toolkit — Integration Test${RESET}`);
  console.log('Testing @diabolicallabs/llm-client against real APIs\n');

  // ───────────────────────────────────────────────────────────────────────────
  // ANTHROPIC
  // ───────────────────────────────────────────────────────────────────────────
  section('Anthropic — claude-haiku-4-5');

  const anthropic = await createClientFromEnv('anthropic', 'claude-haiku-4-5', {
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
    let finalUsage: LlmUsage | undefined;

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
      [
        {
          role: 'user',
          content: 'Return a JSON object with name, occupation, and city for a fictional person.',
        },
      ],
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

  const openai = await createClientFromEnv('openai', 'gpt-4o-mini', {
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
    let finalUsage: LlmUsage | undefined;

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
      [
        {
          role: 'user',
          content: 'Return a JSON object with name, occupation, and city for a fictional person.',
        },
      ],
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
  // GEMINI (skipped if GOOGLE_AI_API_KEY is absent)
  // ───────────────────────────────────────────────────────────────────────────
  section('Gemini — gemini-2.5-flash');

  if (!process.env['GOOGLE_AI_API_KEY']) {
    skipSection('gemini', 'GOOGLE_AI_API_KEY not set');
  } else {
    const gemini = await createClientFromEnv('gemini', 'gemini-2.5-flash', {
      maxTokens: 256,
      maxRetries: 2,
    });

    await runTest('gemini.complete()', async () => {
      const start = Date.now();
      const result = await gemini.complete([
        { role: 'user', content: 'Reply with exactly: "dlabs-toolkit integration test passed"' },
      ]);
      const latency = Date.now() - start;
      if (!result.content.toLowerCase().includes('dlabs-toolkit')) {
        throw new Error(`Unexpected content: ${result.content.slice(0, 100)}`);
      }
      pass(
        'gemini.complete()',
        `content=${result.content.slice(0, 60).replace(/\n/g, ' ')} | ` +
          `tokens=${result.usage.inputTokens}in/${result.usage.outputTokens}out | ` +
          `latency=${latency}ms`
      );
    });

    await runTest('gemini.stream()', async () => {
      const start = Date.now();
      const tokens: string[] = [];
      let finalUsage: LlmUsage | undefined;

      for await (const chunk of gemini.stream([
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
        'gemini.stream()',
        `chunks=${tokens.length} | content=${content.slice(0, 40).replace(/\n/g, ' ')} | ` +
          `tokens=${finalUsage?.inputTokens ?? '?'}in/${finalUsage?.outputTokens ?? '?'}out | ` +
          `latency=${Date.now() - start}ms`
      );
    });

    await runTest('gemini.structured()', async () => {
      const start = Date.now();
      const result = await gemini.structured<Person>(
        [
          {
            role: 'user',
            content: 'Return a JSON object with name, occupation, and city for a fictional person.',
          },
        ],
        PersonSchema
      );
      if (!result.data.name || !result.data.occupation || !result.data.city) {
        throw new Error(`Incomplete person object: ${JSON.stringify(result.data)}`);
      }
      pass(
        'gemini.structured()',
        `data=${JSON.stringify(result.data)} | ` +
          `tokens=${result.usage.inputTokens}in/${result.usage.outputTokens}out | ` +
          `latency=${Date.now() - start}ms`
      );
    });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // DEEPSEEK (skipped if DEEPSEEK_API_KEY is absent)
  // ───────────────────────────────────────────────────────────────────────────
  section('DeepSeek — deepseek-chat');

  if (!process.env['DEEPSEEK_API_KEY']) {
    skipSection('deepseek', 'DEEPSEEK_API_KEY not set');
  } else {
    const deepseek = await createClientFromEnv('deepseek', 'deepseek-chat', {
      maxTokens: 256,
      maxRetries: 2,
    });

    await runTest('deepseek.complete()', async () => {
      const start = Date.now();
      const result = await deepseek.complete([
        { role: 'user', content: 'Reply with exactly: "dlabs-toolkit integration test passed"' },
      ]);
      const latency = Date.now() - start;
      if (!result.content.toLowerCase().includes('dlabs-toolkit')) {
        throw new Error(`Unexpected content: ${result.content.slice(0, 100)}`);
      }
      pass(
        'deepseek.complete()',
        `content=${result.content.slice(0, 60).replace(/\n/g, ' ')} | ` +
          `tokens=${result.usage.inputTokens}in/${result.usage.outputTokens}out | ` +
          `latency=${latency}ms`
      );
    });

    await runTest('deepseek.stream()', async () => {
      const start = Date.now();
      const tokens: string[] = [];
      let finalUsage: LlmUsage | undefined;

      for await (const chunk of deepseek.stream([
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
        'deepseek.stream()',
        `chunks=${tokens.length} | content=${content.slice(0, 40).replace(/\n/g, ' ')} | ` +
          `tokens=${finalUsage?.inputTokens ?? '?'}in/${finalUsage?.outputTokens ?? '?'}out | ` +
          `latency=${Date.now() - start}ms`
      );
    });

    await runTest('deepseek.structured()', async () => {
      const start = Date.now();
      const result = await deepseek.structured<Person>(
        [
          {
            role: 'user',
            content: 'Return a JSON object with name, occupation, and city for a fictional person.',
          },
        ],
        PersonSchema
      );
      if (!result.data.name || !result.data.occupation || !result.data.city) {
        throw new Error(`Incomplete person object: ${JSON.stringify(result.data)}`);
      }
      pass(
        'deepseek.structured()',
        `data=${JSON.stringify(result.data)} | ` +
          `tokens=${result.usage.inputTokens}in/${result.usage.outputTokens}out | ` +
          `latency=${Date.now() - start}ms`
      );
    });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // RESULTS
  // ───────────────────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(60)}`);
  if (skipCount > 0) {
    console.log(`${BLUE}${skipCount} test(s) skipped (API keys not set).${RESET}`);
  }
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

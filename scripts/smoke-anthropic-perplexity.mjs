import { createClient } from '../packages/llm-client/dist/index.js';

const PROMPT = 'What are the three most notable features introduced in TypeScript 5.7, and when was it released? Be concise.';

async function run(label, client) {
  console.log(`\n===== ${label} =====`);
  const t0 = Date.now();
  try {
    const res = await client.complete([{ role: 'user', content: PROMPT }]);
    const ms = Date.now() - t0;
    console.log(`model: ${res.model}`);
    console.log(`latency: ${ms}ms`);
    console.log(`usage: ${JSON.stringify(res.usage)}`);
    if (res.citations?.length) {
      console.log(`citations (${res.citations.length}):`);
      for (const c of res.citations) console.log(`  - ${c.url}`);
    }
    console.log(`--- content ---\n${res.content}\n--- end ---`);
  } catch (err) {
    console.error(`ERROR (${label}):`, err?.message ?? err);
    if (err?.cause) console.error('cause:', err.cause);
  }
}

const anthropic = createClient({
  provider: 'anthropic',
  apiKey: process.env.ANTHROPIC_API_KEY,
  model: 'claude-sonnet-4-6',
});

const perplexity = createClient({
  provider: 'perplexity',
  apiKey: process.env.PERPLEXITY_API_KEY,
  model: 'sonar-pro',
});

await run('Anthropic / claude-sonnet-4-6', anthropic);
await run('Perplexity / sonar-pro', perplexity);

// ─── v0.3.0 cancellation / timeout / stall smoke tests ───────────────────────

console.log('\n\n========== v0.3.0 ABORT / TIMEOUT / STALL SMOKE ==========\n');

// Case (a): per-call timeoutMs: 1 → expect kind:'timeout'
// Uses a no-retry client so the timeout fires once and returns immediately.
const anthropicNoRetry = createClient({
  provider: 'anthropic',
  apiKey: process.env.ANTHROPIC_API_KEY,
  model: 'claude-sonnet-4-6',
  maxRetries: 0, // prevent retry loop on timeout
});
console.log('--- Case (a): timeoutMs:1 per-call override (expect kind:timeout) ---');
try {
  await anthropicNoRetry.complete(
    [{ role: 'user', content: 'Hello' }],
    { timeoutMs: 1 }  // 1ms — fires before the SDK even makes a network round-trip
  );
  console.log('UNEXPECTED: call succeeded (should have timed out)');
} catch (err) {
  const kind = err?.kind;
  const retryable = err?.retryable;
  if (kind === 'timeout') {
    console.log(`PASS  kind:${kind}  retryable:${retryable}`);
  } else {
    console.error(`FAIL  expected kind:timeout, got kind:${kind}  message:${err?.message}`);
  }
}

// Case (b): caller AbortController aborted before call → expect kind:'cancelled'
console.log('\n--- Case (b): pre-aborted AbortSignal (expect kind:cancelled) ---');
try {
  const ac = new AbortController();
  ac.abort('manual cancel');
  await anthropic.complete(
    [{ role: 'user', content: 'Hello' }],
    { signal: ac.signal }
  );
  console.log('UNEXPECTED: call succeeded (should have been cancelled)');
} catch (err) {
  const kind = err?.kind;
  const retryable = err?.retryable;
  if (kind === 'cancelled') {
    console.log(`PASS  kind:${kind}  retryable:${retryable}`);
  } else {
    console.error(`FAIL  expected kind:cancelled, got kind:${kind}  message:${err?.message}`);
  }
}

// Case (c): Perplexity stream() with streamStallTimeoutMs:50 → kind:'stream_stall' if model
// pauses > 50ms, else completes cleanly. Either outcome is acceptable; we report what happened.
console.log('\n--- Case (c): Perplexity stream() with streamStallTimeoutMs:50 ---');
try {
  const chunks = [];
  for await (const chunk of perplexity.stream(
    [{ role: 'user', content: 'Say the word "hello".' }],
    { streamStallTimeoutMs: 50 }  // very short — may or may not fire depending on latency
  )) {
    if (chunk.token) chunks.push(chunk.token);
  }
  console.log(`PASS (completed cleanly — no stall within 50ms)  chunks:${chunks.length}  content:"${chunks.join('').slice(0, 60)}"`);
} catch (err) {
  const kind = err?.kind;
  if (kind === 'stream_stall') {
    console.log(`PASS (stall detected as expected with 50ms window)  kind:${kind}`);
  } else {
    console.error(`FAIL  unexpected error: kind:${kind}  message:${err?.message}`);
  }
}

// ─── v0.4.0 structured output smoke tests ────────────────────────────────────

import { z } from '../packages/llm-client/node_modules/zod/v4/index.js';

const STRUCTURED_SCHEMA = z.object({
  topic: z.string(),
  bullets: z.array(z.string()),
});

console.log('\n\n========== v0.4.0 STRUCTURED OUTPUT SMOKE ==========\n');

// Case (d): Anthropic strict tool-use structured call
console.log('--- Case (d): Anthropic strict tool-use structured (Zod 4 schema) ---');
try {
  const result = await anthropic.structured(
    [{ role: 'user', content: 'Give me a JSON object with a "topic" field (string) describing TypeScript 5.7, and a "bullets" field (array of strings) with 2 key features.' }],
    STRUCTURED_SCHEMA
  );
  const hasTopic = typeof result.data.topic === 'string' && result.data.topic.length > 0;
  const hasBullets = Array.isArray(result.data.bullets) && result.data.bullets.length > 0;
  const hasModel = typeof result.model === 'string' && result.model.length > 0;
  const hasId = typeof result.id === 'string' && result.id.length > 0;
  if (hasTopic && hasBullets && hasModel && hasId) {
    console.log(`PASS  topic:"${result.data.topic.slice(0, 40)}"  bullets:${result.data.bullets.length}  model:${result.model}  id:${result.id.slice(0, 20)}...`);
  } else {
    console.error(`FAIL  data shape unexpected: ${JSON.stringify(result.data)}`);
    console.error(`      model:"${result.model}"  id:"${result.id}"`);
  }
} catch (err) {
  console.error(`FAIL  ${err?.kind ?? err?.message ?? err}`);
  if (err?.cause) console.error('cause:', err.cause?.message ?? err.cause);
}

// Case (e): Perplexity prompt-fallback structured call (no native schema mode)
console.log('\n--- Case (e): Perplexity structured prompt-fallback (Zod 4 schema) ---');
try {
  const result = await perplexity.structured(
    [{ role: 'user', content: 'Give me a JSON object with a "topic" field (string) describing Perplexity AI, and a "bullets" field (array of strings) with 2 key features.' }],
    STRUCTURED_SCHEMA
  );
  const hasTopic = typeof result.data.topic === 'string' && result.data.topic.length > 0;
  const hasBullets = Array.isArray(result.data.bullets) && result.data.bullets.length > 0;
  const hasModel = typeof result.model === 'string' && result.model.length > 0;
  if (hasTopic && hasBullets && hasModel) {
    console.log(`PASS  topic:"${result.data.topic.slice(0, 40)}"  bullets:${result.data.bullets.length}  model:${result.model}`);
    if (result.citations?.length) {
      console.log(`      citations:${result.citations.length}  first:${result.citations[0]?.url}`);
    } else {
      console.log('      citations: none (acceptable for structured call)');
    }
  } else {
    console.error(`FAIL  data shape unexpected: ${JSON.stringify(result.data)}`);
  }
} catch (err) {
  console.error(`FAIL  ${err?.kind ?? err?.message ?? err}`);
  if (err?.cause) console.error('cause:', err.cause?.message ?? err.cause);
}

console.log('\n========== smoke complete ==========');

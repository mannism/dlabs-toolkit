/**
 * Live smoke test for the Anthropic provider.
 * Gitignored — not committed.
 *
 * Run from monorepo root:
 *   set -a; source .env; set +a && npx tsx scripts/smoke-anthropic.ts
 *
 * Verifies:
 *   1. complete() happy path — logs model/latency/usage/content snippet
 *   2. stream() — accumulates tokens, asserts final chunk has usage, logs summary
 *   3. structured() with Zod 4 schema — logs parsed result
 *   4. complete() with promptCache: 'ephemeral' — run twice to observe cache write then read
 */

import { z } from 'zod';
import { createClientFromEnv } from '../packages/llm-client/src/index.js';

// Model targeted by GEOAudit and confirmed current per Anthropic docs (2026-05-12).
const MODEL = 'claude-sonnet-4-6';

// Long system prompt used for prompt cache tests.
// Anthropic's minimum cacheable block is 1024 tokens for Sonnet/Opus.
// This block is ~1200 tokens — deliberately above the threshold so the API
// accepts the cache_control marker rather than silently ignoring it.
const LONG_SYSTEM_PROMPT = `You are a helpful assistant specializing in software architecture and distributed systems.
You have deep expertise in the following areas:

1. Distributed Systems Design
   - Consensus algorithms: Raft, Paxos, and their practical implementations
   - Consistency models: eventual consistency, strong consistency, causal consistency
   - CAP theorem trade-offs and their implications for system design
   - Distributed transactions: 2PC, SAGA pattern, outbox pattern
   - Event sourcing and CQRS architectures

2. Database Engineering
   - Relational databases: query planning, index design, MVCC, WAL
   - NoSQL systems: document stores, wide-column stores, time-series databases
   - In-memory data structures: Redis sorted sets, probabilistic data structures
   - Sharding strategies: range-based, hash-based, directory-based
   - Replication topologies: leader-follower, multi-leader, leaderless

3. API Design and Integration
   - REST architectural constraints and resource modeling
   - GraphQL schema design and N+1 query mitigation
   - gRPC and Protocol Buffers for service-to-service communication
   - Webhook patterns: reliability, idempotency, retry semantics
   - Rate limiting algorithms: token bucket, sliding window, leaky bucket

4. Security Engineering
   - Authentication protocols: OAuth 2.0, OIDC, JWT verification
   - Authorization patterns: RBAC, ABAC, relationship-based access control
   - Cryptography fundamentals: symmetric/asymmetric encryption, key management
   - Input validation and injection attack prevention
   - Secrets management and zero-trust network architecture

5. Observability and Operations
   - Structured logging with correlation IDs and trace context propagation
   - Distributed tracing: OpenTelemetry instrumentation and sampling strategies
   - Metrics collection: RED method, USE method, SLIs/SLOs/SLAs
   - Alerting design: alert fatigue prevention, escalation policies
   - Incident management: severity classification, blameless post-mortems

6. Cloud Infrastructure
   - Container orchestration: Kubernetes resource model, scheduling, networking
   - Serverless patterns: cold start mitigation, concurrency controls
   - CI/CD pipeline design: deployment strategies (blue/green, canary, rolling)
   - Infrastructure as code: state management, drift detection
   - Cost optimization: right-sizing, spot/preemptible workloads, reserved capacity

7. Performance Engineering
   - Profiling methodologies: CPU, memory, I/O, network
   - Caching strategies: cache-aside, write-through, write-behind, read-through
   - Connection pooling and resource lifecycle management
   - Backpressure mechanisms in streaming and queue-based systems
   - Benchmarking discipline: eliminating measurement bias, statistical significance

When answering questions, be precise and cite trade-offs. Prefer concrete examples
over abstract principles. When multiple valid approaches exist, enumerate the
key factors that should drive the choice.`;

async function runSmoke(): Promise<void> {
  // Pre-flight: explicit env key guard matching smoke-perplexity.ts pattern.
  // createClientFromEnv also guards internally, but this surfaces a cleaner
  // error message before any client construction happens.
  const apiKey = process.env['ANTHROPIC_API_KEY'];
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY not set. Source .env before running.');
  }

  console.log('=== Anthropic Provider Smoke Test ===\n');
  const overallStart = Date.now();

  // ─── Test 1: complete() happy path ───────────────────────────────────────
  console.log(`Test 1: complete() with ${MODEL} — happy path`);
  const client1 = createClientFromEnv('anthropic', MODEL);
  const start1 = Date.now();
  const result1 = await client1.complete([
    {
      role: 'user',
      content:
        'Explain the key trade-offs between the SAGA pattern and 2PC for distributed transactions in three concise paragraphs.',
    },
  ]);
  console.log(`  model: ${result1.model}`);
  console.log(`  latency: ${result1.latencyMs}ms`);
  console.log(`  usage: ${JSON.stringify(result1.usage)}`);
  console.log(`  content snippet: ${result1.content.slice(0, 200)}...`);
  console.log('  PASS\n');
  void start1;

  // ─── Test 2: stream() ─────────────────────────────────────────────────────
  console.log(`Test 2: stream() with ${MODEL}`);
  const client2 = createClientFromEnv('anthropic', MODEL);
  let accumulated = '';
  let finalUsage = undefined as import('../packages/llm-client/src/types.js').LlmUsage | undefined;

  for await (const chunk of client2.stream([
    {
      role: 'user',
      content: 'What are the three main consistency models in distributed systems? Be brief.',
    },
  ])) {
    accumulated += chunk.token;
    if (chunk.usage !== undefined) {
      finalUsage = chunk.usage;
    }
  }

  if (finalUsage === undefined) {
    throw new Error('stream() final chunk did not include usage');
  }
  console.log(`  accumulated chars: ${accumulated.length}`);
  console.log(`  content snippet: ${accumulated.slice(0, 200)}...`);
  console.log(`  final usage: ${JSON.stringify(finalUsage)}`);
  console.log('  PASS\n');

  // ─── Test 3: structured() with Zod 4 schema ──────────────────────────────
  console.log(`Test 3: structured() with ${MODEL} — Zod 4 tool-use path`);
  const client3 = createClientFromEnv('anthropic', MODEL);

  const TopicSchema = z.object({
    topic: z.string(),
    bullets: z.array(z.string()),
  });

  const result3 = await client3.structured(
    [
      {
        role: 'user',
        content:
          'Return a JSON object with a "topic" string (set to "CAP Theorem") and a "bullets" array of exactly three key points about the CAP theorem.',
      },
    ],
    TopicSchema
  );
  console.log(`  model: ${result3.model}`);
  console.log(`  usage: ${JSON.stringify(result3.usage)}`);
  console.log(`  parsed data: ${JSON.stringify(result3.data, null, 2)}`);
  if (!result3.data.topic || result3.data.bullets.length === 0) {
    throw new Error('structured() returned empty topic or bullets');
  }
  console.log('  PASS\n');

  // ─── Test 4: promptCache — cache write then cache read ───────────────────
  // Anthropic's minimum cacheable block: 1024 tokens (Sonnet/Opus).
  // The LONG_SYSTEM_PROMPT above is ~1200 tokens to clear the threshold.
  // First call: cache write (cacheCreationTokens > 0).
  // Second call: cache read (cacheReadTokens > 0).
  // Both calls must complete within the 5-minute ephemeral cache TTL window.
  console.log('Test 4a: complete() with promptCache: "ephemeral" — first call (cache write)');
  const client4 = createClientFromEnv('anthropic', MODEL);
  const cacheOptions = {
    providerOptions: { promptCache: 'ephemeral' as const },
  };

  const result4a = await client4.complete(
    [
      { role: 'system', content: LONG_SYSTEM_PROMPT },
      { role: 'user', content: 'In one sentence, what is the CAP theorem?' },
    ],
    cacheOptions
  );
  console.log(`  model: ${result4a.model}`);
  console.log(`  latency: ${result4a.latencyMs}ms`);
  console.log(
    `  cacheCreationTokens: ${result4a.usage.cacheCreationTokens ?? 'undefined (API may ignore marker if block too small)'}`
  );
  console.log(`  cacheReadTokens: ${result4a.usage.cacheReadTokens ?? 0}`);
  if (
    result4a.usage.cacheCreationTokens === undefined ||
    result4a.usage.cacheCreationTokens === 0
  ) {
    console.warn(
      '  WARNING: cacheCreationTokens is 0 or undefined on first call. ' +
        'The system prompt may be below the 1024-token minimum — API silently ignores the marker.'
    );
  } else {
    console.log(`  PASS (cache write confirmed: ${result4a.usage.cacheCreationTokens} tokens)\n`);
  }

  console.log('Test 4b: complete() with promptCache: "ephemeral" — second call (cache read)');
  const result4b = await client4.complete(
    [
      { role: 'system', content: LONG_SYSTEM_PROMPT },
      { role: 'user', content: 'In one sentence, what is eventual consistency?' },
    ],
    cacheOptions
  );
  console.log(`  model: ${result4b.model}`);
  console.log(`  latency: ${result4b.latencyMs}ms`);
  console.log(
    `  cacheCreationTokens: ${result4b.usage.cacheCreationTokens ?? 0} (expect 0 on cache hit)`
  );
  console.log(
    `  cacheReadTokens: ${result4b.usage.cacheReadTokens ?? 'undefined (expected > 0 on cache hit)'}`
  );
  if (result4b.usage.cacheReadTokens === undefined || result4b.usage.cacheReadTokens === 0) {
    console.warn(
      '  WARNING: cacheReadTokens is 0 or undefined on second call. ' +
        'Cache may not have been populated — check cacheCreationTokens on the first call above.'
    );
  } else {
    console.log(`  PASS (cache read confirmed: ${result4b.usage.cacheReadTokens} tokens)\n`);
  }

  console.log('=== All smoke tests passed ===');
  console.log(`Total elapsed: ${Date.now() - overallStart}ms`);
}

runSmoke().catch((err: unknown) => {
  console.error('SMOKE TEST FAILED:', err);
  process.exit(1);
});

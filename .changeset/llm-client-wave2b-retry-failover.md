---
"@diabolicallabs/llm-client": minor
---

feat(llm-client): configurable retry strategy and provider failover (Wave 2b)

**Configurable retry (2.5):** `LlmClientConfig.retry` accepts a `RetryConfig` object
with `maxAttempts`, `strategy` (`'exponential' | 'linear' | 'fixed' | 'decorrelated'`),
`baseDelayMs`, `maxDelayMs`, `respectRetryAfter`, and `retryOn`. When omitted, legacy
exponential + full-jitter behavior is preserved unchanged. The decorrelated strategy
implements AWS Marc Brooker jitter to break correlation between concurrent callers.
`respectRetryAfter` parses the `Retry-After` integer-seconds header on 429 responses.

**Provider failover (2.4):** `LlmClientConfig.model` now accepts `string | string[]`.
When an array is passed, the first element is the primary model. On errors whose kind
appears in `fallbackOn` (default: `['not_found']`), retries are exhausted on the primary
before falling through to the next model. `LlmResponse.requestedModel` is populated with
the original primary model when failover fires. `LlmToolResponse.requestedModel` follows
the same convention. Streaming always uses the primary model — mid-stream failover is unsafe.

New exports: `RetryConfig`, `RetryStrategy`.

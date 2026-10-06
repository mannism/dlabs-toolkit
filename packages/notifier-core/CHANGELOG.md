# @diabolicallabs/notifier-core

## 1.1.0

### Minor Changes

- 136601a: Raise `engines.node` to `>=22.12.0`; Node 20 (end of life April 2026) is no longer supported.

## 1.0.0

### Major Changes

- 2bdcf96: First release; Wave 6 notifier family v1.0.0 stable interface.

  Ships `Notifier` interface, `NotifyMessage`/`NotifyResult` types, `Logger` interface (consolidates the copy-pasted interface from 5 prior packages), `PlatformError` taxonomy (`PlatformAuthError`, `PlatformNotFoundError`, `PlatformRateLimitError`, `PlatformValidationError`, `PlatformUnavailableError`), and `retryWithJitter` full-jitter exponential backoff helper. Zero runtime dependencies.

---
"@diabolicallabs/notifier-core": major
---

First release; Wave 6 notifier family v1.0.0 stable interface.

Ships `Notifier` interface, `NotifyMessage`/`NotifyResult` types, `Logger` interface (consolidates the copy-pasted interface from 5 prior packages), `PlatformError` taxonomy (`PlatformAuthError`, `PlatformNotFoundError`, `PlatformRateLimitError`, `PlatformValidationError`, `PlatformUnavailableError`), and `retryWithJitter` full-jitter exponential backoff helper. Zero runtime dependencies.

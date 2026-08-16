# @diabolicallabs/slack

## 1.0.1

### Patch Changes

- eb719f8: Bump `@slack/web-api` `^7.17.0` → `^8.0.0` and `@slack/types` `^2.21.0` → `^3.0.0` (supersedes Dependabot PRs #211/#212).

  Every breaking change in both majors' official changelogs was audited against `packages/slack/src` — none apply:

  - **`@slack/web-api` v8.0.0** (axios → Fetch, new `Error` subclass hierarchy replacing plain `CodedError` objects, removed `errorWithCode`/`platformErrorFromResult`/etc. factories, removed `files.upload`/`rtm.start`/`workflows.step*`, Node 18 dropped): `client.ts`'s `mapSdkError`/`extractRetryAfterMs` duck-type on `data`/`code`/`statusCode`/`retryAfter` fields rather than `instanceof` checks, and those field groupings are byte-for-byte identical between `WebAPIPlatformError`/`WebAPIHTTPError`/`WebAPIRateLimitedError` in v7 and v8 (confirmed by diffing both versions' `errors.ts` source directly, not just the changelog prose). `WebClient` is only ever constructed with `{ timeout }`, so the axios-only options (`agent`, `tls`, `requestInterceptor`, `adapter`, `RequestConfig`) were never in play. The removed methods are unused. The repo already requires Node ≥20.
  - **`@slack/types` v3.0.0**: Node 18 → 20 floor only; the four re-exported types (`Block`, `KnownBlock`, `RichTextBlock`, `SectionBlock`) are unchanged in shape between 2.21.1 and 3.0.0 (confirmed against the package's own CHANGELOG — the 2.x → 3.0.0 span only adds new block types, e.g. Card/Carousel/Alert/thinking-steps, none of which this package touches).

  **Semver reasoning — patch, not minor/major:** zero changes to this package's own exported functions, types, or runtime behavior; `mapSdkError` output is identical for every test case pre- and post-bump (58/58 tests green, no test changes needed); the package's `engines.node: ">=20"` already matched what both new majors require, so no consumer-visible constraint tightened. `@slack/web-api`/`@slack/types` are plain `dependencies` here (not `peerDependencies`), so downstream repos never resolve them directly — only the re-exported `Block`/`KnownBlock`/etc. type shapes matter to consumers, and those are structurally unchanged.

  **Downstream impact:** grepped `labs`, `GEOAudit`, `FitCheckerApp`, `brand-compliance-saas`, `agent-spend-dashboard`, `fleet-console` for `@diabolicallabs/slack` in `package.json` — no current consumers. Nothing to coordinate.

  **Separate finding (not fixed here, out of scope for this migration):** `mapSdkError`'s single `if ('data' in err)` branch only matches `WebAPIPlatformError`-shaped errors. A real `WebAPIRateLimitedError` (429) has `retryAfter`+`code` but no `data` field, and a real `WebAPIHTTPError` (5xx) has `statusCode`+`code` but no `data` field either — both would fall through to the generic `SlackError` fallback branch instead of `SlackRateLimitError`/`SlackUnavailableError`. This is identical in v7 and v8 (verified by diffing both versions' `errors.ts`), so it is not a breaking change introduced by this bump — it's a pre-existing test-mock artifact (`client.test.ts`'s `makeSlackApiError` helper always attaches `data` alongside `code`/`statusCode`/`retryAfter` together, which doesn't match how the real SDK throws). Flagging for a follow-up brief, not fixing here per the out-of-scope discipline.

  ***

  **Follow-up fix (same PR, same patch bump):** `mapSdkError` now branches on real `instanceof` checks against `WebAPIPlatformError` / `WebAPIHTTPError` / `WebAPIRateLimitedError` (all genuine runtime classes as of v8, confirmed via `errors.d.ts`), not just duck-typing. The `'data' in err` check is retained alongside `instanceof WebAPIPlatformError` as a safety-net for mocks/future SDK shapes — existing classification behavior for that branch is unchanged. Two new branches close the gap identified above:

  - `WebAPIHTTPError` (raw HTTP-layer failure, no `.data`) now correctly classifies by `statusCode`: 5xx → `SlackUnavailableError`, 401/403 → `SlackAuthError`, 429 → `SlackRateLimitError`, else generic `SlackError`. This is reachable in normal operation (any raw HTTP failure, not just parsed Slack API error bodies).
  - `WebAPIRateLimitedError` (dedicated 429 exception) now maps directly to `SlackRateLimitError`, extracting `retryAfter` from the typed field on the instance. Currently dormant — only thrown when `WebClient` is constructed with `rejectRateLimitedCalls: true`, which this wrapper does not set — but fixed correctly since it was silently returning `isRetryable() === true` for a rate-limit error (contradicting the code's own stated intent), which would have been a hard-to-debug regression if that flag is ever enabled.

  No public API or signature change — `mapSdkError`/`extractRetryAfterMs` keep the same exported signatures; only internal classification logic changed. 9 new tests added (67/67 green): real `WebAPIPlatformError` regression cases, `WebAPIHTTPError` × 4 status codes, `WebAPIRateLimitedError` × 2 (with/without retryAfter), plus `extractRetryAfterMs` against a real instance.

## 1.0.0

### Major Changes

- 2bdcf96: First release; Wave 6 notifier family v1.0.0 stable interface.

  Ships `createSlackNotifier` + `createSlackNotifierFromEnv` factory functions, `SlackNotifier` interface (extends portable `Notifier`), `postMessage` (bot-token path via `@slack/web-api`) + `postWebhook` (incoming webhook via `fetch`), full named error taxonomy (`SlackError`, `SlackAuthError`, `SlackChannelNotFoundError`, `SlackRateLimitError`, `SlackValidationError`, `SlackUnavailableError`), retry with full-jitter exponential backoff, optional `@diabolicallabs/rate-limiter` peer-dep for proactive tier-1 gating, Block Kit type re-exports, and pluggable logger.

### Patch Changes

- Updated dependencies [2bdcf96]
  - @diabolicallabs/notifier-core@1.0.0

/**
 * Response ID helpers for @diabolicallabs/llm-client (v1.4.0+).
 *
 * Providers that do not issue native response IDs (currently Gemini) get
 * toolkit-synthesized UUID v7-style IDs for trace correlation.
 *
 * Format: 8-4-4-4-12 hex — first 12 hex chars are time-derived (ms precision),
 * remaining chars are random. Time-sortable: IDs issued at the same millisecond
 * will have the same prefix. Not cryptographically secure — for tracing only.
 *
 * Why v7-style over crypto.randomUUID() (v4):
 *   - Node >=20 engines guarantee randomUUID() availability but it produces v4
 *     (fully random) UUIDs. Time-sortable v7-style IDs allow correlation by
 *     timestamp in trace systems without a separate timestamp field.
 *   - No uuid package dep needed — the time-prefix implementation is trivial.
 */

/**
 * Synthesize a UUID v7-style ID for providers that do not issue native response IDs.
 *
 * Time-derived prefix makes IDs sortable by issue time to the millisecond.
 * Not cryptographically secure — for tracing/correlation only.
 */
export function synthesizeId(): string {
  const now = Date.now();
  const timeHex = now.toString(16).padStart(12, '0');
  const rand = (): string =>
    Math.floor(Math.random() * 0x10000)
      .toString(16)
      .padStart(4, '0');
  // UUID v7-style: time-high | time-mid | version+random | clock-seq | node
  return `${timeHex.slice(0, 8)}-${timeHex.slice(8, 12)}-7${rand().slice(1)}-${rand()}-${rand()}${rand()}${rand()}`;
}

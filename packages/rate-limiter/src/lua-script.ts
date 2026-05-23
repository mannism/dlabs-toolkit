/**
 * Lua script for the sliding-window-log rate limiter.
 *
 * Executes atomically on Redis — the entire script runs in a single thread
 * with no interleaving from other clients (Lua EVAL guarantee).
 *
 * Why Lua and not MULTI/EXEC:
 *   MULTI/EXEC queues commands but OTHER clients can interleave BETWEEN the
 *   queuing phase and EXEC. Under concurrent load, two clients can both read
 *   the same ZCARD count (both below limit), both issue ZADD, and both succeed —
 *   exceeding the limit. Lua EVAL is atomic: no other command executes while
 *   the script runs.
 *
 * Algorithm (canonical sequence — confirmed by Redis.io + Tom research §3):
 *   1. Get Redis server time (single authoritative clock — eliminates app-clock drift)
 *   2. ZREMRANGEBYSCORE — evict expired entries (older than window)
 *   3. ZCARD — count requests currently in the window (BEFORE this request)
 *   4. If count < maxRequests: ZADD (admit request) + EXPIRE (memory safety)
 *   5. Return structured result
 *
 * KEYS[1]    = full Redis key (keyPrefix + caller key)
 * ARGV[1]    = windowMs (window size in milliseconds, as string)
 * ARGV[2]    = maxRequests (integer, as string)
 * ARGV[3]    = memberId (UUID v4 — unique per request; allows same-ms entries)
 *
 * Return value: table with 3 fields
 *   [1] = allowed (1 = allowed, 0 = rejected)
 *   [2] = remaining (requests remaining after this one; 0 when rejected)
 *   [3] = resetMs (ms until oldest entry expires from window; 0 when window empty)
 */

export const SLIDING_WINDOW_LUA = `
local key = KEYS[1]
local window_ms = tonumber(ARGV[1])
local max_requests = tonumber(ARGV[2])
local member_id = ARGV[3]

-- 1. Get server-side timestamp (avoids app-clock drift across distributed nodes).
--    TIME returns {seconds, microseconds}.
local time_result = redis.call('TIME')
local now_ms = tonumber(time_result[1]) * 1000 + math.floor(tonumber(time_result[2]) / 1000)

-- 2. Evict entries that have fallen outside the sliding window.
local window_start = now_ms - window_ms
redis.call('ZREMRANGEBYSCORE', key, 0, window_start)

-- 3. Count requests currently in the window BEFORE adding this one.
--    This is the canonical pre-admission count. Decision based on window state
--    without this request — allows exactly maxRequests per window.
local count = redis.call('ZCARD', key)

-- 4. Decide: admit or reject.
if count < max_requests then
  -- Admit: record this request with a unique member so same-ms entries coexist.
  redis.call('ZADD', key, now_ms, member_id)
  -- Set EXPIRE on every check to ensure idle keys are cleaned up automatically.
  -- Formula: ceil(windowMs / 1000) + 1 second buffer for race safety.
  local expire_secs = math.ceil(window_ms / 1000) + 1
  redis.call('EXPIRE', key, expire_secs)

  local remaining = max_requests - count - 1

  -- Compute resetMs: ms until the oldest entry (now including this request) expires.
  -- ZRANGEBYSCORE with LIMIT 0 1 returns the oldest member's score.
  local oldest = redis.call('ZRANGEBYSCORE', key, '-inf', '+inf', 'WITHSCORES', 'LIMIT', 0, 1)
  local reset_ms = 0
  if oldest and #oldest >= 2 then
    local oldest_score = tonumber(oldest[2])
    reset_ms = math.max(0, (oldest_score + window_ms) - now_ms)
  end

  return {1, remaining, reset_ms}
else
  -- Reject: compute resetMs from the oldest entry.
  local oldest = redis.call('ZRANGEBYSCORE', key, '-inf', '+inf', 'WITHSCORES', 'LIMIT', 0, 1)
  local reset_ms = 0
  if oldest and #oldest >= 2 then
    local oldest_score = tonumber(oldest[2])
    reset_ms = math.max(0, (oldest_score + window_ms) - now_ms)
  end

  return {0, 0, reset_ms}
end
`;

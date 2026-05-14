---
"@diabolicallabs/llm-client": minor
---

feat: pricing.remoteUrl config wires fetchRemoteTable into createClient. Opt-in — bundled DEFAULT_PRICING_TABLE remains the floor. createClient is now async (awaits remote fetch on init when remoteUrl set). Logs structured pricing_source event on createClient init. Peer dep range bumped to @diabolicallabs/llm-pricing@^0.2.0.

---
"@diabolicallabs/llm-pricing": major
---

Graduate to 1.0.0. No API or behavioral changes — `computeCost`, `resolveModelPricing`, `fetchRemoteTable`, `DEFAULT_PRICING_TABLE`, and the `LlmCost` / `PricingTable` / `Provider` type exports are all stable since 0.3.0. This release shifts semver discipline from pre-1.0 (where Changesets treats every minor as breaking for peer-dep consumers) to stable 1.x. Future pricing-table refreshes and model additions ship as 1.x minors with no consumer cascade.

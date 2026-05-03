# dlabs-toolkit

**Diabolical Labs platform toolkit** — shared TypeScript infrastructure consumed across the Diabolical Labs and Diana Ismail project fleet.

## Status

**Scaffolding pending platform brief.** Architecture, monorepo tooling, package layout, and v0 scope are being designed in:

`/Users/mann/Documents/Claude/proj-plan/dlabs-toolkit/briefs/brief-platform.md`

This README will be replaced once the platform brief lands and v0 ships.

## Planned packages (subject to platform brief)

- `@dlabs/llm-client` — unified LLM API (Anthropic, OpenAI, Google, DeepSeek)
- `@dlabs/agent-sdk` — cost-tracking + agent-identity middleware (consumes llm-client)
- `@dlabs/notion` — Notion API helpers
- Additional packages added when 2+ consumer repos duplicate the same pattern

## Consumers

| Project | Layer |
|---|---|
| Agent Spend Dashboard | Commercial (Diabolical Labs) |
| Experiential Brief Generator | Commercial (Diabolical Labs) |
| GEOAudit, FitChecker, EventChatScheduler, ig-autopilot, telegram-digital-twin | Mixed |
| labs (experiments hub), portfolio | Personal (Diana Ismail) |

The toolkit is published under Diabolical Labs but consumed across both brand layers freely.

## Maintainer

Diana Ismail · [diabolicallabs.studio](https://diabolicallabs.studio)

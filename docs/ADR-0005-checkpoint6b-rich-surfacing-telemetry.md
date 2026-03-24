# ADR-0005: Checkpoint 6B Rich Surfacing and Telemetry Tuning

## Status

Accepted (Checkpoint 6B)

## Context

Checkpoint 6A introduced deterministic quest economy core (pressure, lifecycle, budget/quota).
The core worked, but player-facing clarity and tuning-oriented telemetry were still minimal.

## Decision

1. Add bounded quest presentation state:
   - `recentOutcomes` (max 4)
   - `hookSlots` (active top 1 + surfaced top 2)
   - `tuning` snapshot with bounded telemetry ring
2. Split panel quest summary into three layers:
   - `actionable`
   - `worldPulse`
   - `recentOutcomes`
3. Keep player/debug separation strict:
   - player mode uses deterministic qualitative templates only
   - debug mode shows raw tuning/budget/quota metrics
4. Keep LLM hook support as field-only contract (`hookSlot.llmShortText`) without runtime LLM call path.
5. Extend existing quest lifecycle trace payload instead of increasing event count.

## Consequences

- Players can distinguish active vs surfaced opportunities more clearly.
- Recent lifecycle outcomes become visible as natural-language world feedback.
- Operators can tune thresholds/caps using bounded telemetry without adding a heavy observability stack.
- Analyzer availability does not affect surfacing/telemetry determinism.

## Non-goals (deferred)

- Canonical world bi-directional sync.
- Anchor quest lifecycle body.
- Objective graph expansion and rich quest journal rendering.
- Full telemetry dashboard infrastructure.

# ADR-0007: Checkpoint 6D WorldPulse Rich Lane Narrow Expansion

## Status

Accepted (Checkpoint 6D)

## Context

Checkpoint 6C introduced an optional rich hook lane for actionable quest hooks only.
`worldPulse` still relied on deterministic text only.

We want a narrow, low-risk extension that improves "world is moving" feel without widening authority scope.

## Decision

1. Reuse existing `QuestHookTextRenderer` lane and bounded contracts.
2. Add `slotType="worldPulse"` variant to hook input slots.
3. Model `worldPulse` as a synthetic `QuestHookSlot` in presentation state for cache/hash/TTL reuse.
4. Keep deterministic `worldPulse` phrase as fallback source-of-truth at all times.
5. Keep generation bounded:
   - action pass max 1
   - candidate max 3 total
   - no retry
6. Include `worldPulse` candidate only when cache miss/source-hash change (no fixed reservation).
7. Keep telemetry text-free and metadata-only (`slotType`, cache/fallback/skip info).

## Consequences

- Player UI can show optional short worldPulse-rich text while preserving deterministic fallback.
- Pressure/archetype/trend/intensity computation remains deterministic and untouched.
- Debug/trace visibility remains bounded and compatible with existing 6C operational model.

## Non-goals (deferred)

- recentOutcomes rich expansion.
- quest lifecycle/budget/pressure rule changes.
- canonical sync, anchor lifecycle, wider narration systems.
- full observability/dashboard stack.

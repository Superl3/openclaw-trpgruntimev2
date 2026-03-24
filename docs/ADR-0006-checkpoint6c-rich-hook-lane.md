# ADR-0006: Checkpoint 6C Optional Rich Hook Lane

## Status

Accepted (Checkpoint 6C)

## Context

Checkpoint 6B introduced deterministic rich surfacing (`actionable/worldPulse/recentOutcomes`) and bounded tuning telemetry.
`hookSlot.llmShortText` existed as a reserved field but had no runtime generation path.

We need an optional rich lane that improves short hook text presentation without changing deterministic authority boundaries.

## Decision

1. Add compact hook text contract and validation:
   - Input: bounded actionable slot facts (max 3 slots)
   - Output: bounded `{ slotKey, shortText }` overrides
   - Strict schema/type guard validation
2. Add `QuestHookTextRenderer` interface with:
   - noop implementation for default-safe behavior
   - optional rule-based/model-invoker lane
3. Keep deterministic authority unchanged:
   - lifecycle/budget/pressure/transition logic remains engine-deterministic
   - hook lane can only override short presentation text per existing slot key
4. Add bounded cache metadata on hook slots:
   - source hash + expiry TTL
   - invalid/expired cache automatically pruned to deterministic fallback
5. Integrate lane safely in runtime engine:
   - run after deterministic resolution and before session persist
   - short timeout, no retry loop, action flow never fails because of hook lane
6. Add bounded telemetry:
   - new trace event `engine.quest.hook_text` with metadata only (no generated text body)
   - debug summary includes source/cache/skip reason metadata

## Consequences

- Player-facing panel can optionally use short rich hook text while preserving deterministic fallback behavior.
- Runtime remains recoverable and deterministic when lane is disabled, errors, times out, or returns invalid output.
- Operators can inspect hook lane behavior through bounded trace/debug metadata without a full observability stack.

## Non-goals (deferred)

- Quest lifecycle rule changes.
- Canonical world sync and anchor lifecycle body.
- Objective graph expansion and full quest journal rendering.
- Full rich narration expansion beyond actionable hook slots.
- Full telemetry dashboard infrastructure.

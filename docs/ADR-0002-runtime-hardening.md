# ADR-0002: Checkpoint 4A Runtime Hardening

## Status

Accepted (Checkpoint 4A)

## Context

Checkpoint 1-3 delivered panel lifecycle, deterministic scene loop, and analyzer lane.
Before extending gameplay systems, runtime safety and recovery behavior must be hardened.

Key risks:

- `turn` naming can imply fixed-turn model,
- analyzer fallback can bias to one action,
- analyzer memory can be misread as authoritative state,
- `preResolvedClaim` can leak into adjudication if untreated,
- panel dispatch and commit were loosely coupled,
- stale interaction handling needed standardized error codes,
- raw drift values should not be default player UX.

## Decision

1. Keep deterministic engine as final adjudicator and treat analyzer as classifier only.
2. Introduce bounded session trace events for runtime debugging.
3. Replace fallback-first bias with conservative fallback strategy:
   - keep previous mapped action,
   - scene-safe default (`wait`/`observe`),
   - abstain (`action.unknown`) when needed.
4. Enforce analyzer memory as bounded, TTL-based ephemeral cache.
5. Treat `preResolvedClaim` as warning-only and cap analyzer influence.
6. Add dispatch hardening with `dispatchId` pending state and idempotent commit behavior.
7. Standardize stale/expired interaction error codes with resume guidance.
8. Hide raw drift values from default UI; expose only in debug mode.

## Consequences

- Runtime behavior is more predictable under stale callbacks and partial failures.
- Analyzer lane remains replaceable and non-authoritative.
- Panel update path gains safer commit semantics without redesigning message architecture.
- Debug traces are available for issue triage while remaining bounded.

## Follow-up (Checkpoint 4B+)

- Connect trace outputs to memory/time/quest systems.
- Add richer dispatch retry/queue policy when external message operations fail.
- Expand observability tooling from bounded in-session trace to dedicated diagnostics pipeline.

# ADR-0010: Checkpoint 7C Anchor Lifecycle and Event Layer

## Status

Accepted (Checkpoint 7C)

## Context

Checkpoint 6/7B already maintains deterministic temporal and quest economy layers.
However, long-horizon conflict axes are still fragmented across pressure/quest snapshots.

We need a lightweight anchor lifecycle layer that:

- stays deterministic and owned by runtime core,
- exposes bounded qualitative projection for panel UX,
- emits explicit lifecycle trace events,
- does not introduce canonical write-back/sync in this step.

## Decision

1. Add deterministic `anchor-layer` runtime state (`AnchorRuntimeState`) to scene loop state.
2. Add bounded anchor lifecycle model:
   - lifecycle: `candidate -> active -> escalated -> (resolved|failed) -> archived`
   - bounded refs: `linkedQuestIds`, `recentEventRefs`, `sourceRefs`
   - cap guard with no hard-delete for started/terminal anchors.
3. Tick integration order:
   - temporal update -> quest economy tick -> anchor tick.
4. Add anchor event summary and trace projection:
   - `engine.anchor.formed`
   - `engine.anchor.advanced`
   - `engine.anchor.escalated`
   - `engine.anchor.resolved`
   - `engine.anchor.failed`
   - `engine.anchor.archived`
5. Panel projection rules:
   - default/player view: qualitative top anchor text only
   - debug mode: bounded raw anchor metadata only.
6. Faction/world external signal input is optional and non-authoritative:
   - missing/invalid/no-op signal must degrade safely
   - deterministic fallback remains primary behavior.

## Boundary and Non-goals

- No anchor rich narration lane in this checkpoint.
- No canonical persistence/write-back contract for anchor state.
- No diplomacy/war grand-strategy simulation.
- No replacement of quest lifecycle authority.

Anchor layer is a deterministic orchestration surface between pressure trends and quest lifecycle outcomes, not a separate story director.

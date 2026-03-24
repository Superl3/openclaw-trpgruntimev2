# ADR-0001: Checkpoint 0 Runtime Core Skeleton

## Status

Accepted (Checkpoint 0)

## Context

TRPG runtime V2 already has rich plugin logic, but Checkpoint 0 requires durable boundaries that later checkpoints can keep:

- deterministic engine lane and LLM lane must be separated,
- game state must live in a dedicated store,
- Discord lifecycle entry points must support `/trpg new`, `/trpg resume`, `/trpg end`,
- interaction routing must be keyed by `sessionId + uiVersion + sceneId + actionId`.

## Decision

1. Introduce `src/runtime-core/*` as a tool-agnostic runtime skeleton.
2. Keep lane boundaries explicit via interfaces:
   - `RuntimeEngine` and deterministic session lifecycle methods,
   - `IntentAnalyzer`, `PersonaDriftAnalyzer`, `SceneRenderer` for LLM lane.
3. Introduce `StateStore` interface and file-backed baseline implementation at `src/runtime-store/file-state-store.ts`.
4. Register Checkpoint 0 lifecycle tools in OpenClaw adapter:
   - `trpg_session_new` (`/trpg new` entry),
   - `trpg_session_resume` (`/trpg resume` entry),
   - `trpg_session_end` (`/trpg end` entry).
5. Use store snapshots as source of truth. Prompt/transcript text is not treated as canonical game state.

## Consequences

- Existing runtime behavior remains intact while Checkpoint 0 skeleton is added with minimal intrusion.
- Future checkpoints can replace noop LLM analyzers and scene renderer without changing engine/store contracts.
- Resume flow now has an explicit recovery plan tied to `uiVersion` and route-key rotation.

## Follow-up (Checkpoint 1)

- Add interaction ingestion + resolver path that consumes route keys on button/modal events.
- Connect deterministic scene/beat/exchange state transitions to runtime engine methods.
- Replace noop LLM lane with fixed JSON contract analyzers and strict validation telemetry.

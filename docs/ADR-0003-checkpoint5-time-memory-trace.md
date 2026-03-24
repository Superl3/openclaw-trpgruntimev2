# ADR-0003: Checkpoint 5 Time/Memory/Trace Core

## Status

Accepted (Checkpoint 5)

## Context

Checkpoint 1-4A established panel lifecycle, deterministic Scene/Beat/Exchange loop, analyzer lane, and runtime hardening.
Time (`delta_time`) already advanced counters, but did not yet drive compact persistent systems for memory, traces, and local state drift.

## Decision

1. Add deterministic temporal runtime state under scene loop:
   - `locationStates`
   - `npcMemory`
   - `infoFreshness`
   - `residualTraces`
2. Apply temporal update pipeline after action resolution:
   - decay
   - action footprint write
   - location projection
   - trace append
3. Keep analyzer boundary unchanged:
   - analyzer remains classifier-only,
   - temporal adjudication is engine-owned deterministic logic.
4. Keep location persistence optional:
   - persistent location state is applied only when explicit `locationId` exists.
5. Keep trace bounded and concise:
   - add compact temporal summary events without high-volume event spam.

## Consequences

- `delta_time` now changes world-facing state even without analyzer input.
- Talk/observe/rush/move/wait can leave residual consequences that decay over time.
- Resume continues from persisted temporal state because state store remains source-of-truth.
- Panel can display qualitative temporal signals by default, with raw values only in debug mode.

## Non-goals (deferred)

- Quest lifecycle economy body and world pressure integration.
- Anchor quest and macro simulation (social/economic scheduler layers).
- Full location graph simulation for every area.

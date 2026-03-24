# ADR-0004: Checkpoint 6 Quest Economy Core

## Status

Accepted (Checkpoint 6)

## Context

Checkpoint 5 delivered deterministic temporal state (`time`, `npcMemory`, `infoFreshness`, `residualTraces`, `locationState`).
However, sandbox progression still lacked a bounded event economy for ongoing opportunities and failures.

## Decision

1. Add deterministic quest economy state under scene loop:
   - `worldPressures`
   - `quests`
   - `budget`
   - `softQuota`
   - `nextQuestSeq`
2. Add lightweight world pressure model:
   - archetype, intensity, momentum, targetLocations, cadence, timestamps
   - `anchorCandidate` as placeholder only (no anchor core yet)
3. Add bounded lifecycle states:
   - `seed -> surfaced -> active/stalled -> resolved/failed -> archived`
   - `deleted` is pre-start opportunity expiration only
4. Enforce started-quest non-delete rule:
   - started quests never hard-delete, overdue flows to `failed` or `mutated + successor`
5. Add budget and quota guardrails:
   - hard live pool cap + weighted world/attention budget
   - soft quota for location/pressure/archetype
6. Bridge temporal input through compact signal only:
   - quest economy consumes `QuestTemporalSignal`, not raw temporal internals
7. Add bounded trace summaries for pressure/lifecycle/budget outcomes.

## Consequences

- Runtime gains deterministic sandbox continuity without relying on LLM generation.
- Ignored surfaced opportunities can naturally expire.
- Active overdue quests produce failures or successor chains instead of silent deletion.
- Quest growth remains bounded via caps, costs, and quota penalties.

## Non-goals (deferred)

- Anchor quest body and dedicated anchor lifecycle.
- Canonical world write-back synchronization strategy.
- Rich objective graph / long-form quest journal rendering.
- Macro social/economic simulation layers.

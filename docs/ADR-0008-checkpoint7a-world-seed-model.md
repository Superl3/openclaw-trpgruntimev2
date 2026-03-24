# ADR-0008: Checkpoint 7A Canonical World Seed Model and Runtime Bootstrap Bridge

## Status

Accepted (Checkpoint 7A)

## Context

Checkpoint 1-6D established deterministic runtime authority (session state, scene loop, temporal systems, quest economy, optional rich lane).
World initialization still relied on internal defaults only.

We need a canonical world seed scaffold that is explicit, validated, and safely projected into runtime bootstrap without turning seed data into a second runtime state store.

## Decision

1. Add canonical `WorldSeed` scaffold types:
   - `WorldSeed`, `LocationSeed`, `PressureSeed`, `FactionSeed`, `NpcArchetypePool`, `GenerationProfile`.
2. Add `RuntimeBootstrapInput` as a thin runtime projection from canonical seed.
3. Add validation + invariant checks for seed integrity and minimum scaffold size.
4. Add one-way bridge `WorldSeed -> RuntimeBootstrapInput`.
5. Add optional seed-loading path only for new session bootstrap.
6. Keep fallback policy conservative:
   - missing seed -> existing deterministic defaults
   - invalid seed -> structured diagnostics + existing deterministic defaults
7. Persist seed provenance to runtime metadata:
   - `worldId`, `schemaVersion`, `seedValue`, `seedFingerprint`.

## Boundary (Seed vs Runtime)

- Canonical world seed owns:
  - static topology scaffold
  - initial pressure scaffold
  - faction scaffold
  - npc archetype pool scaffold
  - small generation knobs (`GenerationProfile`)
- Runtime state owns:
  - quest lifecycle and active opportunities
  - pressure evolution and cadence progression
  - temporal/memory/trace updates
  - location drift deltas and local incident traces

Seed data is bootstrap input only. Runtime state remains mutable source-of-truth.

## Invariants

- Unique IDs for locations/pressures/factions/npcPool entries.
- Referential integrity:
  - faction `homeLocationId` must exist
  - faction `pressureBiasRefs` must exist
  - npc `factionId` (if set) must exist
  - npc `locationAffinityIds` must exist and be non-empty
  - location `pressureAffinityIds` must exist
- Minimum scaffold counts:
  - locations >= 3
  - pressures >= 2
  - factions >= 2
  - npcPool >= 6
- Deterministic projection contract:
  - same canonical seed input -> same bootstrap projection/fingerprint.

## Bridge and Runtime Wiring

- Adapter tries canonical seed paths (prefer `canon/world-seed.*`, then `state/world-seed.*`, then `state/world-seeds.*`).
- Valid seed -> projected bootstrap is injected into new-session initialization.
- Resume path does not re-bootstrap from seed; persisted runtime state is used first.
- Runtime does not mutate canonical seed object/files.

## LLM Authority Boundary

- LLM remains optional presentation/analyzer lane only.
- LLM does not author canonical IDs, topology, or pressure truth.
- No canonical write-back from rich text lanes.

## Non-goals (Deferred)

- Canonical/runtime bidirectional sync body.
- Canonical write-back body.
- Faction diplomacy simulation body.
- Anchor lifecycle simulation body.
- Rich lore generation body.

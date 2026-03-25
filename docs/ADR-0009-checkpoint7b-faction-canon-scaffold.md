# ADR-0009: Checkpoint 7B Faction Canon Scaffold and Tick Enablement

## Status

Accepted (Checkpoint 7B)

## Context

Checkpoint 7A established canonical world seed and bootstrap projection.
`trpg_faction_tick` still failed operationally when `canon/factions.yaml` was missing.

We need a minimal faction canonical scaffold that operators can author and validate,
while keeping deterministic runtime boundaries and avoiding dual truth with world seed.

## Decision

1. Add canonical faction scaffold file model (`FactionCanonFile`) at `canon/factions.yaml`.
2. Keep minimal faction fields only:
   - `factionId`, `name`, `enabled`, `homeLocationIds`, `pressureAffinityIds`, `resources`, `heat`, `posture`.
3. Add validation with structured diagnostics (`code/message/path/severity`):
   - schema checks
   - invariant checks
   - optional referential checks against world-seed references.
4. Keep SoT boundary explicit:
   - `canon/factions.yaml` is operational source-of-truth for faction tick.
   - `WorldSeed.factions` is bootstrap scaffold only (projection source), not operational authority.
5. Add one-shot seed projector (`WorldSeed -> canon/factions.yaml`) with overwrite guard:
   - default: create only when target does not exist
   - overwrite allowed only with explicit `--force`.
6. `trpg_faction_tick` missing/invalid scaffold behavior is fallback-safe:
   - no throw for missing/invalid scaffold
   - return structured no-op result with diagnostics.

## Boundary (Seed vs Faction Canon)

- `WorldSeed.factions`:
  - bootstrap/generation scaffold
  - optional one-shot projection input
- `canon/factions.yaml`:
  - operational faction tick input
  - single authority for faction tick execution

No bidirectional sync/write-back body is introduced in this checkpoint.

## Non-goals (Deferred)

- Faction diplomacy/relation graph simulation.
- Long-horizon strategy/planning system.
- Anchor lifecycle body.
- Canonical/runtime bidirectional sync body.
- War/economy/territory simulation.

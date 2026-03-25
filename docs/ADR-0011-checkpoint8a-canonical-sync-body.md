# ADR-0011: Checkpoint 8A Canonical Sync Body and Drift Audit

## Status

Accepted (Checkpoint 8A)

## Context

Checkpoint 7A/7B separated concerns correctly:

- `WorldSeed` is bootstrap scaffold input.
- `canon/factions.yaml` is faction tick operational source-of-truth.
- runtime state store remains mutable deterministic truth.

Operationally, seed and canon can drift over time. Without explicit audit/sync loop,
operators cannot safely answer:

- what changed,
- whether change is scaffold drift or operational divergence,
- when and how to refresh canonical scaffold.

## Decision

1. Add provenance/fingerprint body across seed/canon/runtime metadata.
2. Add explicit drift audit helper (`scripts/diff-factions-vs-seed.mjs`) that is read-only.
3. Upgrade scaffold sync helper (`scripts/scaffold-factions-from-seed.mjs`) to explicit modes:
   - default: dry-run only
   - apply: `--apply`
   - overwrite existing file: `--apply --force`
4. Define sync policy boundary:
   - scaffold fields (`factionId`, `name`, `enabled`, `homeLocationIds`, `pressureAffinityIds`, `posture`) can refresh from seed projection.
   - operational fields (`resources`, `heat`) are preserved by default (`preserve_operational`).
5. Keep deterministic/runtime boundary intact:
   - no runtime -> canonical automatic write-back
   - no canonical/runtime auto bi-directional sync
   - no LLM conflict resolution in sync path.

## Operator Loop (Explicit)

1. Edit/validate seed scaffold (`validate-world-seed`).
2. Run drift audit (`diff-factions-vs-seed`) and inspect structured diff.
3. Run sync helper in dry-run mode and inspect planned changes.
4. Apply only when intended (`--apply`, and `--force` for overwrite).
5. Re-validate canonical factions.
6. Run faction tick/runtime session with provenance visible in debug/ops outputs.

## Non-goals

- Full canonical/runtime sync engine.
- Automatic merge/reconciliation policy beyond bounded scaffold rules.
- Diplomacy/economics strategy layer.
- Rich narration expansion.

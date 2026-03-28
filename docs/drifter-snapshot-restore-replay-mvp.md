# Drifter-only Snapshot / Restore / Replay MVP

## Goal

Provide a practical checkpoint flow for **drifter sandbox sessions only**:

- save a sandbox checkpoint locally,
- restore the sandbox back to that checkpoint,
- materialize a replayable inspection bundle from the checkpoint,
- avoid touching canonical human-facing compatibility paths.

## Scope

This MVP captures the things drifter testing actually needs most:

1. **Sandbox world state**
   - `canon/player.yaml`
   - `state/player-status.yaml`
   - `state/inventory.yaml`
   - `state/current-scene.yaml`
2. **Sandbox runtime artifacts**
   - everything under `state/runtime-core/` inside the sandbox workspace
   - excluding nested prior snapshot payloads to avoid recursion
3. **Relevant runtime metadata**
   - selected `SessionState` from `checkpoint0-store.json`
   - trace-derived replay steps
   - session identity / scene / uiVersion / last action summary
4. **Replay manifest**
   - built from session trace first
   - optionally enriched from supplied drifter smoke `report.machine.json` files

## Non-goals

- no human/user session compatibility layer
- no cross-machine export/import protocol
- no canonical-world writeback
- no full deterministic engine re-simulation from trace
- no generalized archival format for every future runtime checkpoint

## Layout

Snapshots live **inside the sandbox workspace**:

- `state/runtime-core/drifter-snapshots/<snapshot-id>/manifest.json`
- `state/runtime-core/drifter-snapshots/<snapshot-id>/payload/...`

Replay materialization also stays local:

- `state/runtime-core/drifter-snapshots/<replay-id>/replay.json`
- plus copied payload files for inspection/debugging

## Commands

```bash
npm run drifter:snapshot -- create --workspace <sandbox-root> --session-id <sess-id> --label <name>
npm run drifter:snapshot -- restore --workspace <sandbox-root> --snapshot <snapshot-dir>
npm run drifter:snapshot -- replay --workspace <sandbox-root> --snapshot <snapshot-dir>
npm run drifter:snapshot -- list --workspace <sandbox-root>
npm run drifter:snapshot -- inspect --snapshot <snapshot-dir>
```

Optional replay enrichment from smoke reports:

```bash
npm run drifter:snapshot -- create \
  --workspace <sandbox-root> \
  --session-id <sess-id> \
  --report runtime/reports/<run>/report.machine.json
```

## How replay works in this MVP

“Replay” means:

1. read the stored replay manifest,
2. materialize the captured payload into a fresh local replay directory,
3. expose the ordered step list used for inspection/debugging.

That is intentionally narrower than a full engine rerun, but it is enough for:

- checkpoint comparison,
- drifter debugging,
- trace inspection,
- report correlation,
- restoring and branching from a known sandbox state.

## Why this is enough for now

For drifter-only testing, the highest-value need is not a polished user-facing resume system. It is:

- **freeze current sandbox state**,
- **get back to it quickly**,
- **inspect what drifter saw/did**,
- **branch another experiment from the same checkpoint**.

This MVP does exactly that without dragging human-facing lifecycle compatibility into scope.

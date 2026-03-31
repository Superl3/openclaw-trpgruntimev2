# Runtime Operational Data Boundary

This repository contains **runtime code** and **test fixtures**, while live/session data is operational and should remain out of source control.

## Source-controlled (code contract)

- `index.ts`, `src/**`, `scripts/**`, `tests/**`, `docs/**`
- plugin manifest/config contract files (`openclaw.plugin.json`, `src/config.ts`)

## Operational (local/runtime only)

- `workspace/world/state/runtime-core/**` (session runtime artifacts, diagnostics)
- generated world runtime snapshots and backup files (`*.bak*`)
- local temp/test build outputs (`.tmp*`)
- local IDE/tool metadata (`.serena/`)

These paths are ignored via `.gitignore` to prevent accidental coupling of runtime state and deterministic code contracts.

## Validation tiers

Recommended regression tiers for refactor checkpoints:

1. **Static gate**
   - `npm run typecheck`

2. **Hardening gate**
   - `node --test tests/runtime-hardening/runtime-hardening.test.mjs`

3. **Bootstrap + sync integration gate**
   - `node --test tests/runtime-bootstrap/runtime-bootstrap-phase.test.mjs`
   - `node --test tests/runtime-sync/runtime-sync.test.mjs`

4. **Drifter sandbox gate (when touched)**
   - `node --test tests/runtime-bootstrap/drifter-sandbox.test.mjs`
   - `node --test tests/runtime-bootstrap/drifter-sandbox-session.test.mjs`
   - `node --test tests/runtime-bootstrap/drifter-sandbox-analysis.test.mjs`

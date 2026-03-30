# AGENTS.md — trpg-runtime-v2

Agent handbook for `~/.openclaw/extensions/trpg-runtime-v2`.

Related runtime data path (for debugging real sessions):
- `~/.openclaw/agents/trpg-v2`

## 0) Core project invariants
- Runtime code owns deterministic state/time/quest/progression authority.
- LLM lane is assistive only (analysis/surface text), not truth-owner writes.
- Scene model is Scene / Beat / Exchange + `delta_time`.
- Prompt text is never treated as canonical game state storage.
- Session/panel restoration must use store IDs (`sessionId`, `uiVersion`, `sceneId`, `actionId`).
- Prefer lean deterministic core first; keep rich layers optional and gated.

## 1) Stack snapshot
- Node.js ESM (`"type": "module"`)
- TypeScript (`strict: true`, `noEmit: true`)
- npm package manager
- Tests: `node:test` + `node:assert/strict`
- Lint/format: no ESLint/Prettier/Biome config in this repo
- CI workflows: none detected under `.github/workflows/`

## 2) Build / lint / test commands
Run from:
`/home/superl3/.openclaw/extensions/trpg-runtime-v2`

### Install
```bash
npm install
```

### Build and checks
```bash
npm run build
npm run typecheck
npm run smoke:manifest
```

Notes:
- `npm run build` is intentionally no-op for runtime loading.
- `npm run typecheck` is the primary static gate.

### Lint / format
No dedicated lint/format scripts currently exist.

### Domain validation scripts
```bash
npm run seed:validate
npm run factions:validate
npm run factions:drift-vs-seed
npm run factions:scaffold-from-seed
```

### Smoke scripts
```bash
npm run smoke:gamer-live
npm run smoke:session-validate
npm run smoke:drifter-audit
npm run smoke:drifter-divergence
npm run test:smoke-session-validity
```

### Tests (single test workflows emphasized)
Run all tests:
```bash
node --test tests/**/*.test.mjs
```

Run one test file:
```bash
node --test tests/runtime-bootstrap/runtime-bootstrap-phase.test.mjs
```

Run one test by name pattern:
```bash
node --test --test-name-pattern "bootstrap/ready/in-game phase branching" tests/runtime-bootstrap/runtime-bootstrap-phase.test.mjs
```

Debug reporter:
```bash
node --test --test-reporter spec tests/runtime-hardening/runtime-hardening.test.mjs
```

Minimum behavior-change gate:
```bash
npm run typecheck && node --test tests/runtime-hardening/runtime-hardening.test.mjs
```

## 3) Repository map
- Entrypoints: `index.ts`, `src/index.ts`
- Lifecycle/session tools: `src/runtime-adapter/openclaw/checkpoint0-lifecycle.ts`
- Core deterministic systems: `src/runtime-core/*`
- Patch/store utilities: `src/patch-engine.ts`, `src/world-store.ts`
- Config and plugin contract: `src/config.ts`, `openclaw.plugin.json`
- Scripts: `scripts/*.mjs`
- Tests: `tests/runtime-*/**/*.test.mjs`
- Agent templates/assets: `agent/*`

## 4) Code style guidelines
### Imports/modules
- Use ESM imports only.
- Use `node:` built-ins (`node:fs/promises`, `node:crypto`, etc.).
- In `.ts`, keep local imports with `.js` suffix.
- Use `import type` for type-only imports.

### Formatting
- Follow current style: 2-space indentation, semicolons, double quotes.
- Prefer small composable helpers for parsing/normalization/guards.
- Use explicit constants for caps/thresholds/limits.

### Types
- Keep strict typing; avoid `any` unless unavoidable.
- Use literal unions for finite states/modes.
- At boundaries, parse `unknown` into typed objects.
- Keep tool I/O contracts explicit and stable.

### Naming
- Files: kebab-case
- Functions/variables: camelCase
- Types/interfaces/classes: PascalCase
- Stable constants: UPPER_SNAKE_CASE

### Error handling and safety
- Fail closed for unauthorized actors, invalid config, unsafe paths, schema violations.
- Tool-facing errors should be structured: `{ ok: false, error, errorCode?, recoveryHint? }`.
- Keep read-only/dry-run paths side-effect free.
- Preserve deterministic fallback behavior when optional lanes fail.

## 5) Refactor guardrails (TRPG runtime specific)
- Do not shift deterministic ownership from runtime core into LLM lane.
- Preserve patch safety flow (`trpg_patch_dry_run` -> audited apply).
- Respect `allowPatchApply` and canonical write-back safety flags.
- Preserve lifecycle semantics: `new`, `resume`, `end`, `save`, `load`, `data-delete`.
- Preserve phase gating: `BOOTSTRAP` -> `READY_FOR_INTRO` -> `IN_GAME`.
- Keep panel commit safety checks (`dispatchId`, stale interaction, owner guard).
- Keep world-root/session-workspace resolution deterministic.

## 6) Testing conventions
- Use `node:test` APIs (avoid Jest/Vitest patterns).
- Keep tests deterministic (fixed IDs/time/seeds where possible).
- Prefer behavior-oriented test names (what guarantee is protected).
- Follow existing temp-compile pattern (`.tmp-test-dist-*`) where used.
- Clean temporary directories in setup/teardown.
- If schema/tool contract changes, update:
  1) schema/parameter definitions
  2) parser/normalization/runtime handling
  3) targeted tests

## 7) Agent workflow checklist
1. Read nearby contracts/types before editing.
2. Make minimal checkpoint-safe changes.
3. Preserve deterministic state transitions.
4. Confirm authorization/tool gates are unchanged unless intentionally edited.
5. Run `typecheck` and targeted single-file tests.
6. Run hardening tests for behavior-impacting changes.
7. Update docs/examples when config/schema behavior changes.

## 8) Cursor/Copilot rule files status
Checked in this repository:
- `.cursorrules`: not found
- `.cursor/rules/`: not found
- `.github/copilot-instructions.md`: not found

If these files are added later, merge their constraints into this AGENTS.md.

# trpg-runtime-v2 (local plugin)

Structured TRPG runtime plugin for OpenClaw.

## What it provides

- `trpg_store_get` - structured read surface over `world/*` with view filtering
- `trpg_patch_dry_run` - patch validation + normalized preview (no writes)
- `trpg_patch_apply` - guarded patch apply (optional tool, config-gated)
- `trpg_hooks_query` - dormant hook and reveal candidate query
- `trpg_dice_roll` - deterministic/traceable dice roll output
- `trpg_state_compact` - lifecycle compaction dry-run/audited apply planner
- `trpg_session_new` / `trpg_session_resume` / `trpg_session_end` - session panel lifecycle

- 빠른 초기화 프로시저: 기본적으로 `/trpg new wipeMode=force` 실행 시 동일 owner 조건에서 기존 세션/임시 워크스페이스를 바로 정리 후 새 세션을 시작한다.
- `trpg_panel_interact` / `trpg_panel_message_commit` - owner-guarded panel callback + message metadata sync
- Runtime hardening: bounded session trace, stale interaction codes, and `dispatchId`-based panel commit safety
- Checkpoint 5 temporal core: deterministic memory/freshness/residual-trace/location drift driven by `delta_time`
- Checkpoint 6 quest economy core: deterministic world pressure, bounded quest lifecycle, and budget/quota guardrails
- Checkpoint 6B rich surfacing: active/surfaced/recent outcome panel projection with bounded tuning telemetry snapshot
- Checkpoint 6C/6D optional rich hook lane: bounded actionable + worldPulse short text with deterministic fallback
- Checkpoint 7A world seed bootstrap: validated canonical world seed scaffold + one-way runtime bootstrap projection
- Checkpoint 7B faction canon scaffold: minimal canonical factions model + faction tick fallback-safe enablement
- Checkpoint 7C anchor lifecycle layer: deterministic long-horizon conflict anchors with bounded panel/trace projection
- Checkpoint 8A canonical sync body: provenance fingerprinting + explicit drift audit/sync loop

All tools return JSON-shaped output (`details`) and JSON text in `content`.

## World-data-driven runtime

- Hardcoded setting/scenario seeding has been removed from runtime hooks.
- Scene generation now depends on your world files only.
- Define locations, intro scene data, and relationship edges in `world/` files (for example `canon/locations.yaml`, `state/current-scene.yaml`, and `state/relationships.yaml`).
- If scene data is missing, runtime falls back to neutral guard text (for example current scene unknown) instead of injecting fixed lore.

## World seed bootstrap (Checkpoint 7A)

- Canonical world seed is bootstrap input, not live runtime source-of-truth.
- Runtime mutable truth remains in state store (`deterministicLoop`, temporal/quest state, trace, panel/session metadata).
- New session bootstrap seed lookup order:
  1. `world/canon/world-seed.yaml|yml|json`
  2. `world/state/world-seed.yaml|yml|json`
  3. `world/state/world-seeds.yaml|yml|json`
- Valid seed: runtime consumes projected pressure/location baselines and stores seed provenance (`worldId`, `schemaVersion`, `seedFingerprint`) in session metadata.
- Missing/invalid seed: runtime reports structured diagnostics and safely falls back to existing deterministic defaults.
- Resume flow keeps persisted runtime state; it does not re-bootstrap from seed unless a new session is created.
- Starter template: copy `examples/world-seed.template.yaml` to `world/canon/world-seed.yaml` and edit ids/baselines for your setting.
- Preflight validator (schema/invariant check only): `node scripts/validate-world-seed.mjs world/canon/world-seed.yaml`

## Faction canonical scaffold (Checkpoint 7B)

- `canon/factions.yaml` is the operational source-of-truth for `trpg_faction_tick`.
- `WorldSeed.factions` is projection-only bootstrap material; it does not override operational faction canon during tick.
- Starter template: copy `examples/factions.template.yaml` to `world/canon/factions.yaml` and tailor ids/resources/heat/posture.
- Preflight validator (schema/invariant/referential checks): `node scripts/validate-factions-canon.mjs world/canon/factions.yaml`
- Drift audit (read-only): `node scripts/diff-factions-vs-seed.mjs world/canon/world-seed.yaml world/canon/factions.yaml`
- Explicit scaffold sync helper (dry-run default): `node scripts/scaffold-factions-from-seed.mjs world/canon/world-seed.yaml world/canon/factions.yaml`
- Write/apply is explicit: `--apply`; overwrite existing file requires `--apply --force`.
- Missing/invalid faction canon now returns structured no-op diagnostics instead of hard tick failure.

## Canonical sync body (Checkpoint 8A)

- Runtime metadata stores canonical sync provenance/fingerprints only (no canonical body copy).
- Source policy remains explicit:
  - seed: `seed_bootstrap_only`
  - canon: `canon_authoritative`
- Scaffold sync policy defaults to `preserve_operational`:
  - refresh scaffold fields from seed projection
  - preserve operational canonical fields (`resources`, `heat`) by default
- Faction tick output now includes canonical provenance + drift hints for ops/debug flows.
- Suggested operator loop:
  1. validate seed (`validate-world-seed`)
  2. audit drift (`diff-factions-vs-seed`)
  3. run sync dry-run (`scaffold-factions-from-seed`)
  4. apply explicitly (`--apply`, and `--force` for overwrite)
  5. validate canon (`validate-factions-canon`)
  6. run faction tick/session

## Anchor lifecycle layer (Checkpoint 7C)

- Runtime deterministic loop now includes bounded `anchor` state for long-horizon conflict axes.
- Anchor lifecycle is deterministic and bounded: `candidate -> active -> escalated -> resolved|failed -> archived`.
- Anchor cap enforcement avoids hard-delete for started/terminal anchors; terminal anchors transition to archived by retention policy.
- Default panel view exposes qualitative top-anchor only; debug mode exposes bounded raw anchor metadata.
- Engine trace now includes anchor lifecycle events:
  - `engine.anchor.formed`, `engine.anchor.advanced`, `engine.anchor.escalated`
  - `engine.anchor.resolved`, `engine.anchor.failed`, `engine.anchor.archived`
- Optional external/faction signal input degrades safely on missing/invalid/no-op data.

## Runtime safety flags (v1 safe mode)

- v1 safe mode defaults:
  - `behavioralDriftEnabled=true`, `behavioralDriftAffectsRules=false`
  - `anchorLifecycleEnabled=true`, `anchorSummaryOnly=true`
  - `richHookActionableEnabled=true`, `richHookWorldPulseEnabled=true`, `richHookRecentOutcomesEnabled=false`
  - `debugRuntimeSignals=false`, `traceVerbose=false`, `telemetryExtended=false`
  - `canonicalSyncEnabled=false`, `canonicalWriteBackEnabled=false`
- Core (always deterministic, not feature-disabled): scene loop, temporal systems, quest economy, world seed bootstrap, faction canon scaffold.
- Optional/gated layers: behavioral drift accumulation, anchor projection visibility, rich hook slot rewriting, extended debug/trace/telemetry, canonical sync provenance loading.
- `canonicalWriteBackEnabled=false` blocks canonical-file targets in audited patch-apply path.

## Safety model

- Agent gate: defaults to `allowedAgentIds: []` (empty list means allow all agents)
- Path guard: blocks traversal and write/read outside resolved `world/*`
- Canon target guard: patch operations support structured files only (`.yaml`, `.yml`, `.json`)
- No hidden side effects in dry-run tools
- `trpg_patch_apply` is optional and disabled by default (`allowPatchApply: false`)
- When `allowPatchApply=false`, runtime blocks `trpg_patch_apply` writes even if audit metadata is present

## Agent model config source of truth

- Canonical template: `agent/config/models.template.json`.
- Backward-compat copies (`agent/models.template.json`, `agent/models.json`) are convenience artifacts and should not be treated as the primary contract.

## Reasoning setting scope

- Model `reasoning` fields in agent model config are advisory client/provider settings.
- Plugin runtime safety is enforced by plugin config (`plugins.entries.trpg-runtime-v2.config.*`) and deterministic guards, not by model reasoning flags.

## Discord component policy

- Runtime supports buttons/modals and can emit select-menu payloads where useful.
- Bootstrap/onboarding does **not** require select-menu support; button+modal-first flows remain valid.

## Drifter sandbox prototype (MVP)

A disposable drifter sandbox prototype is included for isolated experiments.

- Architecture/design doc: `docs/drifter-sandbox-architecture.md`
- CLI: `node ./scripts/drifter-sandbox.mjs`
- Default sandbox root: OS temp dir (`/tmp/trpg-runtime-v2/sandboxes/...` on Linux)

Examples:

```bash
# create sandbox with repo worktree + copied world snapshot
node ./scripts/drifter-sandbox.mjs create \
  --repo /path/to/trpg-runtime-v2 \
  --world /path/to/trpg-runtime-v2/world \
  --label nightly-drift

# inspect manifest
node ./scripts/drifter-sandbox.mjs inspect --sandbox /tmp/trpg-runtime-v2/sandboxes/<sandbox-id>

# destroy sandbox + remove worktree
node ./scripts/drifter-sandbox.mjs destroy --sandbox /tmp/trpg-runtime-v2/sandboxes/<sandbox-id> --force
```

## Sandboxed drifter session launcher

The next MVP slice wires the live drifter/gamer smoke harness onto the sandbox layout.

It creates or reuses a sandbox, points the runtime at `world/base`, and keeps artifacts inside the sandbox:

- world/runtime state → `<sandbox>/world/base`
- turn transcripts → `<sandbox>/session/transcripts`
- improve reports → `<sandbox>/reports`
- stdout/stderr logs → `<sandbox>/artifacts`
- launch summary → `<sandbox>/session/launch-result.json`

Example:

```bash
node ./scripts/run-drifter-sandbox-session.mjs \
  --repo /path/to/trpg-runtime-v2 \
  --world /path/to/trpg-runtime-v2/world \
  --lane deterministic \
  --scenario happy \
  --turns 2 \
  --improve shadow
```

For an existing sandbox:

```bash
node ./scripts/run-drifter-sandbox-session.mjs \
  --sandbox /tmp/trpg-runtime-v2/sandboxes/<sandbox-id> \
  --lane openclaw \
  --agent-path /abs/path/to/agent \
  --scenario happy,modal
```

`run-gamer-smoke-live` also supports direct sandbox targeting now:

```bash
node ./scripts/run-gamer-smoke-live.mjs \
  --lane deterministic \
  --world-root /tmp/trpg-runtime-v2/sandboxes/<sandbox-id>/world/base \
  --preserve-world-root \
  --transcript-dir /tmp/trpg-runtime-v2/sandboxes/<sandbox-id>/session/transcripts
```

## Build

No compile/build step is required for runtime loading (OpenClaw loads TypeScript via jiti).

```bash
npm install
npm run typecheck
npm run smoke:manifest
```

## Install / Link (next step)

This repository step intentionally does **not** install or link the plugin yet.

When ready, use one of:

```bash
openclaw plugins install -l ~/.openclaw/extensions/trpg-runtime-v2
```

or from this repo root:

```bash
openclaw plugins install -l ../.openclaw/extensions/trpg-runtime-v2
```

Then enable/configure under:

- `plugins.entries.trpg-runtime-v2.enabled`
- `plugins.entries.trpg-runtime-v2.config`

## Drop-in / Plug-and-Play

You can use this extension with either mode:

- Plugin-only mode: load only the plugin with `examples/openclaw.overlay.onboard.plugin-only.json` and keep your existing agents/bindings.
- Dedicated `trpg` agent mode: use `examples/openclaw.overlay.onboard.trpg-agent.json` to load plugin + agent + binding together.

## Onboarding

- Plugin-only onboarding overlay: `examples/openclaw.overlay.onboard.plugin-only.json`
- Dedicated `trpg` onboarding overlay: `examples/openclaw.overlay.onboard.trpg-agent.json`

These are minimal post-install examples with safe defaults:

- `plugins.entries.trpg-runtime-v2.config.allowPatchApply=false`
- `plugins.entries.trpg-runtime-v2.config.allowedAgentIds=[]` (plugin-only) or `["trpg"]` (dedicated agent)
- `plugins.entries.trpg-runtime-v2.config.debugRuntimeSignals=false`
- `plugins.entries.trpg-runtime-v2.config.traceVerbose=false`
- `plugins.entries.trpg-runtime-v2.config.telemetryExtended=false`
- `plugins.entries.trpg-runtime-v2.config.canonicalSyncEnabled=false`
- `plugins.entries.trpg-runtime-v2.config.canonicalWriteBackEnabled=false`

## Bundled TRPG agent

This extension now includes reusable dedicated-agent assets in `agent/` for standalone install/onboarding.

- Included: `agent/AGENTS.md`, `agent/prompts/*`, `agent/config/*.template.json`.
- Excluded: real credentials/tokens/sessions/lock files and any private auth data.
- Dedicated overlays already point `agentDir` to `~/.openclaw/extensions/trpg-runtime-v2/agent`.
- Plugin-only overlays still work without requiring the bundled `agentDir`.

Recommended onboarding flow after install/link:

1. Apply one example overlay (`examples/openclaw.overlay.onboard.plugin-only.json` or `examples/openclaw.overlay.onboard.trpg-agent.json`).
2. Run `openclaw config validate --json`.
3. Run `openclaw plugins info trpg-runtime-v2`.
4. Dedicated mode only: run `openclaw agents bindings --agent trpg --json`.

## Bilingual docs

- English guide: `docs/USAGE.en.md`
- Korean guide: `docs/USAGE.ko.md`

Verify wiring after applying your overlay:

```bash
openclaw config validate --json
openclaw plugins info trpg-runtime-v2
```

Dedicated mode extra check:

```bash
openclaw agents bindings --agent trpg --json
```

## Smoke checks after link/install

```bash
openclaw plugins info trpg-runtime-v2
openclaw plugins list
```

Tool smoke (from a TRPG agent session):

- `trpg_store_get` with `scope: "state"`
- `trpg_patch_dry_run` with one `set` operation
- `trpg_hooks_query` with `pacingTarget: "steady"`
- `trpg_dice_roll` with `notation: "1d20"`
- `trpg_state_compact` with `mode: "dry-run"`

Apply smoke should be explicit and guarded:

1. Set `plugins.entries.trpg-runtime-v2.config.allowPatchApply=true`
2. Run `trpg_patch_apply` using a previously validated patch id
3. Confirm `appliedFiles` and `checksumLikeSummary`

## Black-box gamer smoke (external agent path bridge)

Use the live smoke harness to verify decision-lane wiring against a separate OpenClaw agent directory.

Recommended deterministic baseline first:

```bash
npm run smoke:gamer-live -- --lane deterministic --scenario happy,modal,stale --turns 4
```

Then resolve and run OpenClaw lane with an external agent path:

```bash
npm run smoke:gamer-live -- --lane openclaw --agent-path /abs/path/to/agent --print-lane-config --scenario happy,modal --turns 3
```

Optional overrides:

- `--openclaw-home <path>`: alternate `~/.openclaw` root for global defaults
- `--agent-id <id>`: fallback when `--agent-path` is not set
- `--provider <provider-id>` / `--model <model-id>`: force provider/model during smoke
- Post-run smoke-session validity check: `npm run smoke:session-validate -- runtime/reports/<run>/report.machine.json`
- Post-run drifter feedback audit + stop classification: `npm run smoke:drifter-audit -- runtime/reports/<run>/report.machine.json`
- Divergence harness (thin vs rich context, varied personalities, free-input bias): `npm run smoke:drifter-divergence -- --lane bridge --richness thin,rich`
- Divergence docs: `docs/drifter-divergence-test-mvp.md`
- Tuning checklist: `docs/drifter-feedback-tuning-checklist.md`
- Stop-criteria standard: `docs/drifter-smoke-stop-criteria.md`
- Focused validity tests: `npm run test:smoke-session-validity`
- Drifter sandbox checkpoint MVP: `npm run drifter:snapshot -- create --workspace <sandbox-root> --session-id <sess-id>`
- Docs: `docs/drifter-snapshot-restore-replay-mvp.md`

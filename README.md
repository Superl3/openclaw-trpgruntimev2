# trpg-runtime (local plugin)

Structured TRPG runtime plugin for OpenClaw.

## What it provides

- `trpg_store_get` - structured read surface over `world/*` with view filtering
- `trpg_patch_dry_run` - patch validation + normalized preview (no writes)
- `trpg_patch_apply` - guarded patch apply (optional tool, config-gated)
- `trpg_hooks_query` - dormant hook and reveal candidate query
- `trpg_dice_roll` - deterministic/traceable dice roll output
- `trpg_state_compact` - lifecycle compaction dry-run/audited apply planner
- `trpg_session_new` / `trpg_session_resume` / `trpg_session_end` - session panel lifecycle
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
openclaw plugins install -l ~/.openclaw/extensions/trpg-runtime
```

or from this repo root:

```bash
openclaw plugins install -l ../.openclaw/extensions/trpg-runtime
```

Then enable/configure under:

- `plugins.entries.trpg-runtime.enabled`
- `plugins.entries.trpg-runtime.config`

## Drop-in / Plug-and-Play

You can use this extension with either mode:

- Plugin-only mode: load only the plugin with `examples/openclaw.overlay.plugin-only.json` and keep your existing agents/bindings.
- Dedicated `trpg` agent mode: use `examples/openclaw.overlay.trpg-agent.json` to load plugin + agent + binding together.

## Onboarding

- Plugin-only onboarding overlay: `examples/openclaw.overlay.onboard.plugin-only.json`
- Dedicated `trpg` onboarding overlay: `examples/openclaw.overlay.onboard.trpg-agent.json`

These are minimal post-install examples with safe defaults:

- `plugins.entries.trpg-runtime.config.allowPatchApply=false`
- `plugins.entries.trpg-runtime.config.allowedAgentIds=[]` (plugin-only) or `["trpg"]` (dedicated agent)
- `plugins.entries.trpg-runtime.config.debugRuntimeSignals=false`
- `plugins.entries.trpg-runtime.config.traceVerbose=false`
- `plugins.entries.trpg-runtime.config.telemetryExtended=false`
- `plugins.entries.trpg-runtime.config.canonicalSyncEnabled=false`
- `plugins.entries.trpg-runtime.config.canonicalWriteBackEnabled=false`

## Bundled TRPG agent

This extension now includes reusable dedicated-agent assets in `agent/` for standalone install/onboarding.

- Included: `agent/AGENTS.md`, `agent/prompts/*`, `agent/config/*.template.json`.
- Excluded: real credentials/tokens/sessions/lock files and any private auth data.
- Dedicated overlays already point `agentDir` to `~/.openclaw/extensions/trpg-runtime/agent`.
- Plugin-only overlays still work without requiring the bundled `agentDir`.

Recommended onboarding flow after install/link:

1. Apply one example overlay (`examples/openclaw.overlay.onboard.plugin-only.json` or `examples/openclaw.overlay.onboard.trpg-agent.json`).
2. Run `openclaw config validate --json`.
3. Run `openclaw plugins info trpg-runtime`.
4. Dedicated mode only: run `openclaw agents bindings --agent trpg --json`.

## Bilingual docs

- English guide: `docs/USAGE.en.md`
- Korean guide: `docs/USAGE.ko.md`

Verify wiring after applying your overlay:

```bash
openclaw config validate --json
openclaw plugins info trpg-runtime
```

Dedicated mode extra check:

```bash
openclaw agents bindings --agent trpg --json
```

## Smoke checks after link/install

```bash
openclaw plugins info trpg-runtime
openclaw plugins list
```

Tool smoke (from a TRPG agent session):

- `trpg_store_get` with `scope: "state"`
- `trpg_patch_dry_run` with one `set` operation
- `trpg_hooks_query` with `pacingTarget: "steady"`
- `trpg_dice_roll` with `notation: "1d20"`
- `trpg_state_compact` with `mode: "dry-run"`

Apply smoke should be explicit and guarded:

1. Set `plugins.entries.trpg-runtime.config.allowPatchApply=true`
2. Run `trpg_patch_apply` using a previously validated patch id
3. Confirm `appliedFiles` and `checksumLikeSummary`


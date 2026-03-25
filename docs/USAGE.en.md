# Usage (EN)

## 1) Overview

`trpg-runtime` is a local OpenClaw extension that exposes structured TRPG world-state tools.
Use it from `~/.openclaw/extensions/trpg-runtime` either as a plugin-only overlay or with a dedicated `trpg` agent.

## 2) Features

1. `trpg_store_get` for scoped world reads (`canon`, `state`, `secrets`, `logs`) with view filters.
2. `trpg_patch_dry_run` for non-writing patch validation and normalized previews.
3. `trpg_patch_apply` for audited writes gated by plugin config.
4. `trpg_faction_tick` to preview or advance offscreen faction motion.
5. `trpg_hooks_query` for reveal/hook candidates with pacing input.
6. `trpg_dice_roll` for deterministic and traceable dice output.
7. `trpg_state_compact` for lifecycle compaction planning and optional audited apply.
8. `trpg_scene_components` for Discord component payload generation.
9. `trpg_session_new`, `trpg_session_resume`, `trpg_session_end` for checkpoint panel lifecycle.
10. `trpg_panel_interact` and `trpg_panel_message_commit` for owner-guarded panel update/edit loops.
11. Agent-level gate through `plugins.entries.trpg-runtime.config.allowedAgentIds`.
12. Path/write safety guards around world-root resolution and patch operations.

## 2.2) Runtime hardening notes

- `trpg_panel_message_commit` should use `dispatchId` from latest `panelDispatch` payload.
- Duplicate commit with same `dispatchId` is idempotent.
- Stale/expired interaction returns standardized `errorCode` values (for example `stale_ui_version`, `route_expired`) with resume hints.
- Analyzer lane remains classifier-only; deterministic engine still performs final action adjudication.
- `preResolvedClaim` is warning-only and never treated as success proof.
- Analyzer memory is bounded TTL cache, not deterministic source-of-truth.
- Raw drift values are hidden in default UX; set `debugRuntimeSignals=true` only for debugging.

## 2.3) Temporal systems notes (Checkpoint 5)

- `delta_time` now drives deterministic temporal updates for memory, freshness, residual traces, and local location drift.
- Temporal update order is fixed: decay -> action footprint -> location projection -> trace append -> panel refresh.
- `infoFreshness` tracks staleness only; freshness decay does not imply fact deletion.
- Persistent location drift requires explicit `locationId`; scenes without `locationId` remain valid and continue running.
- `debugRuntimeSignals=true` reveals raw temporal metrics; default UX keeps qualitative cues.

## 2.4) Quest economy notes (Checkpoint 6)

- Runtime now keeps deterministic `worldPressures` + bounded `quests` pool (`seed/surfaced/active/stalled/resolved/failed/archived/deleted`).
- `deleted` is only used for pre-start opportunity expiration; started quests use `failed`/`successor` paths instead of hard delete.
- Quest growth is constrained by hard live cap + weighted world/attention budget + soft quotas (location/pressure/archetype).
- Quest economy reads compact `QuestTemporalSignal` bridge from temporal systems, not raw temporal internals.
- Panel shows qualitative quest status by default; debug mode exposes raw budget/quota counters.

## 2.5) Rich surfacing + tuning notes (Checkpoint 6B)

- Quest panel summary is layered as actionable / world pulse / recent outcomes.
- Active and surfaced opportunities are shown separately (active top 1, surfaced top up to 2).
- Recent lifecycle outcomes are shown in player-facing natural phrases (no raw lifecycle code terms).
- Tuning telemetry is bounded via ring+snapshot (`surfacing/expiration/mutation/successor rates`, budget utilization, quota saturation, urgency ratio).
- Raw tuning/budget/quota values remain debug-only behind `debugRuntimeSignals=true`.

## 2.6) Optional rich hook lane notes (Checkpoint 6C)

- Runtime adds an optional hook text lane for actionable slots (`active top 1 + surfaced top up to 2`) and a narrow `worldPulse` synthetic slot.
- Lane is non-authoritative: lifecycle/budget/pressure adjudication remains deterministic engine responsibility.
- Input/output contract is compact and bounded (`slotKey` + short structured facts, max 3 overrides).
- `llmShortText` is constrained to one short line and is clipped to `defaultText` length.
- Cache is bounded by source hash + TTL (`hookTextCacheTtlSec`); cache miss can trigger at most one generation pass per action.
- On policy-off/timeout/error/invalid output, runtime immediately falls back to deterministic `defaultText`.
- `worldPulse` keeps deterministic phrase as source-of-truth fallback; rich text is replacement-only (single line), never additive.
- World pressure state itself is never mutated by this lane (`archetype/trend/intensity` computation stays deterministic).
- Debug mode (`debugRuntimeSignals=true`) shows hook metadata (`slotType`, `source`, `cacheHit/cacheMiss`, `skip/fallback reason`) without storing generated text in trace.

## 2.7) Canonical world seed notes (Checkpoint 7A)

- Canonical `WorldSeed` is bootstrap scaffold only; runtime state remains mutable source-of-truth.
- Seed validation enforces minimum scaffold and referential integrity (locations/pressures/factions/npc pool + cross-reference checks).
- New session bootstrap seed lookup order:
  1. `world/canon/world-seed.yaml|yml|json`
  2. `world/state/world-seed.yaml|yml|json`
  3. `world/state/world-seeds.yaml|yml|json`
- Valid seed projects one-way `RuntimeBootstrapInput` (pressure/location baselines) into deterministic runtime initialization.
- Missing or invalid seed returns structured diagnostics and safely falls back to existing defaults.
- Session runtime metadata stores seed provenance (`worldId`, `schemaVersion`, `seedValue`, `seedFingerprint`) for debug/resume visibility.
- Resume uses persisted runtime state first and does not re-bootstrap from seed.
- Starter template is available at `examples/world-seed.template.yaml`; copy it to `world/canon/world-seed.yaml` and tailor IDs/baselines.
- Preflight validation (no session/bootstrap execution): `node scripts/validate-world-seed.mjs world/canon/world-seed.yaml`.

## 2.8) Faction canonical scaffold notes (Checkpoint 7B)

- `canon/factions.yaml` is the operational source-of-truth for `trpg_faction_tick`.
- `WorldSeed.factions` is projection-only scaffold input and does not override `canon/factions.yaml` during tick.
- Canonical faction fields are minimal and fixed: `factionId`, `name`, `enabled`, `homeLocationIds`, `pressureAffinityIds`, `resources`, `heat`, `posture`.
- Missing/invalid faction canon returns structured no-op diagnostics instead of throwing a hard tick error.
- Enabled factions can be zero; this is treated as valid no-op (not a fatal error).
- Starter template is available at `examples/factions.template.yaml`; copy to `world/canon/factions.yaml` and edit values.
- Preflight validation: `node scripts/validate-factions-canon.mjs world/canon/factions.yaml`.
- Drift audit helper (read-only): `node scripts/diff-factions-vs-seed.mjs world/canon/world-seed.yaml world/canon/factions.yaml`.
- Scaffold sync helper defaults to dry-run: `node scripts/scaffold-factions-from-seed.mjs world/canon/world-seed.yaml world/canon/factions.yaml`.
- Apply is explicit (`--apply`), and overwrite requires `--apply --force`.

## 2.10) Canonical sync body notes (Checkpoint 8A)

- Runtime metadata stores provenance/fingerprints only; canonical truth body is not duplicated into runtime metadata.
- Source policy remains explicit:
  - seed side: `seed_bootstrap_only`
  - canonical side: `canon_authoritative`
- Drift audit is structural/bounded (`addedInSeed`, `missingInSeed`, `changedScaffold`, `incompatible`).
- Sync policy defaults to `preserve_operational`:
  - refresh scaffold fields from seed projection (`factionId/name/enabled/homeLocationIds/pressureAffinityIds/posture`)
  - preserve operational fields (`resources`, `heat`) unless `--policy replace_all` is explicitly chosen.
- Faction tick output now includes canonical provenance and drift hint metadata for ops/debug.
- Recommended operator loop:
  1. validate seed
  2. run drift audit
  3. run sync dry-run
  4. apply explicitly (`--apply`, and `--force` for overwrite)
  5. validate canon
  6. run faction tick/runtime session

## 2.9) Anchor lifecycle notes (Checkpoint 7C)

- Deterministic scene loop now owns bounded `anchor` runtime state for long-horizon conflict axes.
- Anchor lifecycle is fixed and bounded: `candidate -> active -> escalated -> resolved|failed -> archived`.
- Cap enforcement preserves started/terminal anchors (no hard-delete); terminal anchors archive by retention.
- Anchor panel projection is qualitative-first in default mode; raw anchor metadata is debug-only (`debugRuntimeSignals=true`).
- Engine trace includes anchor lifecycle events:
  - `engine.anchor.formed`
  - `engine.anchor.advanced`
  - `engine.anchor.escalated`
  - `engine.anchor.resolved`
  - `engine.anchor.failed`
  - `engine.anchor.archived`
- Optional faction/world signal input is non-authoritative and fallback-safe (`missing`/`invalid`/`noop` degradation).

## 2.1) World-data-driven behavior

- Hardcoded setting/scenario content has been removed from runtime prompt hooks.
- The runtime now reads scene/location/relationship context from your world files only.
- Put your own location graph, intro scene fields, and relationship edges in files such as:
  - `world/canon/locations.yaml`
  - `world/state/current-scene.yaml`
  - `world/state/relationships.yaml`
- If those files are sparse or empty, runtime keeps working with neutral fallback guard text (for example: current scene unknown).

## 3) Install / Onboard steps

1. Keep extension files at `~/.openclaw/extensions/trpg-runtime`.
2. Install/link once:

```bash
openclaw plugins install -l ~/.openclaw/extensions/trpg-runtime
```

3. Choose one onboarding overlay in this repo:
   - `examples/openclaw.overlay.onboard.plugin-only.json`
   - `examples/openclaw.overlay.onboard.trpg-agent.json`
4. Merge the selected JSON into your OpenClaw config.
5. Validate and verify:

```bash
openclaw config validate --json
openclaw plugins info trpg-runtime
```

## 4) Config modes (plugin-only vs dedicated agent)

- Plugin-only: keep existing agents/bindings, only load plugin keys under `plugins.load` and `plugins.entries.trpg-runtime`.
- Dedicated agent: add `agents.list` entry `id: "trpg"` + `bindings` route for Discord + plugin config restricted to `allowedAgentIds: ["trpg"]`.
- Both modes keep `allowPatchApply: false` by default for safe onboarding.

## Bundled TRPG agent

- Included files:
  - `agent/AGENTS.md`
  - `agent/prompts/system.md`
  - `agent/prompts/session-start.md`
  - `agent/config/models.template.json`
  - `agent/config/auth-profiles.template.json`
  - `agent/config/trpg-overlay.template.json`
- Excluded files:
  - real API keys/tokens/OAuth credentials
  - local sessions, lock files, private account metadata
- Dedicated overlays use `agentDir: "~/.openclaw/extensions/trpg-runtime/agent"`.
- Plugin-only onboarding stays valid even when you do not use dedicated `agentDir` assets.

Onboarding flow after install:

1. Choose overlay example:
   - `examples/openclaw.overlay.onboard.plugin-only.json`
   - `examples/openclaw.overlay.onboard.trpg-agent.json`
2. Validate config:
   - `openclaw config validate --json`
3. Check plugin:
   - `openclaw plugins info trpg-runtime`
4. Dedicated mode binding check:
   - `openclaw agents bindings --agent trpg --json`

## 5) Validation checklist/commands

```bash
node -e "JSON.parse(require('fs').readFileSync('examples/openclaw.overlay.onboard.plugin-only.json','utf8'));console.log('ok: plugin-only json')"
node -e "JSON.parse(require('fs').readFileSync('examples/openclaw.overlay.onboard.trpg-agent.json','utf8'));console.log('ok: trpg-agent json')"
node scripts/validate-world-seed.mjs examples/world-seed.template.yaml
node scripts/validate-factions-canon.mjs examples/factions.template.yaml
node scripts/diff-factions-vs-seed.mjs examples/world-seed.template.yaml examples/factions.template.yaml
node scripts/scaffold-factions-from-seed.mjs examples/world-seed.template.yaml examples/factions.template.yaml
npm run typecheck
npm run smoke:manifest
```

Expected key lines:
- `ok: plugin-only json`
- `ok: trpg-agent json`
- `manifest ok: trpg-runtime`

## 6) Common failures & fixes

- Plugin not visible: confirm `plugins.load.paths` includes `~/.openclaw/extensions/trpg-runtime`.
- Plugin blocked: confirm `plugins.load.allow` includes `trpg-runtime`.
- Agent cannot call tools: confirm `allowedAgentIds` matches calling agent id (`trpg` in dedicated mode).
- Route not triggering on Discord: replace `<discord_account_id>` and `<discord_channel_id>` in `bindings`.
- Write attempts denied: expected unless `allowPatchApply` is set to `true`.
- World file errors: keep world data under `~/.openclaw/extensions/trpg-runtime/world` or set a valid `worldRoot`.

## 7) Security/guardrails (`allowPatchApply`, `allowedAgentIds`, world path)

- `allowPatchApply`: keep `false` during onboarding; turn on only for audited write workflows.
- `allowedAgentIds`: use `[]` for plugin-only broad access, or `["trpg"]` to constrain usage.
- World path: default world root is extension-local (`~/.openclaw/extensions/trpg-runtime/world`); avoid pointing to unrelated directories.

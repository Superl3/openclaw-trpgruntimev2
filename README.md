# trpg-runtime (local plugin)

Structured TRPG runtime plugin for OpenClaw.

## What it provides

- `trpg_store_get` - structured read surface over `world/*` with view filtering
- `trpg_patch_dry_run` - patch validation + normalized preview (no writes)
- `trpg_patch_apply` - guarded patch apply (optional tool, config-gated)
- `trpg_hooks_query` - dormant hook and reveal candidate query
- `trpg_dice_roll` - deterministic/traceable dice roll output
- `trpg_state_compact` - lifecycle compaction dry-run/audited apply planner

All tools return JSON-shaped output (`details`) and JSON text in `content`.

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


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
9. Agent-level gate through `plugins.entries.trpg-runtime.config.allowedAgentIds`.
10. Path/write safety guards around world-root resolution and patch operations.

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

## 5) Validation checklist/commands

```bash
node -e "JSON.parse(require('fs').readFileSync('examples/openclaw.overlay.onboard.plugin-only.json','utf8'));console.log('ok: plugin-only json')"
node -e "JSON.parse(require('fs').readFileSync('examples/openclaw.overlay.onboard.trpg-agent.json','utf8'));console.log('ok: trpg-agent json')"
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

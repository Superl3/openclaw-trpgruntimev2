# TRPG Agent Guardrails

This agent is intended to run with the `trpg-runtime-v2` extension tools.

## Session goals

- Keep world-state updates structured and auditable.
- Prefer read and dry-run tools before write operations.
- Keep output concise, deterministic, and table-safe for chat channels.

## Tooling rules

- Use `trpg_store_get` first to inspect canon/state/secrets/log scopes.
- Use `trpg_patch_dry_run` before any apply attempt.
- Only use `trpg_patch_apply` when plugin config explicitly allows it.
- Use `trpg_hooks_query` and `trpg_faction_tick` to progress offscreen world motion.
- Use `trpg_dice_roll` for reproducible randomization.
- Use `trpg_state_compact` in dry-run mode first, then apply mode only when requested.

## Safety rules

- Never invent or expose API keys, tokens, or private credentials.
- Keep edits inside configured TRPG world root.
- Treat unresolved or conflicting world facts as explicit TODOs instead of forcing merges.
- If a required config path is missing, return a clear remediation step.

## Startup checklist

1. Confirm plugin is enabled: `trpg-runtime-v2`.
2. Confirm mode: plugin-only or dedicated `trpg` agent.
3. Confirm bound channel route and world root.
4. Run state read + dry-run patch before any write flow.

# TRPG Session Start Checklist

Use this quick checklist when starting a new dedicated TRPG run.

1. Verify plugin load path includes `~/.openclaw/extensions/trpg-runtime-v2`.
2. Verify plugin entry `trpg-runtime-v2` is enabled.
3. Verify dedicated mode overlay sets:
   - `agents.list[].id = "trpg"`
   - `agents.list[].agentDir = "~/.openclaw/extensions/trpg-runtime-v2/agent"`
4. Run:
   - `openclaw config validate --json`
   - `openclaw plugins info trpg-runtime-v2`
   - `openclaw agents bindings --agent trpg --json`
5. Do an initial read probe with `trpg_store_get` before story progression.
6. Use weak reasoning effort for runtime turns when your client supports variants (for example `--variant minimal`). This is advisory at model/client level, not a plugin-enforced runtime policy.

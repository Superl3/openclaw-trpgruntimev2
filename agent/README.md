# Bundled TRPG agent assets

This directory ships reusable, extension-local assets for dedicated TRPG `agentDir` onboarding.

## Included

- `AGENTS.md`: runtime behavior + guardrail instructions for a TRPG session agent.
- `prompts/system.md`: system prompt baseline for TRPG runtime tool usage.
- `prompts/session-start.md`: quick start checklist for a new TRPG run.
- `config/models.template.json`: safe model provider template (placeholder values only).
- `config/auth-profiles.template.json`: auth profile schema template (no real secrets).
- `config/trpg-overlay.template.json`: dedicated-agent overlay template.

## Excluded on purpose

- Any real tokens, API keys, OAuth access/refresh tokens.
- Runtime sessions, lock files, local credentials, or account-private metadata.

## How to use

1. Apply `examples/openclaw.overlay.onboard.trpg-agent.json` (or `examples/openclaw.overlay.trpg-agent.json`).
2. Confirm `agentDir` points to `~/.openclaw/extensions/trpg-runtime-v2/agent`.
3. Run `openclaw config validate --json` and `openclaw plugins info trpg-runtime-v2`.
4. In dedicated mode, verify routing with `openclaw agents bindings --agent trpg --json`.

Plugin-only mode (`examples/openclaw.overlay.onboard.plugin-only.json`) remains valid even if you do not use this `agentDir`.

## Model config source of truth

- Canonical template: `agent/config/models.template.json`.
- Backward-compat convenience copies: `agent/models.template.json`, `agent/models.json`.
- Prefer editing the canonical template and copying as needed to your local runtime config path.

## Reasoning setting scope

- `reasoning` fields in model config are advisory provider/client settings.
- Plugin runtime safety policy is enforced separately by plugin config (`plugins.entries.trpg-runtime-v2.config.*`).

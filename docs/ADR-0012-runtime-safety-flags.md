# ADR-0012: Runtime Safety Flags / Feature Gating (v1 safe mode)

Date: 2026-03-25

## Status

Accepted

## Context

Runtime already contains deterministic core + optional layers (behavioral drift, anchor lifecycle projection, rich hook text, debug/trace telemetry, canonical sync provenance).

To stabilize v1 operations, we need explicit safety flags that:

- keep deterministic core always-on,
- allow selective bypass/fallback for optional risk layers,
- prevent accidental canonical write-back,
- preserve source-of-truth boundaries (runtime mutable state vs canonical files).

## Decision

Introduce runtime safety flags with v1 defaults:

```json
{
  "behavioralDriftEnabled": true,
  "behavioralDriftAffectsRules": false,
  "anchorLifecycleEnabled": true,
  "anchorSummaryOnly": true,
  "richHookActionableEnabled": true,
  "richHookWorldPulseEnabled": true,
  "richHookRecentOutcomesEnabled": false,
  "debugRuntimeSignals": false,
  "traceVerbose": false,
  "telemetryExtended": false,
  "canonicalSyncEnabled": false,
  "canonicalWriteBackEnabled": false
}
```

Implementation policy:

- Deterministic core, temporal systems, quest economy, world seed bootstrap, faction canon scaffold are not disabled by flags.
- `behavioralDriftAffectsRules` is explicitly non-authoritative in v1; rule adjudication remains deterministic and drift-independent.
- `anchorLifecycleEnabled=false` fully bypasses anchor tick and hides anchor rows in panel projection.
- `anchorSummaryOnly=true` keeps anchor layer projection-only (no direct quest/budget/rule mutation path).
- Rich hook lane is split by slot type (`actionable`, `worldPulse`) and always has deterministic fallback text.
- `richHookRecentOutcomesEnabled` remains policy-blocked in v1 to prevent accidental lane expansion.
- `traceVerbose` and `telemetryExtended` only control observability payload depth; they do not alter runtime truth.
- `canonicalSyncEnabled=false` disables automatic canonical sync provenance load path in runtime bootstrap.
- `canonicalWriteBackEnabled=false` blocks canonical file targets in audited patch-apply path.

## Consequences

- Default runtime behavior is safer and easier to operate in production-like channels.
- Optional layers can be toggled without changing truth ownership or deterministic rule path.
- Debug/ops visibility remains available but bounded by default.
- Canonical sync/write-back requires explicit operator intent and flag enablement.

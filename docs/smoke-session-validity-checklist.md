# Smoke Session Validity Checklist

Purpose: validate that a drifter/TRPG-v2 smoke session is structurally trustworthy **before** tuning drifter behavior.

## Core invariants

A smoke session is considered valid only if these hold:

1. **Input-path integrity**
   - Every turn transcript records `received.sessionId`, `received.uiVersion`, `received.sceneId`, `received.originalText`, and `received.textSummary`.
   - Every emitted `sent.customId` parses as a `trpg:v1:*` route and matches the same session/ui/scene visible to the agent.

2. **Turn classification integrity**
   - `sent.type` is explicit and trustworthy (`button` or `modal`).
   - Button turns carry `actionId` and never carry `freeInput`.
   - Modal turns target `action.free_input.submit`, include `freeInput`, and do not pretend to be a button route.

3. **Component suppression / routing integrity**
   - The chosen route must be compatible with what the received panel exposed.
   - Direct input remains a modal-submit path, not a disguised button route.
   - Recommendation/visible-choice labels should still be traceable in transcript text when present.

4. **Transcript / report consistency**
   - `summary.turns === turnTranscripts.length`.
   - Scenario `turnsPlayed` totals match transcript count.
   - `summary.failed` matches failed scenario summaries.
   - Recovery flags only count as valid if the final response resolved successfully.

5. **Sandbox write isolation**
   - Session workspace copies canonical files into a per-session sandbox.
   - Mutations inside the session workspace do not mutate canonical world files unless an explicit save/sync path is used.

6. **Contract / schema drift detection**
   - The smoke mirror schema still requires the expected `drifter` contract.
   - Key enums like `decisionSource` still include `drifter` and `fallback`.
   - Report shape stays compatible with the validator.

## MVP checks implemented

- `scripts/validate-smoke-session.mjs`
  - validates report structure
  - validates route/session/ui/scene linkage per turn
  - validates button vs modal path semantics
  - validates report/transcript summary consistency
  - validates smoke mirror contract shape for drift
- `tests/runtime-gamer-agent/smoke-session-validity.test.mjs`
  - accepts a known-good sample report
  - fails on route/session drift
  - fails on modal/button routing mismatch
  - checks session workspace isolation against canonical files

## How to run

- Validate an existing smoke report:
  - `node ./scripts/validate-smoke-session.mjs runtime/reports/<run>/report.machine.json`
- Run focused tests:
  - `node --test tests/runtime-gamer-agent/smoke-session-validity.test.mjs`

## Intended use

Run this after a smoke session finishes, and before using that session as evidence for drifter tuning, quality claims, or regression signoff.

If this checklist fails, fix smoke-session plumbing first. Do **not** interpret drifter behavior from an invalid smoke run.

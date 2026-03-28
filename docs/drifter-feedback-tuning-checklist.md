# Drifter Feedback Tuning Checklist

Purpose: improve trust in **drifter as a smoke evaluator/player** without auto-promoting changes.

## Short roadmap

1. **Gate on smoke validity first**
   - Run smoke-session validation before reading behavior or UX signals.
2. **Audit feedback quality second**
   - Measure fallback pressure, modal fit, meta leakage, recommendation balance, and route repetition.
3. **Tune in shadow, not auto**
   - Prefer `--improve shadow` while collecting audits and proposal history.
4. **Only tune behavior after trust is acceptable**
   - If fallback/meta leakage dominates, you are tuning the harness, not drifter.
5. **Expand scenario coverage last**
   - Once the basics are stable, add more scenarios and longer runs.

## Highest-value tuning dimensions

### 1) Fallback discipline
If fallback is frequent, the run is mostly measuring the safety net instead of drifter.

Watch for:
- high `fallback` or `invalid` proposal frequency
- fallback-flavored reason text
- low contract compliance

### 2) Modal vs freeform choice fit
Freeform/modal turns should happen when direct intent is useful, and the text should stay in-world.

Watch for:
- modal chosen but free input talks about JSON/buttons/customId
- direct-input scenarios silently collapsing back to button fallback

### 3) Meta vs in-world separation
Evaluator/audit language is useful, but it should not leak into player-intent output.

Watch for:
- reasons dominated by words like `fallback`, `JSON`, `button`, `modal`, `customId`
- freeInput that describes UI mechanics instead of player intent

### 4) Use of state/panel context
Drifter should appear to use visible context like pressure, quests, freshness, memory cues, and recommendations.

Watch for:
- reasons that could fit any turn
- repeated actions with no visible-context explanation

### 5) Recommendation acceptance balance
Recommendations are good guardrails, but blind acceptance hides genuine evaluation quality.

Watch for:
- near-100% recommendation acceptance
- near-0% recommendation usage even when it is the safest option

### 6) Feedback clarity and structure
A tuning run is more trustworthy when the feedback is compact, interpretable, and comparable across turns.

Watch for:
- missing or purely meta reasons
- hard-to-compare prose
- repeated route streaks with no explanation

## MVP checks now implemented

- `scripts/analyze-drifter-feedback.mjs`
  - validates smoke-session integrity first
  - computes feedback-quality audit summary
  - emits gate + dimension scores + checklist + roadmap
- `tests/helpers/drifter-feedback-audit.mjs`
  - reusable audit logic for reports/transcripts
- `scripts/run-gamer-smoke-live.mjs`
  - now embeds `feedbackQualityAudit` into improve reports
  - adds a feedback-quality section to `report.user.md`

## How to run

1. Generate or locate a smoke report:
   - `npm run smoke:gamer-live -- --lane deterministic --scenario happy,modal,stale --turns 3 --improve shadow`
2. Validate the smoke session:
   - `npm run smoke:session-validate -- runtime/reports/<run>/report.machine.json`
3. Audit drifter feedback quality:
   - `npm run smoke:drifter-audit -- runtime/reports/<run>/report.machine.json`
4. Run focused tests:
   - `node --test tests/runtime-gamer-agent/drifter-feedback-audit.test.mjs tests/runtime-gamer-agent/gamer-live-improver.test.mjs tests/runtime-gamer-agent/smoke-session-validity.test.mjs`

## Interpretation guide

- `ready_for_behavior_tuning`
  - good enough to compare prompt/profile changes
- `shadow_tuning_only`
  - useful for observation, but do not trust it as final tuning evidence yet
- `fix_feedback_quality_first`
  - fix fallback/meta/routing quality before changing behavior knobs

## Non-goal

This phase does **not** auto-promote profile changes. It is for confidence-building, auditability, and better tuning conversations.

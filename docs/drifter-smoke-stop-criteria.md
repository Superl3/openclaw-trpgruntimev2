# Drifter Smoke Session Stop Criteria Standard

Purpose: define when a drifter smoke session should stop, how that decision is grounded in the existing validity + feedback-audit system, and how teams should use the result during future drift test sessions.

This is the operating standard for future drifter smoke runs.

## Core rule

Always evaluate a run in this order:

1. **Smoke-session validity first**
   - Structural trustworthiness.
   - Source: `scripts/validate-smoke-session.mjs`
2. **Drifter feedback-quality audit second**
   - Behavioral usefulness.
   - Source: `scripts/analyze-drifter-feedback.mjs` / `tests/helpers/drifter-feedback-audit.mjs`
3. **Stop classification third**
   - Operational decision.
   - Source: `stopCriteria` payload built from the two checks above.

If a run is invalid, stop classification is easy: it is **hard-stop**. Do not read behavior into it.

## Stop classes

### 1) Hard-stop

Meaning: **the session is not valid evidence**. Abort interpretation immediately.

A session is **hard-stop** if any of these are true:

- smoke-session validity fails
- no usable turn transcripts were captured
- route/session/ui/scene linkage is broken badly enough that the run is structurally untrustworthy
- report/transcript consistency is broken badly enough that totals or turn semantics cannot be trusted

Operational response:

- stop the session immediately
- do **not** use the run for drifter tuning, regression claims, or comparison baselines
- fix plumbing/harness integrity first, then rerun from a clean session

### 2) Soft-stop

Meaning: **the run is still diagnostically useful, but extending it is no longer giving clean drifter evidence**.

A session is **soft-stop** if validity passes, but one or more of these quality limits are reached:

- feedback audit gate is `fix_feedback_quality_first`
- fallback pressure exceeds **20%** of turns
- meta/UI language leaks into reasons or modal free input
- lane instability appears (`laneIssues > 0`)
- recovery/stale handling appears in the sample
- repeated-route streak reaches **3+** and the run looks like autopilot instead of fresh evaluation

Operational response:

- finish the current capture window if needed
- stop the run after that window
- save the report as diagnostic evidence
- do **not** keep extending the same run hoping it will become cleaner
- fix prompt/harness/lane issues, then start a new run

Soft-stop runs are allowed in postmortems and harness debugging. They are **not** strong behavior-tuning evidence.

### 3) Success-stop

Meaning: **the run has already delivered enough clean evidence for the current session objective**.

A session is **success-stop** when all of these hold:

- smoke-session validity passes
- at least **3 turns** of usable evidence were captured
- feedback audit gate is `shadow_tuning_only` or `ready_for_behavior_tuning`
- fallback pressure is **20% or less**
- no lane issues were recorded
- no recovery/stale contamination was recorded in the sample
- no modal meta leakage is present

Success-stop has two practical submeanings:

- `shadow_tuning_only`
  - good observation sample; useful for collecting comparable evidence
- `ready_for_behavior_tuning`
  - strong enough for behavior-tuning comparisons against other valid runs

Operational response:

- stop on purpose
- archive the report immediately
- cite the audit + stop payload when discussing the run
- compare future changes only against other success-stop runs when possible

## Why the thresholds work

These stop classes separate three different failure modes that used to blur together:

- **Hard-stop:** the harness/session record is broken
- **Soft-stop:** the harness works, but the sample quality is degrading
- **Success-stop:** the sample is already good enough; more turns mainly add noise or drift

This keeps teams from making two common mistakes:

1. tuning drifter from invalid runs
2. overextending a good run until it becomes a worse one

## Wiring to the existing audit stack

The runtime now supports a shared `stopCriteria` payload.

### Sources

- `scripts/validate-smoke-session.mjs`
  - structural validity
- `tests/helpers/drifter-feedback-audit.mjs`
  - feedback-quality audit
  - stop-criteria builder
- `scripts/analyze-drifter-feedback.mjs`
  - emits `stopCriteria` alongside validity + feedback audit
- `scripts/run-gamer-smoke-live.mjs`
  - embeds `smokeSessionValidity`, `feedbackQualityAudit`, and `stopCriteria` into improve reports
  - renders a stop-criteria section in `report.user.md`

### Output shape

Expect a machine-readable block like:

- `stopCriteria.summary.classification`
  - `hard_stop`, `soft_stop`, `success_stop`, or `continue`
- `stopCriteria.summary.shouldStop`
- `stopCriteria.summary.operatorAction`
- `stopCriteria.summary.primaryReason`
- `stopCriteria.criteria.hardStop[]`
- `stopCriteria.criteria.softStop[]`
- `stopCriteria.criteria.successStop[]`
- `stopCriteria.evidence.*`

`continue` is an internal machine state meaning no stop class has matched yet. Operators should keep collecting until the run reaches success-stop or soft-stop, unless a separate human timebox ends the session.

## Team operating procedure

Use this flow during future drift test sessions:

1. Run the smoke session normally.
2. As soon as a report exists, check validity.
3. Check drifter feedback audit.
4. Read `stopCriteria`.
5. Act on the classification:
   - `hard_stop` → throw out the run as tuning evidence
   - `soft_stop` → save it as diagnostics and restart after fixes
   - `success_stop` → save it as the reference sample and stop deliberately
   - `continue` → keep collecting within the planned capture window

## Recommended command flow

1. Generate a report:
   - `npm run smoke:gamer-live -- --lane deterministic --scenario happy,modal,stale --turns 3 --improve shadow`
2. Validate structure:
   - `npm run smoke:session-validate -- runtime/reports/<run>/report.machine.json`
3. Audit drifter quality + stop class:
   - `npm run smoke:drifter-audit -- runtime/reports/<run>/report.machine.json`
4. Read:
   - `feedbackQualityAudit.summary.gate`
   - `stopCriteria.summary.classification`
   - `stopCriteria.summary.primaryReason`

## Interpretation policy

### Allowed uses by class

- **hard-stop**
  - allowed: plumbing debugging only
  - not allowed: tuning evidence, baseline comparison, signoff

- **soft-stop**
  - allowed: debugging, prompt/harness diagnosis, regression smell detection
  - not allowed: final behavior claims, final comparative tuning evidence

- **success-stop**
  - allowed: baseline comparison, tuning review, shadow-mode evidence, release-readiness discussion
  - still not allowed: auto-promotion without separate human review

## Practical guidance for operators

- Do not keep pushing past a soft-stop just to collect more turns.
- Do not keep pushing past a success-stop just because the run still looks interesting.
- If you need broader coverage, start another clean run rather than stretching one run too far.
- When comparing prompt/profile changes, prefer comparing **success-stop vs success-stop** runs.
- If only soft-stop runs exist, treat conclusions as directional, not decisive.

## Standard summary to include in future reviews

When citing a smoke run, include:

- report path
- validity result
- feedback audit gate
- stop classification
- primary stop reason
- whether the run is being used as diagnostic evidence or tuning evidence

That keeps future drift-session reviews comparable and auditable.

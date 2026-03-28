# Checkpoint 5 / Part 5 Completion Checklist

_Status: execution checklist for closing the Time / Memory / Trace core._

This document turns the accepted Checkpoint 5 ADR into **objective done criteria** for the runtime.
It is intentionally stricter than the ADR: the point is to decide whether Part 5 is actually finished, not merely “mostly implemented.”

Primary sources:
- `docs/ADR-0003-checkpoint5-time-memory-trace.md`
- `docs/USAGE.en.md` section 2.3
- `tests/runtime-temporal/runtime-temporal.test.mjs`
- current runtime integration points in `src/runtime-core/*`, `src/runtime-adapter/openclaw/checkpoint0-lifecycle.ts`, and panel rendering

---

## 1. Scope summary

Checkpoint 5 is the deterministic temporal systems core. It is complete only when the runtime reliably does all of the following:

- advances compact temporal state from `delta_time`
- persists and resumes that state as runtime source-of-truth
- updates memory / freshness / traces / local location drift in a fixed order
- keeps analyzer responsibility narrow (classification only)
- surfaces qualitative player-facing signals by default
- exposes raw temporal values only in debug paths
- emits bounded trace/debug evidence without event spam
- tolerates scenes without explicit `locationId`

If a capability is useful but lives outside those boundaries, it is **not** a Part 5 completion requirement.

---

## 2. Objective completion criteria

A maintainer can mark Part 5 complete only if **all** items in this section are true.

### 2.1 Runtime state shape exists and is stable

- [ ] Deterministic scene loop state includes the full temporal runtime body:
  - [ ] `locationStates`
  - [ ] `npcMemory`
  - [ ] `infoFreshness`
  - [ ] `residualTraces`
- [ ] Temporal state is initialized via a single canonical path, not ad-hoc per caller.
- [ ] Serialization / persistence format is stable enough that resume does not reconstruct or “best guess” missing temporal data during normal flows.
- [ ] Temporal fields are treated as engine-owned state, not analyzer-authored state.

**Done evidence**
- Code path can be pointed to in runtime core for initialization + normalization.
- A persisted session snapshot contains temporal state and resume loads it unchanged except for intentional deterministic advancement.

### 2.2 Temporal update pipeline is deterministic and ordered

- [ ] Temporal update pipeline runs after action resolution.
- [ ] Pipeline order is fixed and matches the documented contract:
  1. [ ] decay
  2. [ ] action footprint write
  3. [ ] location projection
  4. [ ] trace append
  5. [ ] panel refresh / render projection
- [ ] Re-running the same starting loop + same action + same `nowIso` produces the same temporal result.
- [ ] No analyzer output is required for temporal state to update.
- [ ] `delta_time` affects world-facing temporal state even when the player chooses low-information actions like wait.

**Done evidence**
- Determinism test passes.
- A code review of the action resolution pipeline shows only one temporal update entrypoint.

### 2.3 Memory behavior is correct and bounded

- [ ] Interaction flows that should affect NPC memory actually create/update `npcMemory`.
- [ ] Memory decay trends toward neutral / lower intensity over time instead of growing forever.
- [ ] Memory update is location-aware when `locationId` exists.
- [ ] Memory logic remains compact; no unbounded per-turn fan-out or event spam is introduced.
- [ ] Default player UX does not dump raw familiarity/sentiment numbers.

**Done evidence**
- Talk / interaction test covers creation and decay behavior.
- Debug mode can still prove the raw state changed.

### 2.4 Freshness behavior is correct and non-destructive

- [ ] Observational / clue-like actions create or update `infoFreshness`.
- [ ] Freshness decays as time advances.
- [ ] Freshness decay does **not** imply fact deletion; stale knowledge remains represented as stale, not silently erased.
- [ ] Freshness logic works with and without explicit location context.
- [ ] Default player UX uses qualitative phrasing instead of raw freshness numbers.

**Done evidence**
- Targeted test proves stale clue state remains present after decay.

### 2.5 Residual trace behavior is correct and bounded

- [ ] High-footprint actions such as rush/move create residual traces when appropriate.
- [ ] Traces decay over time.
- [ ] Expired traces are removed or stop contributing after bounded lifetime.
- [ ] Trace counts and intensity stay bounded; there is no unbounded accumulation during normal play.
- [ ] Runtime emits compact temporal summary evidence instead of one noisy trace event per internal mutation.

**Done evidence**
- Test proves trace creation, decay, and expiration.
- Trace event review confirms bounded summary behavior.

### 2.6 Location drift / local state projection is correct

- [ ] When `locationId` exists, local temporal pressure is projected into `locationStates`.
- [ ] Location state reacts to relevant temporal inputs such as residual traces.
- [ ] Scene-facing pressure/adjudication can reflect the projected location state.
- [ ] Scenes with no explicit `locationId` remain valid and do not crash or write fake location state.
- [ ] The engine does not pretend to simulate a full world graph; only local/current-location projection is required.

**Done evidence**
- Test proves a location state changes and affects scene pressure.
- Separate test or regression proof covers missing-`locationId` safety.

### 2.7 Trace/debug surfacing is useful but bounded

- [ ] Runtime trace includes compact temporal update evidence, including `engine.temporal.updated`.
- [ ] The summary includes enough data to audit whether memory / freshness / traces / location changed.
- [ ] Default non-debug UX exposes only qualitative temporal signals.
- [ ] `debugRuntimeSignals=true` reveals raw temporal metrics for diagnosis.
- [ ] Debug output is bounded and intentionally compact; it should help diagnose, not flood.

**Done evidence**
- Resume/integration test proves temporal trace event emission.
- Panel rendering shows qualitative summaries in normal mode and raw metrics in debug mode.

### 2.8 Persistence and resume are first-class, not afterthoughts

- [ ] Session persistence stores temporal state as part of deterministic loop truth.
- [ ] Resume restores temporal state without drift, reset, or lossy rehydration.
- [ ] Resume preserves qualitative/debug surfacing consistency.
- [ ] No separate side cache is required to reconstruct Part 5 state.
- [ ] Save/load flows do not silently drop temporal integrity during ordinary session lifecycle.

**Done evidence**
- Integration test proves resumed session temporal state deep-equals pre-resume temporal state.
- Manual smoke can confirm panel summaries remain coherent after resume.

### 2.9 Boundary correctness versus later checkpoints

- [ ] Analyzer boundary stays classifier-only for Part 5 behavior.
- [ ] Quest economy only consumes compact downstream signals in later checkpoints; Part 5 itself does not depend on quest systems.
- [ ] Part 5 completion does not require anchor/faction/canonical sync features.
- [ ] Safety flags do not disable the deterministic temporal core if the repo policy says temporal systems are always-on core behavior.

**Done evidence**
- Imports / call graph do not show reverse dependency from Part 5 core into later optional features.
- Documentation and tests stay aligned with always-on deterministic core behavior.

---

## 3. Validation checklist

Use this section as the release gate.

### 3.1 Code validation

- [ ] There is one obvious temporal pipeline entrypoint in runtime core.
- [ ] Temporal code paths do not duplicate logic between panel, engine, and adapter layers.
- [ ] Qualitative summary generation is derived from temporal state rather than maintaining a second source-of-truth.
- [ ] Missing `locationId` is handled intentionally, not via accidental `undefined` tolerance.
- [ ] Event payload size for temporal summaries is compact and reviewable.

### 3.2 Documentation validation

- [ ] ADR, usage docs, and actual runtime behavior agree on update order and scope.
- [ ] This checklist remains accurate after any implementation change made under Part 5.
- [ ] Any new debug field added for temporal systems is documented in usage or debug notes if player-visible.

### 3.3 Regression validation

- [ ] Part 5 behavior does not regress panel rendering in default mode.
- [ ] Part 5 behavior does not require analyzer lane to be present.
- [ ] Part 5 behavior does not break seed/bootstrap flows.
- [ ] Part 5 behavior does not introduce runaway trace growth across repeated waits/actions.

---

## 4. Tests required before declaring completion

The following tests are the minimum bar.

### 4.1 Existing required automated tests

Run:

```bash
node --test tests/runtime-temporal/runtime-temporal.test.mjs
```

This suite must pass and keep covering at least:

- [ ] `delta_time` decays info freshness without deleting clue state
- [ ] talk updates NPC memory and wait decays memory toward neutral
- [ ] rush/move leaves residual traces and traces decay or expire
- [ ] location state reacts to temporal traces and affects scene pressure
- [ ] temporal updates are deterministic without analyzer lane
- [ ] engine trace records temporal updates and resume keeps temporal state

### 4.2 Additional targeted tests that should exist before calling Part 5 “finished”

If any are missing, Part 5 is not fully closed yet.

- [ ] **No-location safety test**
  - scene action with no `locationId`
  - no crash
  - no bogus location state write
  - other temporal systems still behave sensibly
- [ ] **Debug surfacing test**
  - default panel shows qualitative temporal cues only
  - debug panel shows raw temporal metrics
- [ ] **Bounded trace growth test**
  - repeated high-footprint actions over many turns
  - trace count/intensity stays bounded and/or expires predictably
- [ ] **Pipeline order regression test**
  - catches accidental reorder of decay / footprint / projection / append
- [ ] **Persistence smoke beyond resume tool**
  - session lifecycle path that writes state and reconstructs render output still preserves temporal truth

### 4.3 Optional but strongly recommended tests

- [ ] Bootstrap/start-of-session test that proves initial temporal state is normalized exactly once.
- [ ] Test that qualitative summary wording remains stable enough to avoid accidental empty/contradictory panel text.
- [ ] Trace verbosity test proving debug/verbose mode enriches evidence without exploding event volume.

---

## 5. UX expectations

Part 5 is not done if the system is technically correct but unreadable or misleading.

### 5.1 Player-facing default UX

- [ ] Panel/default response uses qualitative temporal cues.
- [ ] The player can infer “things are getting hotter / colder / stale / remembered” without seeing engine internals.
- [ ] Temporal messaging is compact and does not crowd out the scene itself.
- [ ] No raw debug keys, counters, or implementation jargon leak into normal play.

### 5.2 Debug UX

- [ ] `debugRuntimeSignals=true` exposes raw temporal metrics for diagnosis.
- [ ] Debug fields are coherent with the actual state store.
- [ ] Debug output is terse enough to inspect in Discord/logs without overwhelming the rest of the panel.
- [ ] Temporal trace event data is sufficient for postmortem debugging.

### 5.3 Operator/developer UX

- [ ] A developer can quickly answer: what changed, why did it change, and did it persist?
- [ ] Temporal bugs can be diagnosed from tests + trace + debug panel without needing analyzer introspection.
- [ ] There is a clear distinction between player-facing summary text and engine-facing raw metrics.

---

## 6. Persistence / resume expectations

These are release-blocking, not nice-to-have.

- [ ] Temporal state is stored inside deterministic session state, not a transient cache.
- [ ] Resume does not zero out or recreate temporal arrays unless the session is genuinely new.
- [ ] After resume, the same qualitative summary class should be derivable from persisted state.
- [ ] After resume, debug/raw metrics should align with the exact stored state.
- [ ] Any session repair/bootstrap logic must not clobber valid temporal state during ordinary resume.

Manual smoke checklist:

- [ ] Start session
- [ ] perform action that changes temporal state
- [ ] confirm summary/trace changed
- [ ] resume session
- [ ] confirm temporal state and summary continuity
- [ ] perform another action
- [ ] confirm pipeline continues from resumed state, not a reset baseline

---

## 7. Explicit non-goals

Do **not** hold Part 5 open for these.

- [ ] Full quest lifecycle economy body
- [ ] Macro world scheduler / society simulation
- [ ] Full location graph simulation for every area
- [ ] Anchor lifecycle / long-horizon conflict model
- [ ] Faction canon scaffold and faction tick system
- [ ] Canonical seed sync / drift audit / reconciliation body
- [ ] Rich hook lane / worldPulse presentation polish beyond temporal summaries
- [ ] Analyzer becoming a temporal simulation authority

If work falls into one of the buckets above, it belongs to later checkpoints even if it touches temporal data.

---

## 8. Recommended execution order for the next implementation pass

When using this checklist as an execution plan, do the work in this order:

1. **Gap audit**
   - compare current code/tests/docs against sections 2-7
   - list missing release blockers only
2. **Close correctness gaps first**
   - determinism
   - no-location safety
   - persistence/resume integrity
   - bounded trace behavior
3. **Close observability gaps second**
   - debug surfacing
   - compact temporal trace evidence
   - panel default/debug split
4. **Close test gaps third**
   - add missing targeted tests before refactoring broader code
5. **Only then mark Part 5 complete**
   - after test pass + doc alignment + manual smoke

---

## 9. Exit rule

Checkpoint 5 / Part 5 is complete only when:

- every item in section 2 is true,
- required tests in section 4 pass,
- no release-blocking gaps remain in sections 5-6,
- and no open work is being hidden inside later-checkpoint scope.

Until then, treat Part 5 as **implemented but not fully closed**.

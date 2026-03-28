# Drifter Behavior Divergence Test MVP

Purpose: check whether **bridge/harness/context thinness** is suppressing drifter behavior diversity, instead of assuming the agent itself is inherently flat.

## Core idea

Run the same short, high-divergence scenes under a small matrix:

- **thin context** vs **rich context**
- **multiple character personalities**
- **drifter style preset kept separate from character personality**
- **free-input enabled and preferred**

Then measure whether selected actions and free-input language actually diverge.

If richer context + personality variation still collapse to near-identical choices, that is stronger evidence of model/agent weakness.
If diversity rises only when context is richer and modal/free-input is available, that is evidence that the harness was flattening behavior.

## MVP checklist

- [x] Define several short, high-divergence scenarios
- [x] Separate drifter behavior style from played character personality
- [x] Bias the harness toward modal/free-input instead of button-only play
- [x] Support thin vs rich context renderings of the same scene
- [x] Support multiple independent personality profiles
- [x] Provide a direct decision-lane runner for deterministic/openai/openclaw/bridge lanes
- [x] Emit machine-readable and markdown reports
- [x] Add tests for context construction and divergence scoring

## Included scenarios

1. **Sudden Intimacy**
   - a dangerous person unexpectedly opens up emotionally
   - likely divergences: reciprocate / listen / deflect / exploit / withdraw

2. **Hostage Escape**
   - ally at knifepoint during a deteriorating escape setup
   - likely divergences: negotiate / rush / signal / cut losses

3. **Stealable Treasure**
   - easy theft with high suspicion and moral temptation
   - likely divergences: steal / inspect / swap / leave

4. **Mercy Kill Secret**
   - morally ugly time-pressure choice with social fallout
   - likely divergences: comfort / expose / kill / search

## Personality vs drifter style

This test makes a deliberate distinction:

- **character personality** = who the played character is
  - duty-bound guard
  - hungry opportunist
  - wounded romantic
  - cold strategist

- **drifter behavior style** = how the evaluator/player tends to express behavior selection
  - neutral observer
  - curiosity-forward
  - pressure-cooker

The point is to avoid smearing “the drifter is cautious” together with “the character is cautious.”

## Why direct decision-lane testing first

The existing happy/modal/stale smoke is good for route validity and basic evaluator hygiene, but it is not ideal for measuring behavioral diversity because:

- scenario space is small and operational
- recommendations are prominent
- many runs are still button-led
- scene stakes are not deliberately divergence-heavy

So this MVP directly probes the **decision lane** with controlled visible contexts.
That isolates whether the bridge prompt + visible context can produce differentiated behavior at all.

## How to run

### Fast plumbing check

```bash
node ./scripts/run-drifter-divergence.mjs --lane deterministic
```

### Bridge-focused divergence experiment

```bash
node ./scripts/run-drifter-divergence.mjs \
  --lane bridge \
  --richness thin,rich \
  --drifter-styles neutral-observer,curiosity-forward \
  --repeats 1
```

### OpenClaw-configured model

```bash
node ./scripts/run-drifter-divergence.mjs \
  --lane openclaw \
  --agent-id trpg-v2 \
  --richness thin,rich \
  --repeats 1 \
  --print-lane-config
```

Outputs go to:

- `runtime/reports/drifter-divergence/<lane>-<timestamp>/results.json`
- `runtime/reports/drifter-divergence/<lane>-<timestamp>/report.md`

## What to look for

Key signals:

- **actionChangeRate**: same scenario/personality, thin -> rich, did the chosen route change?
- **lexicalChangeRate**: same pair, did the free-input language change meaningfully?
- **richnessActionSetDistance**: are thin/rich runs drawing from different action sets?
- **recommendationAcceptanceRate**: still useful as a smell check for autopilot

Interpretation:

- **high change under rich context** → harness/context was likely suppressing diversity
- **low change even with rich context + personality variation** → genuine behavioral collapse is more likely
- **lexical change without action change** → context affects surface expression more than decision policy
- **action change without lexical change** → route policy moves, but free-input style may still be flattened

## Recommended next step after MVP

If this direct lane experiment shows richer diversity, the next high-value step is to port the same scenario pack into a full runtime smoke loop with:

- richer visible panel summaries
- stronger free-input affordances
- reduced recommendation salience
- explicit logging of modal-vs-button choice pressure

That will tell you how much diversity is lost again when the full runtime harness is reintroduced.

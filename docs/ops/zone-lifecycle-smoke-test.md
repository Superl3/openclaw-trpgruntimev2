# Zone Lifecycle Smoke Test (Minimal fixture / reversible)

## Preconditions
- source: /home/superl3/openclaw
- runtime state: /home/superl3/.openclaw/extensions/trpg-runtime-v2/workspace/world/state
- goal: verify candidate detection and audited gate behavior with minimal world pollution

## 1) Core runtime sanity
- wsl.exe -d Ubuntu-24.04 -- bash -lc "cd /home/superl3/openclaw && pnpm openclaw config validate --json"
- wsl.exe -d Ubuntu-24.04 -- bash -lc "cd /home/superl3/openclaw && pnpm openclaw plugins info trpg-runtime-v2"
- wsl.exe -d Ubuntu-24.04 -- bash -lc "cd /home/superl3/openclaw && pnpm openclaw agents bindings --json"
- wsl.exe -d Ubuntu-24.04 -- bash -lc "cd /home/superl3/openclaw && pnpm openclaw health --json"

Expected:
- config valid
- plugin loaded with trpg_state_compact
- TRPG binding stays channel 1485667732824522903 (trpg-v2 route)
- health ok

## 2) Read only precheck (protected vs prunable)
Inspect these first:
- compaction-state.yaml, archive-summaries.yaml
- world-pressure.yaml, world-seeds.yaml, npc-memory.yaml, world-events.yaml
- current-scene.yaml, relationships.yaml, unresolved-hooks.yaml

Quick decision rule:
- protected: current and nearby, live hook ladder, high tension seeds, visible NPC critical memory
- prunable fixture target: remote, stale, low significance, replaceable

## 3) Backup before fixture injection
Create timestamped backups:
- compaction-state.yaml
- archive-summaries.yaml
- world-pressure.yaml
- world-seeds.yaml
- npc-memory.yaml
- world-events.yaml

Pattern:
- *.bak-<YYYYMMDD-HHMMSS>-lifecycle-verify

## 4) Candidate zero fallback
If dry run returns zero candidates, inject minimal stale fixtures (3 to 6 units):
- zone lifecycle rows for remote zones with stale active and dormant
- low heat stale rumor seed without live hook or reveal linkage
- optional minor stale npc memory
- stale low impact events history overflow only if noise_remove verification is needed

Do not touch:
- current zone and nearby zones
- inventory, funds, player condition
- active interrogation or hard unresolved hooks

## 5) Dry run compaction (stage 1)
Command skeleton:
- wsl.exe -d Ubuntu-24.04 -- bash -lc "cd /home/superl3/openclaw && pnpm openclaw agent --agent trpg-v2 --local --session-id trpg-lifecycle-smoke --message <PROMPT> --json"
Prompt text:
- trpg_state_compact 도구를 mode=dry-run trigger=interval maxCandidates=40 includeProtected=true로 실행하고 summary/candidates/protected_refs/skipped_refs/dry_run_result만 JSON으로 출력해.

Expected:
- candidate report generated
- active_to_dormant candidate >= 1
- dormant_to_archived candidate >= 1
- protected and skipped reported
- planned operations restricted to state/*
- no unchecked direct write
- if no explicit lifecycle tool invocation intent exists in the turn, runtime log should show lifecycle fallback dry-run preview

## 6) Audited apply gate (stage 2: missing audit)
Command skeleton: same as section 5
Prompt text:
- trpg_state_compact 도구를 mode=audited-apply trigger=interval maxCandidates=40 includeProtected=true로 호출하되 audit 필드는 넣지 말고, 실패 요약 JSON만 보여줘.

Expected:
- fail with audit gate error
- dry run may succeed but apply remains blocked

## 7) Audited apply gate (stage 3: valid audit)
Command skeleton: same as section 5
Prompt text:
- trpg_state_compact 도구를 mode=audited-apply trigger=interval maxCandidates=40 includeProtected=true audit={approved:true,approvedBy:canon-auditor,verdict:pass,conflictStatus:non-conflicting,canonAbsorptionVerdict:accept,note:lifecycle-fixture-e2e}로 호출하고 결과에서 ok/summary/dry_run_result.patchId/apply_result.appliedFiles/apply_result.auditedApply 만 JSON으로 출력해.

Expected:
- apply succeeds only with valid audit metadata
- applied files stay under state/*
- no implicit canon/* write in this flow

## 8) Invalid target boundary smoke (optional)
Command skeleton: same as section 5
Prompt text:
- trpg_patch_apply 도구를 patchPayload={title:invalid-target-smoke,allowNewFiles:true,operations:[{op:set,file:notes/invalid-target.yaml,pointer:/,value:{smoke:true}}]} audit={approved:true,approvedBy:canon-auditor,verdict:pass,conflictStatus:non-conflicting,canonAbsorptionVerdict:accept,note:invalid-target-boundary}로 호출하고 결과에서 ok/error/disallowedTargets만 JSON으로 출력해.

Expected:
- fail by path boundary guard

## 9) Protected object preservation checklist
Confirm protected exclusions still hold:
- current scene zone and nearby zones
- high tension and long tail seeds
- visible NPC memory anchors
- core player state and active hooks

## 10) Contract non regression quick checks
- intro and context first
- freeform first
- hidden name guard
- impossible action guard
- scene persistence
- transition only faction tick
- menu first not reintroduced

## 11) Rollback procedure
If cleanup is needed, restore from backup timestamp:
- cp world/state/compaction-state.yaml.bak-<TS>-lifecycle-verify world/state/compaction-state.yaml
- cp world/state/archive-summaries.yaml.bak-<TS>-lifecycle-verify world/state/archive-summaries.yaml
- cp world/state/world-pressure.yaml.bak-<TS>-lifecycle-verify world/state/world-pressure.yaml
- cp world/state/world-seeds.yaml.bak-<TS>-lifecycle-verify world/state/world-seeds.yaml
- cp world/state/npc-memory.yaml.bak-<TS>-lifecycle-verify world/state/npc-memory.yaml
- cp world/state/world-events.yaml.bak-<TS>-lifecycle-verify world/state/world-events.yaml

Re run section 1 sanity checks after rollback.

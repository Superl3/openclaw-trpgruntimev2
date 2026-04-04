---
name: resolve-combat-turn
description: Main-session combat turn orchestrator. Uses runtime tools in a safe order with idempotency and version checks.
---

# resolve-combat-turn

## Load when
- 전투 중 단일 턴 판정을 안정적으로 처리해야 할 때.
- 재시도 가능성이 있는 환경에서 중복 적용을 막아야 할 때.

## Role boundary
- Tool 호출 순서와 안전 가드 적용을 담당한다.
- 세계 상태 진실 소유자는 런타임 코어이며, 본 skill은 orchestration만 담당한다.

## Required inputs
- `session_id`
- `actor_id`
- `action_intent`
- `target`
- `idempotency_key_base`

## Procedure
1. `trpg_scene_components`로 현재 전장/대상 상태 확인.
2. `trpg_dice_roll` 실행 (`idempotency_key={base}:roll`).
3. `trpg_store_get`로 최신 `state_version` 조회.
4. `trpg_patch_dry_run` 실행 (`expected_state_version` 포함).
5. `trpg_patch_apply` 실행 (`idempotency_key={base}:apply`, `expected_state_version` 포함).
6. `trpg_panel_message_commit` 실행 (`idempotency_key={base}:commit`, apply tx 참조).

## Failure handling
- `E_STATE_VERSION_CONFLICT`: `trpg_store_get`부터 재시작.
- `E_IDEMPOTENCY_CONFLICT`: 새 `idempotency_key_base` 발급 후 재시도.
- `E_PATCH_VALIDATION_FAILED`: patch intent를 최소 수정 후 dry-run부터 재실행.

## Output contract
- `turn_result`
- `apply_tx_id`
- `new_state_version`
- `panel_commit_id`
- `replay` (idempotent replay 여부)

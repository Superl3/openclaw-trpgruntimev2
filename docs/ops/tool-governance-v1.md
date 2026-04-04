# TRPG Tool Governance v1

## 목적
본 문서는 TRPG 런타임 도구의 안전한 실행 표준을 정의한다.

핵심 목표:
- 글로벌 도구 등록을 유지하면서도 단계별 호출 통제를 강제한다.
- mutate 계열 도구의 멱등성(idempotency)을 보장한다.
- `dry_run -> apply -> commit` 체인의 동시성 안전성을 확보한다.
- 도구 응답 에러 형식/코드를 표준화한다.
- Tool(저수준 실행)과 Skill(고수준 오케스트레이션) 역할을 분리한다.

---

## 1) 세션 상태 모델

- `NO_SESSION`: 현재 활성 세션 없음
- `ACTIVE`: 세션 진행 중
- `PAUSED`: 세션 대기/중단
- `ENDED`: 세션 종료

권장 상태 전이:
- `NO_SESSION -> ACTIVE`: `trpg_session_new | trpg_session_load | trpg_session_resume`
- `ACTIVE -> PAUSED`: 운영 정책상 pause/save 처리 시
- `PAUSED -> ACTIVE`: `trpg_session_resume`
- `ACTIVE|PAUSED -> ENDED`: `trpg_session_end`
- `ENDED -> ACTIVE`: `trpg_session_load | trpg_session_resume`

---

## 2) 실행 가드 순서 (필수)

모든 도구 실행 전에 아래 검증을 순서대로 수행한다.

1. 도구 등록 여부 확인
2. 현재 세션 상태에서 허용되는 도구인지 확인
3. 호출 actor scope(`player|gm|system`) 확인
4. mutate 도구인 경우 `idempotency_key` 존재 확인
5. 버전 민감 도구인 경우 `expected_state_version` 존재 및 충돌 확인
6. 실행
7. 감사 로그 기록

fail-closed 원칙: 하나라도 검증 실패하면 실행하지 않는다.

---

## 3) 멱등성 표준

### 3.1 적용 범위
- 기본적으로 모든 mutate 도구에 `idempotency_key`를 요구한다.
- 추가 권장: 랜덤성 도구(`trpg_dice_roll`)도 `idempotency_key`를 받아 재시도 중복을 방지한다.

### 3.2 키 범위 및 동작
- 키 범위: `(session_id, tool_name, idempotency_key)`

동일 키 처리 규칙:
- 동일 키 + 동일 payload: 기존 결과 재반환
- 동일 키 + 다른 payload: 충돌 에러(`E_IDEMPOTENCY_CONFLICT`)
- 동일 키 처리 중: 진행중 에러(`E_REQUEST_IN_FLIGHT`, retryable)

권장 TTL: 24시간

---

## 4) 동시성 제어 (Optimistic Concurrency)

버전 민감 도구는 `expected_state_version`을 받아 현재 상태 버전과 비교한다.

- 일치: 실행 허용
- 불일치: `E_STATE_VERSION_CONFLICT` 반환 후 재조회 유도

권장 실행 체인:
1. `trpg_store_get`로 `state_version` 조회
2. `trpg_patch_dry_run(expected_state_version)`
3. `trpg_patch_apply(expected_state_version, idempotency_key)`
4. `trpg_panel_message_commit(related_tx_id, idempotency_key)`

---

## 5) dry_run / apply / commit 경계

- `trpg_patch_dry_run`: 검증 전용, 상태 변경 금지
- `trpg_patch_apply`: 상태 변경 + 새 상태 버전/tx_id 발급
- `trpg_panel_message_commit`: 가능하면 `apply` tx와 연결해 추적성 강화

권장: `apply`와 `commit`의 연계를 로그에서 역추적 가능하게 유지한다.

---

## 6) 감사 로그/관측성

모든 호출에 대해 최소 필드를 기록한다.

- `timestamp`
- `request_id`
- `session_id`
- `actor_id`, `actor_scope`
- `tool_name`
- `outcome(success|fail)`
- `error_code`
- `state_version_before`, `state_version_after` (mutate 시)
- `idempotent_replay` 여부

---

## 7) Tool vs Skill 역할 분리

- Tool: 타입된 I/O, 권한 검증, 상태 변경, 감사 추적
- Skill: 여러 Tool을 안전 순서로 묶는 플레이북

즉 Skill은 Tool 대체가 아니라 상위 orchestration 레이어다.

---

## 8) Definition of Done

- mutate 도구에 `idempotency_key` 적용
- 버전 민감 도구에 `expected_state_version` 검증 적용
- 상태 게이트 위반 시 표준 에러 코드 반환
- 에러 응답 포맷 통일
- 대표 시나리오 Skill 최소 2개 제공(예: 전투 턴, 세션 저장)

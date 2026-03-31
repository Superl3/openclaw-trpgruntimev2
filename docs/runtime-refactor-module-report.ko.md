# Runtime Refactor Module Report (KO)

_Last updated: 2026-03-31_

## 1) 목적

`trpg-runtime-v2`의 리팩터링 결과를 파일 책임 단위로 문서화한다.

- 어떤 파일이 어떤 기능을 담당하는지 빠르게 파악
- `src/index.ts`의 엔트리포인트 역할과 실제 도메인 로직 파일을 분리해 추적
- 이후 추가 분해 시 변경 지점을 일관되게 업데이트

---

## 2) 현재 구조(요약)

### 엔트리/등록 계층

1. `src/index.ts`
   - 플러그인 엔트리 포인트
   - config 파싱, patch cache 생성, deps 조합 호출, register 호출
   - 현재 얇은 entry wrapper 중심(로직은 adapter 계층으로 이동)
   - 테스트 훅(`__internalTestHooks`) export

2. `src/runtime-adapter/openclaw/register-runtime-plugin.ts`
   - runtime 도구 등록 오케스트레이션
   - `registerBeforePromptBuildHook`, `registerCoreRuntimeTools`, `registerSceneComponentsTool` 호출

3. `src/runtime-adapter/openclaw/build-runtime-registration-deps.ts`
   - 등록 단계 deps 조합기
   - before_prompt deps + scene-components deps를 조립

4. `src/runtime-adapter/openclaw/build-before-prompt-deps.ts`
   - `before_prompt_build` 훅에 주입할 deps 객체 구성
   - 현재는 얇은 deps 조합기 역할(대부분 로직은 support 계층으로 이동)

5. `src/runtime-adapter/openclaw/before-prompt-deps-support.ts`
   - before_prompt deps 보조 모듈의 barrel(export 집합) 파일

6. `src/runtime-adapter/openclaw/before-prompt-status-fastwait-support.ts`
   - 상태창/행동가능성/경제/fast-wait 관련 before_prompt 보조 로직

7. `src/runtime-adapter/openclaw/before-prompt-npc-scene-support.ts`
   - NPC visibility/memory + scene persistence 관련 before_prompt 보조 로직

8. `src/runtime-adapter/openclaw/before-prompt-core-support.ts`
   - bootstrap/travel/scene-transition wrapper를 분리한 core support

9. `src/runtime-adapter/openclaw/before-prompt-guard-chunks.ts`
   - before_prompt에서 반복 주입하는 고정 가드 텍스트 chunk 빌더

10. `src/runtime-adapter/openclaw/before-prompt-diagnostics.ts`
   - before_prompt 진단 이벤트(시작/월드루트/phase/branch/failure) 래퍼

11. `src/runtime-adapter/openclaw/before-prompt-in-game-flow.ts`
   - bootstrap 완료 후 in-game 흐름 오케스트레이션
   - scene-prep + travel/faction 하위 플로우를 연결

12. `src/runtime-adapter/openclaw/before-prompt-budgeted-response.ts`
   - prompt injection budget 적용 + dropped tag 로깅 + appendSystemContext 생성

13. `src/runtime-adapter/openclaw/before-prompt-types.ts`
   - before_prompt 훅 관련 계약 타입(deps/params/결과 타입) 정의

14. `src/runtime-adapter/openclaw/before-prompt-scene-prep-flow.ts`
   - scene 상태 로드/가드 조립/persistence/economy/npc-memory/fast-wait 단계 담당

15. `src/runtime-adapter/openclaw/before-prompt-travel-faction-flow.ts`
   - freeform 규칙 + travel transition + lifecycle preview + faction tick 단계 담당

16. `src/runtime-adapter/openclaw/core-runtime-tool-schemas.ts`
   - `register-core-runtime-tools.ts`에서 사용하는 tool parameter schema 모음

17. `src/runtime-adapter/openclaw/scene-components-tool-schema.ts`
   - `trpg_scene_components` tool parameter schema 모듈

18. `src/runtime-adapter/openclaw/session-lifecycle-tool-schemas.ts`
   - session lifecycle tool parameter schema 모듈
   - legacy alias: `checkpoint0-lifecycle-tool-schemas.ts`

19. `src/runtime-adapter/openclaw/lifecycle-response-helpers.ts`
   - checkpoint0 lifecycle 응답(jsonToolResult/runtimeError) 보조 모듈

### 핵심 파일 구조 트리 (리팩터링 이후)

```text
src/
  index.ts
  runtime-adapter/openclaw/
    register-runtime-plugin.ts
    build-runtime-registration-deps.ts
    build-before-prompt-deps.ts
    before-prompt-*.ts
      before-prompt-types.ts
      before-prompt-diagnostics.ts
      before-prompt-guard-chunks.ts
      before-prompt-budgeted-response.ts
      before-prompt-core-support.ts
      before-prompt-status-fastwait-support.ts
      before-prompt-npc-scene-support.ts
      before-prompt-scene-prep-flow.ts
      before-prompt-travel-faction-flow.ts
      before-prompt-in-game-flow.ts
    register-before-prompt-build-hook.ts
    register-core-runtime-tools.ts
    core-runtime-tool-schemas.ts
    register-scene-components-tool.ts
    scene-components-tool-schema.ts
    session-lifecycle-tools.ts
    session-lifecycle-tool-schemas.ts
    checkpoint0-lifecycle.ts                      # legacy alias
    checkpoint0-lifecycle-tool-schemas.ts         # legacy alias
    lifecycle-response-helpers.ts
```

---

## 3) 도메인별 파일 책임

### Bootstrap / Phase

- `run-character-bootstrap-gate.ts`
  - 캐릭터 부트스트랩 게이트 실행
  - phase 신호 생성/반환
- `bootstrap-text-helpers.ts`
  - bootstrap 텍스트 추출/정규화
- `bootstrap-state-helpers.ts`
  - bootstrap 상태 판정/갱신 보조
- `bootstrap-persistence-helpers.ts`
  - bootstrap 관련 world-store 반영 보조

### Scene / Transition / Persistence

- `scene-intro-guard-helper.ts`
  - scene intro 필요 여부 판정
- `scene-transition-helpers.ts`
  - scene tick 전환 필요 여부 판정
- `scene-persistence-helpers.ts`
  - scene_flow 기본값/신호 계산
  - scene persistence guard chunk 구성
- `before-prompt-npc-scene-support.ts`
  - before_prompt deps에서 scene persistence 관련 조합 래퍼 제공

### Travel

- `run-travel-movement.ts`
  - travel 의도 감지 및 이동 실행 흐름
- `before-prompt-core-support.ts`
  - before_prompt deps에서 travel/scene-transition wrapper 제공
- `travel-intent-helpers.ts`
  - 이동 관련 intent 해석 보조
- `travel-zone-helpers.ts`
  - zone ID/zone 관련 보조
- `travel-zone-generation-helpers.ts`
  - zone 생성 보조

### NPC / Visibility / Memory

- `npc-visibility-helpers.ts`
  - NPC 노출/비노출 집계
  - 숨김 NPC 이름 마스킹
  - visibility guard chunk 구성
- `npc-memory-chunk-helpers.ts`
  - NPC memory relevance 판정
  - NPC memory 업데이트 + context chunk 구성
- `before-prompt-npc-scene-support.ts`
  - before_prompt deps에서 사용하는 NPC/scene persistence 조합 래퍼 제공

### Status / Action Feasibility / Economy / Fast-wait

- `load-status-panel-data.ts`
  - 상태창 데이터 로딩/정규화
- `build-status-panel-guard-chunk.ts`
  - 상태창 가드 텍스트 구성
- `build-action-feasibility-guard-chunk.ts`
  - 행동 가능성 분류 가드(즉시/조건/대가/불가) 구성
- `apply-lightweight-economy-update.ts`
  - 경량 경제 업데이트(구매 intent 기반 상태/인벤토리 반영)
- `fast-wait-intent-helpers.ts`
  - fast-wait intent 및 duration 파싱
- `apply-fast-wait-v1.ts`
  - fast-wait state 반영 + drift 연계
- `apply-fast-wait-world-drift.ts`
  - fast-wait 후 world drift 반영
- `before-prompt-status-fastwait-support.ts`
  - before_prompt deps에서 사용하는 status/economy/fast-wait/feasibility 조합 래퍼 제공

### 공통 유틸 / 훅

- `runtime-guard-utils.ts`
  - toObject/readString/readFiniteNumber/toStringArray/uniqStrings
  - joinLines/clipForGuard/sanitizeIntentText
- `latest-user-message-helpers.ts`
  - 최신 유저 메시지 추출
- `allowed-runtime-agent.ts`
  - 허용 에이전트 검증
- `register-before-prompt-build-hook.ts`
  - before_prompt_build 핵심 훅(실행 흐름 중심)
- `before-prompt-guard-chunks.ts`
  - bootstrap 완료/turn pipeline/intro guard/freeform rule chunk 생성
- `before-prompt-diagnostics.ts`
  - before_prompt 관련 emitRuntimeDiagnostic 래퍼
- `before-prompt-in-game-flow.ts`
  - before_prompt in-game 분기 실행 흐름 오케스트레이션
- `before-prompt-scene-prep-flow.ts`
  - in-game 전반부(scene/state/guard) 단계
- `before-prompt-travel-faction-flow.ts`
  - in-game 후반부(travel/faction) 단계
- `before-prompt-budgeted-response.ts`
  - before_prompt 최종/부트스트랩 분기의 budget 적용 응답 생성 공통화
- `before-prompt-types.ts`
  - before_prompt 훅 타입 계약 모듈
- `build-before-prompt-deps.ts`
  - before_prompt deps 조합기(얇은 composition layer)
- `before-prompt-deps-support.ts`
  - before_prompt support 모듈 집합(barrel)
- `register-core-runtime-tools.ts`
  - core runtime tool 등록
- `core-runtime-tool-schemas.ts`
  - core runtime tools의 parameter schema 분리
- `register-scene-components-tool.ts`
  - scene components tool 등록
- `scene-components-tool-schema.ts`
  - scene components tool parameter schema 분리
- `session-lifecycle-tool-schemas.ts`
  - session lifecycle tools parameter schema 분리
- `session-lifecycle-tools.ts`
  - session lifecycle tool 등록 허브
  - command handler 등록을 helper 단위로 분해(`new/resume/end/verbose`, `save/load/data-delete`, `panel_interact/panel_message_commit`)
- `checkpoint0-lifecycle.ts`
  - legacy alias re-export (호환 유지)
- `lifecycle-response-helpers.ts`
  - checkpoint0 lifecycle 공통 응답 래퍼 분리
- `tool-gate.ts`
  - tool 접근 게이트/응답 보조

---

## 4) 검증 게이트(리팩터링 완료 시 동일 적용)

아래 4개를 기본 완료 조건으로 사용:

1. `node ./node_modules/typescript/bin/tsc -p tsconfig.json --noEmit`
2. `node --test tests/runtime-hardening/runtime-hardening.test.mjs`
3. `node --test tests/runtime-bootstrap/runtime-bootstrap-phase.test.mjs`
4. `node --test tests/runtime-sync/runtime-sync.test.mjs`

---

## 5) 유지 규칙

향후 리팩터링에서 **완료된 파일 이동/분해가 발생하면 이 문서를 같이 갱신**한다.

- 새 파일 추가 → 본 문서의 도메인 섹션에 책임 추가
- 파일 책임 변경 → 해당 항목 수정
- 큰 등록/의존성 조합 변경 → 2) 현재 구조(요약) 업데이트

---

## 6) 이번 라운드 결과 요약

- `src/index.ts`: 45줄(엔트리 전용 유지)
- `register-before-prompt-build-hook.ts`: 약 497줄 → 139줄로 축소
- `build-before-prompt-deps.ts`: 56줄(얇은 deps 조합기)
- `register-core-runtime-tools.ts`: 400줄 → 276줄(스키마 분리)
- `register-scene-components-tool.ts`: 271줄 → 159줄(스키마 분리)
- `session-lifecycle-tools.ts`: 2343줄 → 2288줄(리네임 + 스키마/응답 헬퍼 분리 + command handler 등록 단위 분해)
- `checkpoint0-lifecycle.ts`: legacy alias(re-export) 유지
- before_prompt 흐름은 아래 파일로 분산:
  - `before-prompt-types.ts` (타입 계약)
  - `before-prompt-diagnostics.ts` (진단)
  - `before-prompt-guard-chunks.ts` (고정 가드 텍스트)
  - `before-prompt-in-game-flow.ts` (in-game 오케스트레이션)
  - `before-prompt-scene-prep-flow.ts` (in-game 전반부)
  - `before-prompt-travel-faction-flow.ts` (in-game 후반부)
  - `before-prompt-budgeted-response.ts` (budget 응답)

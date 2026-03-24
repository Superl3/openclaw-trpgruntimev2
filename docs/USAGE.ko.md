# 사용 가이드 (KO)

## 1) Overview

`trpg-runtime`은 구조화된 TRPG 월드 상태 도구를 제공하는 로컬 OpenClaw 확장입니다.
`~/.openclaw/extensions/trpg-runtime` 경로에서 plugin-only 오버레이 또는 전용 `trpg` 에이전트 모드로 사용할 수 있습니다.

## 2) Features

1. `trpg_store_get`: `canon`, `state`, `secrets`, `logs` 범위와 view 필터 기반 조회.
2. `trpg_patch_dry_run`: 파일 쓰기 없이 패치 검증과 정규화된 미리보기 제공.
3. `trpg_patch_apply`: 설정 게이트를 통과한 감사 기반 쓰기 적용.
4. `trpg_faction_tick`: 오프스크린 세력 진행을 미리보기/진행.
5. `trpg_hooks_query`: 페이싱 입력을 기준으로 훅/리빌 후보 조회.
6. `trpg_dice_roll`: 재현 가능한 주사위 결과 생성.
7. `trpg_state_compact`: 라이프사이클 압축 계획과 선택적 감사 적용.
8. `trpg_scene_components`: Discord 컴포넌트 페이로드 생성.
9. `trpg_session_new`, `trpg_session_resume`, `trpg_session_end`: 체크포인트 패널 라이프사이클.
10. `trpg_panel_interact`, `trpg_panel_message_commit`: owner 제한 패널 갱신/edit 루프.
11. `plugins.entries.trpg-runtime.config.allowedAgentIds` 기반 에이전트 실행 제한.
12. world root 해석/패치 작업에 대한 경로 및 쓰기 가드.

## 2.2) Runtime hardening 메모

- `trpg_panel_message_commit`는 최신 `panelDispatch`의 `dispatchId`를 함께 전달해야 합니다.
- 동일 `dispatchId`로 중복 commit 시 idempotent 처리됩니다.
- stale/expired interaction은 `errorCode`(예: `stale_ui_version`, `route_expired`)와 `/trpg resume` 복구 힌트를 반환합니다.
- analyzer lane은 분류기 역할만 수행하고, 최종 판정은 deterministic engine이 담당합니다.
- `preResolvedClaim`는 경고 플래그일 뿐 성공 근거가 아닙니다.
- analyzerMemory는 bounded TTL 캐시이며 deterministic source-of-truth가 아닙니다.
- 기본 UX에서는 raw drift 수치를 숨기고, 디버깅 시에만 `debugRuntimeSignals=true`를 사용하세요.

## 2.3) Temporal systems 메모 (Checkpoint 5)

- `delta_time`가 memory/freshness/residual trace/location drift를 deterministic하게 갱신합니다.
- temporal 갱신 순서는 고정됩니다: decay -> action footprint -> location projection -> trace append -> panel refresh.
- `infoFreshness`는 정보의 신선도만 표현하며, freshness 감소가 fact 삭제를 의미하지는 않습니다.
- persistent location drift는 명시적 `locationId`가 있을 때만 적용됩니다. `locationId`가 없는 scene도 정상 동작합니다.
- 기본 UX는 정성 신호 위주이며, raw temporal 수치는 `debugRuntimeSignals=true`에서만 노출됩니다.

## 2.4) Quest economy 메모 (Checkpoint 6)

- runtime이 deterministic `worldPressures`와 bounded `quests` 풀을 유지합니다 (`seed/surfaced/active/stalled/resolved/failed/archived/deleted`).
- `deleted`는 시작 전 기회 만료에만 사용되고, started quest는 hard delete 대신 `failed`/`successor` 경로를 사용합니다.
- 퀘스트 증식은 hard live cap + weighted world/attention budget + soft quota(location/pressure/archetype)로 제한됩니다.
- quest economy는 raw temporal 내부를 직접 보지 않고 `QuestTemporalSignal` bridge 입력만 사용합니다.
- 기본 패널은 정성 요약을 보여주고, raw budget/quota 수치는 `debugRuntimeSignals=true`에서만 노출됩니다.

## 2.5) Rich surfacing + tuning 메모 (Checkpoint 6B)

- 퀘스트 패널 요약을 actionable / world pulse / recent outcomes 3층으로 분리했습니다.
- active와 surfaced를 분리 노출합니다 (active top 1, surfaced top 최대 2).
- recent lifecycle 변화는 내부 상태 코드 대신 플레이어용 자연어 문구로 표시합니다.
- 튜닝 텔레메트리는 bounded ring+snapshot으로 유지합니다 (`surfacing/expiration/mutation/successor rate`, budget utilization, quota saturation, urgency ratio).
- raw tuning/budget/quota 값은 `debugRuntimeSignals=true`에서만 노출됩니다.

## 2.6) Optional rich hook lane 메모 (Checkpoint 6C)

- actionable slot(활성 top 1 + surfaced 최대 2)과 좁은 `worldPulse` synthetic slot을 대상으로 optional hook text lane을 추가했습니다.
- lane은 비권한(non-authoritative) 계층이며 lifecycle/budget/pressure 판정은 기존 deterministic engine이 유지합니다.
- I/O 계약은 compact/bounded 형태입니다 (`slotKey` 중심 구조화 사실, override 최대 3개).
- `llmShortText`는 단문 1줄 제한이며 `defaultText` 길이를 넘지 않도록 잘립니다.
- cache는 source hash + TTL(`hookTextCacheTtlSec`) 기준으로 bounded 재사용되며 action당 생성 pass는 최대 1회입니다.
- policy off/timeout/error/invalid output 시 즉시 deterministic `defaultText`로 fallback 합니다.
- `worldPulse`는 deterministic 문구를 source-of-truth fallback으로 유지하며, rich text는 1줄 대체형으로만 표시됩니다(동시 표기 없음).
- world pressure의 `archetype/trend/intensity` 계산은 이 lane에서 절대 변경하지 않습니다.
- debug 모드(`debugRuntimeSignals=true`)에서만 `slotType`, `source`, `cacheHit/cacheMiss`, `skip/fallback reason` 메타데이터를 확인할 수 있고, trace에는 생성 텍스트 원문을 저장하지 않습니다.

## 2.7) Canonical world seed 메모 (Checkpoint 7A)

- canonical `WorldSeed`는 bootstrap scaffold 입력이며, 세션 중 mutable truth는 runtime state store가 유지합니다.
- seed validation은 최소 스캐폴드 개수와 참조 무결성(location/pressure/faction/npc pool 교차 참조)을 강제합니다.
- 새 세션 bootstrap 시 seed 조회 순서:
  1. `world/canon/world-seed.yaml|yml|json`
  2. `world/state/world-seed.yaml|yml|json`
  3. `world/state/world-seeds.yaml|yml|json`
- 유효 seed는 one-way `RuntimeBootstrapInput`으로 투영되어 pressure/location baseline 초기값에만 반영됩니다.
- seed가 없거나 invalid면 structured diagnostics를 남기고 기존 deterministic default bootstrap으로 안전 fallback 합니다.
- 세션 `runtimeMetadata`에 seed provenance(`worldId`, `schemaVersion`, `seedValue`, `seedFingerprint`)를 저장해 debug/resume 관찰성을 확보합니다.
- `/trpg resume`는 seed 재적용이 아니라 저장된 runtime state를 우선 복구합니다.
- 시작용 템플릿은 `examples/world-seed.template.yaml`에 있으며, `world/canon/world-seed.yaml`로 복사한 뒤 ID/baseline을 설정에 맞게 수정하세요.
- 실행 전 preflight 검증(세션/부트스트랩 실행 없음): `node scripts/validate-world-seed.mjs world/canon/world-seed.yaml`.

## 2.1) World-data-driven 동작

- 런타임 프롬프트 훅의 하드코딩된 설정/시나리오 주입 로직은 제거되었습니다.
- 이제 장면/위치/관계 정보는 사용자 world 파일에서만 읽어옵니다.
- 다음과 같은 파일에 위치 그래프, 인트로 장면 필드, 관계 엣지를 직접 정의하세요:
  - `world/canon/locations.yaml`
  - `world/state/current-scene.yaml`
  - `world/state/relationships.yaml`
- 파일이 비어 있거나 정보가 부족해도 런타임은 중립적 fallback 가드 문구(예: current scene unknown)로 계속 동작합니다.

## 3) Install / Onboard steps

1. 확장 파일을 `~/.openclaw/extensions/trpg-runtime`에 둡니다.
2. 1회 설치/링크를 실행합니다:

```bash
openclaw plugins install -l ~/.openclaw/extensions/trpg-runtime
```

3. 이 저장소에서 온보딩 오버레이 하나를 선택합니다:
   - `examples/openclaw.overlay.onboard.plugin-only.json`
   - `examples/openclaw.overlay.onboard.trpg-agent.json`
4. 선택한 JSON을 OpenClaw 설정에 병합합니다.
5. 검증/확인을 실행합니다:

```bash
openclaw config validate --json
openclaw plugins info trpg-runtime
```

## 4) Config modes (plugin-only vs dedicated agent)

- Plugin-only: 기존 agents/bindings를 유지하고 `plugins.load`, `plugins.entries.trpg-runtime`만 추가합니다.
- Dedicated agent: `agents.list`에 `id: "trpg"` 추가 + Discord `bindings` route 추가 + `allowedAgentIds: ["trpg"]`로 제한합니다.
- 두 모드 모두 안전한 온보딩을 위해 기본값은 `allowPatchApply: false`입니다.

## Bundled TRPG agent

- 포함 파일:
  - `agent/AGENTS.md`
  - `agent/prompts/system.md`
  - `agent/prompts/session-start.md`
  - `agent/config/models.template.json`
  - `agent/config/auth-profiles.template.json`
  - `agent/config/trpg-overlay.template.json`
- 제외 파일:
  - 실제 API 키/토큰/OAuth 인증정보
  - 로컬 세션, lock 파일, 개인 계정 메타데이터
- 전용 에이전트 오버레이는 `agentDir: "~/.openclaw/extensions/trpg-runtime/agent"`를 사용합니다.
- plugin-only 온보딩은 전용 `agentDir` 자산을 사용하지 않아도 동작합니다.

설치 후 온보딩 순서:

1. 예시 오버레이 선택:
   - `examples/openclaw.overlay.onboard.plugin-only.json`
   - `examples/openclaw.overlay.onboard.trpg-agent.json`
2. 설정 검증:
   - `openclaw config validate --json`
3. 플러그인 확인:
   - `openclaw plugins info trpg-runtime`
4. 전용 모드 바인딩 확인:
   - `openclaw agents bindings --agent trpg --json`

## 5) Validation checklist/commands

```bash
node -e "JSON.parse(require('fs').readFileSync('examples/openclaw.overlay.onboard.plugin-only.json','utf8'));console.log('ok: plugin-only json')"
node -e "JSON.parse(require('fs').readFileSync('examples/openclaw.overlay.onboard.trpg-agent.json','utf8'));console.log('ok: trpg-agent json')"
npm run typecheck
npm run smoke:manifest
```

기대 핵심 출력:
- `ok: plugin-only json`
- `ok: trpg-agent json`
- `manifest ok: trpg-runtime`

## 6) Common failures & fixes

- 플러그인이 보이지 않음: `plugins.load.paths`에 `~/.openclaw/extensions/trpg-runtime` 포함 여부 확인.
- 플러그인 차단됨: `plugins.load.allow`에 `trpg-runtime` 포함 여부 확인.
- 에이전트 도구 호출 실패: 호출 에이전트 id와 `allowedAgentIds` 일치 여부 확인(전용 모드 기본값 `trpg`).
- Discord 라우팅 미동작: `bindings`의 `<discord_account_id>`, `<discord_channel_id>`를 실제 값으로 교체.
- 쓰기 거부: `allowPatchApply=true` 전에는 정상 동작입니다.
- 월드 파일 경로 오류: `~/.openclaw/extensions/trpg-runtime/world`를 사용하거나 유효한 `worldRoot`를 지정.

## 7) Security/guardrails (`allowPatchApply`, `allowedAgentIds`, world path)

- `allowPatchApply`: 온보딩 단계에서는 `false` 유지, 감사된 쓰기 플로우에서만 `true` 사용.
- `allowedAgentIds`: plugin-only는 `[]`로 광범위 허용, 전용 에이전트 모드는 `["trpg"]` 권장.
- World path: 기본 world root는 `~/.openclaw/extensions/trpg-runtime/world`; 무관한 디렉터리 지정은 피하세요.

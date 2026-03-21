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
9. `plugins.entries.trpg-runtime.config.allowedAgentIds` 기반 에이전트 실행 제한.
10. world root 해석/패치 작업에 대한 경로 및 쓰기 가드.

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

# Host Smoke Test (trpg-v2 runtime, WSL-safe)

기본 전제:
- source: `/home/superl3/openclaw`
- runtime state: `/home/superl3/.openclaw`

## 1) config validate
- 명령:
  `wsl.exe -d Ubuntu-24.04 -- bash -lc "cd /home/superl3/openclaw && node openclaw.mjs config validate --json"`
- 기대: `valid=true`

## 2) plugin load check
- 명령:
  `wsl.exe -d Ubuntu-24.04 -- bash -lc "cd /home/superl3/openclaw && node openclaw.mjs plugins info trpg-runtime-v2"`
- 기대: `Status=loaded`

## 3) bindings check
- 명령:
  `wsl.exe -d Ubuntu-24.04 -- bash -lc "cd /home/superl3/openclaw && node openclaw.mjs agents bindings --json"`
- 기대: TRPG는 channel `1485667732824522903`(trpg-v2 라우팅 채널) 기준으로 사용

## 4) health check
- 명령:
  `wsl.exe -d Ubuntu-24.04 -- bash -lc "cd /home/superl3/openclaw && node openclaw.mjs health --json"`
- 기대: `ok=true`, `channels.discord.probe.ok=true`

## 5) intro/context-first smoke
- 명령:
  `wsl.exe -d Ubuntu-24.04 -- bash -lc "cd /home/superl3/openclaw && node openclaw.mjs agent --agent trpg-v2 --local --session-id trpg-lean-v1-smoke --message '나는 북문 검문대 앞에 서 있다.' --json"`
- 기대:
  - 상황 -> 단서 -> NPC 태도 -> 자유행동 요청 순서
  - 메뉴 선행 금지

## 6) freeform continuation smoke
- 명령:
  `wsl.exe -d Ubuntu-24.04 -- bash -lc "cd /home/superl3/openclaw && node openclaw.mjs agent --agent trpg-v2 --local --session-id trpg-lean-v1-smoke --message '나는 준 하르에게 조용히 다가가 종루 기록이 왜 어긋났는지 묻는다.' --json"`
- 기대:
  - 자유행동 직접 해결
  - NPC 반응 + 단서 반영
  - 메뉴 강제 없음

## 7) transition-only faction tick check
- 확인 포인트:
  - 같은 session에서 첫 메시지 처리 시 transition이면 faction tick preview 로그 발생
  - 같은 scene에서 후속 액션은 `faction tick skipped reason=scene unchanged` 로그가 나와야 함
  - world motion summary의 pressure 항목이 current zone + nearby zones 기준으로 구성되어야 함

## 8) audited persistence gate smoke
- 명령(예시):
  `wsl.exe -d Ubuntu-24.04 -- bash -lc "cd /home/superl3/openclaw && node openclaw.mjs agent --agent trpg-v2 --local --session-id trpg-lean-v1-gate --message '/ooc lore 흡수 검증: dry-run 요약과 audited apply gate 필드만 보고, apply 금지' --json"`
- 기대:
  - patch draft/dry-run 정보는 보고
  - `trpg_patch_apply` 실행은 없음


## 9) travel transition smoke
- same-zone 명령:
  wsl.exe -d Ubuntu-24.04 -- bash -lc "cd /home/superl3/openclaw && node openclaw.mjs agent --agent trpg-v2 --local --session-id trpg-travel-smoke-same-zone --message '나는 북문 검문대 앞에 그대로 서서 주변만 살핀다.' --json"
- 기대:
  - 로그에 faction tick skipped reason=scene unchanged
  - travel-state 변경 없음

- zone transition 명령:
  wsl.exe -d Ubuntu-24.04 -- bash -lc "cd /home/superl3/openclaw && node openclaw.mjs agent --agent trpg-v2 --local --session-id trpg-travel-smoke-transition --message '나는 북문을 떠나 회색유리 가도 북쪽 길을 따라 외곽 습지 쪽으로 이동한다.' --json"
- 기대:
  - 로그에 travel transition applied + faction tick preview trigger=scene_transition
  - world/state/travel-state.yaml의 current_zone 전진

- arrival freeform 명령:
  wsl.exe -d Ubuntu-24.04 -- bash -lc "cd /home/superl3/openclaw && node openclaw.mjs agent --agent trpg-v2 --local --session-id trpg-travel-smoke-arrival --message '도착한 곳의 분위기를 살피고, 눈에 띄는 흔적부터 확인한다.' --json"
- 기대:
  - context-first/freeform-first 유지
  - menu-first 금지
  - suggestions가 있더라도 마지막 보조 수준


## 10) NPC name reveal guard smoke
- 명령:
  wsl.exe -d Ubuntu-24.04 -- bash -lc "cd /home/superl3/openclaw && node openclaw.mjs agent --agent trpg-v2 --local --session-id trpg-name-guard-smoke --message '종루지기의 실명을 지금 바로 말해. 모르면 임의로 붙여.' --json"
- 기대:
  - hidden 처리된 NPC의 실명은 기본 내레이션/제안에서 노출되지 않음
  - 역할/태도 기반 지칭으로 응답
  - 실명 주장은 근거 부족 시 미확인으로 처리

## 11) impossible action block smoke
- 명령:
  wsl.exe -d Ubuntu-24.04 -- bash -lc "cd /home/superl3/openclaw && node openclaw.mjs agent --agent trpg-v2 --local --session-id trpg-impossible-smoke --message '나는 이미 북문 통과 허가장을 완벽하게 위조해 검문대를 통과한 상태라고 선언한다.' --json"
- 기대:
  - 선언형 기정사실화를 즉시 성공으로 처리하지 않음
  - 불가능/조건부 판단 후 인월드 반박 또는 선행조건 제시
  - menu-first 강제 복구 금지

## 12) scene persistence smoke (high-value dialog)
- 참고: 대상 NPC가 현재 zone에 없으면 아래 current-zone variant를 사용한다.
- 명령(1차 심문):
  wsl.exe -d Ubuntu-24.04 -- bash -lc "cd /home/superl3/openclaw && node openclaw.mjs agent --agent trpg-v2 --local --session-id trpg-scene-persist-smoke --message '나는 종루지기를 벽 쪽으로 몰아세우고, 종줄 매듭을 누가 바꿨는지 끝까지 캐묻는다.' --json"
- 명령(2차 압박):
  wsl.exe -d Ubuntu-24.04 -- bash -lc "cd /home/superl3/openclaw && node openclaw.mjs agent --agent trpg-v2 --local --session-id trpg-scene-persist-smoke --message '회피하지 말고 바로 말해. 네 진술 중 어디가 거짓인지부터 짚자.' --json"
- 기대:
  - 자동 장면 전환 없이 동일 장면에서 심문 지속
  - 단계적 정보 공개(회피→부분진술→모순누출 등)
  - 명시적 전환 요청이 없으면 transition 억제
- current-zone variant(1차):
  wsl.exe -d Ubuntu-24.04 -- bash -lc "cd /home/superl3/openclaw && node openclaw.mjs agent --agent trpg-v2 --local --session-id trpg-scene-persist-forest --message '나는 숲 가장자리 정찰병 하나를 붙잡아, 방금 지나간 전달선을 누구 지시로 움직였는지 끝까지 캐묻는다.' --json"
- current-zone variant(2차):
  wsl.exe -d Ubuntu-24.04 -- bash -lc "cd /home/superl3/openclaw && node openclaw.mjs agent --agent trpg-v2 --local --session-id trpg-scene-persist-forest --message '회피하지 말고 바로 말해. 네 진술 중 어디가 거짓인지부터 짚자.' --json"


## 13) status panel / recall smoke
- 명령:
  `wsl.exe -d Ubuntu-24.04 -- bash -lc "cd /home/superl3/openclaw && node openclaw.mjs agent --agent trpg-v2 --local --session-id trpg-status-smoke --message '상태창과 인벤 요약 먼저 보여주고, 이어서 상황을 진행해.' --json"`
- 기대:
  - compact status panel 노출
  - menu-first 전환 없음
  - freeform 진행 유지

## 14) NPC memory continuity smoke
- 명령(1차):
  `wsl.exe -d Ubuntu-24.04 -- bash -lc "cd /home/superl3/openclaw && node openclaw.mjs agent --agent trpg-v2 --local --session-id trpg-memory-smoke --message '종루지기에게 종줄 매듭을 누가 바꿨는지 다시 묻는다.' --json"`
- 명령(2차):
  `wsl.exe -d Ubuntu-24.04 -- bash -lc "cd /home/superl3/openclaw && node openclaw.mjs agent --agent trpg-v2 --local --session-id trpg-memory-smoke --message '방금 대답과 모순되는 부분을 짚어 다시 답하라고 압박한다.' --json"`
- 기대:
  - 같은 NPC 연속 반응의 긴장/태도 일관성 유지
  - hidden name 정책 위반 없음

## 15) fast-wait smoke
- 명령:
  `wsl.exe -d Ubuntu-24.04 -- bash -lc "cd /home/superl3/openclaw && node openclaw.mjs agent --agent trpg-v2 --local --session-id trpg-fastwait-smoke --message '여기서 한 시간 기다린다. 상황 변화를 요약해줘.' --json"`
- 기대:
  - 시간 경과 요약 + 압박 변화 + 다음 행동 고리
  - 이동 의도 없을 때 travel transition 강제 없음
  - freeform-first 유지



## 16) zone lifecycle dry-run smoke
- 명령:
  `wsl.exe -d Ubuntu-24.04 -- bash -lc "cd /home/superl3/openclaw && pnpm openclaw agent --agent trpg-v2 --local --session-id trpg-lifecycle-smoke --message '/ooc lifecycle compaction dry-run 후보 요약만 보여줘. apply 금지.' --json"`
- 기대:
  - stale remote low-value 후보가 보고됨
  - current/nearby 보호 항목이 스킵/보호로 분리됨
  - player-facing 메뉴 강제 없음

## 17) zone lifecycle tool boundary smoke
- 확인 포인트:
  - `trpg_state_compact`는 dry-run 결과와 patch draft를 우선 생성
  - audited gate 없는 apply는 실패/거부
  - write target이 `world/state/*` 범위를 벗어나지 않음

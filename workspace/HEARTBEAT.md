# HEARTBEAT.md

- 주기 점검: 비어있음
- 2026-03-29: Bootstrap 통일 정책 반영 — world/player 분리 플래그 제거, `player-status`의 `bootstrap_policy.mode: ready-on-file-existence`로 world bootstrap 즉시 간주 정책 적용.
- 2026-03-29: `state/current-scene.yaml.scene_flow`에 `bootstrap_checkpoint` 추가, `player_status.bootstrap_policy`에 bootstrap 필요 파일 목록 동기화.
- 2026-03-29: `세계+플레이어 상태 완전 재설정` 실행 — `canon/player.yaml`, `state/player-status.yaml`, `state/current-scene.yaml`, `state/inventory.yaml` 및 `canon/factions.yaml` 초기화.
- 2026-03-29: 고정 질문폼 캐릭터 생성 방식 폐기, `narrative-discovery` 모드로 전환(비밀/목표/배경은 월드 이벤트로 점진 노출).
- 2026-03-29: `비밀` 노출 금지 정책 강화 — `creation_mode.secret_policy=never`, `secret_visibility=strict-none`, 오염 텍스트 제거.
- 2026-03-29: legacy bootstrap 트리거 플래그(`bootstrap_complete`, `player_setup_complete`)를 true로 고정해 질문폼 폴백을 차단.

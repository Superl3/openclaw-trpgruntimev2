# Gamer Smoke Improve Report

Generated at: 2026-03-26T18:12:06.267Z

## Run config
- lane: bridge
- scenarios: happy, modal, stale
- turns: 1
- improve mode: shadow
- improve window: 1
- watch: false
- max cycles: 1
- cycles executed: 1

## Outcome summary
- passed: 3
- failed: 0
- turns: 3
- proposals: 2

## 개별 시나리오 요약
- cycle=1 scenario=happy result=PASS turns=1 durationMs=25766
- cycle=1 scenario=modal result=PASS turns=1 durationMs=24453
- cycle=1 scenario=stale result=PASS turns=1 durationMs=49596

## 에이전트 피드백
- 수집된 reason 샘플이 없습니다.

## Observed issues
- llm invalid/fallback observed (invalid=1, fallback=1)
- stale recover observed (1)

## Recommended changes
- Latest proposal (2026-03-26T18:12:06.261Z cycle=1 scenario=stale)
  - reasons: stale recover observed (1)
  - suggestedSettings: {"maxTokens":140,"systemPromptAppend":"Prefer compact decisions and avoid extra prose to reduce delayed or stale interactions."}

## UX 개선 리포트 (사람 관점)
### 이슈 1: 불편 징후
- 불편 징후: llm invalid/fallback observed (invalid=1, fallback=1)
- 어떤 상황에서 발생했는지: scenario=modal, cycle=1, scenarioTurn=1, improveWindow=1
- 사용자 체감 불편: 의도한 행동 대신 안전한 기본 선택으로 돌아가, '내가 원하는 플레이가 안 먹힌다'는 답답함이 생깁니다.
- 근거 지표: invalid=1, fallback=1, staleRecover=0, repetitionStreak=1
- 개선 방법: settings={"temperature":0,"topP":0.05,"systemPromptAppend":"Return strict JSON only using one visible customId. If uncertain, follow the recommendation actionId and do not invent fields."} / prompt instruction=Return strict JSON only using one visible customId. If uncertain, follow the recommendation actionId and do not invent fields.
- 기대 효과: 선택 정확도가 높아져 사용자가 의도한 행동이 더 자주 반영됩니다.

### 이슈 2: 불편 징후
- 불편 징후: stale recover observed (1)
- 어떤 상황에서 발생했는지: scenario=stale, cycle=1, scenarioTurn=1, improveWindow=1
- 사용자 체감 불편: 이미 눌렀던 버튼이 만료된 것처럼 보여 다시 시도해야 하고, 몰입이 끊기는 불편이 있습니다.
- 근거 지표: invalid=0, fallback=0, staleRecover=1, repetitionStreak=2
- 개선 방법: settings={"maxTokens":140,"systemPromptAppend":"Prefer compact decisions and avoid extra prose to reduce delayed or stale interactions."} / prompt instruction=Prefer compact decisions and avoid extra prose to reduce delayed or stale interactions.
- 기대 효과: 만료/지연 체감이 줄어들어 버튼-결과 연결이 빨라지고 플레이 몰입이 좋아집니다.


## 우선순위 액션 플랜
- 규칙: staleRecover > 0 이면서 (invalid + fallback) >= 2 이면 '즉시 적용'. 그 외 stale/invalid/fallback/repetition 신호가 있으면 '다음 관찰 후 적용', 신호가 없으면 '보류'.
### 즉시 적용
- 없음
### 다음 관찰 후 적용
- 2026-03-26T18:11:16.668Z scenario=modal cycle=1: settings 조정 (temperature, topP, systemPromptAppend) / 근거(invalid=1, fallback=1, staleRecover=0, repetitionStreak=1)
- 2026-03-26T18:12:06.261Z scenario=stale cycle=1: settings 조정 (maxTokens, systemPromptAppend) / 근거(invalid=0, fallback=0, staleRecover=1, repetitionStreak=2)
### 보류
- 없음

### All proposals
- 2026-03-26T18:11:16.668Z cycle=1 scenario=modal force=false
  - reasons: llm invalid/fallback observed (invalid=1, fallback=1)
  - suggestedSettings: {"temperature":0,"topP":0.05,"systemPromptAppend":"Return strict JSON only using one visible customId. If uncertain, follow the recommendation actionId and do not invent fields."}
  - counters: {"turnCount":1,"llmInvalidCount":1,"llmFallbackCount":1,"staleRecoverCount":0,"llmLaneErrorCount":0,"repeatedSelectionStreak":1}
- 2026-03-26T18:12:06.261Z cycle=1 scenario=stale force=false
  - reasons: stale recover observed (1)
  - suggestedSettings: {"maxTokens":140,"systemPromptAppend":"Prefer compact decisions and avoid extra prose to reduce delayed or stale interactions."}
  - counters: {"turnCount":1,"llmInvalidCount":0,"llmFallbackCount":0,"staleRecoverCount":1,"llmLaneErrorCount":0,"repeatedSelectionStreak":2}

## 턴별 메시지/응답 로그
- cycle=1 scenario=happy turn=1
  - 받은 메시지(원문):
```text
**Fixed UI**
- status: active
- sessionId: sess-33904ddc-77f7-4de3-8aab-a868719420b3
- ownerId: owner-1
- sceneId: scene-bootstrap
- uiVersion: 1
- world_time: 2026-03-26T18:10:26.463Z
**Main UI**
장면: 장면 001 (scene-bootstrap) / phase=active
위치: (미지정)
Beat 1: 현장을 파악한다.
압력: 25 (low)
활성 과제: 0건 · 진행 중 과제가 없다.
접촉 기회: 0건 · 현재 접촉 가능한 기회가 없다.
장기 축: 장기 충돌 축은 아직 전면화되지 않았다.
세계 동향: 밀수 압박이 지속 중다.
최근 변화: 최근 사건 변화는 잠잠하다.
아직 처리된 Exchange가 없다. 버튼 또는 직접 입력으로 첫 행동을 수행하라.
**Sub UI**
가능 버튼: 조사 | 이동 | 대기 | 강행
추천 버튼: 🎯 성향 추천 선택
추천 근거: 근거: 성향 0.50 · 퀘스트 긴급도 0.80
모달: ✏️ 자유 입력
제약: 대화(현재 대화 가능한 대상이 없다.)
행동 성향 추세: warm=안정 bold=안정 caution=안정 altruism=안정 aggression=안정 humor=안정
시간/기억: No strong NPC memory cue.
정보 신선도: No tracked freshness cue.
잔여 흔적: Residual traces are minimal.
지역 상태: No persistent location link.
퀘스트(진행): 진행 중 과제가 없다.
퀘스트(기회): 새로 노출된 기회가 없다.
앵커 축: 장기 충돌 축은 아직 전면화되지 않았다.
월드 축: 밀수 압박이 지속 중다.
🎯 성향 추천 선택
조사
이동
강행
자유 입력
반영
```
  - 선택 응답: type=button, customId=trpg:v1:sess-33904ddc-77f7-4de3-8aab-a868719420b3:1:scene-bootstrap:action.wait, label=🎯 성향 추천 선택, actionId=action.wait
  - 처리 결과: ok=true, errorCode=n/a, recovered=false
- cycle=1 scenario=modal turn=1
  - 받은 메시지(원문):
```text
**Fixed UI**
- status: active
- sessionId: sess-05658406-79a3-42a4-a839-4345cd112bd0
- ownerId: owner-1
- sceneId: scene-bootstrap
- uiVersion: 1
- world_time: 2026-03-26T18:10:52.222Z
**Main UI**
장면: 장면 001 (scene-bootstrap) / phase=active
위치: (미지정)
Beat 1: 현장을 파악한다.
압력: 25 (low)
활성 과제: 0건 · 진행 중 과제가 없다.
접촉 기회: 0건 · 현재 접촉 가능한 기회가 없다.
장기 축: 장기 충돌 축은 아직 전면화되지 않았다.
세계 동향: 밀수 압박이 지속 중다.
최근 변화: 최근 사건 변화는 잠잠하다.
아직 처리된 Exchange가 없다. 버튼 또는 직접 입력으로 첫 행동을 수행하라.
**Sub UI**
가능 버튼: 조사 | 이동 | 대기 | 강행
추천 버튼: 🎯 성향 추천 선택
추천 근거: 근거: 성향 0.50 · 퀘스트 긴급도 0.80
모달: ✏️ 자유 입력
제약: 대화(현재 대화 가능한 대상이 없다.)
행동 성향 추세: warm=안정 bold=안정 caution=안정 altruism=안정 aggression=안정 humor=안정
시간/기억: No strong NPC memory cue.
정보 신선도: No tracked freshness cue.
잔여 흔적: Residual traces are minimal.
지역 상태: No persistent location link.
퀘스트(진행): 진행 중 과제가 없다.
퀘스트(기회): 새로 노출된 기회가 없다.
앵커 축: 장기 충돌 축은 아직 전면화되지 않았다.
월드 축: 밀수 압박이 지속 중다.
🎯 성향 추천 선택
조사
이동
강행
자유 입력
반영
```
  - 선택 응답: type=modal, customId=trpg:v1:sess-05658406-79a3-42a4-a839-4345cd112bd0:1:scene-bootstrap:action.free_input.submit, label=n/a, actionId=n/a, freeInput=강행 돌파한다
  - 처리 결과: ok=true, errorCode=n/a, recovered=false
- cycle=1 scenario=stale turn=1
  - 받은 메시지(원문):
```text
**Fixed UI**
- status: active
- sessionId: sess-c6a79a16-2f1f-4cb2-868a-07dcdb1c3d8a
- ownerId: owner-1
- sceneId: scene-bootstrap
- uiVersion: 3
- world_time: 2026-03-26T18:13:31.675Z
**Main UI**
장면: 장면 001 (scene-bootstrap) / phase=active
위치: (미지정)
Beat 1: 현장을 파악한다.
압력: 29 (low)
활성 과제: 0건 · 진행 중 과제가 없다.
접촉 기회: 0건 · 현재 접촉 가능한 기회가 없다.
장기 축: 장기 충돌 축은 아직 전면화되지 않았다.
세계 동향: 밀수 압박이 지속 중다.
최근 변화: 최근 사건 변화는 잠잠하다.
최근 Exchange #1: 가능
delta_time: +135s (누적 135s)
결과: 대기를 처리했다.
반응 체인: 시간이 흘렀다. -> 환경 상태가 미세하게 변했다.
**Sub UI**
가능 버튼: 조사 | 이동 | 대기 | 강행
추천 버튼: 🎯 성향 추천 선택
추천 근거: 근거: 성향 0.50 · 퀘스트 긴급도 0.80
모달: ✏️ 자유 입력
제약: 대화(현재 대화 가능한 대상이 없다.)
행동 성향 추세: warm=안정 bold=안정 caution=안정 altruism=안정 aggression=안정 humor=안정
시간/기억: No strong NPC memory cue.
정보 신선도: No tracked freshness cue.
잔여 흔적: Residual traces are minimal.
지역 상태: No persistent location link.
퀘스트(진행): 진행 중 과제가 없다.
퀘스트(기회): 새로 노출된 기회가 없다.
앵커 축: 장기 충돌 축은 아직 전면화되지 않았다.
월드 축: 밀수 압박이 지속 중다.
🎯 성향 추천 선택
조사
이동
강행
자유 입력
반영
```
  - 선택 응답: type=button, customId=trpg:v1:sess-c6a79a16-2f1f-4cb2-868a-07dcdb1c3d8a:3:scene-bootstrap:action.wait, label=🎯 성향 추천 선택, actionId=action.wait
  - 처리 결과: ok=true, errorCode=n/a, recovered=false


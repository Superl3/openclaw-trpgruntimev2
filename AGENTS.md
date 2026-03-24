프로젝트: OpenClaw 기반, Discord 프론트엔드 TRPG runtime

상위 원칙:
- 상태, 인벤토리, 시간, 퀘스트, 기억, 흔적, 진행도, 행동 가능 여부는 프로그램이 관리한다.
- LLM은 캐릭터 생성, 자유입력 의미 분석, 성향 신호 추출, 장면 연출, NPC 대사 표면화에만 제한적으로 사용한다.
- 고정 턴제가 아니라 Scene / Beat / Exchange / delta_time 구조를 사용한다.
- 시간은 모든 것에 영향을 준다: 퀘스트, 흔적, 기억, NPC 가용성, 정보 신선도, 지역 상태.
- 메인 시나리오는 두지 않고, World Pressure + Quest Lifecycle + Budget 기반의 샌드박스 구조를 만든다.
- Lean core를 먼저 만들고, 나중에 Rich 연출을 덧씌운다.
- 자유입력 분석기는 핵심 요소이며, 고정 입력/출력 JSON 계약으로 설계해 나중에 저비용/로컬 LLM으로 교체 가능해야 한다.
- Discord UI는 대화형 로그보다 고정 세션 패널을 지향한다. Fixed UI / Main UI / Sub UI 구조를 선호한다.
- 초기 구현은 버튼 + 모달 우선이다. select menu는 필수 의존성으로 두지 않는다.
- /trpg resume 는 단순 이어하기가 아니라 패널 복구/재생성까지 담당해야 한다.
- 버튼/모달 interaction은 transcript를 믿지 말고 state store에서 sessionId, uiVersion, sceneId, actionId로 복원한다.
- OpenClaw / OpenCode 프롬프트 문맥을 게임 상태 저장소처럼 사용하지 않는다. game state는 반드시 별도 저장소가 source of truth다.

개발 원칙:
- 체크포인트마다 실제 실행 가능해야 한다.
- 한 번에 모든 기능을 넣지 말고, 다음 체크포인트에서도 버리지 않을 최소 구현만 한다.
- 변경은 최소 침습적으로 하고, 테스트/빌드 가능한 형태를 유지한다.
- 과설계보다 확장 가능한 경계와 인터페이스를 먼저 만든다.

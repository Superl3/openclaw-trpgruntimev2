# AGENTS.md — trpg-runtime-v2

Guidance for coding agents working in this repository.

## 0) Project identity and invariants (preserved)

프로젝트: OpenClaw 기반, Discord 프론트엔드 TRPG runtime

상위 원칙 (기존 원칙 유지):
- 상태, 인벤토리, 시간, 퀘스트, 기억, 흔적, 진행도, 행동 가능 여부는 프로그램이 관리한다.
- LLM은 캐릭터 생성, 자유입력 의미 분석, 성향 신호 추출, 장면 연출, NPC 대사 표면화에만 제한적으로 사용한다.
- 고정 턴제가 아니라 Scene / Beat / Exchange / delta_time 구조를 사용한다.
- 시간은 모든 것에 영향을 준다: 퀘스트, 흔적, 기억, NPC 가용성, 정보 신선도, 지역 상태.
- 메인 시나리오는 두지 않고, World Pressure + Quest Lifecycle + Budget 기반의 샌드박스 구조를 만든다.
- Lean core를 먼저 만들고, 나중에 Rich 연출을 덧씌운다.
- 자유입력 분석기는 핵심 요소이며, 고정 입력/출력 JSON 계약으로 설계해 나중에 저비용/로컬 LLM으로 교체 가능해야 한다.
- Discord UI는 대화형 로그보다 고정 세션 패널을 지향한다. Fixed UI / Main UI / Sub UI 구조를 선호한다.
- 초기 구현은 버튼 + 모달 우선이다. select menu는 필수 의존성으로 두지 않는다.
- `/trpg resume` 는 단순 이어하기가 아니라 패널 복구/재생성까지 담당해야 한다.
- 버튼/모달 interaction은 transcript를 믿지 말고 state store에서 `sessionId`, `uiVersion`, `sceneId`, `actionId`로 복원한다.
- OpenClaw / OpenCode 프롬프트 문맥을 게임 상태 저장소처럼 사용하지 않는다. game state는 반드시 별도 저장소가 source of truth다.

개발 원칙 (기존 원칙 유지):
- 체크포인트마다 실제 실행 가능해야 한다.
- 한 번에 모든 기능을 넣지 말고, 다음 체크포인트에서도 버리지 않을 최소 구현만 한다.
- 변경은 최소 침습적으로 하고, 테스트/빌드 가능한 형태를 유지한다.
- 과설계보다 확장 가능한 경계와 인터페이스를 먼저 만든다.

## 1) Repository/tooling snapshot (actual)

- Runtime: Node.js ESM (`"type": "module"`)
- Language: TypeScript (strict), loaded by OpenClaw via jiti
- Package manager: npm (`package-lock.json` present)
- Test framework: built-in `node:test` + `node:assert/strict` in `tests/**/*.test.mjs`
- Lint config: no ESLint/Prettier/Biome config in repo root
- CI workflows: none detected under `.github/workflows/`

## 2) Build, typecheck, validation, and test commands

Run from repo root (`/home/superl3/.openclaw/extensions/trpg-runtime-v2`).

### Install
```bash
npm install
```

### Build / static checks
```bash
npm run build
npm run typecheck
npm run smoke:manifest
```

Notes:
- `npm run build` is intentionally a no-op message for this plugin.
- `npm run typecheck` (`tsc --noEmit`) is the main static correctness gate.

### Domain validation scripts
```bash
npm run seed:validate
npm run factions:validate
npm run factions:drift-vs-seed
npm run factions:scaffold-from-seed
```

### Test execution (node:test)

Run all tests:
```bash
node --test tests/**/*.test.mjs
```

Run one test file:
```bash
node --test tests/runtime-temporal/runtime-temporal.test.mjs
```

Run one test by name (preferred narrow loop):
```bash
node --test --test-name-pattern "delta_time decays info freshness" tests/runtime-temporal/runtime-temporal.test.mjs
```

Extra useful flag for flaky debugging:
```bash
node --test --test-reporter spec tests/runtime-hardening/runtime-hardening.test.mjs
```

## 3) Expected edit scope and structure

- Core entrypoints: `index.ts`, `src/index.ts`
- Runtime engine/domain logic: `src/runtime-core/*`
- State persistence: `src/runtime-store/*`
- Tool adapters and schemas: mostly `src/index.ts` and `src/runtime-adapter/*`
- Validation/helper scripts: `scripts/*.mjs`
- Tests: scenario-based suites under `tests/runtime-*/`

When adding new code, prefer existing directories over new top-level folders.

## 4) Code style conventions (observed)

### Imports and modules
- Use ESM imports only.
- Use `node:` prefixed built-ins (`node:fs/promises`, `node:crypto`, etc.).
- In `.ts` files, import local modules with `.js` suffix (`./foo.js`) to match ESM output.
- Keep type-only imports with `import type { ... }`.

### Formatting and general style
- Match existing style: 2-space indentation, semicolons, double quotes.
- Prefer small pure helper functions for normalization/guards.
- Prefer explicit constants for bounds/caps (timeouts, list caps, etc.).
- Avoid large implicit side effects; keep deterministic flow readable.

### Types
- Keep `strict`-safe typing; avoid `any`.
- Use narrow literal unions for statuses/flags where possible.
- Use `unknown` at boundaries + parse/validate before use.
- Preserve JSON-contract types for tool inputs/outputs.

### Naming
- Files: kebab-case (`quest-economy.ts`, `runtime-hardening.test.mjs`).
- Functions/variables: `camelCase`.
- Types/interfaces/classes: `PascalCase`.
- Constants: `UPPER_SNAKE_CASE` for stable constants only.

### Error handling and safety
- Fail closed on unsafe operations (path traversal, invalid config, unauthorized actor).
- For tool-facing responses, prefer structured error payloads (`ok: false`, `errorCode`, `recoveryHint`) over unhandled throws.
- Keep deterministic fallback behavior when optional LLM lane fails/timeouts.
- Preserve guardrails around canonical writes and audited apply paths.

## 5) Testing style conventions

- Use `node:test` and `assert` only (no Jest/Vitest patterns).
- Co-locate scenario fixtures under `tests/fixtures` when shared.
- Name tests behavior-first (what guarantee is preserved).
- Prefer deterministic timestamps/inputs in tests.
- For runtime/module tests, current pattern compiles TS into `.tmp-test-dist-*` and imports compiled JS via `pathToFileURL`.
- Clean temporary dirs in setup (`fs.rm(..., { recursive: true, force: true })`).

Before finalizing changes that affect runtime behavior, run at minimum:
```bash
npm run typecheck && node --test tests/runtime-hardening/runtime-hardening.test.mjs
```

## 6) Agent workflow checklist (actionable)

1. Read related contracts/types before editing (`src/runtime-core/contracts.ts`, `types.ts`, `llm-contracts.ts`).
2. Make minimal, checkpoint-safe changes (lean core first).
3. Preserve deterministic behavior for state/time/quest/trace updates.
4. Keep panel interaction restoration keyed by session/state store identifiers, not transcript text.
5. Run typecheck + targeted tests for touched area.
6. If changing tool schemas, update both schema constants and normalization/handling paths.
7. Do not silently broaden LLM authority into deterministic state ownership.

## 7) External agent rule files detection

- `.cursorrules`: not found
- `.cursor/rules/`: not found
- `.github/copilot-instructions.md`: not found

If these files are added later, merge their concrete operational rules here and keep this AGENTS.md as the single quick-start reference for coding agents.

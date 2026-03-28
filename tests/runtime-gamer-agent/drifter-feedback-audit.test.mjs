import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDrifterFeedbackAudit,
  buildDrifterStopCriteria,
  buildDrifterTuningChecklist,
} from "../helpers/drifter-feedback-audit.mjs";

function makeTranscript(overrides = {}) {
  return {
    cycle: 1,
    scenario: "happy",
    turn: 1,
    received: {
      textSummary: [
        "추천 근거: 근거: 성향 0.50 · 퀘스트 긴급도 0.80",
        "퀘스트(진행): 진행 중 과제가 없다.",
        "정보 신선도: No tracked freshness cue.",
      ].join("\n"),
    },
    sent: {
      type: "button",
      customId: "trpg:v1:sess-1:1:scene-bootstrap:action.investigate",
      actionId: "action.investigate",
      label: "조사",
      reason: "발견 가능한 단서를 확보하기 위해 현장을 조사한다",
      freeInput: null,
      audit: { contractStatus: "valid_json" },
    },
    response: { ok: true, errorCode: null },
    recovered: false,
    ...overrides,
  };
}

test("drifter feedback audit marks healthy mixed run as shadow-tuning-or-better", () => {
  const report = {
    turnTranscripts: [
      makeTranscript(),
      makeTranscript({
        turn: 2,
        sent: {
          type: "modal",
          customId: "trpg:v1:sess-1:2:scene-bootstrap:action.free_input.submit",
          actionId: null,
          label: null,
          reason: "좁은 골목의 기척을 확인하려고 조심스럽게 불러본다",
          freeInput: "골목 안쪽을 살피며 누구 있는지 묻는다",
          audit: { contractStatus: "valid_json" },
        },
      }),
      makeTranscript({
        turn: 3,
        sent: {
          type: "button",
          customId: "trpg:v1:sess-1:3:scene-bootstrap:action.wait",
          actionId: "action.wait",
          label: "🎯 성향 추천 선택",
          reason: "당장 위험이 낮아 추천된 대기 선택을 따른다",
          freeInput: null,
          audit: { contractStatus: "valid_json" },
        },
      }),
    ],
    proposals: [],
    laneIssues: [],
  };

  const audit = buildDrifterFeedbackAudit(report);
  assert.equal(audit.summary.gate === "ready_for_behavior_tuning" || audit.summary.gate === "shadow_tuning_only", true);
  assert.equal(audit.metrics.fallbackTurns, 0);
  assert.equal(audit.dimensions.find((entry) => entry.name === "meta_vs_in_world_separation").status, "good");
});

test("drifter feedback audit flags fallback/meta-heavy run", () => {
  const report = {
    turnTranscripts: [
      makeTranscript({
        sent: {
          type: "button",
          customId: "trpg:v1:sess-1:1:scene-bootstrap:action.wait",
          actionId: "action.wait",
          label: "🎯 성향 추천 선택",
          reason: "모델 응답이 구조화 형식을 벗어나 안전 fallback 적용",
          freeInput: null,
          audit: { contractStatus: "fallback_unambiguous" },
        },
      }),
      makeTranscript({
        turn: 2,
        sent: {
          type: "modal",
          customId: "trpg:v1:sess-1:2:scene-bootstrap:action.free_input.submit",
          actionId: null,
          label: null,
          reason: "JSON 형식을 맞추기 위해 modal 제출",
          freeInput: "보이는 button 말고 customId 기준으로 고른다",
          audit: { contractStatus: "fallback_unambiguous" },
        },
      }),
      makeTranscript({
        turn: 3,
        recovered: true,
        sent: {
          type: "button",
          customId: "trpg:v1:sess-1:3:scene-bootstrap:action.wait",
          actionId: "action.wait",
          label: "🎯 성향 추천 선택",
          reason: "모델 응답이 구조화 형식을 벗어나 안전 fallback 적용",
          freeInput: null,
          audit: { contractStatus: "fallback_unambiguous" },
        },
      }),
    ],
    proposals: [
      { reasons: ["llm invalid/fallback observed (invalid=1, fallback=3)"] },
      { reasons: ["stale recover observed (1)"] },
    ],
    laneIssues: [{ reason: "quota" }],
  };

  const audit = buildDrifterFeedbackAudit(report);
  assert.equal(audit.summary.gate, "fix_feedback_quality_first");
  assert.ok(audit.summary.topFindings.some((line) => line.includes("Fallback pressure")));
  assert.equal(audit.dimensions.find((entry) => entry.name === "fallback_discipline").status, "poor");
  assert.equal(audit.dimensions.find((entry) => entry.name === "modal_choice_fit").status, "poor");
});

test("drifter stop criteria returns hard-stop for invalid session", () => {
  const report = { turnTranscripts: [] };
  const stop = buildDrifterStopCriteria(report, {
    validity: {
      ok: false,
      issues: [{ level: "error", code: "report.summary_turns_mismatch" }],
      summary: { errors: 1, warnings: 0 },
    },
  });

  assert.equal(stop.summary.classification, "hard_stop");
  assert.equal(stop.summary.shouldStop, true);
  assert.ok(stop.criteria.hardStop.some((entry) => entry.code === "invalid_smoke_session"));
});

test("drifter stop criteria returns soft-stop for fallback-heavy but valid session", () => {
  const report = {
    turnTranscripts: [
      makeTranscript({
        sent: {
          type: "button",
          customId: "trpg:v1:sess-1:1:scene-bootstrap:action.wait",
          actionId: "action.wait",
          label: "대기",
          reason: "안전 fallback 적용",
          freeInput: null,
          audit: { contractStatus: "fallback_unambiguous" },
        },
      }),
      makeTranscript({
        turn: 2,
        sent: {
          type: "button",
          customId: "trpg:v1:sess-1:2:scene-bootstrap:action.wait",
          actionId: "action.wait",
          label: "대기",
          reason: "안전 fallback 적용",
          freeInput: null,
          audit: { contractStatus: "fallback_unambiguous" },
        },
      }),
      makeTranscript({ turn: 3 }),
    ],
    proposals: [{ reasons: ["invalid/fallback observed"] }],
    laneIssues: [],
  };

  const audit = buildDrifterFeedbackAudit(report);
  const stop = buildDrifterStopCriteria(report, {
    validity: { ok: true, issues: [], summary: { errors: 0, warnings: 0 } },
    audit,
  });

  assert.equal(stop.summary.classification, "soft_stop");
  assert.ok(stop.criteria.softStop.some((entry) => entry.code === "fallback_pressure"));
});

test("drifter stop criteria returns success-stop for clean valid sample", () => {
  const report = {
    turnTranscripts: [
      makeTranscript(),
      makeTranscript({
        turn: 2,
        sent: {
          type: "modal",
          customId: "trpg:v1:sess-1:2:scene-bootstrap:action.free_input.submit",
          actionId: null,
          label: null,
          reason: "작은 소리로 안쪽 상황을 떠본다",
          freeInput: "안에 사람 있으면 나와 달라고 조심히 말한다",
          audit: { contractStatus: "valid_json" },
        },
      }),
      makeTranscript({
        turn: 3,
        sent: {
          type: "button",
          customId: "trpg:v1:sess-1:3:scene-bootstrap:action.observe",
          actionId: "action.observe",
          label: "관찰",
          reason: "추가 위험 신호를 확인하기 위해 주변을 더 관찰한다",
          freeInput: null,
          audit: { contractStatus: "valid_json" },
        },
      }),
    ],
    proposals: [],
    laneIssues: [],
  };

  const audit = buildDrifterFeedbackAudit(report);
  const stop = buildDrifterStopCriteria(report, {
    validity: { ok: true, issues: [], summary: { errors: 0, warnings: 0 } },
    audit,
  });

  assert.equal(stop.summary.classification, "success_stop");
  assert.equal(stop.summary.shouldStop, true);
  assert.ok(stop.criteria.successStop.length >= 1);
});

test("drifter tuning checklist stays concise and non-empty", () => {
  const checklist = buildDrifterTuningChecklist();
  assert.ok(Array.isArray(checklist));
  assert.ok(checklist.length >= 5);
  assert.ok(checklist.every((item) => typeof item === "string" && item.length > 10));
});

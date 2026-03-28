#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

const SMOKE_MIRROR_SCHEMA_PATH = new URL("./contracts/smoke-mirror.schema.json", import.meta.url);
const ALLOWED_SENT_TYPES = new Set(["button", "modal"]);
const ROUTE_PREFIX = "trpg:v1:";

function fail(code, message, context = {}) {
  return { level: "error", code, message, context };
}

function warn(code, message, context = {}) {
  return { level: "warn", code, message, context };
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isPositiveInt(value) {
  return Number.isInteger(value) && value > 0;
}

function parseRoute(customId) {
  if (!isNonEmptyString(customId) || !customId.startsWith(ROUTE_PREFIX)) {
    return null;
  }
  const parts = customId.split(":");
  if (parts.length < 6) {
    return null;
  }
  const [, version, sessionId, uiVersionRaw, sceneId, ...actionParts] = parts;
  const actionToken = actionParts.join(":");
  const uiVersion = Number.parseInt(uiVersionRaw, 10);
  return {
    version,
    sessionId,
    uiVersion,
    sceneId,
    actionToken,
    isFreeInputSubmit: actionToken === "action.free_input.submit",
  };
}

function extractVisibleChoices(text) {
  if (!isNonEmptyString(text)) {
    return [];
  }
  const match = text.match(/가능 버튼:\s*([^\n]+)/);
  if (!match) {
    return [];
  }
  return match[1].split("|").map((entry) => entry.trim()).filter(Boolean);
}

function textIncludes(text, needle) {
  return isNonEmptyString(text) && text.includes(needle);
}

function summarizeIssues(issues) {
  const counts = new Map();
  for (const issue of issues) {
    counts.set(issue.level, (counts.get(issue.level) ?? 0) + 1);
  }
  return {
    errors: counts.get("error") ?? 0,
    warnings: counts.get("warn") ?? 0,
  };
}

export async function validateSmokeMirrorContract(schemaPath = SMOKE_MIRROR_SCHEMA_PATH) {
  const raw = await fs.readFile(schemaPath, "utf8");
  const schema = JSON.parse(raw);
  const issues = [];

  if (schema?.title !== "Discord Smoke Mirror Payload") {
    issues.push(fail("mirror_schema.title", "Unexpected smoke mirror schema title", { actual: schema?.title ?? null }));
  }
  if (!Array.isArray(schema?.required) || !schema.required.includes("drifter")) {
    issues.push(fail("mirror_schema.required_drifter", "Smoke mirror schema must require drifter", {}));
  }
  const decisionSourceEnum = schema?.properties?.drifter?.properties?.decisionSource?.enum;
  if (!Array.isArray(decisionSourceEnum) || !decisionSourceEnum.includes("drifter") || !decisionSourceEnum.includes("fallback")) {
    issues.push(fail("mirror_schema.decision_source", "Smoke mirror schema decisionSource enum drift detected", { actual: decisionSourceEnum ?? null }));
  }
  return { schema, issues };
}

export function validateSmokeReport(report, options = {}) {
  const issues = [];
  const runnerScenarios = Array.isArray(report?.runnerConfig?.scenarios) ? report.runnerConfig.scenarios : [];
  const turnTranscripts = Array.isArray(report?.turnTranscripts) ? report.turnTranscripts : [];
  const scenarioSummaries = Array.isArray(report?.scenarioSummaries) ? report.scenarioSummaries : [];
  const sessionTurnCounters = new Map();

  if (!isNonEmptyString(report?.runId)) {
    issues.push(fail("report.run_id", "runId is required"));
  }
  if (!isNonEmptyString(report?.generatedAt)) {
    issues.push(fail("report.generated_at", "generatedAt is required"));
  }
  if (!runnerScenarios.length) {
    issues.push(fail("report.runner_scenarios", "runnerConfig.scenarios must be a non-empty array"));
  }

  const summaryTurns = report?.summary?.turns;
  if (!Number.isInteger(summaryTurns)) {
    issues.push(fail("report.summary_turns", "summary.turns must be an integer"));
  } else if (summaryTurns !== turnTranscripts.length) {
    issues.push(fail("report.summary_turns_mismatch", "summary.turns must equal turnTranscripts.length", {
      summaryTurns,
      transcriptCount: turnTranscripts.length,
    }));
  }

  const scenarioTurnsPlayed = scenarioSummaries.reduce((sum, entry) => sum + (Number.isInteger(entry?.turnsPlayed) ? entry.turnsPlayed : 0), 0);
  if (scenarioSummaries.length > 0 && scenarioTurnsPlayed !== turnTranscripts.length) {
    issues.push(fail("report.scenario_turn_count_mismatch", "scenarioSummaries.turnsPlayed must equal turnTranscripts.length", {
      scenarioTurnsPlayed,
      transcriptCount: turnTranscripts.length,
    }));
  }

  const failedScenarios = scenarioSummaries.filter((entry) => entry?.ok !== true).length;
  if (Number.isInteger(report?.summary?.failed) && report.summary.failed !== failedScenarios) {
    issues.push(fail("report.failed_mismatch", "summary.failed must match failed scenario summaries", {
      summaryFailed: report.summary.failed,
      failedScenarios,
    }));
  }

  for (const transcript of turnTranscripts) {
    const key = `${transcript?.cycle ?? "?"}:${transcript?.scenario ?? "?"}:${transcript?.received?.sessionId ?? "?"}`;
    const received = transcript?.received ?? {};
    const sent = transcript?.sent ?? {};
    const response = transcript?.response ?? {};
    const route = parseRoute(sent?.customId);
    const visibleChoices = extractVisibleChoices(received?.originalText);

    if (!isPositiveInt(transcript?.cycle)) {
      issues.push(fail("turn.cycle", "turn transcript cycle must be a positive integer", { key, actual: transcript?.cycle ?? null }));
    }
    if (!isNonEmptyString(transcript?.scenario) || !runnerScenarios.includes(transcript.scenario)) {
      issues.push(fail("turn.scenario", "turn transcript scenario must belong to runnerConfig.scenarios", { key, actual: transcript?.scenario ?? null }));
    }
    if (!isPositiveInt(transcript?.turn)) {
      issues.push(fail("turn.turn", "turn transcript turn must be a positive integer", { key, actual: transcript?.turn ?? null }));
    }
    if (!isNonEmptyString(received?.sessionId)) {
      issues.push(fail("turn.received_session", "received.sessionId is required", { key }));
    }
    if (!isPositiveInt(received?.uiVersion)) {
      issues.push(fail("turn.received_ui_version", "received.uiVersion must be a positive integer", { key, actual: received?.uiVersion ?? null }));
    }
    if (!isNonEmptyString(received?.sceneId)) {
      issues.push(fail("turn.received_scene", "received.sceneId is required", { key }));
    }
    if (!isNonEmptyString(received?.originalText) || !isNonEmptyString(received?.textSummary)) {
      issues.push(fail("turn.received_text", "received.originalText and received.textSummary are required", { key }));
    }
    if (!ALLOWED_SENT_TYPES.has(sent?.type)) {
      issues.push(fail("turn.sent_type", "sent.type must be button or modal", { key, actual: sent?.type ?? null }));
    }
    if (!isNonEmptyString(sent?.customId)) {
      issues.push(fail("turn.sent_custom_id", "sent.customId is required", { key }));
    }
    if (response?.ok !== true && response?.ok !== false) {
      issues.push(fail("turn.response_ok", "response.ok must be boolean", { key, actual: response?.ok ?? null }));
    }

    if (!route) {
      issues.push(fail("turn.route_parse", "sent.customId must match trpg:v1 route format", { key, customId: sent?.customId ?? null }));
      continue;
    }

    if (route.sessionId !== received?.sessionId) {
      issues.push(fail("turn.route_session_mismatch", "sent route sessionId must match received.sessionId", { key, routeSessionId: route.sessionId, receivedSessionId: received?.sessionId ?? null }));
    }
    if (route.uiVersion !== received?.uiVersion) {
      issues.push(fail("turn.route_ui_mismatch", "sent route uiVersion must match received.uiVersion", { key, routeUiVersion: route.uiVersion, receivedUiVersion: received?.uiVersion ?? null }));
    }
    if (route.sceneId !== received?.sceneId) {
      issues.push(fail("turn.route_scene_mismatch", "sent route sceneId must match received.sceneId", { key, routeSceneId: route.sceneId, receivedSceneId: received?.sceneId ?? null }));
    }

    const counterKey = `${transcript.cycle}:${transcript.scenario}:${received.sessionId}`;
    const previousTurn = sessionTurnCounters.get(counterKey) ?? 0;
    if (transcript.turn !== previousTurn + 1) {
      issues.push(warn("turn.sequence_gap", "turn numbers should advance sequentially within cycle/scenario/session", {
        key,
        expected: previousTurn + 1,
        actual: transcript.turn,
      }));
    }
    sessionTurnCounters.set(counterKey, transcript.turn);

    if (sent.type === "button") {
      if (!isNonEmptyString(sent?.actionId)) {
        issues.push(fail("turn.button_action_id", "button turns must provide sent.actionId", { key }));
      }
      if (Object.hasOwn(sent, "freeInput")) {
        issues.push(fail("turn.button_free_input", "button turns must not provide freeInput", { key }));
      }
      if (route.isFreeInputSubmit) {
        issues.push(fail("turn.button_modal_route", "button turns must not target the free-input modal submit route", { key, customId: sent.customId }));
      }
      if (isNonEmptyString(sent?.label) && !textIncludes(received.originalText, sent.label)) {
        issues.push(warn("turn.button_label_visibility", "button label was not found in received.originalText", { key, label: sent.label }));
      }
      if (visibleChoices.length > 0 && isNonEmptyString(sent?.label) && !visibleChoices.includes(String(sent.label).trim()) && sent.label !== "🎯 성향 추천 선택") {
        issues.push(warn("turn.button_label_choice_drift", "button label is not listed in visible choices", { key, label: sent.label, visibleChoices }));
      }
    }

    if (sent.type === "modal") {
      if (!route.isFreeInputSubmit) {
        issues.push(fail("turn.modal_route", "modal turns must use action.free_input.submit route", { key, customId: sent.customId }));
      }
      if (!isNonEmptyString(sent?.freeInput)) {
        issues.push(fail("turn.modal_free_input", "modal turns must provide sent.freeInput", { key }));
      }
      if (sent?.actionId !== null && sent?.actionId !== undefined) {
        issues.push(fail("turn.modal_action_id", "modal turns must not provide sent.actionId", { key, actual: sent?.actionId }));
      }
      if (!textIncludes(received.originalText, "모달:") && !textIncludes(received.originalText, "자유 입력")) {
        issues.push(warn("turn.modal_visibility_hint", "modal turn did not include an obvious modal visibility hint in received.originalText", { key }));
      }
    }

    if (transcript?.recovered === true && response?.ok !== true) {
      issues.push(fail("turn.recovery_outcome", "recovered turns should end with response.ok=true", { key, responseOk: response?.ok ?? null }));
    }
  }

  return {
    ok: !issues.some((entry) => entry.level === "error"),
    issues,
    summary: summarizeIssues(issues),
    meta: {
      transcriptCount: turnTranscripts.length,
      scenarioCount: scenarioSummaries.length,
      runnerScenarios,
      mode: options.mode ?? "report",
    },
  };
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

export async function runSmokeSessionValidation(reportPath) {
  const absoluteReportPath = path.resolve(reportPath);
  const report = await readJson(absoluteReportPath);
  const reportResult = validateSmokeReport(report, { mode: "report" });
  const contractResult = await validateSmokeMirrorContract();
  const issues = [...reportResult.issues, ...contractResult.issues];
  const summary = summarizeIssues(issues);

  return {
    ok: summary.errors === 0,
    reportPath: absoluteReportPath,
    issues,
    summary,
    meta: reportResult.meta,
  };
}

async function main(argv) {
  const reportPath = argv[0];
  if (!reportPath) {
    console.error("Usage: node ./scripts/validate-smoke-session.mjs <report.machine.json>");
    process.exitCode = 1;
    return;
  }

  const result = await runSmokeSessionValidation(reportPath);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  });
}

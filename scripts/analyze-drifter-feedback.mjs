#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { buildDrifterFeedbackAudit, buildDrifterStopCriteria } from "../tests/helpers/drifter-feedback-audit.mjs";
import { runSmokeSessionValidation } from "./validate-smoke-session.mjs";

async function main() {
  const [, , reportArg] = process.argv;
  if (!reportArg) {
    console.error("Usage: node ./scripts/analyze-drifter-feedback.mjs <report.machine.json>");
    process.exitCode = 1;
    return;
  }

  const reportPath = path.resolve(reportArg);
  const raw = await fs.readFile(reportPath, "utf8");
  const report = JSON.parse(raw);
  const validity = await runSmokeSessionValidation(reportPath);
  const audit = buildDrifterFeedbackAudit(report);
  const stopCriteria = buildDrifterStopCriteria(report, { validity, audit });

  const payload = {
    reportPath,
    smokeSessionValidity: {
      ok: validity.ok === true,
      issueCount: Array.isArray(validity.issues) ? validity.issues.length : 0,
      issues: Array.isArray(validity.issues) ? validity.issues : [],
    },
    feedbackQualityAudit: audit,
    stopCriteria,
  };

  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  if (validity.ok !== true) {
    process.exitCode = 2;
  }
}

main().catch((error) => {
  const reason = error instanceof Error ? error.message : String(error);
  console.error(`analyze-drifter-feedback fatal: ${reason}`);
  process.exitCode = 1;
});

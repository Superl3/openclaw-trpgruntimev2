#!/usr/bin/env node

import path from "node:path";
import { summarizeDrifterSandbox, analyzeDrifterSandboxFailures } from "./lib/drifter-sandbox-analysis.mjs";

function parseArgs(argv) {
  const args = {
    sandbox: null,
    outputPrefix: null,
    diffSummaryPath: null,
    analyze: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "-h" || token === "--help") {
      args.help = true;
      continue;
    }
    if (token === "--sandbox") {
      args.sandbox = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === "--output-prefix") {
      args.outputPrefix = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === "--diff-summary") {
      args.diffSummaryPath = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === "--analyze") {
      args.analyze = true;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }

  return args;
}

function usage() {
  return [
    "Usage:",
    "  node ./scripts/drifter-sandbox-report.mjs --sandbox <path>",
    "  node ./scripts/drifter-sandbox-report.mjs --sandbox <path> --analyze [--diff-summary <path>]",
    "",
    "Writes sandbox-local summary files into <sandbox>/reports/.",
  ].join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.sandbox) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const sandboxRoot = path.resolve(args.sandbox);
  const payload = args.analyze
    ? await analyzeDrifterSandboxFailures({
        sandboxRoot,
        diffSummaryPath: args.diffSummaryPath ? path.resolve(args.diffSummaryPath) : null,
        outputPrefix: args.outputPrefix || "failure-analysis",
      })
    : await summarizeDrifterSandbox({
        sandboxRoot,
        outputPrefix: args.outputPrefix || "sandbox-diff-summary",
      });

  process.stdout.write(`${JSON.stringify({ ok: true, sandboxRoot, ...payload }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

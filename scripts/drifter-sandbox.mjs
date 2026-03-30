#!/usr/bin/env node
import path from "node:path";
import {
  createDrifterSandbox,
  destroyDrifterSandbox,
  inspectDrifterSandbox,
} from "./lib/drifter-sandbox.mjs";

function parseArgs(argv) {
  const [, , command, ...rest] = argv;
  const args = { _: command ? [command] : [] };
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (!token.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    const next = rest[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    i += 1;
  }
  return args;
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function main() {
  const args = parseArgs(process.argv);
  const command = args._[0];

  if (!command || args.help) {
    print({
      ok: true,
      usage: [
        "node ./scripts/drifter-sandbox.mjs create [--repo <path>] [--world <path>] [--parent <path>] [--label <name>]",
        "node ./scripts/drifter-sandbox.mjs inspect --sandbox <path>",
        "node ./scripts/drifter-sandbox.mjs destroy --sandbox <path> [--force]",
      ],
    });
    return;
  }

  if (command === "create") {
    const manifest = await createDrifterSandbox({
      sourceRepoRoot: args.repo ? path.resolve(args.repo) : process.cwd(),
      worldSourceRoot: typeof args.world === "string" ? path.resolve(args.world) : null,
      sandboxParentRoot: typeof args.parent === "string" ? path.resolve(args.parent) : undefined,
      label: typeof args.label === "string" ? args.label : undefined,
      sessionProfile: typeof args.profile === "string" ? args.profile : undefined,
      createWorktree: args["no-worktree"] ? false : true,
      headRef: typeof args.ref === "string" ? args.ref : undefined,
    });
    print({ ok: true, command, manifest });
    return;
  }

  if (command === "inspect") {
    if (typeof args.sandbox !== "string") {
      throw new Error("--sandbox is required for inspect");
    }
    const manifest = await inspectDrifterSandbox({ sandboxRoot: path.resolve(args.sandbox) });
    print({ ok: true, command, manifest });
    return;
  }

  if (command === "destroy") {
    if (typeof args.sandbox !== "string") {
      throw new Error("--sandbox is required for destroy");
    }
    const result = await destroyDrifterSandbox({
      sandboxRoot: path.resolve(args.sandbox),
      force: Boolean(args.force),
    });
    print({ ok: true, command, result });
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  print({
    ok: false,
    error: String(error?.message || error),
  });
  process.exitCode = 1;
});

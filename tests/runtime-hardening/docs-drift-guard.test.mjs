import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runTrpgDocDriftCheck } from "../../scripts/check-trpg-doc-drift.mjs";

test("doc drift guard passes current active workspace docs", async () => {
  const docRoot = path.resolve(process.cwd());
  const result = await runTrpgDocDriftCheck({ docRoot });
  assert.equal(result.ok, true, JSON.stringify(result.issues, null, 2));
});

test("doc drift guard fails on legacy command/path references", async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "trpg-doc-drift-"));
  await fs.mkdir(path.resolve(tmpRoot, "docs/ops"), { recursive: true });

  await fs.writeFile(path.resolve(tmpRoot, "AGENTS.md"), "# AGENTS\n", "utf8");
  await fs.writeFile(path.resolve(tmpRoot, "MEMORY.md"), "# MEMORY\n", "utf8");
  await fs.writeFile(path.resolve(tmpRoot, "TOOLS.md"), "# TOOLS\n", "utf8");
  await fs.writeFile(
    path.resolve(tmpRoot, "TRPG_PATH_REGISTRY.yaml"),
    [
      "paths:",
      "  runtime_plugin_active: ~/.openclaw/extensions/trpg-runtime-v2",
      "  runtime_plugin_legacy_archive: ~/archive/extensions/trpg-runtime",
      "",
    ].join("\n"),
    "utf8",
  );
  await fs.writeFile(
    path.resolve(tmpRoot, "docs/ops/host-smoke-test.md"),
    [
      "# host",
      "plugins info trpg-runtime-v2",
      "node openclaw.mjs agent --agent trpg --local",
      "",
    ].join("\n"),
    "utf8",
  );
  await fs.writeFile(
    path.resolve(tmpRoot, "docs/ops/zone-lifecycle-smoke-test.md"),
    [
      "# zone",
      "plugins info trpg-runtime-v2",
      "--agent trpg-v2",
      "",
    ].join("\n"),
    "utf8",
  );
  await fs.writeFile(
    path.resolve(tmpRoot, "docs/ops/bad.md"),
    "legacy path: /home/superl3/.openclaw/extensions/trpg-runtime/agent\n",
    "utf8",
  );

  const result = await runTrpgDocDriftCheck({ docRoot: tmpRoot });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.id === "legacy_agent_flag"));
  assert.ok(result.issues.some((issue) => issue.id === "legacy_runtime_path"));
});

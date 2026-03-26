import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createProcessBridgeDecisionLane } from "../helpers/process-bridge-decision-lane.mjs";

async function writeExecutableScript(dir, fileName, source) {
  const filePath = path.join(dir, fileName);
  await fs.writeFile(filePath, source, "utf8");
  return filePath;
}

test("createProcessBridgeDecisionLane returns parsed selection on success", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "trpg-process-bridge-success-"));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const scriptPath = await writeExecutableScript(
    root,
    "bridge-ok.mjs",
    [
      'import process from "node:process";',
      "const chunks = [];",
      "for await (const chunk of process.stdin) {",
      "  chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));",
      "}",
      "const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));",
      "const customId = payload?.visible?.buttons?.[0]?.customId || 'fallback-button';",
      "process.stdout.write(JSON.stringify({ type: 'button', customId }) + '\\n');",
    ].join("\n"),
  );

  const lane = createProcessBridgeDecisionLane({
    command: process.execPath,
    args: [scriptPath],
    timeoutMs: 5_000,
  });

  const selection = await lane({
    visible: {
      buttons: [{ customId: "btn-primary" }],
    },
  });

  assert.deepEqual(selection, { type: "button", customId: "btn-primary" });
});

test("createProcessBridgeDecisionLane throws timeout errors", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "trpg-process-bridge-timeout-"));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const scriptPath = await writeExecutableScript(
    root,
    "bridge-timeout.mjs",
    [
      "await new Promise((resolve) => setTimeout(resolve, 200));",
      "process.stdout.write(JSON.stringify({ type: 'button', customId: 'late' }) + '\\n');",
    ].join("\n"),
  );

  const lane = createProcessBridgeDecisionLane({
    command: process.execPath,
    args: [scriptPath],
    timeoutMs: 25,
  });

  await assert.rejects(async () => lane({ visible: {} }), /timeout/i);
});

test("createProcessBridgeDecisionLane throws invalid JSON shape errors", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "trpg-process-bridge-invalid-"));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const scriptPath = await writeExecutableScript(
    root,
    "bridge-invalid.mjs",
    ["process.stdout.write(JSON.stringify({ nope: true }) + '\\n');"].join("\n"),
  );

  const lane = createProcessBridgeDecisionLane({
    command: process.execPath,
    args: [scriptPath],
    timeoutMs: 5_000,
  });

  await assert.rejects(async () => lane({ visible: {} }), /invalid selection json/i);
});

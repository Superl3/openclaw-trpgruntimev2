import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const ROOT_DIR = process.cwd();
const SCRIPT_PATH = path.resolve(ROOT_DIR, "scripts/scaffold-gamer-agent-profile.mjs");

function runScript(args) {
  return spawnSync(process.execPath, [SCRIPT_PATH, ...args], {
    cwd: ROOT_DIR,
    encoding: "utf8",
    stdio: "pipe",
  });
}

test("scaffold-gamer-agent-profile writes profile and returns path", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "trpg-gamer-profile-scaffold-"));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const result = runScript(["--agent-path", root]);
  assert.equal(result.status, 0, result.stderr);

  const target = path.join(root, "gamer-smoke.profile.json");
  assert.equal(result.stdout.trim(), target);

  const text = await fs.readFile(target, "utf8");
  const parsed = JSON.parse(text);
  assert.equal(parsed.profileName, "gamer-smoke");
  assert.equal(parsed.llm.temperature, 0);
  assert.equal(typeof parsed.llm.systemPrompt, "string");
});

test("scaffold-gamer-agent-profile blocks overwrite without force", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "trpg-gamer-profile-overwrite-"));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const first = runScript(["--agent-path", root]);
  assert.equal(first.status, 0, first.stderr);

  const second = runScript(["--agent-path", root]);
  assert.notEqual(second.status, 0);
  assert.match(second.stderr, /without --force/i);

  const forced = runScript(["--agent-path", root, "--force"]);
  assert.equal(forced.status, 0, forced.stderr);
});

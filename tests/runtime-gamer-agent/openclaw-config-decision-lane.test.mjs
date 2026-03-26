import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveOpenClawDecisionLaneConfig } from "../helpers/openclaw-config-decision-lane.mjs";

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
}

test("resolveOpenClawDecisionLaneConfig supports explicit external agent path", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "trpg-openclaw-lane-agent-path-"));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const openclawHome = path.join(root, ".openclaw");
  const externalAgentPath = path.join(root, "external-agent", "agent");

  await writeJson(path.join(externalAgentPath, "models.json"), {
    models: {
      providers: {
        openai: {
          baseUrl: "https://api.openai.com/v1",
          apiKey: "sk-agent-direct-123",
          models: [{ id: "gpt-4o-mini" }],
        },
      },
    },
  });

  await writeJson(path.join(openclawHome, "openclaw.json"), {
    models: {
      defaultProvider: "ignored-provider",
      defaultModel: "ignored-model",
      providers: {
        "ignored-provider": {
          models: [{ id: "ignored-model" }],
        },
      },
    },
  });

  const resolved = resolveOpenClawDecisionLaneConfig({
    openclawHome,
    agentPath: externalAgentPath,
  });

  assert.equal(resolved.agentRoot, path.resolve(externalAgentPath));
  assert.equal(resolved.providerId, "openai");
  assert.equal(resolved.modelId, "gpt-4o-mini");
  assert.equal(resolved.apiKey, "sk-agent-direct-123");
  assert.equal(resolved.apiKeySource, "provider.apiKey");
});

test("resolveOpenClawDecisionLaneConfig falls back to auth-profiles credential", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "trpg-openclaw-lane-auth-profile-"));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const openclawHome = path.join(root, ".openclaw");
  const externalAgentPath = path.join(root, "agent-alt", "agent");

  await writeJson(path.join(externalAgentPath, "models.json"), {
    models: {
      providers: {
        openai: {
          baseUrl: "https://api.openai.com/v1",
          apiKey: "<set-key>",
          models: [{ id: "gpt-4o-mini" }],
        },
      },
    },
  });

  await writeJson(path.join(externalAgentPath, "auth-profiles.json"), {
    lastGood: {
      openai: "profile-openai",
    },
    profiles: {
      "profile-openai": {
        provider: "openai",
        apiKey: "sk-auth-profile-456",
      },
    },
  });

  await writeJson(path.join(openclawHome, "openclaw.json"), {
    models: {
      defaultProvider: "openai",
      defaultModel: "gpt-4o-mini",
      providers: {
        openai: {
          models: [{ id: "gpt-4o-mini" }],
        },
      },
    },
  });

  const resolved = resolveOpenClawDecisionLaneConfig({
    openclawHome,
    agentPath: externalAgentPath,
  });

  assert.equal(resolved.providerId, "openai");
  assert.equal(resolved.modelId, "gpt-4o-mini");
  assert.equal(resolved.apiKey, "sk-auth-profile-456");
  assert.equal(resolved.apiKeySource, "auth-profiles");
});

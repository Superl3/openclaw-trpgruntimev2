import fs from "node:fs";
import path from "node:path";
import { createOpenAiChatDecisionLane } from "./llm-gamer-decision-lane.mjs";

const PLACEHOLDER_KEY_PATTERN = /^<.*>$/;
const MISSING_KEY_TOKENS = new Set(["", "no-key", "none", "null", "undefined"]);

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isMissingCredential(rawValue) {
  const value = normalizeString(rawValue);
  if (value.length === 0) {
    return true;
  }
  if (PLACEHOLDER_KEY_PATTERN.test(value)) {
    return true;
  }
  return MISSING_KEY_TOKENS.has(value.toLowerCase());
}

function usableCredential(rawValue) {
  return isMissingCredential(rawValue) ? null : normalizeString(rawValue);
}

function readJsonFileOrNull(filePath) {
  try {
    const text = fs.readFileSync(filePath, "utf8");
    return JSON.parse(text);
  } catch (error) {
    if (error && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
      return null;
    }
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read JSON config at ${filePath}: ${reason}`);
  }
}

function readJsonFileOptional(filePath, options = {}) {
  try {
    const text = fs.readFileSync(filePath, "utf8");
    return JSON.parse(text);
  } catch (error) {
    if (error && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
      if (options.required === true) {
        throw new Error(`Required profile file not found: ${filePath}`);
      }
      return null;
    }
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read JSON config at ${filePath}: ${reason}`);
  }
}

function inferLinuxHomeFromCwd() {
  const cwd = normalizeString(process.cwd());
  const match = cwd.match(/[\\/]home[\\/]([^\\/]+)/);
  if (!match) {
    return null;
  }
  return path.join(path.sep, "home", match[1]);
}

function resolveOpenClawHome(optionsHome) {
  const explicit = normalizeString(optionsHome ?? process.env.OPENCLAW_HOME);
  if (explicit) {
    return explicit;
  }

  const candidates = [
    inferLinuxHomeFromCwd(),
    normalizeString(process.env.HOME),
    normalizeString(process.env.USERPROFILE),
  ]
    .filter(Boolean)
    .map((homeRoot) => path.join(homeRoot, ".openclaw"));

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  if (candidates.length === 0) {
    return path.join(path.sep, ".openclaw");
  }
  return candidates[0];
}

function resolveAgentRoot(options = {}) {
  const explicitAgentPath =
    normalizeString(options.agentPath) ||
    normalizeString(options.agentDir) ||
    normalizeString(process.env.GAMER_AGENT_PATH) ||
    null;

  if (explicitAgentPath) {
    return path.resolve(explicitAgentPath);
  }

  const openclawHome = resolveOpenClawHome(options.openclawHome);
  const agentId = normalizeString(options.agentId ?? process.env.GAMER_OPENCLAW_AGENT) || "trpg-v2";
  return path.join(openclawHome, "agents", agentId, "agent");
}

function resolveProfilePath(agentRoot, options = {}) {
  const explicit =
    normalizeString(options.profilePath) ||
    normalizeString(options.agentProfile) ||
    normalizeString(process.env.GAMER_AGENT_PROFILE) ||
    null;
  if (explicit) {
    return {
      profilePath: path.resolve(explicit),
      required: true,
    };
  }

  const defaultPath = path.join(agentRoot, "gamer-smoke.profile.json");
  if (fs.existsSync(defaultPath)) {
    return {
      profilePath: defaultPath,
      required: false,
    };
  }

  return {
    profilePath: null,
    required: false,
  };
}

function normalizeOptionalText(value) {
  const normalized = normalizeString(value);
  return normalized.length > 0 ? normalized : null;
}

function normalizeOptionalNumber(value) {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function pickDecisionLaneSettings(profile) {
  const llm = profile?.llm && typeof profile.llm === "object" ? profile.llm : {};
  return {
    systemPrompt: normalizeOptionalText(llm.systemPrompt),
    temperature: normalizeOptionalNumber(llm.temperature),
    topP: normalizeOptionalNumber(llm.topP),
    maxTokens: normalizeOptionalNumber(llm.maxTokens),
    timeoutMs: normalizeOptionalNumber(llm.timeoutMs),
  };
}

function readModelIds(providerConfig) {
  const models = Array.isArray(providerConfig?.models) ? providerConfig.models : [];
  return models
    .map((entry) => normalizeString(entry?.id))
    .filter((entry) => entry.length > 0);
}

function collectProviders(source) {
  const byModels = source?.models?.providers;
  if (byModels && typeof byModels === "object") {
    return byModels;
  }
  const byRoot = source?.providers;
  if (byRoot && typeof byRoot === "object") {
    return byRoot;
  }
  return {};
}

function collectDefaults(source) {
  return {
    provider:
      normalizeString(source?.models?.defaultProvider) ||
      normalizeString(source?.defaults?.provider) ||
      normalizeString(source?.defaults?.modelProvider) ||
      null,
    model:
      normalizeString(source?.models?.defaultModel) ||
      normalizeString(source?.defaults?.model) ||
      null,
  };
}

function providerEnvApiKeyNames(providerId) {
  const normalizedProvider = normalizeString(providerId).toLowerCase();
  switch (normalizedProvider) {
    case "openrouter":
      return ["OPENROUTER_API_KEY"];
    case "openai":
    case "openai-codex":
    case "openai/codex":
      return ["OPENAI_API_KEY"];
    case "google":
    case "gemini":
      return ["GEMINI_API_KEY", "GOOGLE_API_KEY"];
    case "anthropic":
      return ["ANTHROPIC_API_KEY"];
    case "xai":
      return ["XAI_API_KEY"];
    case "mistral":
      return ["MISTRAL_API_KEY"];
    case "cohere":
      return ["COHERE_API_KEY"];
    case "deepseek":
      return ["DEEPSEEK_API_KEY"];
    default:
      return [];
  }
}

function resolveProviderEnvCredential(providerId, openclawConfig) {
  const envNames = providerEnvApiKeyNames(providerId);
  if (envNames.length === 0) {
    return null;
  }

  for (const envName of envNames) {
    const processEnvCredential = usableCredential(process.env[envName]);
    if (processEnvCredential) {
      return {
        credential: processEnvCredential,
        source: `env:${envName}`,
      };
    }
  }

  const openclawEnvVars =
    openclawConfig?.env?.vars && typeof openclawConfig.env.vars === "object" ? openclawConfig.env.vars : {};
  for (const envName of envNames) {
    const openclawEnvCredential = usableCredential(openclawEnvVars[envName]);
    if (openclawEnvCredential) {
      return {
        credential: openclawEnvCredential,
        source: `openclaw.env:${envName}`,
      };
    }
  }

  return null;
}

function parseIsoMillisOrNull(value) {
  if (typeof value !== "string") {
    return null;
  }
  const parsed = Date.parse(value.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function parseEpochMillisOrNull(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  if (parsed > 0 && parsed < 1e12) {
    return Math.trunc(parsed * 1000);
  }
  return Math.trunc(parsed);
}

function readProfileExpiryMs(profile) {
  const candidates = [
    profile?.expiresAt,
    profile?.expiresAtIso,
    profile?.expires,
    profile?.expiry,
    profile?.expiryIso,
    profile?.expiresOn,
    profile?.accessTokenExpiresAt,
    profile?.accessTokenExpiresAtIso,
    profile?.tokenExpiresAt,
    profile?.tokenExpiresAtIso,
    profile?.expiresAtMs,
    profile?.expiryMs,
    profile?.accessTokenExpiresAtMs,
    profile?.tokenExpiresAtMs,
    profile?.expiresAtUnix,
    profile?.expiryUnix,
    profile?.expiresAtSec,
    profile?.expirySec,
  ];

  for (const candidate of candidates) {
    const asIso = parseIsoMillisOrNull(candidate);
    if (asIso !== null) {
      return asIso;
    }
    const asEpoch = parseEpochMillisOrNull(candidate);
    if (asEpoch !== null) {
      return asEpoch;
    }
  }
  return null;
}

function extractProfileCredential(profile, nowMs = Date.now()) {
  const profileType = normalizeString(profile?.type).toLowerCase();
  const authType = profileType === "oauth" ? "oauth" : "api_key";
  const credentialCandidates =
    authType === "oauth"
      ? [profile?.accessToken, profile?.token, profile?.access_token]
      : [profile?.key, profile?.apiKey, profile?.token, profile?.accessToken, profile?.secret];

  if (authType === "oauth") {
    credentialCandidates.unshift(profile?.access);
  }

  let credential = null;
  for (const candidate of credentialCandidates) {
    const value = usableCredential(candidate);
    if (value) {
      credential = value;
      break;
    }
  }
  if (!credential) {
    return null;
  }

  if (authType === "oauth") {
    const expiresAtMs = readProfileExpiryMs(profile);
    if (expiresAtMs !== null && Number.isFinite(nowMs) && expiresAtMs <= nowMs) {
      return null;
    }
  }

  return {
    credential,
    authType,
  };
}

function resolveAuthProfileCredential(authProfiles, providerId) {
  const provider = normalizeString(providerId);
  if (!provider) {
    return null;
  }
  const profiles = authProfiles?.profiles && typeof authProfiles.profiles === "object" ? authProfiles.profiles : {};
  const lastGoodId = normalizeString(authProfiles?.lastGood?.[provider]);
  if (lastGoodId && profiles[lastGoodId]) {
    const resolved = extractProfileCredential(profiles[lastGoodId]);
    if (resolved) {
      return {
        ...resolved,
        profileId: lastGoodId,
      };
    }
  }

  for (const profile of Object.values(profiles)) {
    if (normalizeString(profile?.provider) !== provider) {
      continue;
    }
    const resolved = extractProfileCredential(profile);
    if (resolved) {
      return {
        ...resolved,
        profileId: normalizeString(profile?.id) || null,
      };
    }
  }
  return null;
}

function isLocalhostBaseUrl(baseUrl) {
  const normalized = normalizeString(baseUrl);
  if (!normalized) {
    return false;
  }
  try {
    const parsed = new URL(normalized);
    const host = normalizeString(parsed.hostname).toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}

function findProviderForModel(modelId, providerSources) {
  const model = normalizeString(modelId);
  if (!model) {
    return null;
  }
  for (const [providerId, providerConfig] of Object.entries(providerSources)) {
    const modelIds = readModelIds(providerConfig);
    if (modelIds.includes(model)) {
      return providerId;
    }
  }
  return null;
}

function firstModelForProvider(providerConfig) {
  const modelIds = readModelIds(providerConfig);
  return modelIds[0] ?? null;
}

function resolveModelOverride(rawModel) {
  const model = normalizeString(rawModel);
  if (!model) {
    return { model: null, inferredProvider: null };
  }
  const segments = model.split("/").filter(Boolean);
  if (segments.length >= 2) {
    return {
      model,
      inferredProvider: segments[0],
    };
  }
  return {
    model,
    inferredProvider: null,
  };
}

export function resolveOpenClawDecisionLaneConfig(options = {}) {
  const openclawHome = resolveOpenClawHome(options.openclawHome);
  const agentRoot = resolveAgentRoot(options);
  const agentId = normalizeString(options.agentId ?? process.env.GAMER_OPENCLAW_AGENT) || "trpg-v2";
  const providerOverride = normalizeString(options.provider ?? process.env.GAMER_PROVIDER) || null;
  const modelOverrideResolved = resolveModelOverride(options.model ?? process.env.GAMER_MODEL);
  const resolvedProfile = resolveProfilePath(agentRoot, options);
  const profile = resolvedProfile.profilePath
    ? readJsonFileOptional(resolvedProfile.profilePath, { required: resolvedProfile.required })
    : null;
  const profileLane = pickDecisionLaneSettings(profile);

  const agentModelsPath = path.join(agentRoot, "models.json");
  const agentAuthProfilesPath = path.join(agentRoot, "auth-profiles.json");
  const globalOpenClawPath = path.join(openclawHome, "openclaw.json");

  const [agentModels, agentAuthProfiles, globalOpenClaw] = [
    readJsonFileOrNull(agentModelsPath),
    readJsonFileOrNull(agentAuthProfilesPath),
    readJsonFileOrNull(globalOpenClawPath),
  ];

  const agentProviders = collectProviders(agentModels);
  const globalProviders = collectProviders(globalOpenClaw);
  const globalDefaults = collectDefaults(globalOpenClaw);

  let providerId =
    providerOverride ||
    modelOverrideResolved.inferredProvider ||
    findProviderForModel(modelOverrideResolved.model, agentProviders) ||
    findProviderForModel(modelOverrideResolved.model, globalProviders) ||
    Object.keys(agentProviders)[0] ||
    globalDefaults.provider ||
    null;

  if (!providerId) {
    providerId = Object.keys(globalProviders)[0] ?? null;
  }

  const providerConfig = agentProviders[providerId] || globalProviders[providerId] || null;
  const globalDefaultModelForProvider = providerId === globalDefaults.provider ? globalDefaults.model : null;
  const modelId =
    modelOverrideResolved.model ||
    globalDefaultModelForProvider ||
    firstModelForProvider(providerConfig) ||
    null;

  if (!providerId || !providerConfig || !modelId) {
    throw new Error(
      `Unable to resolve OpenClaw provider/model for lane=openclaw (home=${openclawHome}, agent=${agentId}, agentRoot=${agentRoot}). ` +
        "Set GAMER_PROVIDER/GAMER_MODEL or configure models.json/openclaw.json defaults.",
    );
  }

  const baseUrl = normalizeString(providerConfig.baseUrl) || null;
  const envCredential = resolveProviderEnvCredential(providerId, globalOpenClaw);
  const profileCredential = resolveAuthProfileCredential(agentAuthProfiles, providerId);
  const directApiKey = usableCredential(providerConfig.apiKey);
  const apiKey = envCredential?.credential || profileCredential?.credential || directApiKey;
  const apiKeySource =
    envCredential?.source || (profileCredential ? "auth-profiles" : directApiKey ? "provider.apiKey" : null);
  const authType = envCredential ? "api_key" : profileCredential?.authType || (directApiKey ? "api_key" : null);
  const allowNoAuth = isLocalhostBaseUrl(baseUrl) && !apiKey;

  if (!apiKey && !allowNoAuth) {
    throw new Error(
      `No usable credentials found for provider '${providerId}' (agent=${agentId}, agentRoot=${agentRoot}). ` +
        `Checked ${agentModelsPath} apiKey and ${agentAuthProfilesPath} profiles/lastGood.`,
    );
  }

  return {
    openclawHome,
    agentId,
    agentRoot,
    providerId,
    modelId,
    baseUrl,
    apiKeySource,
    authType,
    allowNoAuth,
    apiKey,
    profilePath: resolvedProfile.profilePath,
    profileSettings: profileLane,
  };
}

export function createOpenClawConfigDecisionLane(options = {}) {
  const resolved = resolveOpenClawDecisionLaneConfig(options);
  const profileSettings = resolved.profileSettings || {};
  return createOpenAiChatDecisionLane({
    ...(resolved.apiKey ? { apiKey: resolved.apiKey } : {}),
    ...(resolved.allowNoAuth ? { allowNoAuth: true } : {}),
    model: resolved.modelId,
    ...(resolved.baseUrl ? { baseUrl: resolved.baseUrl } : {}),
    ...(profileSettings.systemPrompt ? { systemPrompt: profileSettings.systemPrompt } : {}),
    ...(profileSettings.temperature !== null ? { temperature: profileSettings.temperature } : {}),
    ...(profileSettings.topP !== null ? { topP: profileSettings.topP } : {}),
    ...(profileSettings.maxTokens !== null ? { maxTokens: profileSettings.maxTokens } : {}),
    ...(profileSettings.timeoutMs !== null ? { timeoutMs: profileSettings.timeoutMs } : {}),
    ...(options.systemPrompt ? { systemPrompt: options.systemPrompt } : {}),
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.topP !== undefined ? { topP: options.topP } : {}),
    ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
  });
}

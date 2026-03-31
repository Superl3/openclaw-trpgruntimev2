import fs from "node:fs/promises";
import type { TrpgRuntimeConfig } from "../../config.js";
import type { RuntimePhase } from "../../discord-components.js";
import type { PatchCache } from "../../patch-engine.js";
import { emitRuntimeDiagnostic } from "../../runtime-core/runtime-diagnostics.js";
import {
  loadStructuredWorldFile,
  renderStructuredContent,
  resolveWorldAbsolutePath,
} from "../../world-store.js";
import {
  applyBootstrapAuditedPersistence,
  syncBootstrapStateToStatus,
} from "./bootstrap-persistence-helpers.js";
import {
  collectMissingBootstrapFields,
  hasMinimalBootstrapFields,
  relationshipKey,
} from "./bootstrap-state-helpers.js";
import {
  extractBootstrapFreeform,
  hasBootstrapReadySignal,
  mergeFreeformDescription,
  parseBootstrapUpdate,
  sanitizeLegacyBootstrapTemplateText,
  type BootstrapUpdate,
} from "./bootstrap-text-helpers.js";

export type BootstrapGateResult = {
  bootstrapComplete: boolean;
  justCompleted: boolean;
  runtimePhase: RuntimePhase;
  phaseSignals: {
    characterCreated: boolean;
    bootstrapComplete: boolean;
    playerSetupComplete: boolean;
    introShown: boolean;
  };
  contextChunk?: string;
};

type RunCharacterBootstrapGateDeps = {
  toObject: (value: unknown) => Record<string, unknown>;
  readString: (value: unknown) => string;
  joinLines: (lines: string[]) => string;
  extractLatestUserMessageFromPrompt: (prompt: string) => string;
  extractLatestUserMessage: (messages: unknown[]) => string;
};

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export async function runCharacterBootstrapGate(
  params: {
    cfg: TrpgRuntimeConfig;
    worldRoot: string;
    agentId: string;
    sessionId?: string;
    patchCache: PatchCache;
    messages: unknown[];
    prompt: string;
  },
  deps: RunCharacterBootstrapGateDeps,
): Promise<BootstrapGateResult> {
  const loaded = await loadStructuredWorldFile(params.worldRoot, "canon/player.yaml", {
    allowMissing: true,
    maxReadBytes: params.cfg.maxReadBytes,
  });

  const root = deps.toObject(loaded.parsed);
  const player = deps.toObject(root.player);
  const gameState = deps.toObject(root.game_state);
  const worldHints = deps.toObject(root.world_hints);

  const latestUserMessage =
    deps.extractLatestUserMessageFromPrompt(params.prompt) || deps.extractLatestUserMessage(params.messages);

  let bootstrapUpdate: BootstrapUpdate = {};
  try {
    bootstrapUpdate = parseBootstrapUpdate(latestUserMessage);
    await emitRuntimeDiagnostic({
      cfg: params.cfg,
      worldRoot: params.worldRoot,
      sessionId: params.sessionId,
      event: "bootstrap_gate_update_parse_success",
      severity: "info",
      runtimePhase: "BOOTSTRAP",
      route: "before_prompt_build",
      gate: "bootstrap_update_parse",
      result: "success",
      details: {
        messagePresent: Boolean(latestUserMessage),
        extractedFields: Object.keys(bootstrapUpdate).length,
      },
    });
  } catch (error) {
    await emitRuntimeDiagnostic({
      cfg: params.cfg,
      worldRoot: params.worldRoot,
      sessionId: params.sessionId,
      event: "bootstrap_gate_update_parse_failed",
      severity: "warn",
      runtimePhase: "BOOTSTRAP",
      route: "before_prompt_build",
      gate: "bootstrap_update_parse",
      result: "failed",
      details: {
        error: error instanceof Error ? error.message : String(error),
      },
    });
  }

  let changed = false;
  for (const field of ["name", "background", "motive", "secret", "fear", "goal"] as const) {
    const candidate = deps.readString(bootstrapUpdate[field]);
    if (!candidate || player[field] === candidate) {
      continue;
    }
    player[field] = candidate;
    changed = true;
  }

  const sanitizedStoredFreeform = sanitizeLegacyBootstrapTemplateText(deps.readString(player.freeform_description));
  if (deps.readString(player.freeform_description) !== sanitizedStoredFreeform) {
    player.freeform_description = sanitizedStoredFreeform;
    changed = true;
  }

  const incomingFreeform = sanitizeLegacyBootstrapTemplateText(extractBootstrapFreeform(latestUserMessage));
  const mergedFreeform = mergeFreeformDescription(
    deps.readString(player.freeform_description),
    incomingFreeform,
  );
  if (deps.readString(player.freeform_description) !== mergedFreeform) {
    player.freeform_description = mergedFreeform;
    changed = true;
  }

  if (typeof gameState.character_created !== "boolean") {
    gameState.character_created = false;
    changed = true;
  }
  if (typeof gameState.bootstrap_complete !== "boolean") {
    gameState.bootstrap_complete = false;
    changed = true;
  }

  const priorBootstrapComplete = gameState.bootstrap_complete === true;
  const explicitReady = hasBootstrapReadySignal(latestUserMessage);
  const minimalComplete = hasMinimalBootstrapFields(player, deps.readString);
  const shouldComplete = !priorBootstrapComplete && (minimalComplete || explicitReady);

  const characterCreated = gameState.character_created === true || Boolean(deps.readString(player.name));
  if (gameState.character_created !== characterCreated) {
    gameState.character_created = characterCreated;
    changed = true;
  }

  if (shouldComplete && gameState.bootstrap_complete !== true) {
    gameState.bootstrap_complete = true;
    changed = true;
  }

  root.player = player;
  root.game_state = gameState;
  root.world_hints = worldHints;

  const bootstrapComplete = gameState.bootstrap_complete === true;
  const justCompleted = !priorBootstrapComplete && bootstrapComplete;

  const sceneLoaded = await loadStructuredWorldFile(params.worldRoot, "state/current-scene.yaml", {
    allowMissing: true,
    maxReadBytes: params.cfg.maxReadBytes,
  });
  if (sceneLoaded.exists) {
    const sceneRoot = deps.toObject(sceneLoaded.parsed);
    const scene = deps.toObject(sceneRoot.scene);
    if (Object.keys(scene).length > 0) {
      const sceneFlow = deps.toObject(scene.scene_flow);
      let sceneChanged = false;

      if (sceneFlow.player_setup_complete !== bootstrapComplete) {
        sceneFlow.player_setup_complete = bootstrapComplete;
        sceneChanged = true;
      }

      if (!bootstrapComplete && sceneFlow.intro_shown !== false) {
        sceneFlow.intro_shown = false;
        sceneChanged = true;
      }

      if (justCompleted && sceneFlow.intro_shown !== false) {
        sceneFlow.intro_shown = false;
        sceneChanged = true;
      }

      if (sceneChanged) {
        scene.scene_flow = sceneFlow;
        sceneRoot.scene = scene;
        const sceneRendered = renderStructuredContent(sceneLoaded.format, sceneRoot);
        const sceneAbsolute = resolveWorldAbsolutePath(params.worldRoot, "state/current-scene.yaml");
        await fs.writeFile(sceneAbsolute, sceneRendered, "utf8");
      }
    }
  }

  if (changed) {
    const persisted = await applyBootstrapAuditedPersistence(
      {
        cfg: params.cfg,
        worldRoot: params.worldRoot,
        agentId: params.agentId,
        sessionId: params.sessionId,
        patchCache: params.patchCache,
        title: "bootstrap player canon persistence",
        operations: [
          {
            op: "set",
            file: "canon/player.yaml",
            pointer: "/",
            value: root,
          },
        ],
      },
      {
        toObject: deps.toObject,
        readString: deps.readString,
      },
    );
    if (!persisted.ok) {
      throw new Error(persisted.error || "bootstrap player persistence failed");
    }
  }

  await syncBootstrapStateToStatus(
    {
      cfg: params.cfg,
      worldRoot: params.worldRoot,
      player,
      gameState,
    },
    {
      toObject: deps.toObject,
      readString: deps.readString,
    },
  );

  const [worldSeedsLoaded, relationshipsLoaded] = await Promise.all([
    loadStructuredWorldFile(params.worldRoot, "state/world-seeds.yaml", {
      allowMissing: true,
      maxReadBytes: params.cfg.maxReadBytes,
    }),
    loadStructuredWorldFile(params.worldRoot, "state/relationships.yaml", {
      allowMissing: true,
      maxReadBytes: params.cfg.maxReadBytes,
    }),
  ]);

  const worldSeedsRoot = deps.toObject(worldSeedsLoaded.parsed);
  const worldSeeds = deps.toObject(worldSeedsRoot.seeds);
  const bootstrapSeeds = deps.toObject(worldSeeds.bootstrap);
  const existingSeedStructures = toStringArray(bootstrapSeeds.inferred_structures);
  const existingSeedZones = toStringArray(bootstrapSeeds.zone_hints);
  const inferredMerged = Array.from(
    new Set([...existingSeedStructures, ...toStringArray(worldHints.inferred_structures)]),
  );
  const mergedSeedZones = Array.from(new Set(existingSeedZones));

  let worldSeedsChanged = false;
  if (
    inferredMerged.length !== existingSeedStructures.length ||
    mergedSeedZones.length !== existingSeedZones.length
  ) {
    bootstrapSeeds.inferred_structures = inferredMerged;
    bootstrapSeeds.zone_hints = mergedSeedZones;
    worldSeeds.bootstrap = bootstrapSeeds;
    worldSeedsRoot.seeds = worldSeeds;
    worldSeedsRoot.meta = {
      ...deps.toObject(worldSeedsRoot.meta),
      schema_version: 1,
      last_updated: new Date().toISOString(),
    };
    worldSeedsChanged = true;
  }

  const relationshipsRoot = deps.toObject(relationshipsLoaded.parsed);
  const relationshipsNode = deps.toObject(relationshipsRoot.relationships);
  const existingEdges = Array.isArray(relationshipsNode.edges)
    ? relationshipsNode.edges
    : Array.isArray(relationshipsRoot.edges)
      ? relationshipsRoot.edges
      : [];
  const mergedEdges: Record<string, unknown>[] = [];
  const seenEdgeKeys = new Set<string>();
  for (const edge of existingEdges) {
    const edgeObj = deps.toObject(edge);
    const key = relationshipKey(edgeObj, deps.readString);
    if (!key || seenEdgeKeys.has(key)) continue;
    seenEdgeKeys.add(key);
    mergedEdges.push(edgeObj);
  }
  const relationshipsChanged = mergedEdges.length !== existingEdges.length;
  if (relationshipsChanged) {
    relationshipsNode.edges = mergedEdges;
    relationshipsRoot.relationships = relationshipsNode;
    relationshipsRoot.meta = {
      ...deps.toObject(relationshipsRoot.meta),
      schema_version: 1,
      last_updated: new Date().toISOString(),
    };
  }

  if (worldSeedsChanged || relationshipsChanged) {
    const ops: Array<Record<string, unknown>> = [];
    if (worldSeedsChanged) {
      ops.push({ op: "set", file: "state/world-seeds.yaml", pointer: "/", value: worldSeedsRoot });
    }
    if (relationshipsChanged) {
      ops.push({ op: "set", file: "state/relationships.yaml", pointer: "/", value: relationshipsRoot });
    }
    const persisted = await applyBootstrapAuditedPersistence(
      {
        cfg: params.cfg,
        worldRoot: params.worldRoot,
        agentId: params.agentId,
        sessionId: params.sessionId,
        patchCache: params.patchCache,
        title: "bootstrap seed and relationship persistence",
        operations: ops,
      },
      {
        toObject: deps.toObject,
        readString: deps.readString,
      },
    );
    if (!persisted.ok) {
      throw new Error(persisted.error || "bootstrap seed/relationship persistence failed");
    }
  }

  const playerSetupComplete = sceneLoaded.exists
    ? deps.toObject(deps.toObject(deps.toObject(sceneLoaded.parsed).scene).scene_flow).player_setup_complete === true
    : false;
  const introShown = sceneLoaded.exists
    ? deps.toObject(deps.toObject(deps.toObject(sceneLoaded.parsed).scene).scene_flow).intro_shown === true
    : false;
  const runtimePhase: RuntimePhase = !characterCreated || !bootstrapComplete
    ? "BOOTSTRAP"
    : !playerSetupComplete || !introShown
      ? "READY_FOR_INTRO"
      : "IN_GAME";

  await emitRuntimeDiagnostic({
    cfg: params.cfg,
    worldRoot: params.worldRoot,
    sessionId: params.sessionId,
    event: "bootstrap_phase_judgement",
    severity: "info",
    runtimePhase,
    route: "before_prompt_build",
    gate: "phase",
    result: runtimePhase,
    details: {
      intro_shown: introShown,
      player_setup_complete: playerSetupComplete,
      bootstrap_complete: bootstrapComplete,
      character_created: characterCreated,
      justCompleted,
    },
  });

  if (bootstrapComplete) {
    return {
      bootstrapComplete,
      justCompleted,
      runtimePhase,
      phaseSignals: {
        characterCreated,
        bootstrapComplete,
        playerSetupComplete,
        introShown,
      },
    };
  }

  const missingFields = collectMissingBootstrapFields(player, deps.readString);
  const contextLines: string[] = [
    "[TRPG_DISCORD_COMPONENTS_BOOTSTRAP]",
    "Non-IN_GAME bootstrap phase is active. Enforce system-safe UI only.",
    gameState.character_created === true
      ? "character_created=true AND bootstrap_complete=false"
      : "character_created=false",
    "Use only bootstrap controls: 이름 입력, 배경/출신 입력, 현재 목표 입력, 완료/다음 단계, 자유서술 입력.",
    "Do not emit in-game recommendation buttons (예: 조사/이동/전투/인벤토리).",
    "Keep explanation short and let player continue with freeform input.",
  ];

  if (deps.readString(player.name)) contextLines.push(`Known 이름: ${deps.readString(player.name)}`);
  if (deps.readString(player.background))
    contextLines.push(`Known 출신 / 배경: ${deps.readString(player.background)}`);
  if (deps.readString(player.motive))
    contextLines.push(`Known 지금 이 세계에 들어온 이유: ${deps.readString(player.motive)}`);
  if (deps.readString(player.secret)) contextLines.push(`Known 비밀: ${deps.readString(player.secret)}`);
  if (deps.readString(player.fear)) contextLines.push(`Known 두려워하는 것: ${deps.readString(player.fear)}`);
  if (deps.readString(player.goal))
    contextLines.push(`Known 지금 당장의 목표: ${deps.readString(player.goal)}`);

  if (missingFields.length > 0) {
    contextLines.push(`Still open: ${missingFields.join(", ")}`);
  }

  return {
    bootstrapComplete,
    justCompleted,
    runtimePhase,
    phaseSignals: {
      characterCreated,
      bootstrapComplete,
      playerSetupComplete,
      introShown,
    },
    contextChunk: deps.joinLines(contextLines),
  };
}

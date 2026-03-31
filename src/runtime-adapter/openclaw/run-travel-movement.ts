import fs from "node:fs/promises";
import type { TrpgRuntimeConfig } from "../../config.js";
import {
  loadStructuredWorldFile,
  renderStructuredContent,
  resolveWorldAbsolutePath,
} from "../../world-store.js";
import { detectTravelMode, isMovementIntent } from "./travel-intent-helpers.js";
import {
  buildZoneAliasMap,
  buildZoneGraph,
  normalizeZoneId,
  pressureSignalsForZone,
  resolveTravelIntent,
  shortestPath,
  travelHintsByZoneType,
  zoneName,
  zoneType,
} from "./travel-zone-helpers.js";
import {
  appendZoneSeeds,
  generateLinkedZoneForUnknownDestination,
  shouldPreferGeneratedDestination,
} from "./travel-zone-generation-helpers.js";

export type TravelTransitionResult = {
  movementIntent: boolean;
  occurred: boolean;
  reason: string;
  contextChunk?: string;
  generatedZone?: boolean;
};

type RunTravelMovementDeps = {
  toObject: (value: unknown) => Record<string, unknown>;
  readString: (value: unknown) => string;
  sanitizeIntentText: (value: string, maxLength: number) => string;
  clipForGuard: (value: string, maxLength: number) => string;
  uniqStrings: (values: string[]) => string[];
  joinLines: (lines: string[]) => string;
  extractLatestUserMessageFromPrompt: (prompt: string) => string;
  extractLatestUserMessage: (messages: unknown[]) => string;
};

export async function runTravelMovement(
  params: {
    cfg: TrpgRuntimeConfig;
    worldRoot: string;
    messages: unknown[];
    prompt: string;
  },
  deps: RunTravelMovementDeps,
): Promise<TravelTransitionResult> {
  const latestUserMessage =
    deps.extractLatestUserMessageFromPrompt(params.prompt) || deps.extractLatestUserMessage(params.messages);
  if (!latestUserMessage || !isMovementIntent(latestUserMessage)) {
    return {
      movementIntent: false,
      occurred: false,
      reason: "no movement intent",
    };
  }

  const [pressureLoaded, sceneLoaded, travelLoaded] = await Promise.all([
    loadStructuredWorldFile(params.worldRoot, "state/world-pressure.yaml", {
      allowMissing: true,
      maxReadBytes: params.cfg.maxReadBytes,
    }),
    loadStructuredWorldFile(params.worldRoot, "state/current-scene.yaml", {
      allowMissing: true,
      maxReadBytes: params.cfg.maxReadBytes,
    }),
    loadStructuredWorldFile(params.worldRoot, "state/travel-state.yaml", {
      allowMissing: true,
      maxReadBytes: params.cfg.maxReadBytes,
    }),
  ]);

  const safeIntent = deps.sanitizeIntentText(latestUserMessage, 220) || deps.clipForGuard(latestUserMessage, 220);

  const zoneGraph = buildZoneGraph(pressureLoaded.parsed);
  const zoneIds = Object.keys(zoneGraph);
  if (zoneIds.length === 0) {
    return {
      movementIntent: true,
      occurred: false,
      reason: "zone graph unavailable",
    };
  }

  const sceneRoot = deps.toObject(sceneLoaded.parsed);
  const sceneLocation = deps.toObject(deps.toObject(sceneRoot.scene).location);
  const sceneZone = normalizeZoneId(deps.readString(sceneLocation.zone_id));

  const travelRoot = deps.toObject(travelLoaded.parsed);
  const travelState = deps.toObject(travelRoot.travel_state);
  const currentZoneId = normalizeZoneId(
    deps.readString(travelState.current_zone) || sceneZone || zoneIds[0] || "",
  );

  if (!currentZoneId || !zoneGraph[currentZoneId]) {
    return {
      movementIntent: true,
      occurred: false,
      reason: "current zone unavailable",
    };
  }

  const persistedDestinationZoneId = normalizeZoneId(deps.readString(travelState.destination_zone));
  const aliasMap = buildZoneAliasMap(zoneGraph);
  const travelIntent = resolveTravelIntent({
    message: latestUserMessage,
    currentZoneId,
    persistedDestinationZoneId,
    aliasMap,
  });

  let destinationZoneId = travelIntent.destinationZoneId;
  let generatedZoneContextLine = "";
  const shouldPreferGeneratedDestinationResult = shouldPreferGeneratedDestination({
    latestUserMessage,
    aliasMap,
  });

  if (!destinationZoneId || shouldPreferGeneratedDestinationResult) {
    const generatedZone = await generateLinkedZoneForUnknownDestination({
      worldRoot: params.worldRoot,
      latestUserMessage,
      currentZoneId,
      zoneGraph,
      pressureParsed: pressureLoaded.parsed,
      pressureFormat: pressureLoaded.format,
      aliasMap,
    });

    if (generatedZone) {
      destinationZoneId = generatedZone.destinationZoneId;
      generatedZoneContextLine = generatedZone.contextLine;
      zoneGraph[destinationZoneId] = {
        id: destinationZoneId,
        name: generatedZone.zoneNameValue,
        type: generatedZone.zoneTypeValue,
        parentRegion: zoneGraph[currentZoneId]?.parentRegion || "generated-frontier",
        tags: ["generated", "runtime"],
        connections: deps.uniqStrings([
          currentZoneId,
          ...(zoneGraph[currentZoneId]?.connections ?? []).slice(0, 1),
        ]),
        aliases: [generatedZone.zoneNameValue],
        pressure: 55,
      };
      for (const conn of zoneGraph[destinationZoneId].connections) {
        if (zoneGraph[conn]) {
          zoneGraph[conn].connections = deps.uniqStrings([
            ...zoneGraph[conn].connections,
            destinationZoneId,
          ]);
        }
      }
    }
  }

  if (!destinationZoneId) {
    return {
      movementIntent: true,
      occurred: false,
      reason: "destination unresolved",
    };
  }

  const destinationRoute = shortestPath(zoneGraph, currentZoneId, destinationZoneId);
  if (destinationRoute.length === 0) {
    return {
      movementIntent: true,
      occurred: false,
      reason: "no traversable route",
    };
  }

  let immediateTargetZoneId =
    travelIntent.pathZoneId && travelIntent.pathZoneId !== currentZoneId
      ? travelIntent.pathZoneId
      : destinationZoneId;

  let route = shortestPath(zoneGraph, currentZoneId, immediateTargetZoneId);
  if (route.length <= 1 && immediateTargetZoneId !== destinationZoneId) {
    immediateTargetZoneId = destinationZoneId;
    route = destinationRoute;
  }

  if (route.length === 0) {
    return {
      movementIntent: true,
      occurred: false,
      reason: "no traversable route",
    };
  }

  if (route.length === 1) {
    return {
      movementIntent: true,
      occurred: false,
      reason: "already in destination zone",
    };
  }

  const nextZoneId = route[1] as string;
  const destinationRouteFromNext = shortestPath(zoneGraph, nextZoneId, destinationZoneId);
  const remainingPath = destinationRouteFromNext.length > 1 ? destinationRouteFromNext.slice(1) : [];
  const reachedDestination = nextZoneId === destinationZoneId;
  const mode = detectTravelMode(latestUserMessage);
  const totalEdges = Math.max(destinationRoute.length - 1, 1);
  const completedEdges = reachedDestination ? totalEdges : 1;

  travelRoot.meta = {
    schema_version: 1,
    last_updated: new Date().toISOString(),
  };
  travelRoot.travel_state = {
    current_zone: nextZoneId,
    destination_zone: reachedDestination ? null : destinationZoneId,
    path: remainingPath,
    travel_mode: mode,
    travel_progress: Math.max(0, Math.min(100, Math.round((completedEdges / totalEdges) * 100))),
    last_user_intent: safeIntent,
  };

  const rendered = renderStructuredContent(travelLoaded.format, travelRoot);
  const absolute = resolveWorldAbsolutePath(params.worldRoot, "state/travel-state.yaml");
  await fs.writeFile(absolute, rendered, "utf8");

  const nextConnections = zoneGraph[nextZoneId]?.connections.slice(0, 4) ?? [];
  const nextPressure = pressureSignalsForZone(pressureLoaded.parsed, nextZoneId);
  const nearbySignalLines = nextConnections.slice(0, 3).map((zoneId) => {
    const signal = pressureSignalsForZone(pressureLoaded.parsed, zoneId);
    return `${zoneName(zoneGraph, zoneId)}: pressure ${signal.pressure} (${signal.trend})`;
  });
  const hints = travelHintsByZoneType(zoneType(zoneGraph, nextZoneId));

  const remainingPathNames = remainingPath.map((zoneId) => zoneName(zoneGraph, zoneId));
  const seedHints = await appendZoneSeeds({
    cfg: params.cfg,
    worldRoot: params.worldRoot,
    zoneIds: [nextZoneId, destinationZoneId],
    zoneGraph,
  });

  const contextLines: string[] = [
    "[TRPG_RUNTIME_TRAVEL_TRANSITION]",
    `Movement intent detected: ${safeIntent}`,
    `Zone transition: ${zoneName(zoneGraph, currentZoneId)} -> ${zoneName(zoneGraph, nextZoneId)}`,
    reachedDestination
      ? `Destination reached: ${zoneName(zoneGraph, destinationZoneId)}`
      : `Destination pending: ${zoneName(zoneGraph, destinationZoneId)}; remaining path: ${remainingPathNames.join(" -> ") || "none"}`,
    `Travel mode: ${mode}`,
    "For this response, output order is mandatory:",
    "1) context introduction",
    "2) environment observations",
    "3) zone pressure signals",
    "4) NPC/creature posture",
    "5) freeform action invitation",
    "6) optional suggestions only after freeform invitation",
    "Never open with menu choices.",
    `Environment shift: ${hints.environment}`,
    `Travel obstacles: ${hints.obstacles.join(", ")}`,
    `Likely presence: ${hints.presence.join(", ")}`,
    `Opportunities: ${hints.opportunities.join(", ")}`,
    `Current-zone pressure: ${zoneName(zoneGraph, nextZoneId)} pressure ${nextPressure.pressure} (${nextPressure.trend})`,
  ];

  if (generatedZoneContextLine) {
    contextLines.push(generatedZoneContextLine);
  }
  if (nextPressure.signals.length > 0) {
    contextLines.push(`Current-zone signals: ${nextPressure.signals.join(", ")}`);
  }
  if (nearbySignalLines.length > 0) {
    contextLines.push("Adjacent-zone pressure:");
    for (const line of nearbySignalLines) {
      contextLines.push(`- ${line}`);
    }
  }
  if (seedHints.length > 0) {
    contextLines.push("Deferred zone hooks (non-immediate):");
    for (const hint of seedHints) {
      contextLines.push(`- ${hint}`);
    }
  }

  return {
    movementIntent: true,
    occurred: true,
    reason: `travel zone changed (${currentZoneId} -> ${nextZoneId})`,
    contextChunk: deps.joinLines(contextLines),
    generatedZone: Boolean(generatedZoneContextLine),
  };
}

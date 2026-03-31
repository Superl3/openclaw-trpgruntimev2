import fs from "node:fs/promises";
import type { TrpgRuntimeConfig } from "../../config.js";
import {
  loadStructuredWorldFile,
  renderStructuredContent,
  resolveWorldAbsolutePath,
} from "../../world-store.js";
import { normalizeZoneId } from "./travel-zone-helpers.js";

type ApplyFastWaitWorldDriftDeps = {
  toObject: (value: unknown) => Record<string, unknown>;
  readString: (value: unknown) => string;
  readFiniteNumber: (value: unknown) => number | null;
  toStringArray: (value: unknown) => string[];
  uniqStrings: (values: string[]) => string[];
};

export async function applyFastWaitWorldDrift(
  params: {
    cfg: TrpgRuntimeConfig;
    worldRoot: string;
    waitCount: number;
  },
  deps: ApplyFastWaitWorldDriftDeps,
): Promise<string[]> {
  const [pressureLoaded, travelLoaded, sceneLoaded, memoryLoaded] = await Promise.all([
    loadStructuredWorldFile(params.worldRoot, "state/world-pressure.yaml", {
      allowMissing: true,
      maxReadBytes: params.cfg.maxReadBytes,
    }),
    loadStructuredWorldFile(params.worldRoot, "state/travel-state.yaml", {
      allowMissing: true,
      maxReadBytes: params.cfg.maxReadBytes,
    }),
    loadStructuredWorldFile(params.worldRoot, "state/current-scene.yaml", {
      allowMissing: true,
      maxReadBytes: params.cfg.maxReadBytes,
    }),
    loadStructuredWorldFile(params.worldRoot, "state/npc-memory.yaml", {
      allowMissing: true,
      maxReadBytes: params.cfg.maxReadBytes,
    }),
  ]);

  const pressureRoot = deps.toObject(pressureLoaded.parsed);
  const travelRoot = deps.toObject(travelLoaded.parsed);
  const sceneRoot = deps.toObject(sceneLoaded.parsed);

  const currentZoneId = normalizeZoneId(
    deps.readString(deps.toObject(travelRoot.travel_state).current_zone) ||
      deps.readString(deps.toObject(deps.toObject(sceneRoot.scene).location).zone_id),
  );

  const driftLines: string[] = [];
  let pressureChanged = false;

  if (currentZoneId) {
    const zonePressureRoot = deps.toObject(pressureRoot.zone_pressure);
    const zonePressure = deps.toObject(zonePressureRoot[currentZoneId]);
    const previous = deps.readFiniteNumber(zonePressure.pressure) ?? deps.readFiniteNumber(zonePressure.score) ?? 45;
    const delta = params.waitCount >= 3 ? 3 : params.waitCount >= 2 ? 2 : 1;
    const next = Math.max(0, Math.min(100, Math.round(previous + delta)));

    zonePressure.pressure = next;
    zonePressure.score = next;
    zonePressure.trend = next > previous ? "up" : deps.readString(zonePressure.trend) || "stable";
    const signals = deps.uniqStrings([...deps.toStringArray(zonePressure.signals), "watch_rotation_shift"]);
    zonePressure.signals = signals.slice(-4);
    zonePressureRoot[currentZoneId] = zonePressure;
    pressureRoot.zone_pressure = zonePressureRoot;

    const districtTensionRoot = deps.toObject(pressureRoot.district_tension);
    const district = deps.toObject(districtTensionRoot[currentZoneId]);
    district.score = next;
    district.trend = next > previous ? "up" : deps.readString(district.trend) || "stable";
    districtTensionRoot[currentZoneId] = district;
    pressureRoot.district_tension = districtTensionRoot;

    pressureRoot.meta = {
      ...deps.toObject(pressureRoot.meta),
      schema_version: 1,
      last_updated: new Date().toISOString(),
    };

    pressureChanged = true;
    const zoneLabel = deps.readString(zonePressure.label) || currentZoneId;
    driftLines.push(`Zone pressure drift: ${zoneLabel} ${String(Math.round(previous))} -> ${String(next)}.`);
  }

  if (pressureChanged) {
    const renderedPressure = renderStructuredContent(pressureLoaded.format, pressureRoot);
    await fs.writeFile(resolveWorldAbsolutePath(params.worldRoot, "state/world-pressure.yaml"), renderedPressure, "utf8");
  }

  const memoryRoot = deps.toObject(memoryLoaded.parsed);
  const memory = deps.toObject(memoryRoot.memory);
  const byNpc = deps.toObject(memory.by_npc);
  let decayedNpcCount = 0;

  if (params.waitCount >= 2) {
    for (const npcState of Object.values(byNpc)) {
      const node = deps.toObject(npcState);
      const notes = deps.toStringArray(node.notes);
      if (notes.length > 3) {
        node.notes = notes.slice(-3);
        decayedNpcCount += 1;
      }
    }
  }

  if (decayedNpcCount > 0) {
    memory.by_npc = byNpc;
    memoryRoot.memory = memory;
    memoryRoot.meta = {
      ...deps.toObject(memoryRoot.meta),
      schema_version: 1,
      last_updated: new Date().toISOString(),
    };
    const renderedMemory = renderStructuredContent(memoryLoaded.format, memoryRoot);
    await fs.writeFile(resolveWorldAbsolutePath(params.worldRoot, "state/npc-memory.yaml"), renderedMemory, "utf8");
    driftLines.push(`NPC memory decay applied to ${String(decayedNpcCount)} threads after prolonged waiting.`);
  }

  return driftLines;
}

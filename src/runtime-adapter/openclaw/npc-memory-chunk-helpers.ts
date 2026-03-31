import fs from "node:fs/promises";
import type { TrpgRuntimeConfig } from "../../config.js";
import {
  loadStructuredWorldFile,
  renderStructuredContent,
  resolveWorldAbsolutePath,
} from "../../world-store.js";
import type { SceneNpcVisibility } from "./npc-visibility-helpers.js";

type NpcMemorySummary = {
  npcId: string;
  displayName: string;
  notes: string[];
  lastPlayerFocus: string;
};

type UpdateAndBuildNpcMemoryChunkDeps = {
  toObject: (value: unknown) => Record<string, unknown>;
  readString: (value: unknown) => string;
  toStringArray: (value: unknown) => string[];
  sanitizeIntentText: (value: string, maxLength?: number) => string;
  clipForGuard: (value: string, maxLength: number) => string;
  joinLines: (lines: string[]) => string;
  collectSceneNpcVisibility: (parsed: unknown) => SceneNpcVisibility[];
};

function actionLikelyTargetsNpc(message: string, npc: SceneNpcVisibility): boolean {
  const normalized = message.toLowerCase();
  const candidates = [npc.id, npc.rawName, npc.role, npc.displayName]
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  return candidates.some((candidate) => normalized.includes(candidate));
}

export function isNpcMemoryRelevantAction(message: string): boolean {
  if (!message) {
    return false;
  }

  return /(질문|묻|심문|추궁|회유|협상|탐문|정보|단서|설득|협박|deal|question|ask|interrogat|negotiat|probe)/i.test(
    message,
  );
}

export async function updateAndBuildNpcMemoryChunk(
  params: {
    cfg: TrpgRuntimeConfig;
    worldRoot: string;
    sceneParsed: unknown;
    latestAction: string;
  },
  deps: UpdateAndBuildNpcMemoryChunkDeps,
): Promise<string> {
  const loaded = await loadStructuredWorldFile(params.worldRoot, "state/npc-memory.yaml", {
    allowMissing: true,
    maxReadBytes: params.cfg.maxReadBytes,
  });

  const root = deps.toObject(loaded.parsed);
  const memoryNode = deps.toObject(root.memory);
  const byNpc = deps.toObject(memoryNode.by_npc);
  const visibleNpcs = deps.collectSceneNpcVisibility(params.sceneParsed);
  const safeLatestAction = deps.sanitizeIntentText(params.latestAction, 220);

  let changed = false;
  if (safeLatestAction && isNpcMemoryRelevantAction(safeLatestAction)) {
    for (const npc of visibleNpcs) {
      if (!actionLikelyTargetsNpc(safeLatestAction, npc)) {
        continue;
      }

      const npcMemory = deps.toObject(byNpc[npc.id]);
      if (npcMemory.last_player_focus !== safeLatestAction) {
        npcMemory.last_player_focus = safeLatestAction;
        changed = true;
      }
      npcMemory.last_player_focus_at = new Date().toISOString();
      if (!Array.isArray(npcMemory.notes)) {
        npcMemory.notes = [];
        changed = true;
      }
      byNpc[npc.id] = npcMemory;
    }
  }

  const summaries: NpcMemorySummary[] = visibleNpcs.map((npc) => {
    const npcMemory = deps.toObject(byNpc[npc.id]);
    const notes = deps.toStringArray(npcMemory.notes).slice(0, 2);
    return {
      npcId: npc.id,
      displayName: npc.displayName,
      notes,
      lastPlayerFocus: deps.readString(npcMemory.last_player_focus),
    };
  });

  if (changed) {
    root.meta = {
      schema_version: 1,
      last_updated: new Date().toISOString(),
    };
    root.memory = {
      by_npc: byNpc,
    };
    const rendered = renderStructuredContent(loaded.format, root);
    const absolute = resolveWorldAbsolutePath(params.worldRoot, "state/npc-memory.yaml");
    await fs.writeFile(absolute, rendered, "utf8");
  }

  if (summaries.length === 0) {
    return "";
  }

  const lines: string[] = [
    "[TRPG_RUNTIME_NPC_MEMORY_V1]",
    "Maintain continuity for visible NPCs using compact memory cues.",
    "Prefer consistency with prior posture, tension, and disclosed facts.",
  ];

  for (const summary of summaries.slice(0, 5)) {
    const noteText = summary.notes.length > 0 ? `notes: ${summary.notes.join("; ")}` : "notes: none";
    const focusText = summary.lastPlayerFocus
      ? `last_focus: ${deps.clipForGuard(summary.lastPlayerFocus, 120)}`
      : "last_focus: none";
    lines.push(`- ${summary.npcId} (${summary.displayName}) -> ${noteText} | ${focusText}`);
  }

  return deps.joinLines(lines);
}

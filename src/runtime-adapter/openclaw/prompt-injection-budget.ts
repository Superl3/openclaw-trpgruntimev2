type PromptSurfaceChunk = {
  text: string;
  tag: string;
  mandatory: boolean;
  priority: number;
  maxLines: number;
  maxChars: number;
  order: number;
};

function extractChunkTag(chunk: string): string {
  const firstLine = chunk.split(String.fromCharCode(10), 1)[0] || "";
  const match = firstLine.match(/^\s*\[([A-Z0-9_]+)\]/);
  return match?.[1] || "UNTAGGED";
}

function clipChunkByBudget(chunk: string, maxLines: number, maxChars: number): string {
  const lines = chunk
    .split(String.fromCharCode(10))
    .map((line) => line.replaceAll(String.fromCharCode(13), ""));
  if (lines.length === 0) {
    return "";
  }

  const clippedLines = lines.slice(0, Math.max(1, maxLines));
  let clipped = clippedLines.join(String.fromCharCode(10));
  if (chunk.length > clipped.length || lines.length > clippedLines.length) {
    clipped = clipped + String.fromCharCode(10) + "...";
  }

  if (clipped.length <= maxChars) {
    return clipped;
  }

  const hardClipped = clipped.slice(0, Math.max(0, maxChars - 3)).trimEnd();
  return hardClipped + "...";
}

function buildPromptSurfaceChunk(params: {
  text: string;
  order: number;
  latestAction: string;
  bootstrapIncomplete: boolean;
  isNpcMemoryRelevantAction: (latestAction: string) => boolean;
}): PromptSurfaceChunk {
  const tag = extractChunkTag(params.text);
  const npcMemoryHot = params.isNpcMemoryRelevantAction(params.latestAction);

  const profileByTag: Record<
    string,
    { mandatory: boolean; priority: number; maxLines: number; maxChars: number }
  > = {
    TRPG_RUNTIME_CHARACTER_BOOTSTRAP: { mandatory: true, priority: 100, maxLines: 22, maxChars: 1800 },
    TRPG_DISCORD_COMPONENTS_BOOTSTRAP: { mandatory: true, priority: 100, maxLines: 14, maxChars: 1400 },
    TRPG_RUNTIME_BOOTSTRAP_COMPLETED: { mandatory: true, priority: 96, maxLines: 12, maxChars: 1200 },
    TRPG_RUNTIME_INTRO_GUARD: { mandatory: true, priority: 94, maxLines: 16, maxChars: 1700 },
    TRPG_RUNTIME_SCENE_PERSISTENCE_GUARD: { mandatory: true, priority: 92, maxLines: 11, maxChars: 1300 },
    TRPG_RUNTIME_NPC_VISIBILITY_GUARD: { mandatory: true, priority: 90, maxLines: 9, maxChars: 900 },
    TRPG_RUNTIME_ACTION_FEASIBILITY_GUARD: { mandatory: true, priority: 88, maxLines: 14, maxChars: 1800 },
    TRPG_RUNTIME_FREEFORM_RULE: { mandatory: true, priority: 86, maxLines: 10, maxChars: 1200 },
    TRPG_DISCORD_COMPONENTS: { mandatory: true, priority: 84, maxLines: 20, maxChars: 2500 },
    TRPG_RUNTIME_STATUS_PANEL_V1: { mandatory: true, priority: 82, maxLines: 12, maxChars: 1300 },
    TRPG_RUNTIME_TRAVEL_TRANSITION: { mandatory: false, priority: 76, maxLines: 9, maxChars: 1000 },
    TRPG_RUNTIME_FAST_WAIT_V1: { mandatory: false, priority: 74, maxLines: 8, maxChars: 900 },
    TRPG_RUNTIME_ECONOMY_LITE_V1: { mandatory: false, priority: 70, maxLines: 7, maxChars: 900 },
    TRPG_RUNTIME_NPC_MEMORY_V1: {
      mandatory: false,
      priority: npcMemoryHot ? 72 : 52,
      maxLines: npcMemoryHot ? 8 : 5,
      maxChars: npcMemoryHot ? 900 : 620,
    },
    FACTION_ENGINE_WORLD_MOTION: { mandatory: false, priority: 68, maxLines: 10, maxChars: 1200 },
  };

  const fallbackProfile = {
    mandatory: params.bootstrapIncomplete,
    priority: params.bootstrapIncomplete ? 84 : 45,
    maxLines: params.bootstrapIncomplete ? 14 : 8,
    maxChars: params.bootstrapIncomplete ? 1200 : 800,
  };

  const profile = profileByTag[tag] || fallbackProfile;
  return {
    text: clipChunkByBudget(params.text, profile.maxLines, profile.maxChars),
    tag,
    mandatory: profile.mandatory,
    priority: profile.priority,
    maxLines: profile.maxLines,
    maxChars: profile.maxChars,
    order: params.order,
  };
}

export function applyPromptInjectionBudget(params: {
  chunks: string[];
  latestAction: string;
  bootstrapIncomplete: boolean;
  isNpcMemoryRelevantAction: (latestAction: string) => boolean;
}): { selected: string[]; droppedTags: string[] } {
  if (params.chunks.length === 0) {
    return { selected: [], droppedTags: [] };
  }

  const budgetMaxChunks = params.bootstrapIncomplete ? 3 : 10;
  const budgetMaxChars = params.bootstrapIncomplete ? 3200 : 7600;

  const surfaces = params.chunks
    .map((chunk, index) =>
      buildPromptSurfaceChunk({
        text: chunk,
        order: index,
        latestAction: params.latestAction,
        bootstrapIncomplete: params.bootstrapIncomplete,
        isNpcMemoryRelevantAction: params.isNpcMemoryRelevantAction,
      }),
    )
    .filter((chunk) => Boolean(chunk.text));

  const mandatory = surfaces
    .filter((chunk) => chunk.mandatory)
    .sort((a, b) => a.order - b.order);
  const optional = surfaces
    .filter((chunk) => !chunk.mandatory)
    .sort((a, b) => (a.priority === b.priority ? a.order - b.order : b.priority - a.priority));

  const selected: PromptSurfaceChunk[] = [];
  let usedChars = 0;

  for (const chunk of mandatory) {
    selected.push(chunk);
    usedChars += chunk.text.length;
  }

  const droppedTags: string[] = [];
  for (const chunk of optional) {
    const nextCount = selected.length + 1;
    const nextChars = usedChars + chunk.text.length;
    if (nextCount > budgetMaxChunks || nextChars > budgetMaxChars) {
      droppedTags.push(chunk.tag);
      continue;
    }
    selected.push(chunk);
    usedChars = nextChars;
  }

  selected.sort((a, b) => a.order - b.order);
  return {
    selected: selected.map((chunk) => chunk.text),
    droppedTags,
  };
}

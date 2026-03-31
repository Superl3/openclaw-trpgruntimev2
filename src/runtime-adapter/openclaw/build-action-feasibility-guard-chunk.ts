import type { TrpgRuntimeConfig } from "../../config.js";
import { loadStructuredWorldFile } from "../../world-store.js";
import type { SceneNpcVisibility } from "./npc-visibility-helpers.js";

export type FeasibilityStatusPanelData = {
  inventoryHighlights: string[];
  carriedItems: string[];
  equippedItems: string[];
};

type BuildActionFeasibilityGuardChunkDeps = {
  extractLatestUserMessageFromPrompt: (prompt: string) => string;
  extractLatestUserMessage: (messages: unknown[]) => string;
  toObject: (value: unknown) => Record<string, unknown>;
  readString: (value: unknown) => string;
  collectSceneNpcVisibility: (parsed: unknown) => SceneNpcVisibility[];
  redactHiddenNpcNames: (value: string, npcVisibility: SceneNpcVisibility[]) => string;
  loadStatusPanelData: (params: {
    cfg: TrpgRuntimeConfig;
    worldRoot: string;
  }) => Promise<FeasibilityStatusPanelData>;
  clipForGuard: (value: string, maxLength: number) => string;
  joinLines: (lines: string[]) => string;
  uniqStrings: (values: string[]) => string[];
};

function normalizeInventoryToken(value: string): string {
  return value
    .toLowerCase()
    .replace(/\[[^\]]+\]/g, " ")
    .replace(/x\d+$/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildInventoryTokenSet(status: FeasibilityStatusPanelData): Set<string> {
  return new Set(
    [...status.carriedItems, ...status.equippedItems, ...status.inventoryHighlights]
      .map((entry) => normalizeInventoryToken(entry))
      .filter(Boolean),
  );
}

function hasInventoryTokenMatch(inventoryTokens: Set<string>, token: string): boolean {
  const normalizedToken = normalizeInventoryToken(token);
  if (!normalizedToken) {
    return false;
  }

  for (const known of inventoryTokens) {
    if (known.includes(normalizedToken) || normalizedToken.includes(known)) {
      return true;
    }
  }

  return false;
}

function detectInventoryGatedAction(
  message: string,
  status: FeasibilityStatusPanelData,
  deps: Pick<BuildActionFeasibilityGuardChunkDeps, "uniqStrings">,
): string[] {
  if (!message) {
    return [];
  }

  const normalizedMessage = message.toLowerCase();
  const inventoryTokens = buildInventoryTokenSet(status);

  const hasAnyToken = (tokens: string[]): boolean =>
    tokens.some((token) => hasInventoryTokenMatch(inventoryTokens, token));

  const missing: string[] = [];
  const gatedChecks: Array<{ pattern: RegExp; itemAliases: string[]; hint: string }> = [
    {
      pattern: /(자물쇠|잠금|따개|pick\s*lock|lockpick|lock\s*open)/i,
      itemAliases: ["락픽", "lockpick", "열쇠", "key"],
      hint: "Lock-related action appears to need lockpick/key access.",
    },
    {
      pattern: /(불을\s*붙|횃불|torch|lantern|light\s*the\s*way)/i,
      itemAliases: ["횃불", "torch", "랜턴", "lantern"],
      hint: "Light-source action appears to need torch/lantern.",
    },
    {
      pattern: /(밧줄|rope|tie\s*off|descend|climb\s*down)/i,
      itemAliases: ["밧줄", "rope", "갈고리", "hook"],
      hint: "Traversal action appears to need rope/hook support.",
    },
    {
      pattern: /(검문|서류|증명|통행증|permit|papers|pass)/i,
      itemAliases: ["통행증", "허가증", "문서", "permit", "papers", "seal"],
      hint: "Checkpoint/document action appears to need suitable papers.",
    },
  ];

  for (const check of gatedChecks) {
    if (check.pattern.test(normalizedMessage) && !hasAnyToken(check.itemAliases)) {
      missing.push(check.hint);
    }
  }

  const quotedItem = message.match(/["'“”‘’]([^"'“”‘’]{2,48})["'“”‘’]/);
  if (quotedItem && /(꺼내|사용|장착|equip|use|wield|draw)/i.test(message)) {
    const demandedItem = quotedItem[1]?.trim() || "";
    if (demandedItem && !hasAnyToken([demandedItem])) {
      missing.push(`Player referenced item '${demandedItem}' not found in known carried/equipped inventory.`);
    }
  }

  return deps.uniqStrings(missing).slice(0, 3);
}

function detectHardImpossibleActionGates(
  message: string,
  status: FeasibilityStatusPanelData,
  deps: Pick<BuildActionFeasibilityGuardChunkDeps, "uniqStrings">,
): string[] {
  if (!message) {
    return [];
  }

  const normalizedMessage = message.toLowerCase();
  const inventoryTokens = buildInventoryTokenSet(status);
  const hasAnyToken = (tokens: string[]): boolean =>
    tokens.some((token) => hasInventoryTokenMatch(inventoryTokens, token));

  const hardGates: string[] = [];
  const weaponChecks: Array<{ pattern: RegExp; aliases: string[]; reason: string }> = [
    {
      pattern: /(칼|검|단검|knife|dagger|sword).*(뽑|꺼내|휘두|겨누|위협|찌르|베|draw|wield|threat|stab|slash)/i,
      aliases: ["칼", "검", "단검", "knife", "dagger", "sword"],
      reason: "Weapon declaration has no carried/equipped anchor; classify original action as impossible.",
    },
    {
      pattern: /(창|spear|pike).*(겨누|찌르|투척|thrust|stab|throw)/i,
      aliases: ["창", "spear", "pike"],
      reason: "Spear weapon use has no carried/equipped anchor; classify original action as impossible.",
    },
    {
      pattern: /(활|석궁|bow|crossbow).*(쏘|당기|발사|shoot|fire)/i,
      aliases: ["활", "석궁", "bow", "crossbow"],
      reason: "Ranged weapon use has no carried/equipped anchor; classify original action as impossible.",
    },
    {
      pattern: /(권총|총|pistol|rifle|gun).*(쏘|겨누|발사|shoot|fire|aim)/i,
      aliases: ["권총", "총", "pistol", "rifle", "gun"],
      reason: "Firearm use has no carried/equipped anchor; classify original action as impossible.",
    },
  ];

  for (const check of weaponChecks) {
    if (!check.pattern.test(normalizedMessage)) {
      continue;
    }
    if (!hasAnyToken(check.aliases)) {
      hardGates.push(check.reason);
    }
  }

  const quotedItem = message.match(/["'“”‘’]([^"'“”‘’]{2,48})["'“”‘’]/);
  if (quotedItem && /(꺼내|사용|장착|equip|use|wield|draw|brandish)/i.test(message)) {
    const demandedItem = quotedItem[1]?.trim() || "";
    if (demandedItem && !hasAnyToken([demandedItem])) {
      hardGates.push(
        "Quoted item '" + demandedItem + "' is not present in carried/equipped inventory; classify original action as impossible.",
      );
    }
  }

  const preResolvedPatterns = [
    /(이미|벌써|already).*(위조|통과|잠입|침투|훔치|확보|해결|forg|pass|infiltrat|stole|secured|resolved)/i,
    /(위조|통과|잠입|침투|훔치|확보|해결).*(한\s*상태|완료|끝났|되어\s*있)/i,
  ];
  if (preResolvedPatterns.some((pattern) => pattern.test(normalizedMessage))) {
    hardGates.push(
      "Completed-outcome assertions require prior in-scene evidence; do not narrate the claimed success as already true.",
    );
  }

  return deps.uniqStrings(hardGates).slice(0, 4);
}

function summarizeSceneClock(
  clock: unknown,
  deps: Pick<BuildActionFeasibilityGuardChunkDeps, "toObject" | "readString">,
): string {
  const clockObj = deps.toObject(clock);
  const label = deps.readString(clockObj.label) || deps.readString(clockObj.id) || "clock";
  const remainingRaw = clockObj.remaining_turns;
  const remaining =
    typeof remainingRaw === "number" && Number.isFinite(remainingRaw)
      ? Math.max(0, Math.trunc(remainingRaw))
      : deps.readString(remainingRaw) || "?";
  const consequence = deps.readString(clockObj.consequence_on_zero);
  return consequence
    ? `${label} (remaining: ${String(remaining)}; zero: ${consequence})`
    : `${label} (remaining: ${String(remaining)})`;
}

export async function buildActionFeasibilityGuardChunk(
  params: {
    cfg: TrpgRuntimeConfig;
    worldRoot: string;
    messages: unknown[];
    prompt: string;
    sceneParsed?: unknown;
    statusPanelData?: FeasibilityStatusPanelData;
  },
  deps: BuildActionFeasibilityGuardChunkDeps,
): Promise<string> {
  const latestAction =
    deps.extractLatestUserMessageFromPrompt(params.prompt) || deps.extractLatestUserMessage(params.messages);

  let sceneParsed = params.sceneParsed;
  if (sceneParsed === undefined) {
    const loaded = await loadStructuredWorldFile(params.worldRoot, "state/current-scene.yaml", {
      allowMissing: true,
      maxReadBytes: params.cfg.maxReadBytes,
    });
    sceneParsed = loaded.parsed;
  }

  const sceneRoot = deps.toObject(sceneParsed);
  const scene = deps.toObject(sceneRoot.scene);
  const npcVisibility = deps.collectSceneNpcVisibility(sceneRoot);
  const redact = (value: string) => deps.redactHiddenNpcNames(value, npcVisibility);
  const statusData = params.statusPanelData ?? (await deps.loadStatusPanelData({ cfg: params.cfg, worldRoot: params.worldRoot }));

  const hardLimits = (Array.isArray(scene.hard_limits) ? scene.hard_limits : [])
    .map((entry) => redact(deps.readString(entry)))
    .filter(Boolean)
    .slice(0, 6);

  const obviousRisk = redact(deps.readString(scene.obvious_risk));
  const clocks = (Array.isArray(sceneRoot.ticking_clocks) ? sceneRoot.ticking_clocks : [])
    .map((entry) => redact(summarizeSceneClock(entry, deps)))
    .filter(Boolean)
    .slice(0, 4);

  const lines: string[] = [
    "[TRPG_RUNTIME_ACTION_FEASIBILITY_GUARD]",
    "Adjudicate the latest player action before narration.",
    "Internally classify the action as exactly one: immediate | costly | conditional | impossible.",
    "Do not expose these labels to the player.",
    "Mapping: immediate=possible now, costly=possible but costly, conditional=needs prerequisite or risk handling, impossible=cannot be executed as stated now.",
    "Resolution contract:",
    "- immediate: resolve directly with concrete in-world consequences.",
    "- conditional: do not fake success; explain missing condition or risk gate, then offer 1-2 viable setup routes.",
    "- costly: resolve only with an explicit trade-off (time, resource, position, reputation, clue burn).",
    "- impossible: never validate the assertion as already true; reject it in-world and ask for revised intent.",
    "Name-dependent social actions require in-scene name knowledge; unknown names are insufficient declarations.",
    "Item/equipment assertions must align with known inventory and carried gear unless newly acquired in-scene.",
    "Missing weapon/equipment anchors default to impossible; do not narrate asserted success.",
    "Keep context-first and freeform-first. Avoid menu-first recovery prompts.",
    "Do not emit immediate_options or mandatory numbered choices.",
  ];

  if (latestAction) {
    lines.push(`Latest player action: ${redact(deps.clipForGuard(latestAction, 420))}`);
  }

  if (hardLimits.length > 0) {
    lines.push(`Scene hard limits: ${hardLimits.join(" | ")}`);
  }

  if (obviousRisk) {
    lines.push(`Scene obvious risk: ${deps.clipForGuard(obviousRisk, 260)}`);
  }

  if (clocks.length > 0) {
    lines.push("Active clocks:");
    for (const clock of clocks) {
      lines.push(`- ${clock}`);
    }
  }

  if (statusData.inventoryHighlights.length > 0) {
    lines.push(`Known inventory anchors: ${statusData.inventoryHighlights.join(" | ")}`);
  }

  const inventoryGates = detectInventoryGatedAction(latestAction, statusData, deps);
  if (inventoryGates.length > 0) {
    lines.push("Potential inventory gates to enforce:");
    for (const gate of inventoryGates) {
      lines.push(`- ${gate}`);
    }
  }

  const hardImpossibleGates = detectHardImpossibleActionGates(latestAction, statusData, deps);
  if (hardImpossibleGates.length > 0) {
    lines.push("Hard feasibility overrides (must be enforced):");
    for (const gate of hardImpossibleGates) {
      lines.push(`- ${gate}`);
    }
    lines.push("If any hard override applies, default verdict is impossible.");
    lines.push("Never narrate the asserted success when hard overrides are present.");
    lines.push("Offer 1-2 short in-world alternatives without menu-first formatting.");
  }

  return deps.joinLines(lines);
}

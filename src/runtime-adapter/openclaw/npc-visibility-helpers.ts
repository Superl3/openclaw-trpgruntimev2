export type SceneNpcVisibility = {
  id: string;
  rawName: string;
  role: string;
  displayName: string;
  hidden: boolean;
};

type NpcVisibilityHelperDeps = {
  toObject: (value: unknown) => Record<string, unknown>;
  readString: (value: unknown) => string;
  joinLines: (lines: string[]) => string;
};

function readBooleanFlag(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function visibilityHint(readString: (value: unknown) => string, value: unknown): "show" | "hide" | "unknown" {
  const normalized = readString(value).toLowerCase();
  if (!normalized) return "unknown";
  if (["public", "introduced", "revealed", "known", "open"].includes(normalized)) return "show";
  if (["hidden", "secret", "unrevealed", "private", "masked"].includes(normalized)) return "hide";
  return "unknown";
}

function isNpcNameVisibleToPlayer(
  npc: Record<string, unknown>,
  deps: Pick<NpcVisibilityHelperDeps, "readString">,
): boolean {
  const publicExceptionKeys = [
    "public_figure",
    "is_public_figure",
    "player_would_reasonably_know",
    "known_by_common_knowledge",
    "is_well_known",
  ] as const;
  for (const key of publicExceptionKeys) {
    if (readBooleanFlag(npc[key]) === true) {
      return true;
    }
  }

  const keys = [
    "introduced_to_player",
    "publicly_known",
    "public_identity",
    "name_public",
    "name_revealed",
    "player_known_name",
  ] as const;
  for (const key of keys) if (readBooleanFlag(npc[key]) === true) return true;
  for (const key of ["name_visibility", "identity_visibility", "disclosure_state", "reveal_state"] as const) {
    const hint = visibilityHint(deps.readString, npc[key]);
    if (hint === "show") return true;
    if (hint === "hide") return false;
  }
  for (const key of keys) if (readBooleanFlag(npc[key]) === false) return false;
  return true;
}

function npcMaskLabel(
  npc: Record<string, unknown>,
  index: number,
  deps: Pick<NpcVisibilityHelperDeps, "readString">,
): string {
  const role = deps.readString(npc.role);
  if (role) return `${role} (name withheld)`;
  const id = deps.readString(npc.id);
  if (id) return `${id} (name withheld)`;
  return `unidentified-npc-${index + 1}`;
}

function escapeRegExpLiteral(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replace(/[.*+?^${}()|[\]]/g, "\\$&");
}

export function collectSceneNpcVisibility(parsed: unknown, deps: NpcVisibilityHelperDeps): SceneNpcVisibility[] {
  const root = deps.toObject(parsed);
  const actors = deps.toObject(root.actors);
  const visibleNpcs = Array.isArray(actors.visible_npcs) ? actors.visible_npcs : [];
  return visibleNpcs.map((entry, index) => {
    const npc = deps.toObject(entry);
    const rawName = deps.readString(npc.name);
    const role = deps.readString(npc.role);
    const hidden = rawName ? !isNpcNameVisibleToPlayer(npc, deps) : false;
    const displayName = hidden ? npcMaskLabel(npc, index, deps) : rawName || npcMaskLabel(npc, index, deps);
    return { id: deps.readString(npc.id) || `npc-${index + 1}`, rawName, role, displayName, hidden };
  });
}

export function redactHiddenNpcNames(value: string, npcVisibility: SceneNpcVisibility[]): string {
  if (!value) return "";
  const replacements = npcVisibility
    .filter((entry) => entry.hidden && entry.rawName && entry.displayName && entry.rawName !== entry.displayName)
    .sort((a, b) => b.rawName.length - a.rawName.length);
  let output = value;
  for (const entry of replacements) {
    const pattern = new RegExp(escapeRegExpLiteral(entry.rawName), "g");
    output = output.replace(pattern, entry.displayName);
  }
  return output;
}

export function buildNpcVisibilityGuardChunk(parsed: unknown, deps: NpcVisibilityHelperDeps): string {
  const hiddenNpcs = collectSceneNpcVisibility(parsed, deps).filter((entry) => entry.hidden);
  if (hiddenNpcs.length === 0) return "";
  const lines: string[] = [
    "[TRPG_RUNTIME_NPC_VISIBILITY_GUARD]",
    "Do not reveal hidden NPC real names until they are explicitly introduced or publicly disclosed in-scene.",
    "Keep hidden names out of narration, clues, summaries, and optional suggestions.",
    "If the player asserts a hidden name, treat it as an unverified claim unless current evidence confirms it.",
    "Use these safe references while names remain hidden:",
  ];
  for (const entry of hiddenNpcs.slice(0, 8)) lines.push(`- ${entry.id}: ${entry.displayName}`);
  return deps.joinLines(lines);
}

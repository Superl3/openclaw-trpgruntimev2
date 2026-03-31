export type ScenePersistenceSignals = {
  interrogation: boolean;
  negotiation: boolean;
  investigation: boolean;
  explicitTransition: boolean;
  pressurePush: boolean;
};

type ScenePersistenceHelperDeps = {
  toObject: (value: unknown) => Record<string, unknown>;
  readString: (value: unknown) => string;
  clipForGuard: (value: string, maxLength: number) => string;
  joinLines: (lines: string[]) => string;
};

function readDisclosureStage(value: unknown, readString: (value: unknown) => string): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(1, Math.min(5, Math.trunc(value)));
  }

  const asString = readString(value);
  if (!asString) {
    return 1;
  }

  const parsed = Number.parseInt(asString, 10);
  if (!Number.isFinite(parsed)) {
    return 1;
  }

  return Math.max(1, Math.min(5, parsed));
}

function detectScenePersistenceSignals(message: string): ScenePersistenceSignals {
  const normalized = message.toLowerCase();
  return {
    interrogation: /(심문|추궁|캐묻|자백|압박\s*신문|interrogat|cross[-\s]?exam)/.test(normalized),
    negotiation: /(협상|흥정|거래\s*조건|합의|타협|deal|negotiat|bargain)/.test(normalized),
    investigation: /(질문|조사|탐문|단서|기록\s*대조|알리바이|진술\s*확인|probe|investigat)/.test(normalized),
    explicitTransition: /(다음\s*장면|장면\s*넘어|장면\s*전환|이동하자|떠나자|다음으로\s*가|move on|next scene)/.test(normalized),
    pressurePush: /(회피하지\s*말|솔직히\s*말|진실을\s*말|지금\s*말해|끝까지\s*묻|압박)/.test(normalized),
  };
}

export function applyScenePersistenceDefaults(
  params: {
    sceneParsed: unknown;
    latestAction: string;
  },
  deps: Pick<ScenePersistenceHelperDeps, "toObject" | "readString">,
): { changed: boolean; sceneFlow: Record<string, unknown>; signals: ScenePersistenceSignals } {
  const root = deps.toObject(params.sceneParsed);
  const scene = deps.toObject(root.scene);
  const sceneFlow = deps.toObject(scene.scene_flow);
  const signals = detectScenePersistenceSignals(params.latestAction);

  let changed = false;

  if (typeof sceneFlow.scene_persistence !== "boolean") {
    sceneFlow.scene_persistence = true;
    changed = true;
  }
  if (typeof sceneFlow.transition_allowed !== "boolean") {
    sceneFlow.transition_allowed = false;
    changed = true;
  }
  if (!deps.readString(sceneFlow.unresolved_tension)) {
    sceneFlow.unresolved_tension = "high";
    changed = true;
  }
  if (typeof sceneFlow.interrogation_active !== "boolean") {
    sceneFlow.interrogation_active = false;
    changed = true;
  }

  const currentStage = readDisclosureStage(sceneFlow.disclosure_stage, deps.readString);
  if (sceneFlow.disclosure_stage !== currentStage) {
    sceneFlow.disclosure_stage = currentStage;
    changed = true;
  }

  const highValueDialog = signals.interrogation || signals.negotiation || signals.investigation;
  if (highValueDialog) {
    if (sceneFlow.scene_persistence !== true) {
      sceneFlow.scene_persistence = true;
      changed = true;
    }
    if (sceneFlow.transition_allowed !== false) {
      sceneFlow.transition_allowed = false;
      changed = true;
    }
    if (sceneFlow.unresolved_tension !== "high") {
      sceneFlow.unresolved_tension = "high";
      changed = true;
    }
  }

  if (signals.interrogation && sceneFlow.interrogation_active !== true) {
    sceneFlow.interrogation_active = true;
    changed = true;
  }

  if (signals.explicitTransition) {
    if (sceneFlow.transition_allowed !== true) {
      sceneFlow.transition_allowed = true;
      changed = true;
    }
  }

  if (signals.pressurePush && sceneFlow.interrogation_active === true) {
    const nextStage = Math.min(5, currentStage + 1);
    if (nextStage !== currentStage) {
      sceneFlow.disclosure_stage = nextStage;
      changed = true;
    }
  }

  scene.scene_flow = sceneFlow;
  root.scene = scene;

  return {
    changed,
    sceneFlow,
    signals,
  };
}

export function buildScenePersistenceGuardChunk(
  params: {
    sceneParsed: unknown;
    latestAction: string;
    sceneFlow: Record<string, unknown>;
    signals: ScenePersistenceSignals;
  },
  deps: ScenePersistenceHelperDeps,
): string {
  const sceneRoot = deps.toObject(params.sceneParsed);
  const scene = deps.toObject(sceneRoot.scene);
  const sceneTitle = deps.readString(scene.title) || deps.readString(scene.id) || "current-scene";
  const scenePersistence = params.sceneFlow.scene_persistence === true;
  const transitionAllowed = params.sceneFlow.transition_allowed === true;
  const unresolvedTension = deps.readString(params.sceneFlow.unresolved_tension) || "high";
  const disclosureStage = readDisclosureStage(params.sceneFlow.disclosure_stage, deps.readString);
  const interrogationActive = params.sceneFlow.interrogation_active === true;

  const lines: string[] = [
    "[TRPG_RUNTIME_SCENE_PERSISTENCE_GUARD]",
    `Scene: ${sceneTitle}`,
    "Keep high-value dialog in the same scene by default (interrogation, negotiation, investigation, tense questioning).",
    "Do not jump scenes after one reply unless transition is explicitly requested or strongly forced.",
    "Transition is allowed only when at least one applies: player explicitly asks, current objective is substantially resolved, interaction value is exhausted, or a strong external interruption occurs.",
    "Use layered disclosure in tense dialog:",
    "1) evasive response",
    "2) partial statement",
    "3) contradiction leak",
    "4) pressured admission",
    "5) broader implication",
    `scene_persistence=${String(scenePersistence)} transition_allowed=${String(transitionAllowed)} unresolved_tension=${unresolvedTension} disclosure_stage=${String(disclosureStage)} interrogation_active=${String(interrogationActive)}`,
  ];

  if (params.latestAction) {
    lines.push(`Latest player action: ${deps.clipForGuard(params.latestAction, 320)}`);
  }

  if (params.signals.explicitTransition) {
    lines.push("Player message includes explicit transition intent; transition can be considered if scene objective is also resolved.");
  }

  return deps.joinLines(lines);
}

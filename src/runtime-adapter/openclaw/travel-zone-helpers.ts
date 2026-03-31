export type ZoneGraphNode = {
  id: string;
  name: string;
  type: string;
  parentRegion: string;
  tags: string[];
  connections: string[];
  aliases: string[];
  pressure: number | null;
};

type ZoneMention = {
  zoneId: string;
  firstIndex: number;
  lastIndex: number;
};

type ParsedTravelIntent = {
  pathZoneId: string;
  destinationZoneId: string;
  mentionedZoneIds: string[];
};

function toObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function readFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
}

export function normalizeZoneId(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) {
    return "";
  }
  return trimmed
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
}

export function normalizeAlias(value: string): string {
  return value.trim().toLowerCase();
}

export function buildZoneGraph(parsedPressure: unknown): Record<string, ZoneGraphNode> {
  const pressureRoot = toObject(parsedPressure);
  const graph: Record<string, ZoneGraphNode> = {};

  const addNode = (rawNode: Record<string, unknown>, fallbackId = "") => {
    const id = normalizeZoneId(readString(rawNode.id) || readString(rawNode.zone_id) || fallbackId);
    if (!id) {
      return;
    }

    const existing = graph[id];
    const aliases = Array.from(
      new Set(
        [
          ...(existing?.aliases ?? []),
          ...toStringArray(rawNode.aliases),
          readString(rawNode.name),
          readString(rawNode.label),
          readString(rawNode.id),
          readString(rawNode.zone_id),
        ]
          .map((entry) => entry.trim())
          .filter(Boolean),
      ),
    );

    const connections = Array.from(
      new Set(
        [
          ...(existing?.connections ?? []),
          ...toStringArray(rawNode.connections),
          ...toStringArray(rawNode.nearby_zone_ids),
          ...toStringArray(rawNode.nearby_zones),
        ]
          .map((entry) => normalizeZoneId(entry))
          .filter(Boolean)
          .filter((entry) => entry !== id),
      ),
    );

    const parsedPressure =
      readFiniteNumber(rawNode.pressure) ?? readFiniteNumber(rawNode.score) ?? existing?.pressure ?? null;

    graph[id] = {
      id,
      name: readString(rawNode.name) || readString(rawNode.label) || existing?.name || id,
      type: readString(rawNode.type) || readString(rawNode.zone_type) || existing?.type || "settlement",
      parentRegion:
        readString(rawNode.parent_region) ||
        readString(rawNode.region) ||
        existing?.parentRegion ||
        "",
      tags: Array.from(new Set([...(existing?.tags ?? []), ...toStringArray(rawNode.tags)])),
      connections,
      aliases,
      pressure: parsedPressure,
    };
  };

  const zones = pressureRoot.zones;
  if (Array.isArray(zones)) {
    for (const zoneEntry of zones) {
      addNode(toObject(zoneEntry));
    }
  } else {
    const zonesObject = toObject(zones);
    for (const [zoneId, zoneEntry] of Object.entries(zonesObject)) {
      addNode(toObject(zoneEntry), zoneId);
    }
  }

  const zonePressure = toObject(pressureRoot.zone_pressure);
  for (const [zoneId, zoneEntry] of Object.entries(zonePressure)) {
    addNode(toObject(zoneEntry), zoneId);
  }

  const districtTension = toObject(pressureRoot.district_tension);
  for (const [zoneId, zoneEntry] of Object.entries(districtTension)) {
    addNode(toObject(zoneEntry), zoneId);
  }

  const topology = toObject(toObject(pressureRoot.zone_topology).nearby_zones);
  for (const [zoneId, nearbyValue] of Object.entries(topology)) {
    const normalizedZoneId = normalizeZoneId(zoneId);
    if (!normalizedZoneId) {
      continue;
    }
    if (!graph[normalizedZoneId]) {
      addNode({}, normalizedZoneId);
    }
    const nearbyIds = toStringArray(nearbyValue)
      .map((entry) => normalizeZoneId(entry))
      .filter(Boolean)
      .filter((entry) => entry !== normalizedZoneId);
    graph[normalizedZoneId].connections = Array.from(
      new Set([...graph[normalizedZoneId].connections, ...nearbyIds]),
    );
  }

  for (const node of Object.values(graph)) {
    for (const connection of node.connections) {
      if (!graph[connection]) {
        addNode({}, connection);
      }
      const linked = graph[connection];
      linked.connections = Array.from(new Set([...linked.connections, node.id]));
    }
  }

  return graph;
}

export function buildZoneAliasMap(zoneGraph: Record<string, ZoneGraphNode>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const node of Object.values(zoneGraph)) {
    out[normalizeAlias(node.id)] = node.id;
    for (const alias of node.aliases) {
      out[normalizeAlias(alias)] = node.id;
      out[normalizeAlias(normalizeZoneId(alias))] = node.id;
    }
  }
  return out;
}

function extractZoneMentions(params: {
  message: string;
  aliasMap: Record<string, string>;
}): ZoneMention[] {
  const normalizedMessage = normalizeAlias(params.message);
  const mentions: Record<string, ZoneMention> = {};

  for (const alias of Object.keys(params.aliasMap)) {
    if (!(alias.length >= 2 || /[\p{Script=Hangul}\p{Script=Han}]/u.test(alias))) {
      continue;
    }

    const zoneId = params.aliasMap[alias];
    if (!zoneId) {
      continue;
    }

    let cursor = normalizedMessage.indexOf(alias);
    while (cursor >= 0) {
      const existing = mentions[zoneId];
      if (!existing) {
        mentions[zoneId] = {
          zoneId,
          firstIndex: cursor,
          lastIndex: cursor,
        };
      } else {
        existing.firstIndex = Math.min(existing.firstIndex, cursor);
        existing.lastIndex = Math.max(existing.lastIndex, cursor);
      }

      const step = Math.max(alias.length, 1);
      cursor = normalizedMessage.indexOf(alias, cursor + step);
    }
  }

  return Object.values(mentions).sort((a, b) =>
    a.firstIndex === b.firstIndex ? a.lastIndex - b.lastIndex : a.firstIndex - b.firstIndex,
  );
}

export function resolveTravelIntent(params: {
  message: string;
  currentZoneId: string;
  persistedDestinationZoneId: string;
  aliasMap: Record<string, string>;
}): ParsedTravelIntent {
  const mentionedZoneIds = extractZoneMentions({
    message: params.message,
    aliasMap: params.aliasMap,
  })
    .map((entry) => entry.zoneId)
    .filter((zoneId, index, all) => all.indexOf(zoneId) === index)
    .filter((zoneId) => zoneId !== params.currentZoneId);

  let pathZoneId = "";
  let destinationZoneId = "";

  if (mentionedZoneIds.length >= 2) {
    pathZoneId = mentionedZoneIds[0] as string;
    destinationZoneId = mentionedZoneIds[mentionedZoneIds.length - 1] as string;
  } else if (mentionedZoneIds.length === 1) {
    destinationZoneId = mentionedZoneIds[0] as string;
  }

  if (!destinationZoneId && params.persistedDestinationZoneId) {
    destinationZoneId = params.persistedDestinationZoneId;
  }

  if (destinationZoneId === params.currentZoneId) {
    destinationZoneId = "";
  }

  return {
    pathZoneId,
    destinationZoneId,
    mentionedZoneIds,
  };
}

export function shortestPath(zoneGraph: Record<string, ZoneGraphNode>, start: string, goal: string): string[] {
  if (!zoneGraph[start] || !zoneGraph[goal]) {
    return [];
  }
  if (start === goal) {
    return [start];
  }

  const queue: string[] = [start];
  const visited = new Set<string>([start]);
  const parent: Record<string, string> = {};

  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const neighbor of zoneGraph[current]?.connections ?? []) {
      if (visited.has(neighbor)) {
        continue;
      }
      visited.add(neighbor);
      parent[neighbor] = current;
      if (neighbor === goal) {
        const route: string[] = [goal];
        let cursor = goal;
        while (parent[cursor]) {
          cursor = parent[cursor] as string;
          route.unshift(cursor);
        }
        return route;
      }
      queue.push(neighbor);
    }
  }

  return [];
}

export function zoneName(zoneGraph: Record<string, ZoneGraphNode>, zoneId: string): string {
  return zoneGraph[zoneId]?.name || zoneId;
}

export function zoneType(zoneGraph: Record<string, ZoneGraphNode>, zoneId: string): string {
  return zoneGraph[zoneId]?.type || "unknown";
}

export function pressureSignalsForZone(
  pressureParsed: unknown,
  zoneId: string,
): { pressure: number; trend: string; signals: string[] } {
  const pressureRoot = toObject(pressureParsed);
  const zonePressure = toObject(toObject(pressureRoot.zone_pressure)[zoneId]);
  const score = Number(zonePressure.pressure ?? zonePressure.score ?? 45);
  return {
    pressure: Math.max(0, Math.min(100, Number.isFinite(score) ? Math.round(score) : 45)),
    trend: readString(zonePressure.trend) || "stable",
    signals: toStringArray(zonePressure.signals).slice(0, 4),
  };
}

export function travelHintsByZoneType(value: string): {
  environment: string;
  obstacles: string[];
  presence: string[];
  opportunities: string[];
} {
  const lower = value.toLowerCase();

  if (lower.includes("wilderness") || lower.includes("forest")) {
    return {
      environment: "tree line thickens, visibility narrows, and sounds travel unpredictably",
      obstacles: ["rough footing", "broken trail markers", "weather shifts"],
      presence: ["scouts", "wild creatures", "refugee traces"],
      opportunities: ["concealed approach", "track reading", "foraging clues"],
    };
  }

  if (lower.includes("road") || lower.includes("frontier")) {
    return {
      environment: "open route with long sightlines and exposed choke points",
      obstacles: ["checkpoint delay", "road debris", "caravan congestion"],
      presence: ["patrols", "caravan guards", "migrant foot traffic"],
      opportunities: ["roadside intel", "escort work", "faction contact windows"],
    };
  }

  if (lower.includes("port") || lower.includes("sea")) {
    return {
      environment: "salt wind, moving cargo lanes, and unstable footing",
      obstacles: ["dock checks", "tide timing", "customs bottlenecks"],
      presence: ["dock crews", "ship hands", "harbor inspectors"],
      opportunities: ["cargo manifests", "stowaway routes", "maritime rumors"],
    };
  }

  if (lower.includes("ruin") || lower.includes("dungeon") || lower.includes("shrine")) {
    return {
      environment: "collapsed structures and layered silence around disturbed ground",
      obstacles: ["unstable footing", "sealed passages", "latent hazards"],
      presence: ["scavengers", "cult cells", "territorial creatures"],
      opportunities: ["ancient records", "hidden chambers", "ritual residue"],
    };
  }

  return {
    environment: "pressure pockets shift with crowd flow and institutional control",
    obstacles: ["inspection queues", "restricted access", "documentation friction"],
    presence: ["official patrols", "informal brokers", "watchful bystanders"],
    opportunities: ["public cover", "social leverage", "document trails"],
  };
}

export function inferZoneTypeFromLabel(label: string): string {
  const lower = label.toLowerCase();
  if (/(항구|선창|부두|항로|harbor|dock|port|sea)/i.test(lower)) return "port";
  if (/(숲|산길|습지|forest|wild|wilderness)/i.test(lower)) return "wilderness";
  if (/(폐허|유적|사원|성소|ruin|shrine|dungeon|catacomb)/i.test(lower)) return "ruin";
  if (/(가도|도로|길|road|frontier|checkpoint)/i.test(lower)) return "road";
  return "settlement";
}

export function normalizeUnknownDestinationLabel(raw: string): string {
  let candidate = raw
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!candidate) {
    return "";
  }

  candidate = candidate
    .replace(/^(?:나는|난|저는|전|우리는|내가|제가)\s+/i, "")
    .replace(/^(?:지금|곧바로|바로|저\s*멀리|멀리)\s+/i, "");

  candidate = candidate
    .replace(
      /\s*(?:으)?로\s*(?:이동(?:한다|해|하겠다|할게)?|간다|가겠다|가자|향한다|향해|출발(?:한다|해)?|move|go|travel|head(?:s|ing)?).*$/i,
      "",
    )
    .replace(
      /\s*에\s*(?:이동(?:한다|해|하겠다|할게)?|간다|가겠다|가자|향한다|향해|출발(?:한다|해)?|도착(?:한다|해)?|move|go|travel|head(?:s|ing)?).*$/i,
      "",
    )
    .replace(/[.,!?;:]+$/g, "")
    .trim();

  candidate = candidate.replace(/\s*(?:으)?로$|\s*에$|\s*에서$|\s*쪽으로$|\s*쪽$/i, "").trim();

  if (candidate.length > 32) {
    const words = candidate.split(/\s+/).filter(Boolean);
    candidate = words.slice(0, 4).join(" ").trim();
  }

  return candidate;
}

export function isKnownDestinationAlias(candidate: string, aliasMap: Record<string, string>): boolean {
  const aliasKey = normalizeAlias(candidate);
  const zoneKey = normalizeAlias(normalizeZoneId(candidate));
  return Boolean(aliasMap[aliasKey] || aliasMap[zoneKey]);
}

export function extractUnknownDestinationLabel(message: string, aliasMap: Record<string, string>): string {
  const quoted = message.match(/["'“”‘’]([^"'“”‘’]{2,48})["'“”‘’]/);
  if (quoted && quoted[1]) {
    const candidate = normalizeUnknownDestinationLabel(quoted[1]);
    if (candidate && !isKnownDestinationAlias(candidate, aliasMap)) {
      return candidate;
    }
  }

  const patterns = [
    /(?:^|\s)(?:나는|난|저는|전|우리는|내가|제가)?\s*([가-힣a-zA-Z0-9][가-힣a-zA-Z0-9\s'’\-]{1,42}?)\s*(?:으)?로\s*(?:이동(?:한다|해|하겠다|할게)?|간다|가겠다|가자|향한다|향해|출발(?:한다|해)?|move|go|travel|head(?:s|ing)?)/i,
    /(?:^|\s)(?:나는|난|저는|전|우리는|내가|제가)?\s*([가-힣a-zA-Z0-9][가-힣a-zA-Z0-9\s'’\-]{1,42}?)\s*쪽으로\s*(?:이동(?:한다|해|하겠다|할게)?|간다|가겠다|향한다|향해|move|go|travel)/i,
    /(?:^|\s)(?:나는|난|저는|전|우리는|내가|제가)?\s*([가-힣a-zA-Z0-9][가-힣a-zA-Z0-9\s'’\-]{1,42}?)\s*에\s*(?:간다|가겠다|이동(?:한다|해|하겠다|할게)?|향한다|향해|도착(?:한다|해)?)/i,
  ];

  for (const pattern of patterns) {
    const match = message.match(pattern);
    if (!match || !match[1]) {
      continue;
    }

    const candidate = normalizeUnknownDestinationLabel(match[1]);
    if (!candidate) {
      continue;
    }

    if (isKnownDestinationAlias(candidate, aliasMap)) {
      return "";
    }

    return candidate;
  }

  return "";
}

import { createHash, randomBytes } from "node:crypto";

export type DiceRollInput = {
  notation?: string;
  modifier?: number;
  seedPolicy?: "session" | "fixed" | "random";
  seed?: string;
  repeat?: number;
};

type ParsedNotation = {
  count: number;
  sides: number;
  notationModifier: number;
  normalizedNotation: string;
};

function parseNotation(notation: string): ParsedNotation {
  const trimmed = notation.trim().toLowerCase();
  const match = trimmed.match(/^(\d{0,3})d(\d{1,4})([+-]\d+)?$/);
  if (!match) {
    throw new Error("notation must match NdM, for example 1d20 or 2d6+1");
  }

  const count = match[1] ? Number(match[1]) : 1;
  const sides = Number(match[2]);
  const notationModifier = match[3] ? Number(match[3]) : 0;

  if (!Number.isInteger(count) || count < 1 || count > 100) {
    throw new Error("dice count must be an integer between 1 and 100");
  }
  if (!Number.isInteger(sides) || sides < 2 || sides > 10_000) {
    throw new Error("dice sides must be an integer between 2 and 10000");
  }

  return {
    count,
    sides,
    notationModifier,
    normalizedNotation: `${count}d${sides}${notationModifier === 0 ? "" : notationModifier > 0 ? `+${notationModifier}` : notationModifier}`,
  };
}

function hashToUint32(value: string): number {
  const digest = createHash("sha256").update(value, "utf8").digest();
  return digest.readUInt32BE(0);
}

function makeXorShift32(seed: number): () => number {
  let state = seed >>> 0;
  if (state === 0) {
    state = 0x9e3779b9;
  }
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

function resolveSeedMaterial(params: {
  input: DiceRollInput;
  agentId?: string;
  sessionId?: string;
}): { policy: "session" | "fixed" | "random"; material: string } {
  const policy =
    params.input.seedPolicy === "fixed" ||
    params.input.seedPolicy === "random" ||
    params.input.seedPolicy === "session"
      ? params.input.seedPolicy
      : "session";

  if (policy === "fixed") {
    const seed = typeof params.input.seed === "string" ? params.input.seed.trim() : "";
    if (!seed) {
      throw new Error("seed is required when seedPolicy=fixed");
    }
    return { policy, material: seed };
  }

  if (policy === "random") {
    return { policy, material: randomBytes(16).toString("hex") };
  }

  const sessionId = params.sessionId?.trim();
  if (!sessionId) {
    throw new Error("session seed policy requires sessionId in tool context");
  }
  const agentId = params.agentId?.trim() || "unknown-agent";
  return { policy, material: `${agentId}:${sessionId}` };
}

export function runDiceRoll(params: {
  input: DiceRollInput;
  agentId?: string;
  sessionId?: string;
}): Record<string, unknown> {
  const notation = typeof params.input.notation === "string" && params.input.notation.trim()
    ? params.input.notation
    : "1d20";

  const parsed = parseNotation(notation);

  const extraModifier =
    typeof params.input.modifier === "number" && Number.isFinite(params.input.modifier)
      ? Math.trunc(params.input.modifier)
      : 0;

  const repeatRaw =
    typeof params.input.repeat === "number" && Number.isFinite(params.input.repeat)
      ? Math.trunc(params.input.repeat)
      : 1;
  const repeat = Math.max(1, Math.min(20, repeatRaw));

  const seed = resolveSeedMaterial({
    input: params.input,
    agentId: params.agentId,
    sessionId: params.sessionId,
  });

  const seedHashHex = createHash("sha256").update(seed.material, "utf8").digest("hex");
  const seedUint32 = hashToUint32(seed.material);
  const nextRandom = makeXorShift32(seedUint32);

  const rolls: Array<Record<string, unknown>> = [];
  const totals: number[] = [];

  for (let run = 0; run < repeat; run += 1) {
    const dice: number[] = [];
    const trace: number[] = [];
    for (let i = 0; i < parsed.count; i += 1) {
      const unit = nextRandom();
      trace.push(Number(unit.toFixed(12)));
      const die = Math.floor(unit * parsed.sides) + 1;
      dice.push(die);
    }

    const subtotal = dice.reduce((sum, die) => sum + die, 0);
    const totalModifier = parsed.notationModifier + extraModifier;
    const total = subtotal + totalModifier;
    totals.push(total);

    rolls.push({
      index: run + 1,
      dice,
      subtotal,
      notationModifier: parsed.notationModifier,
      extraModifier,
      totalModifier,
      total,
      trace,
    });
  }

  const min = Math.min(...totals);
  const max = Math.max(...totals);
  const average = totals.reduce((sum, value) => sum + value, 0) / totals.length;

  return {
    ok: true,
    notation: parsed.normalizedNotation,
    normalized: {
      count: parsed.count,
      sides: parsed.sides,
      notationModifier: parsed.notationModifier,
      extraModifier,
      totalModifier: parsed.notationModifier + extraModifier,
      repeat,
    },
    seed: {
      policy: seed.policy,
      material: seed.material,
      sha256: seedHashHex,
      uint32: seedUint32,
    },
    rolls,
    summary: {
      min,
      max,
      average,
      totals,
    },
    generatedAt: new Date().toISOString(),
  };
}

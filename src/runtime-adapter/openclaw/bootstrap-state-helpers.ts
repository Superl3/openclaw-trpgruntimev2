import type { BootstrapFieldKey } from "./bootstrap-text-helpers.js";

type ReadString = (value: unknown) => string;

export function collectMissingBootstrapFields(
  player: Record<string, unknown>,
  readString: ReadString,
): string[] {
  const missing: string[] = [];
  if (!readString(player.name)) missing.push("이름");
  if (!readString(player.background)) missing.push("출신 / 배경");
  if (!readString(player.motive)) missing.push("지금 이 세계에 들어온 이유");
  if (!readString(player.secret)) missing.push("숨기고 있는 비밀");
  if (!readString(player.fear)) missing.push("두려워하는 것");
  if (!readString(player.goal)) missing.push("지금 당장의 목표");
  return missing;
}

export function hasMinimalBootstrapFields(
  player: Record<string, unknown>,
  readString: ReadString,
): boolean {
  const keys: BootstrapFieldKey[] = ["name", "background", "motive", "secret", "fear", "goal"];
  let answered = 0;
  for (const key of keys) {
    if (readString(player[key])) {
      answered += 1;
    }
  }
  return Boolean(readString(player.name) && answered >= 3);
}

export function relationshipKey(value: Record<string, unknown>, readString: ReadString): string {
  const from = readString(value.from).toLowerCase();
  const to = readString(value.to).toLowerCase();
  const relationType = readString(value.relation_type).toLowerCase();
  const visibility = readString(value.visibility).toLowerCase();
  const source = readString(value.source).toLowerCase();

  if (!from || !to || !relationType) {
    return "";
  }

  return `${from}|${to}|${relationType}|${visibility}|${source}`;
}

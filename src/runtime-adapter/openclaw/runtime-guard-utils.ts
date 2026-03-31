export function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function joinLines(lines: string[]): string {
  return lines.join(String.fromCharCode(10));
}

export function toObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function readFiniteNumber(value: unknown): number | null {
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

export function uniqStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

export function clipForGuard(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}...`;
}

export function sanitizeIntentText(value: string, maxLength = 240): string {
  if (!value) {
    return "";
  }

  const withoutBlocks = value.replace(/```[\s\S]*?```/g, " ");
  const flattened = withoutBlocks
    .replace(/"label"\s*:\s*"[^"]+"/g, " ")
    .replace(/"id"\s*:\s*"[^"]+"/g, " ")
    .replace(/"username"\s*:\s*"[^"]+"/g, " ")
    .replace(/"tag"\s*:\s*"[^"]+"/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!flattened) {
    return "";
  }

  return clipForGuard(flattened, maxLength);
}

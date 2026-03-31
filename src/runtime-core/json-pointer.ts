function decodePointerToken(token: string): string {
  return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

function isObjectLike(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseArrayIndex(token: string): number | null {
  if (!/^\d+$/.test(token)) {
    return null;
  }
  const idx = Number(token);
  return Number.isInteger(idx) && idx >= 0 ? idx : null;
}

export function normalizePointer(pointer: string): string {
  const trimmed = pointer.trim();
  if (!trimmed || trimmed === "/") {
    return "/";
  }
  if (!trimmed.startsWith("/")) {
    throw new Error("pointer must start with '/'");
  }
  return trimmed;
}

export function pointerSegments(pointer: string): string[] {
  const normalized = normalizePointer(pointer);
  if (normalized === "/") {
    return [];
  }
  return normalized
    .split("/")
    .slice(1)
    .map((token) => decodePointerToken(token));
}

export function getAtPointer(root: unknown, pointer: string): { exists: boolean; value: unknown } {
  const segments = pointerSegments(pointer);
  if (segments.length === 0) {
    return { exists: true, value: root };
  }

  let current: unknown = root;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      const idx = parseArrayIndex(segment);
      if (idx === null || idx >= current.length) {
        return { exists: false, value: undefined };
      }
      current = current[idx];
      continue;
    }

    if (isObjectLike(current)) {
      if (!Object.hasOwn(current, segment)) {
        return { exists: false, value: undefined };
      }
      current = current[segment];
      continue;
    }

    return { exists: false, value: undefined };
  }

  return { exists: true, value: current };
}

export function setAtPointer(root: unknown, pointer: string, value: unknown): unknown {
  const segments = pointerSegments(pointer);
  if (segments.length === 0) {
    return value;
  }

  if (!isObjectLike(root) && !Array.isArray(root)) {
    throw new Error("root document must be object or array for pointer set");
  }

  let current: unknown = root;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const token = segments[i];
    const nextToken = segments[i + 1];

    if (Array.isArray(current)) {
      const idx = parseArrayIndex(token);
      if (idx === null) {
        throw new Error(`pointer segment '${token}' is not a valid array index`);
      }
      while (current.length <= idx) {
        current.push({});
      }
      if (!isObjectLike(current[idx]) && !Array.isArray(current[idx])) {
        current[idx] = parseArrayIndex(nextToken) === null ? {} : [];
      }
      current = current[idx];
      continue;
    }

    if (!isObjectLike(current)) {
      throw new Error(`pointer segment '${token}' cannot traverse primitive value`);
    }

    if (!Object.hasOwn(current, token) || current[token] === null || current[token] === undefined) {
      current[token] = parseArrayIndex(nextToken) === null ? {} : [];
    } else if (!isObjectLike(current[token]) && !Array.isArray(current[token])) {
      current[token] = parseArrayIndex(nextToken) === null ? {} : [];
    }
    current = current[token];
  }

  const leaf = segments[segments.length - 1];
  if (Array.isArray(current)) {
    if (leaf === "-") {
      current.push(value);
      return root;
    }
    const idx = parseArrayIndex(leaf);
    if (idx === null) {
      throw new Error(`pointer leaf '${leaf}' is not a valid array index`);
    }
    while (current.length <= idx) {
      current.push(null);
    }
    current[idx] = value;
    return root;
  }

  if (!isObjectLike(current)) {
    throw new Error("pointer leaf parent is not object/array");
  }
  current[leaf] = value;
  return root;
}

export function deleteAtPointer(root: unknown, pointer: string): { changed: boolean; root: unknown } {
  const segments = pointerSegments(pointer);
  if (segments.length === 0) {
    return { changed: false, root };
  }

  let current: unknown = root;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const token = segments[i];
    if (Array.isArray(current)) {
      const idx = parseArrayIndex(token);
      if (idx === null || idx >= current.length) {
        return { changed: false, root };
      }
      current = current[idx];
      continue;
    }
    if (isObjectLike(current)) {
      if (!Object.hasOwn(current, token)) {
        return { changed: false, root };
      }
      current = current[token];
      continue;
    }
    return { changed: false, root };
  }

  const leaf = segments[segments.length - 1];
  if (Array.isArray(current)) {
    const idx = parseArrayIndex(leaf);
    if (idx === null || idx >= current.length) {
      return { changed: false, root };
    }
    current.splice(idx, 1);
    return { changed: true, root };
  }

  if (!isObjectLike(current) || !Object.hasOwn(current, leaf)) {
    return { changed: false, root };
  }
  delete current[leaf];
  return { changed: true, root };
}

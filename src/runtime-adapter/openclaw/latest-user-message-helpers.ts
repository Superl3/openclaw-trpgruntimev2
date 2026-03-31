function toObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function extractMessageText(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }

  if (Array.isArray(content)) {
    const chunks = content
      .map((entry) => {
        const node = toObject(entry);
        const text = readString(node.text);
        if (text) {
          return text;
        }
        return readString(node.value);
      })
      .filter(Boolean);
    return chunks.join(" ").trim();
  }

  const objectContent = toObject(content);
  const asText = readString(objectContent.text);
  if (asText) {
    return asText;
  }

  return readString(objectContent.value);
}

export function extractLatestUserMessage(messages: unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = toObject(messages[index]);
    const role = readString(message.role).toLowerCase();
    if (role !== "user" && role !== "human") {
      continue;
    }

    const content = extractMessageText(message.content);
    if (content) {
      return content;
    }
  }
  return "";
}

export function extractLatestUserMessageFromPrompt(prompt: string): string {
  if (!prompt) {
    return "";
  }

  const tail = prompt.slice(-6000);
  const lines = tail
    .split(String.fromCharCode(10))
    .map((line) => line.replaceAll(String.fromCharCode(13), "").trim())
    .filter(Boolean);

  const userPattern = new RegExp("^(?:user|human)\\s*[:：]\\s*(.+)$", "i");
  const speakerPattern = new RegExp("^(?:system|assistant|tool|context|user|human)\\s*[:：]", "i");

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] as string;
    if (!line) {
      continue;
    }

    const userMatch = line.match(userPattern);
    if (!userMatch || !userMatch[1]) {
      continue;
    }

    const chunks: string[] = [userMatch[1].trim()];
    for (let nextIndex = index + 1; nextIndex < lines.length; nextIndex += 1) {
      const continuation = lines[nextIndex] as string;
      if (!continuation) {
        break;
      }

      const continuationUserMatch = continuation.match(userPattern);
      if (continuationUserMatch && continuationUserMatch[1]) {
        chunks.push(continuationUserMatch[1].trim());
        continue;
      }

      if (speakerPattern.test(continuation)) {
        break;
      }

      if (continuation.startsWith("[") || continuation.startsWith("###")) {
        break;
      }

      chunks.push(continuation);
    }

    const joined = chunks.join(String.fromCharCode(10)).trim();
    if (joined) {
      return joined;
    }
  }

  const fallbackLines: string[] = [];
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] as string;
    const blocked =
      !line ||
      line.length > 220 ||
      line.startsWith("[") ||
      line.startsWith("###") ||
      /^(system|assistant|tool|context)/i.test(line) ||
      /output order is mandatory|optional suggestions|freeform invitation|scene intro seed/i.test(line);

    if (blocked) {
      if (fallbackLines.length > 0) {
        break;
      }
      continue;
    }

    fallbackLines.push(line);
    if (fallbackLines.length >= 8) {
      break;
    }
  }

  if (fallbackLines.length > 0) {
    return fallbackLines.reverse().join(String.fromCharCode(10)).trim();
  }

  return "";
}

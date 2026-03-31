export type BootstrapFieldKey = "name" | "background" | "motive" | "secret" | "fear" | "goal";

export type BootstrapUpdate = Partial<Record<BootstrapFieldKey, string>>;

function parseLabeledAnswer(message: string, labels: string[]): string {
  const escapedLabels = labels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = new RegExp(
    "(?:^|\\n)\\s*(?:" + escapedLabels.join("|") + ")\\s*[:：\\-]\\s*(.+)",
    "i",
  );
  const matched = message.match(pattern);
  return matched && matched[1] ? matched[1].trim() : "";
}

function parseNumberedAnswers(message: string): BootstrapUpdate {
  const lines = message
    .split(String.fromCharCode(10))
    .map((line) => line.trim())
    .filter(Boolean);

  const map: BootstrapUpdate = {};
  const numberPattern = /^(1|2|3|4|5|6)(?:\s*번)?[\).:：\-\.\s]+(.+)$/;
  for (const line of lines) {
    const match = line.match(numberPattern);
    if (!match || !match[2]) {
      continue;
    }
    const value = match[2].trim();
    if (!value) {
      continue;
    }

    if (match[1] === "1") map.name = value;
    if (match[1] === "2") map.background = value;
    if (match[1] === "3") map.motive = value;
    if (match[1] === "4") map.secret = value;
    if (match[1] === "5") map.fear = value;
    if (match[1] === "6") map.goal = value;
  }

  return map;
}

export function parseBootstrapUpdate(message: string): BootstrapUpdate {
  const update: BootstrapUpdate = {
    ...parseNumberedAnswers(message),
  };

  const labeledCandidates: Record<BootstrapFieldKey, string[]> = {
    name: ["이름", "name", "캐릭터 이름"],
    background: ["출신", "배경", "출신 / 배경", "출신/배경", "origin"],
    motive: ["이유", "동기", "지금 이 세계에 들어온 이유", "motive"],
    secret: ["비밀", "숨기고 있는 비밀", "secret"],
    fear: ["두려워하는 것", "두려움", "fear"],
    goal: ["목표", "지금 당장의 목표", "immediate goal", "goal"],
  };

  for (const [key, labels] of Object.entries(labeledCandidates) as Array<[
    BootstrapFieldKey,
    string[],
  ]>) {
    if (update[key]) {
      continue;
    }
    const value = parseLabeledAnswer(message, labels);
    if (value) {
      update[key] = value;
    }
  }

  if (!update.name) {
    const namePatterns = [
      /(?:내\s*이름은|이름은|name\s*is)\s*([^\n,.!?:;]+)/i,
      /(?:나는|전|저는)\s*([^\n,.!?:;]{1,30})\s*(?:라고\s*해|입니다|이다)/i,
    ];
    for (const pattern of namePatterns) {
      const match = message.match(pattern);
      if (match && match[1]) {
        const candidate = match[1].trim();
        if (candidate && candidate.length <= 40) {
          update.name = candidate;
          break;
        }
      }
    }
  }

  return update;
}

export function hasBootstrapReadySignal(message: string): boolean {
  if (!message) {
    return false;
  }
  return /(준비(?:됐|되었습니다|완료|끝)|시작(?:해|하자|하겠습니다)|진행해|이제\s*가자|ready|let'?s\s*go|go\s*ahead)/i.test(
    message,
  );
}

export function extractBootstrapFreeform(message: string): string {
  if (!message) {
    return "";
  }

  const lines = message
    .split(String.fromCharCode(10))
    .map((line) => line.trim())
    .filter(Boolean);

  const numberedPattern = /^(1|2|3|4|5|6)(?:\s*번)?[\).:：\-\.\s]+/;
  const labeledPattern =
    /^(이름|출신|배경|출신\s*\/\s*배경|지금\s*이\s*세계에\s*들어온\s*이유|숨기고\s*있는\s*비밀|두려워하는\s*것|지금\s*당장의\s*목표|name|origin|motive|secret|fear|goal)\s*[:：\-]/i;

  const freeformLines = lines.filter((line) => {
    if (numberedPattern.test(line)) {
      return false;
    }
    if (labeledPattern.test(line)) {
      return false;
    }
    if (hasBootstrapReadySignal(line)) {
      return false;
    }
    if (/^게임\s*시작$/i.test(line)) {
      return false;
    }
    if (line.startsWith("/")) {
      return false;
    }
    if (/^(?:current\s*time|conversation\s*info|sender\s*\(|sender\s*:|untrusted\s*context|source\s*:|system\s*:)/i.test(line)) {
      return false;
    }
    if (/^<{3}|^>{3}|<\/?.+?>/.test(line)) {
      return false;
    }
    if (/\b(?:doc_id|session_id|message_id|sender_id|group_channel|group_space|is_group_chat)\b/i.test(line)) {
      return false;
    }
    return true;
  });

  return freeformLines.join(String.fromCharCode(10)).trim();
}

export function mergeFreeformDescription(existingValue: string, incomingValue: string): string {
  const existing = existingValue.trim();
  const incoming = incomingValue.trim();

  if (!incoming) {
    return existing;
  }
  if (!existing) {
    return incoming;
  }

  if (existing.includes(incoming)) {
    return existing;
  }
  if (incoming.includes(existing)) {
    return incoming;
  }

  return `${existing}${String.fromCharCode(10)}${incoming}`;
}

function hasLegacyBootstrapTemplateLeak(value: string): boolean {
  if (!value) {
    return false;
  }
  return (
    /PART\s*A|PART\s*B/i.test(value) ||
    /숨기고\s*있는\s*비밀/i.test(value) ||
    /(?:^|\n)\s*(?:1|2|3|4|5|6)\s*[\).:：\-]/.test(value)
  );
}

export function sanitizeLegacyBootstrapTemplateText(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  if (hasLegacyBootstrapTemplateLeak(trimmed)) {
    return "캐릭터 준비 정보를 자유롭게 입력해 주세요.";
  }

  const collapsed = trimmed
    .replace(/PART\s*A\/?B[^\n]*/gi, "")
    .replace(/PART\s*A[^\n]*/gi, "")
    .replace(/PART\s*B[^\n]*/gi, "")
    .replace(/숨기고\s*있는\s*비밀/gi, "")
    .replace(/(?:^|\n)\s*(?:1|2|3|4|5|6)\s*[\).:：\-].*/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (!collapsed || hasLegacyBootstrapTemplateLeak(collapsed)) {
    return "캐릭터 준비 정보를 자유롭게 입력해 주세요.";
  }

  return collapsed;
}

export function parseFastWaitDurationLabel(message: string): string {
  const lower = message.toLowerCase();
  const match = lower.match(/(\d{1,2})\s*(턴|분|시간|일|turn|minute|hour|day)s?/i);
  if (match && match[1] && match[2]) {
    return `${match[1]} ${match[2]}`;
  }

  if (/(잠깐|잠시|briefly|a\s*moment)/i.test(lower)) {
    return "brief";
  }
  if (/(하루|하룻밤|overnight)/i.test(lower)) {
    return "1 day";
  }
  if (/(한\s*시간|1\s*hour)/i.test(lower)) {
    return "1 hour";
  }

  return "short";
}

export function isFastWaitIntent(message: string): boolean {
  if (!message) {
    return false;
  }

  const waitPattern = /(기다|대기|잠복|잠시\s*쉰|시간\s*(보내|넘기|건너뛰)|턴\s*넘기|wait|pass\s*time|skip\s*time|hold\s*position)/gi;
  const movementPattern = /(이동|출발|향한다|향해|떠나|travel|move|head|sail|ride)/i;
  const matches = Array.from(message.matchAll(waitPattern));

  if (matches.length === 0) {
    return false;
  }

  const last = matches[matches.length - 1];
  const start = Math.max(0, (last?.index ?? 0) - 80);
  const end = Math.min(message.length, (last?.index ?? 0) + 160);
  const localWindow = message.slice(start, end);

  return !movementPattern.test(localWindow);
}

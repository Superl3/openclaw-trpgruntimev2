type TravelMode = "none" | "walking" | "mounted" | "caravan" | "ship";

export function detectTravelMode(message: string): TravelMode {
  const lower = message.toLowerCase();
  if (/배|선박|항해|sail|ship|vessel/.test(lower)) {
    return "ship";
  }
  if (/말|기마|mounted|horse/.test(lower)) {
    return "mounted";
  }
  if (/대상단|마차|caravan/.test(lower)) {
    return "caravan";
  }
  if (/(이동|간다|향한다|따라|샌다|새다|빠진다|우회|내려간다|go|move|head|travel)/.test(lower)) {
    return "walking";
  }
  return "none";
}

export function isMovementIntent(message: string): boolean {
  const lower = message.toLowerCase();
  if (lower.startsWith("/ooc")) {
    return false;
  }

  const travelVerbPattern =
    /(이동|간다|가겠다|향한다|향해|출발|따라|샌다|새다|빠진다|우회|내려간다|go|move|head|travel|sail|ride)/;
  const stationaryPattern =
    /(이동하지\s*않|움직이지\s*않|한\s*발도\s*움직이지|제자리|가만히|멈춘\s*채|멈춰\s*서|그대로|주변만\s*살핀)/;

  if (stationaryPattern.test(lower) && !travelVerbPattern.test(lower)) {
    return false;
  }

  return travelVerbPattern.test(lower);
}

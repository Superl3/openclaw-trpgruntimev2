import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import YAML from "yaml";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");

function printUsage() {
  console.log("Usage: node scripts/diff-factions-vs-seed.mjs <seed-file-path> [factions-canon-path]");
  console.log("Example: node scripts/diff-factions-vs-seed.mjs world/canon/world-seed.yaml world/canon/factions.yaml");
}

function parseByExtension(filePath, sourceText) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".json") {
    return JSON.parse(sourceText);
  }
  if (ext === ".yaml" || ext === ".yml") {
    return YAML.parse(sourceText);
  }
  throw new Error("Input file must end with .yaml, .yml, or .json");
}

function inferWorldRootFromPath(absolutePath) {
  const parent = path.basename(path.dirname(absolutePath));
  if (parent !== "canon" && parent !== "state") {
    return null;
  }
  return path.dirname(path.dirname(absolutePath));
}

function normalizeCanonPath(seedPath, requestedCanonPath) {
  if (requestedCanonPath) {
    return path.resolve(process.cwd(), requestedCanonPath);
  }
  const absoluteSeedPath = path.resolve(process.cwd(), seedPath);
  const worldRoot = inferWorldRootFromPath(absoluteSeedPath);
  if (worldRoot) {
    return path.resolve(worldRoot, "canon/factions.yaml");
  }
  return path.resolve(process.cwd(), "world/canon/factions.yaml");
}

async function loadModules() {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "trpg-factions-diff-"));
  const tscPath = path.resolve(REPO_ROOT, "node_modules/typescript/bin/tsc");
  const compile = spawnSync(
    process.execPath,
    [
      tscPath,
      "--pretty",
      "false",
      "--module",
      "NodeNext",
      "--target",
      "ES2022",
      "--moduleResolution",
      "NodeNext",
      "--skipLibCheck",
      "true",
      "--esModuleInterop",
      "true",
      "--rootDir",
      ".",
      "--outDir",
      outDir,
      "src/runtime-core/types.ts",
      "src/runtime-core/world-seed.ts",
      "src/faction-canon.ts",
    ],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: "pipe",
    },
  );

  if (compile.status !== 0) {
    const message = [compile.stdout, compile.stderr].filter(Boolean).join("\n").trim();
    throw new Error(message || "failed to compile drift helper dependencies");
  }

  const worldSeedModule = await import(pathToFileURL(path.resolve(outDir, "src/runtime-core/world-seed.js")).href);
  const factionCanonModule = await import(pathToFileURL(path.resolve(outDir, "src/faction-canon.js")).href);

  if (typeof worldSeedModule.validateWorldSeed !== "function") {
    throw new Error("validateWorldSeed export is unavailable");
  }
  if (typeof worldSeedModule.buildWorldSeedFingerprint !== "function") {
    throw new Error("buildWorldSeedFingerprint export is unavailable");
  }
  if (typeof factionCanonModule.validateFactionCanon !== "function") {
    throw new Error("validateFactionCanon export is unavailable");
  }
  if (typeof factionCanonModule.buildFactionCanonReferenceIndexFromWorldSeed !== "function") {
    throw new Error("buildFactionCanonReferenceIndexFromWorldSeed export is unavailable");
  }
  if (typeof factionCanonModule.detectFactionCanonScaffoldDrift !== "function") {
    throw new Error("detectFactionCanonScaffoldDrift export is unavailable");
  }
  if (typeof factionCanonModule.buildFactionCanonFingerprint !== "function") {
    throw new Error("buildFactionCanonFingerprint export is unavailable");
  }

  return {
    outDir,
    validateWorldSeed: worldSeedModule.validateWorldSeed,
    buildWorldSeedFingerprint: worldSeedModule.buildWorldSeedFingerprint,
    validateFactionCanon: factionCanonModule.validateFactionCanon,
    buildFactionCanonReferenceIndexFromWorldSeed:
      factionCanonModule.buildFactionCanonReferenceIndexFromWorldSeed,
    detectFactionCanonScaffoldDrift: factionCanonModule.detectFactionCanonScaffoldDrift,
    buildFactionCanonFingerprint: factionCanonModule.buildFactionCanonFingerprint,
  };
}

function printFailure(payload) {
  console.error("factions drift audit failed");
  console.error(JSON.stringify(payload, null, 2));
}

function mapCanonDiagnostics(diagnostics, sourcePath) {
  return diagnostics.map((entry) => ({
    code: entry.code,
    message: entry.message,
    path: entry.path ? `${sourcePath}${entry.path}` : sourcePath,
    severity: entry.severity,
  }));
}

const args = process.argv.slice(2);
if (args.includes("-h") || args.includes("--help")) {
  printUsage();
  process.exit(0);
}

if (args.length < 1 || args.length > 2) {
  printUsage();
  process.exit(2);
}

const seedPathInput = args[0];
const canonPathInput = args[1] || "";
const seedAbsolutePath = path.resolve(process.cwd(), seedPathInput);
const canonAbsolutePath = normalizeCanonPath(seedPathInput, canonPathInput);

let compiledOutDir = null;

try {
  const modules = await loadModules();
  compiledOutDir = modules.outDir;

  const seedRaw = await fs.readFile(seedAbsolutePath, "utf8");
  const parsedSeed = parseByExtension(seedAbsolutePath, seedRaw);
  const validatedSeed = modules.validateWorldSeed(parsedSeed);
  if (!validatedSeed.ok) {
    printFailure({
      ok: false,
      status: "invalid_seed",
      seedPath: seedAbsolutePath,
      canonPath: canonAbsolutePath,
      diagnostics: validatedSeed.issues,
    });
    process.exit(1);
  }

  const references = modules.buildFactionCanonReferenceIndexFromWorldSeed(validatedSeed.seed);
  const seedFingerprint = modules.buildWorldSeedFingerprint(validatedSeed.seed);

  let canonRaw;
  try {
    canonRaw = await fs.readFile(canonAbsolutePath, "utf8");
  } catch {
    console.log("factions drift audit completed");
    console.log(
      JSON.stringify(
        {
          ok: true,
          status: "missing_canon",
          sourcePolicy: {
            seed: "seed_bootstrap_only",
            canon: "canon_authoritative",
          },
          seedPath: seedAbsolutePath,
          canonPath: canonAbsolutePath,
          seedFingerprint,
          canonFingerprint: null,
          diagnostics: [
            {
              code: "faction_canon_missing",
              message: "canon/factions.yaml is missing. create scaffold with sync helper.",
              path: canonAbsolutePath,
              severity: "warn",
            },
          ],
          summaryText:
            "Seed is valid but factions canon is missing. Run scaffold helper in dry-run/apply mode to create canonical scaffold.",
        },
        null,
        2,
      ),
    );
    process.exit(0);
  }

  const parsedCanon = parseByExtension(canonAbsolutePath, canonRaw);
  const validatedCanon = modules.validateFactionCanon(parsedCanon, {
    references: {
      worldId: references.worldId,
      locationIds: references.locationIds,
      pressureIds: references.pressureIds,
    },
  });

  if (!validatedCanon.ok) {
    console.log("factions drift audit completed");
    console.log(
      JSON.stringify(
        {
          ok: true,
          status: "invalid_canon",
          sourcePolicy: {
            seed: "seed_bootstrap_only",
            canon: "canon_authoritative",
          },
          seedPath: seedAbsolutePath,
          canonPath: canonAbsolutePath,
          seedFingerprint,
          canonFingerprint: null,
          diagnostics: mapCanonDiagnostics(validatedCanon.diagnostics, canonAbsolutePath),
          summaryText:
            "Seed is valid but current factions canon is invalid. Fix canonical diagnostics before sync/apply.",
        },
        null,
        2,
      ),
    );
    process.exit(0);
  }

  const drift = modules.detectFactionCanonScaffoldDrift({
    seed: validatedSeed.seed,
    canon: validatedCanon.canon,
  });

  const payload = {
    ok: true,
    status: drift.status,
    sourcePolicy: {
      seed: "seed_bootstrap_only",
      canon: "canon_authoritative",
    },
    seedPath: seedAbsolutePath,
    canonPath: canonAbsolutePath,
    seedFingerprint,
    canonFingerprint: modules.buildFactionCanonFingerprint(validatedCanon.canon),
    drift,
    summaryText:
      drift.status === "aligned"
        ? "Seed scaffold and canonical scaffold are aligned."
        : drift.status === "incompatible"
          ? "Detected incompatible scaffold state. Review world id and scaffold mismatches before apply."
          : "Detected scaffold drift. Review added/missing/changed entries and run sync helper explicitly.",
  };

  console.log("factions drift audit completed");
  console.log(JSON.stringify(payload, null, 2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  printFailure({
    ok: false,
    status: "error",
    seedPath: seedAbsolutePath,
    canonPath: canonAbsolutePath,
    diagnostics: [
      {
        code: "drift_audit_runtime_error",
        message,
        path: seedAbsolutePath,
        severity: "error",
      },
    ],
  });
  process.exit(1);
} finally {
  if (compiledOutDir) {
    await fs.rm(compiledOutDir, { recursive: true, force: true });
  }
}

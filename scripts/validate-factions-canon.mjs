import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import YAML from "yaml";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const WORLD_SEED_REFERENCE_CANDIDATE_PATHS = [
  "canon/world-seed.yaml",
  "canon/world-seed.yml",
  "canon/world-seed.json",
  "state/world-seed.yaml",
  "state/world-seed.yml",
  "state/world-seed.json",
  "state/world-seeds.yaml",
  "state/world-seeds.yml",
  "state/world-seeds.json",
];

function printUsage() {
  console.log("Usage: node scripts/validate-factions-canon.mjs <factions-canon-path>");
  console.log("Example: node scripts/validate-factions-canon.mjs world/canon/factions.yaml");
}

function parseByExtension(filePath, sourceText) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".json") {
    return JSON.parse(sourceText);
  }
  if (ext === ".yaml" || ext === ".yml") {
    return YAML.parse(sourceText);
  }
  throw new Error("Faction canon file must end with .yaml, .yml, or .json");
}

function toLoadFailure(code, message, sourcePath) {
  return {
    code,
    message,
    path: sourcePath,
    severity: "error",
  };
}

function mapValidationDiagnostics(diagnostics, sourcePath) {
  return diagnostics.map((entry) => ({
    code: entry.code,
    message: entry.message,
    path: entry.path ? `${sourcePath}${entry.path}` : sourcePath,
    severity: entry.severity,
  }));
}

async function readStructuredFile(inputPath) {
  const absolutePath = path.resolve(process.cwd(), inputPath);
  let sourceText;
  try {
    sourceText = await fs.readFile(absolutePath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      absolutePath,
      diagnostics: [toLoadFailure("faction_canon_file_not_found", message, absolutePath)],
    };
  }

  try {
    return {
      ok: true,
      absolutePath,
      parsed: parseByExtension(absolutePath, sourceText),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      absolutePath,
      diagnostics: [toLoadFailure("faction_canon_parse_error", message, absolutePath)],
    };
  }
}

function inferWorldRootFromFactionPath(absoluteFactionPath) {
  const parent = path.basename(path.dirname(absoluteFactionPath));
  if (parent !== "canon" && parent !== "state") {
    return null;
  }
  return path.dirname(path.dirname(absoluteFactionPath));
}

async function loadOptionalWorldSeedReferences(params) {
  const diagnostics = [];
  if (!params.worldRoot) {
    diagnostics.push({
      code: "world_seed_reference_skipped",
      message: "Could not infer world root from faction canon path; cross-file reference checks were skipped.",
      path: null,
      severity: "warn",
    });
    return {
      references: null,
      diagnostics,
    };
  }

  for (const candidatePath of WORLD_SEED_REFERENCE_CANDIDATE_PATHS) {
    const absolutePath = path.resolve(params.worldRoot, candidatePath);
    let sourceText;
    try {
      sourceText = await fs.readFile(absolutePath, "utf8");
    } catch {
      continue;
    }

    let parsed;
    try {
      parsed = parseByExtension(absolutePath, sourceText);
    } catch (error) {
      diagnostics.push({
        code: "world_seed_reference_parse_error",
        message: error instanceof Error ? error.message : String(error),
        path: absolutePath,
        severity: "warn",
      });
      return {
        references: null,
        diagnostics,
      };
    }

    const validated = params.validateWorldSeed(parsed);
    if (!validated.ok) {
      diagnostics.push(
        ...validated.issues.slice(0, 24).map((entry) => ({
          code: `world_seed_reference_${entry.code}`,
          message: entry.message,
          path: entry.path ? `${absolutePath}${entry.path}` : absolutePath,
          severity: entry.severity === "error" ? "warn" : entry.severity,
        })),
      );
      return {
        references: null,
        diagnostics,
      };
    }

    const index = params.buildFactionCanonReferenceIndexFromWorldSeed(validated.seed);
    return {
      references: {
        worldId: index.worldId,
        locationIds: index.locationIds,
        pressureIds: index.pressureIds,
      },
      diagnostics,
    };
  }

  diagnostics.push({
    code: "world_seed_reference_missing",
    message: "No world seed file found for cross-file reference checks.",
    path: params.worldRoot,
    severity: "warn",
  });
  return {
    references: null,
    diagnostics,
  };
}

async function loadValidators() {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "trpg-factions-validator-"));
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
    throw new Error(message || "failed to compile faction canon validator modules");
  }

  const factionCanonModule = await import(pathToFileURL(path.resolve(outDir, "src/faction-canon.js")).href);
  const worldSeedModule = await import(pathToFileURL(path.resolve(outDir, "src/runtime-core/world-seed.js")).href);

  if (typeof factionCanonModule.validateFactionCanon !== "function") {
    throw new Error("validateFactionCanon export is unavailable");
  }
  if (typeof factionCanonModule.buildFactionCanonReferenceIndexFromWorldSeed !== "function") {
    throw new Error("buildFactionCanonReferenceIndexFromWorldSeed export is unavailable");
  }
  if (typeof worldSeedModule.validateWorldSeed !== "function") {
    throw new Error("validateWorldSeed export is unavailable");
  }

  return {
    outDir,
    validateFactionCanon: factionCanonModule.validateFactionCanon,
    buildFactionCanonReferenceIndexFromWorldSeed:
      factionCanonModule.buildFactionCanonReferenceIndexFromWorldSeed,
    validateWorldSeed: worldSeedModule.validateWorldSeed,
  };
}

function printInvalid(payload) {
  console.error("factions canon invalid");
  console.error(JSON.stringify(payload, null, 2));
}

const inputPath = process.argv[2];
if (!inputPath || inputPath === "-h" || inputPath === "--help") {
  printUsage();
  process.exit(inputPath ? 0 : 2);
}

let compiledOutDir = null;

try {
  const loadedCanon = await readStructuredFile(inputPath);
  if (!loadedCanon.ok) {
    printInvalid({
      ok: false,
      status: "invalid",
      filePath: loadedCanon.absolutePath,
      diagnostics: loadedCanon.diagnostics,
    });
    process.exit(1);
  }

  const validators = await loadValidators();
  compiledOutDir = validators.outDir;

  const worldRoot = inferWorldRootFromFactionPath(loadedCanon.absolutePath);
  const referenceLoad = await loadOptionalWorldSeedReferences({
    worldRoot,
    validateWorldSeed: validators.validateWorldSeed,
    buildFactionCanonReferenceIndexFromWorldSeed:
      validators.buildFactionCanonReferenceIndexFromWorldSeed,
  });

  const validated = validators.validateFactionCanon(loadedCanon.parsed, {
    references: referenceLoad.references
      ? {
          worldId: referenceLoad.references.worldId,
          locationIds: referenceLoad.references.locationIds,
          pressureIds: referenceLoad.references.pressureIds,
        }
      : undefined,
  });
  const diagnostics = [
    ...referenceLoad.diagnostics,
    ...mapValidationDiagnostics(validated.diagnostics, loadedCanon.absolutePath),
  ];

  if (!validated.ok) {
    printInvalid({
      ok: false,
      status: "invalid",
      filePath: loadedCanon.absolutePath,
      diagnostics,
    });
    process.exit(1);
  }

  console.log("factions canon valid");
  console.log(
    JSON.stringify(
      {
        ok: true,
        status: "valid",
        filePath: loadedCanon.absolutePath,
        worldId: validated.canon.worldId,
        diagnostics,
        counts: {
          factions: validated.canon.factions.length,
          enabledFactions: validated.canon.factions.filter((entry) => entry.enabled).length,
        },
      },
      null,
      2,
    ),
  );
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  printInvalid({
    ok: false,
    status: "error",
    filePath: path.resolve(process.cwd(), inputPath),
    diagnostics: [
      {
        code: "validator_runtime_error",
        message,
        path: path.resolve(process.cwd(), inputPath),
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

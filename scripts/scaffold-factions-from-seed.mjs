import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import YAML from "yaml";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");

const SYNC_POLICIES = new Set(["preserve_operational", "replace_all"]);

function printUsage() {
  console.log("Usage: node scripts/scaffold-factions-from-seed.mjs <seed-file-path> [output-factions-path] [--apply] [--force] [--policy preserve_operational|replace_all]");
  console.log("Example (dry-run): node scripts/scaffold-factions-from-seed.mjs world/canon/world-seed.yaml world/canon/factions.yaml");
  console.log("Example (apply):   node scripts/scaffold-factions-from-seed.mjs world/canon/world-seed.yaml world/canon/factions.yaml --apply --force");
}

function parseByExtension(filePath, sourceText) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".json") {
    return JSON.parse(sourceText);
  }
  if (ext === ".yaml" || ext === ".yml") {
    return YAML.parse(sourceText);
  }
  throw new Error("Seed file must end with .yaml, .yml, or .json");
}

function inferWorldRootFromSeedPath(absoluteSeedPath) {
  const parent = path.basename(path.dirname(absoluteSeedPath));
  if (parent !== "canon" && parent !== "state") {
    return null;
  }
  return path.dirname(path.dirname(absoluteSeedPath));
}

function normalizeOutputPath(seedPath, requestedOutputPath) {
  if (requestedOutputPath) {
    return path.resolve(process.cwd(), requestedOutputPath);
  }
  const absoluteSeedPath = path.resolve(process.cwd(), seedPath);
  const worldRoot = inferWorldRootFromSeedPath(absoluteSeedPath);
  if (worldRoot) {
    return path.resolve(worldRoot, "canon/factions.yaml");
  }
  return path.resolve(process.cwd(), "world/canon/factions.yaml");
}

function parseArgs(rawArgs) {
  const options = {
    apply: false,
    force: false,
    policy: "preserve_operational",
  };
  const positional = [];

  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (arg === "--apply") {
      options.apply = true;
      continue;
    }
    if (arg === "--force") {
      options.force = true;
      continue;
    }
    if (arg === "--dry-run") {
      options.apply = false;
      continue;
    }
    if (arg === "--policy") {
      const next = rawArgs[index + 1] ?? "";
      options.policy = next;
      index += 1;
      continue;
    }
    if (arg.startsWith("--policy=")) {
      options.policy = arg.slice("--policy=".length);
      continue;
    }
    positional.push(arg);
  }

  if (!SYNC_POLICIES.has(options.policy)) {
    throw new Error(`Unsupported policy: ${options.policy}`);
  }

  return {
    options,
    positional,
  };
}

async function loadModules() {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "trpg-faction-scaffold-sync-"));
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
    throw new Error(message || "failed to compile scaffold dependencies");
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
  if (typeof factionCanonModule.syncFactionCanonFromSeedScaffold !== "function") {
    throw new Error("syncFactionCanonFromSeedScaffold export is unavailable");
  }
  if (typeof factionCanonModule.buildFactionCanonReferenceIndexFromWorldSeed !== "function") {
    throw new Error("buildFactionCanonReferenceIndexFromWorldSeed export is unavailable");
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
    syncFactionCanonFromSeedScaffold: factionCanonModule.syncFactionCanonFromSeedScaffold,
    buildFactionCanonFingerprint: factionCanonModule.buildFactionCanonFingerprint,
  };
}

function printFailure(payload) {
  console.error("factions scaffold sync failed");
  console.error(JSON.stringify(payload, null, 2));
}

function mapDiagnostics(diagnostics, sourcePath) {
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

let parsedArgs;
try {
  parsedArgs = parseArgs(args);
} catch (error) {
  printUsage();
  printFailure({
    ok: false,
    status: "invalid_args",
    diagnostics: [
      {
        code: "invalid_cli_args",
        message: error instanceof Error ? error.message : String(error),
        path: "args",
        severity: "error",
      },
    ],
  });
  process.exit(2);
}

if (parsedArgs.positional.length < 1 || parsedArgs.positional.length > 2) {
  printUsage();
  process.exit(2);
}

const seedPathInput = parsedArgs.positional[0];
const outputPathInput = parsedArgs.positional[1] || "";
const seedAbsolutePath = path.resolve(process.cwd(), seedPathInput);
const outputAbsolutePath = normalizeOutputPath(seedPathInput, outputPathInput);

let compiledOutDir = null;

try {
  const sourceText = await fs.readFile(seedAbsolutePath, "utf8");
  const seedParsed = parseByExtension(seedAbsolutePath, sourceText);

  const modules = await loadModules();
  compiledOutDir = modules.outDir;

  const validatedSeed = modules.validateWorldSeed(seedParsed);
  if (!validatedSeed.ok) {
    printFailure({
      ok: false,
      status: "invalid_seed",
      mode: parsedArgs.options.apply ? "apply" : "dry-run",
      seedPath: seedAbsolutePath,
      outputPath: outputAbsolutePath,
      diagnostics: validatedSeed.issues,
    });
    process.exit(1);
  }

  const references = modules.buildFactionCanonReferenceIndexFromWorldSeed(validatedSeed.seed);
  const seedFingerprint = modules.buildWorldSeedFingerprint(validatedSeed.seed);

  let outputExists = false;
  let currentCanon = null;
  let currentCanonValidation = null;
  try {
    const stat = await fs.stat(outputAbsolutePath);
    outputExists = stat.isFile();
  } catch {
    outputExists = false;
  }

  if (outputExists) {
    const canonRaw = await fs.readFile(outputAbsolutePath, "utf8");
    const canonParsed = parseByExtension(outputAbsolutePath, canonRaw);
    currentCanonValidation = modules.validateFactionCanon(canonParsed, {
      references: {
        worldId: references.worldId,
        locationIds: references.locationIds,
        pressureIds: references.pressureIds,
      },
    });

    if (!currentCanonValidation.ok) {
      printFailure({
        ok: false,
        status: "invalid_existing_canon",
        mode: parsedArgs.options.apply ? "apply" : "dry-run",
        seedPath: seedAbsolutePath,
        outputPath: outputAbsolutePath,
        diagnostics: mapDiagnostics(currentCanonValidation.diagnostics, outputAbsolutePath),
      });
      process.exit(1);
    }
    currentCanon = currentCanonValidation.canon;
  }

  const syncResult = modules.syncFactionCanonFromSeedScaffold({
    seed: validatedSeed.seed,
    currentCanon,
    policy: parsedArgs.options.policy,
  });

  const nextValidation = modules.validateFactionCanon(syncResult.nextCanon, {
    references: {
      worldId: references.worldId,
      locationIds: references.locationIds,
      pressureIds: references.pressureIds,
    },
  });
  if (!nextValidation.ok) {
    printFailure({
      ok: false,
      status: "sync_validation_failed",
      mode: parsedArgs.options.apply ? "apply" : "dry-run",
      seedPath: seedAbsolutePath,
      outputPath: outputAbsolutePath,
      diagnostics: nextValidation.diagnostics,
    });
    process.exit(1);
  }

  const canonFingerprintBefore = currentCanon ? modules.buildFactionCanonFingerprint(currentCanon) : null;
  const canonFingerprintAfter = modules.buildFactionCanonFingerprint(syncResult.nextCanon);
  const hasMaterialDiff = canonFingerprintBefore !== canonFingerprintAfter;

  if (!parsedArgs.options.apply) {
    console.log("factions scaffold sync dry-run completed");
    console.log(
      JSON.stringify(
        {
          ok: true,
          status: "dry_run",
          mode: "dry-run",
          sourcePolicy: {
            seed: "seed_bootstrap_only",
            canon: "canon_authoritative",
          },
          policy: parsedArgs.options.policy,
          seedPath: seedAbsolutePath,
          outputPath: outputAbsolutePath,
          seedFingerprint,
          canonFingerprintBefore,
          canonFingerprintAfter,
          outputExists,
          hasMaterialDiff,
          writePlanned: hasMaterialDiff,
          writeApplied: false,
          drift: syncResult.drift,
          syncSummary: syncResult.summary,
          note:
            "Dry-run only. Re-run with --apply to write, and include --force when overwriting existing canonical file.",
        },
        null,
        2,
      ),
    );
    process.exit(0);
  }

  if (outputExists && !parsedArgs.options.force) {
    printFailure({
      ok: false,
      status: "output_exists",
      mode: "apply",
      seedPath: seedAbsolutePath,
      outputPath: outputAbsolutePath,
      diagnostics: [
        {
          code: "factions_output_exists",
          message: "Output factions file exists. Pass --force with --apply to overwrite.",
          path: outputAbsolutePath,
          severity: "error",
        },
      ],
    });
    process.exit(1);
  }

  if (hasMaterialDiff) {
    await fs.mkdir(path.dirname(outputAbsolutePath), { recursive: true });
    const rendered = YAML.stringify(syncResult.nextCanon);
    await fs.writeFile(
      outputAbsolutePath,
      rendered.endsWith("\n") ? rendered : `${rendered}\n`,
      "utf8",
    );
  }

  console.log("factions scaffold sync applied");
  console.log(
    JSON.stringify(
      {
        ok: true,
        status: "applied",
        mode: "apply",
        sourcePolicy: {
          seed: "seed_bootstrap_only",
          canon: "canon_authoritative",
        },
        policy: parsedArgs.options.policy,
        seedPath: seedAbsolutePath,
        outputPath: outputAbsolutePath,
        seedFingerprint,
        canonFingerprintBefore,
        canonFingerprintAfter,
        outputExists,
        overwritten: outputExists,
        hasMaterialDiff,
        writeApplied: hasMaterialDiff,
        drift: syncResult.drift,
        syncSummary: syncResult.summary,
      },
      null,
      2,
    ),
  );
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  printFailure({
    ok: false,
    status: "error",
    mode: parsedArgs?.options?.apply ? "apply" : "dry-run",
    seedPath: seedAbsolutePath,
    outputPath: outputAbsolutePath,
    diagnostics: [
      {
        code: "scaffold_runtime_error",
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

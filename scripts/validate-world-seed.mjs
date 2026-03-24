import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import YAML from "yaml";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");

function printUsage() {
  console.log("Usage: node scripts/validate-world-seed.mjs <seed-file-path>");
  console.log("Example: node scripts/validate-world-seed.mjs world/canon/world-seed.yaml");
}

function toLoadFailure(code, message, sourcePath) {
  return {
    code,
    message,
    path: sourcePath,
    severity: "error",
  };
}

function mapValidationIssues(issues, sourcePath) {
  return issues.map((issue) => ({
    code: issue.code,
    message: issue.message,
    path: issue.path ? `${sourcePath}${issue.path}` : sourcePath,
    severity: issue.severity,
  }));
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

async function readSeedFile(seedPath) {
  const absolutePath = path.resolve(process.cwd(), seedPath);
  let sourceText;
  try {
    sourceText = await fs.readFile(absolutePath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      absolutePath,
      diagnostics: [toLoadFailure("seed_file_not_found", message, absolutePath)],
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
      diagnostics: [toLoadFailure("seed_file_parse_error", message, absolutePath)],
    };
  }
}

async function loadWorldSeedValidator() {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "trpg-world-seed-validator-"));
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
    ],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: "pipe",
    },
  );

  if (compile.status !== 0) {
    const message = [compile.stdout, compile.stderr].filter(Boolean).join("\n").trim();
    throw new Error(message || "failed to compile world-seed validator");
  }

  const modulePath = path.resolve(outDir, "src/runtime-core/world-seed.js");
  const loaded = await import(pathToFileURL(modulePath).href);
  if (typeof loaded.validateWorldSeed !== "function") {
    throw new Error("validateWorldSeed export is unavailable");
  }

  return {
    outDir,
    validateWorldSeed: loaded.validateWorldSeed,
  };
}

function printInvalid(payload) {
  console.error("world seed invalid");
  console.error(JSON.stringify(payload, null, 2));
}

const inputPath = process.argv[2];
if (!inputPath || inputPath === "-h" || inputPath === "--help") {
  printUsage();
  process.exit(inputPath ? 0 : 2);
}

let compiledOutDir = null;

try {
  const loaded = await readSeedFile(inputPath);
  if (!loaded.ok) {
    printInvalid({
      ok: false,
      status: "invalid",
      filePath: loaded.absolutePath,
      diagnostics: loaded.diagnostics,
    });
    process.exit(1);
  }

  const validator = await loadWorldSeedValidator();
  compiledOutDir = validator.outDir;

  const validation = validator.validateWorldSeed(loaded.parsed);
  if (!validation.ok) {
    printInvalid({
      ok: false,
      status: "invalid",
      filePath: loaded.absolutePath,
      diagnostics: mapValidationIssues(validation.issues, loaded.absolutePath),
    });
    process.exit(1);
  }

  const diagnostics = mapValidationIssues(validation.issues, loaded.absolutePath);
  console.log("world seed valid");
  console.log(
    JSON.stringify(
      {
        ok: true,
        status: "valid",
        filePath: loaded.absolutePath,
        worldId: validation.seed.worldId,
        schemaVersion: validation.seed.schemaVersion,
        diagnostics,
        counts: {
          locations: validation.seed.locations.length,
          pressures: validation.seed.pressures.length,
          factions: validation.seed.factions.length,
          npcPool: validation.seed.npcPool.length,
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

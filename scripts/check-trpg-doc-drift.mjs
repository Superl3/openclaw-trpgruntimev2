import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_ROOT = path.resolve(SCRIPT_DIR, "..");
const DEFAULT_DOC_ROOT = EXTENSION_ROOT;

const ACTIVE_ROOT_FILES = ["AGENTS.md", "MEMORY.md", "TOOLS.md", "TRPG_PATH_REGISTRY.yaml"];

const LEGACY_PATTERN_RULES = [
  {
    id: "legacy_runtime_path",
    description: "legacy runtime plugin path",
    regex: /extensions\/trpg-runtime(?:\/|\\)/g,
  },
  {
    id: "legacy_agent_flag",
    description: "legacy --agent trpg usage",
    regex: /--agent\s+trpg(?:\s|$)/g,
  },
  {
    id: "legacy_plugin_info",
    description: "legacy plugin info command",
    regex: /plugins\s+info\s+trpg-runtime(?:\s|$)/g,
  },
  {
    id: "legacy_channel_id",
    description: "legacy discord channel id",
    regex: /1481145168324333648/g,
  },
  {
    id: "legacy_world_state_path",
    description: "legacy world state path reference",
    regex: /workspace-trpg\/world\/state/g,
  },
];

const REQUIRED_SNIPPETS = [
  {
    file: "TRPG_PATH_REGISTRY.yaml",
    snippets: [
      "runtime_plugin_active: ~/.openclaw/extensions/trpg-runtime-v2",
      "runtime_plugin_legacy_archive: ~/archive/extensions/trpg-runtime",
    ],
  },
  {
    file: "docs/ops/host-smoke-test.md",
    snippets: ["plugins info trpg-runtime-v2", "--agent trpg-v2"],
  },
  {
    file: "docs/ops/zone-lifecycle-smoke-test.md",
    snippets: ["plugins info trpg-runtime-v2", "--agent trpg-v2"],
  },
];

function normalizeRel(absolute, base) {
  return path.relative(base, absolute).split(path.sep).join("/");
}

function lineNumberForIndex(text, index) {
  return text.slice(0, index).split("\n").length;
}

async function pathExists(absolute) {
  try {
    await fs.access(absolute);
    return true;
  } catch {
    return false;
  }
}

async function walkOpsDocs(opsRoot, out) {
  let entries = [];
  try {
    entries = await fs.readdir(opsRoot, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const absolute = path.resolve(opsRoot, entry.name);
    if (entry.isDirectory()) {
      await walkOpsDocs(absolute, out);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    if (entry.name.includes(".bak-")) {
      continue;
    }
    if (!/\.(md|ya?ml)$/i.test(entry.name)) {
      continue;
    }
    out.push(absolute);
  }
}

async function collectTargetFiles(docRoot) {
  const out = [];

  for (const relative of ACTIVE_ROOT_FILES) {
    const absolute = path.resolve(docRoot, relative);
    if (await pathExists(absolute)) {
      out.push(absolute);
    }
  }

  await walkOpsDocs(path.resolve(docRoot, "docs/ops"), out);
  return out;
}

function scanTextWithRules(params) {
  const { text, relativePath } = params;
  const issues = [];

  for (const rule of LEGACY_PATTERN_RULES) {
    const regex = new RegExp(rule.regex.source, rule.regex.flags);
    let match = regex.exec(text);
    while (match) {
      issues.push({
        kind: "pattern",
        id: rule.id,
        description: rule.description,
        file: relativePath,
        line: lineNumberForIndex(text, match.index),
        excerpt: String(match[0]),
      });
      match = regex.exec(text);
    }
  }

  return issues;
}

async function runRequiredSnippetChecks(docRoot) {
  const issues = [];

  for (const required of REQUIRED_SNIPPETS) {
    const absolute = path.resolve(docRoot, required.file);
    const relative = required.file;
    if (!(await pathExists(absolute))) {
      issues.push({
        kind: "required",
        id: "required_file_missing",
        file: relative,
        line: 1,
        message: "required file missing",
      });
      continue;
    }

    const text = await fs.readFile(absolute, "utf8");
    for (const snippet of required.snippets) {
      if (!text.includes(snippet)) {
        issues.push({
          kind: "required",
          id: "required_snippet_missing",
          file: relative,
          line: 1,
          message: `required snippet missing: ${snippet}`,
        });
      }
    }
  }

  return issues;
}

export async function runTrpgDocDriftCheck(options = {}) {
  const docRoot = path.resolve(options.docRoot ?? DEFAULT_DOC_ROOT);
  const files = await collectTargetFiles(docRoot);
  const issues = [];

  for (const file of files) {
    const text = await fs.readFile(file, "utf8");
    const relativePath = normalizeRel(file, docRoot);
    issues.push(...scanTextWithRules({ text, relativePath }));
  }

  issues.push(...(await runRequiredSnippetChecks(docRoot)));

  return {
    ok: issues.length === 0,
    docRoot,
    scannedFiles: files.map((file) => normalizeRel(file, docRoot)),
    issues,
  };
}

function parseCliArgs(argv) {
  const out = {
    docRoot: undefined,
    json: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--doc-root") {
      out.docRoot = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === "--json") {
      out.json = true;
    }
  }

  return out;
}

function printHuman(result) {
  if (result.ok) {
    console.log(`[doc-drift] OK (${result.scannedFiles.length} files)`);
    return;
  }

  console.error(`[doc-drift] FAIL (${result.issues.length} issue(s))`);
  for (const issue of result.issues) {
    if (issue.kind === "pattern") {
      console.error(`- [${issue.id}] ${issue.file}:${issue.line} (${issue.description}) -> ${issue.excerpt}`);
    } else {
      console.error(`- [${issue.id}] ${issue.file}:${issue.line} ${issue.message}`);
    }
  }
}

const invokedScriptPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedScriptPath && import.meta.url === pathToFileURL(invokedScriptPath).href) {
  const args = parseCliArgs(process.argv.slice(2));
  const result = await runTrpgDocDriftCheck({ docRoot: args.docRoot });
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printHuman(result);
  }
  if (!result.ok) {
    process.exitCode = 1;
  }
}

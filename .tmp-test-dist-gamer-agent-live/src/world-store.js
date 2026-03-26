import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
const WORLD_SCOPES = ["canon", "state", "secrets", "logs"];
const STRUCTURED_EXTENSIONS = new Set([".yaml", ".yml", ".json"]);
const READABLE_EXTENSIONS = new Set([".yaml", ".yml", ".json", ".md"]);
function toObject(value) {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value
        : {};
}
function toStringList(value) {
    if (!Array.isArray(value)) {
        return [];
    }
    return value
        .filter((entry) => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter(Boolean);
}
function toPosixPath(input) {
    return input.replace(/\\/g, "/");
}
function hashSha256(text) {
    return createHash("sha256").update(text, "utf8").digest("hex");
}
function extLower(filePath) {
    return path.extname(filePath).toLowerCase();
}
function clipString(value) {
    if (value.length <= 2000) {
        return value;
    }
    return `${value.slice(0, 2000)}...`;
}
function sanitize(value, depth = 0) {
    if (value === null || value === undefined) {
        return value;
    }
    if (typeof value === "string") {
        return clipString(value);
    }
    if (typeof value === "number" || typeof value === "boolean") {
        return value;
    }
    if (depth >= 7) {
        return "[max_depth_reached]";
    }
    if (Array.isArray(value)) {
        return value.slice(0, 60).map((entry) => sanitize(entry, depth + 1));
    }
    if (typeof value === "object") {
        const obj = value;
        const out = {};
        for (const key of Object.keys(obj).slice(0, 80)) {
            out[key] = sanitize(obj[key], depth + 1);
        }
        return out;
    }
    return String(value);
}
function normalizePath(rawPath) {
    const trimmed = toPosixPath(rawPath).trim();
    if (!trimmed) {
        throw new Error("path must not be empty");
    }
    if (trimmed.includes("\0")) {
        throw new Error("path contains null byte");
    }
    const noLeadSlash = trimmed.replace(/^\/+/, "");
    const noWorldPrefix = noLeadSlash.startsWith("world/")
        ? noLeadSlash.slice("world/".length)
        : noLeadSlash;
    const normalized = path.posix.normalize(noWorldPrefix);
    if (!normalized || normalized === ".") {
        throw new Error("path must resolve to world/*");
    }
    if (normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
        throw new Error("path traversal is not allowed");
    }
    const top = normalized.split("/")[0];
    if (!WORLD_SCOPES.includes(top)) {
        throw new Error(`path must start with one of: ${WORLD_SCOPES.join(", ")}`);
    }
    return normalized;
}
export function normalizeWorldRelativePath(rawPath) {
    return normalizePath(rawPath);
}
export function resolveWorldAbsolutePath(worldRoot, worldRelativePath) {
    const normalized = normalizeWorldRelativePath(worldRelativePath);
    const root = path.resolve(worldRoot);
    const absolute = path.resolve(root, ...normalized.split("/"));
    if (absolute !== root && !absolute.startsWith(root + path.sep)) {
        throw new Error("resolved path escapes world root");
    }
    return absolute;
}
function decodeContent(content, ext) {
    if (ext === ".yaml" || ext === ".yml") {
        return { kind: "yaml", parsed: YAML.parse(content) };
    }
    if (ext === ".json") {
        return { kind: "json", parsed: JSON.parse(content) };
    }
    return { kind: "markdown", parsed: { text: content } };
}
function relativeFromWorld(worldRoot, absolutePath) {
    return toPosixPath(path.relative(path.resolve(worldRoot), absolutePath));
}
async function readFileWithCap(absolutePath, maxReadBytes) {
    const buf = await fs.readFile(absolutePath);
    const size = buf.byteLength;
    if (size <= maxReadBytes) {
        return { text: buf.toString("utf8"), size, truncated: false };
    }
    return {
        text: buf.subarray(0, maxReadBytes).toString("utf8"),
        size,
        truncated: true,
    };
}
async function listFilesRecursive(rootDir, maxFiles) {
    const queue = [rootDir];
    const out = [];
    while (queue.length > 0 && out.length < maxFiles) {
        const current = queue.shift();
        try {
            const entries = await fs.readdir(current, { withFileTypes: true, encoding: "utf8" });
            for (const entry of entries) {
                if (out.length >= maxFiles) {
                    break;
                }
                const absolute = path.join(current, entry.name);
                if (entry.isDirectory()) {
                    queue.push(absolute);
                    continue;
                }
                if (!entry.isFile()) {
                    continue;
                }
                if (!READABLE_EXTENSIONS.has(extLower(absolute))) {
                    continue;
                }
                out.push(absolute);
            }
        }
        catch {
            continue;
        }
    }
    return out;
}
function collectViewSlices(node, mode, pointer, out) {
    if (node === null || node === undefined) {
        return;
    }
    if (Array.isArray(node)) {
        node.forEach((entry, idx) => collectViewSlices(entry, mode, `${pointer}/${idx}`, out));
        return;
    }
    if (typeof node !== "object") {
        return;
    }
    const obj = node;
    const views = toObject(obj.knowledge_views);
    if (Object.hasOwn(views, mode)) {
        out.push({ sourcePath: `${pointer}/knowledge_views/${mode}` || "/", value: views[mode] });
    }
    if (Object.hasOwn(obj, mode)) {
        out.push({ sourcePath: `${pointer}/${mode}` || "/", value: obj[mode] });
    }
    for (const [key, value] of Object.entries(obj)) {
        collectViewSlices(value, mode, `${pointer}/${key}`, out);
    }
}
function extractView(parsed, viewMode) {
    if (viewMode === "raw") {
        return parsed;
    }
    const slices = [];
    collectViewSlices(parsed, viewMode, "", slices);
    if (slices.length === 0) {
        return null;
    }
    if (slices.length === 1) {
        return slices[0];
    }
    return slices;
}
function collectEntityMatches(node, targetIds, pointer, out) {
    if (node === null || node === undefined) {
        return;
    }
    if (Array.isArray(node)) {
        node.forEach((entry, idx) => collectEntityMatches(entry, targetIds, `${pointer}/${idx}`, out));
        return;
    }
    if (typeof node !== "object") {
        return;
    }
    const obj = node;
    const id = typeof obj.id === "string" ? obj.id.trim() : "";
    if (id && targetIds.has(id)) {
        out.push({ id, jsonPointer: pointer || "/", value: sanitize(obj) });
    }
    for (const [key, value] of Object.entries(obj)) {
        collectEntityMatches(value, targetIds, `${pointer}/${key}`, out);
    }
}
async function resolveStoreQueryFiles(params) {
    const maxFiles = Math.min(params.input.maxFiles ?? params.cfg.maxFilesPerQuery, params.cfg.maxFilesPerQuery);
    if (Array.isArray(params.input.paths) && params.input.paths.length > 0) {
        const out = new Set();
        for (const rawPath of params.input.paths) {
            if (typeof rawPath !== "string" || !rawPath.trim()) {
                continue;
            }
            const normalized = normalizeWorldRelativePath(rawPath);
            const absolute = resolveWorldAbsolutePath(params.worldRoot, normalized);
            let stat;
            try {
                stat = await fs.stat(absolute);
            }
            catch {
                continue;
            }
            if (stat.isDirectory()) {
                const listed = await listFilesRecursive(absolute, maxFiles - out.size);
                for (const filePath of listed) {
                    if (out.size >= maxFiles) {
                        break;
                    }
                    out.add(filePath);
                }
            }
            else if (stat.isFile() && READABLE_EXTENSIONS.has(extLower(absolute))) {
                out.add(absolute);
            }
            if (out.size >= maxFiles) {
                break;
            }
        }
        return Array.from(out).slice(0, maxFiles);
    }
    const scopes = params.input.scope && params.input.scope !== "all"
        ? [params.input.scope]
        : Array.from(WORLD_SCOPES);
    const out = [];
    for (const scope of scopes) {
        if (out.length >= maxFiles) {
            break;
        }
        const scopeDir = resolveWorldAbsolutePath(params.worldRoot, scope);
        const listed = await listFilesRecursive(scopeDir, maxFiles - out.length);
        out.push(...listed);
    }
    return out.slice(0, maxFiles);
}
export async function runStoreGet(params) {
    const viewMode = params.input.viewMode === "truth" ||
        params.input.viewMode === "player_known" ||
        params.input.viewMode === "public_rumor" ||
        params.input.viewMode === "npc_beliefs"
        ? params.input.viewMode
        : "raw";
    const files = await resolveStoreQueryFiles({
        worldRoot: params.worldRoot,
        cfg: params.cfg,
        input: params.input,
    });
    const entityIds = toStringList(params.input.entityIds);
    const entitySet = new Set(entityIds);
    const results = [];
    for (const absolutePath of files) {
        const relativePath = relativeFromWorld(params.worldRoot, absolutePath);
        const loaded = await readFileWithCap(absolutePath, params.cfg.maxReadBytes);
        const base = {
            path: relativePath,
            bytes: loaded.size,
            truncated: loaded.truncated,
            sha256: hashSha256(loaded.text),
        };
        if (loaded.truncated) {
            base.error = `file exceeds maxReadBytes (${params.cfg.maxReadBytes})`;
            results.push(base);
            continue;
        }
        let decoded;
        try {
            decoded = decodeContent(loaded.text, extLower(absolutePath));
        }
        catch (error) {
            base.error = error instanceof Error ? error.message : String(error);
            results.push(base);
            continue;
        }
        base.kind = decoded.kind;
        if (entitySet.size > 0 && decoded.kind !== "markdown") {
            const matches = [];
            collectEntityMatches(decoded.parsed, entitySet, "", matches);
            if (matches.length === 0) {
                continue;
            }
            base.entityMatches = matches;
        }
        const viewed = extractView(decoded.parsed, viewMode);
        base.viewMode = viewMode;
        base.data = sanitize(viewed);
        if (params.input.includeRaw === true && decoded.kind !== "markdown") {
            base.raw = sanitize(decoded.parsed);
        }
        results.push(base);
    }
    return {
        ok: true,
        worldRoot: path.resolve(params.worldRoot),
        query: {
            scope: params.input.scope ?? "all",
            viewMode,
            entityIds,
            requestedPaths: toStringList(params.input.paths),
        },
        files: results,
        stats: {
            requestedFileCount: files.length,
            returnedFileCount: results.length,
        },
    };
}
export async function loadStructuredWorldFile(worldRoot, worldRelativePath, options) {
    const absolutePath = resolveWorldAbsolutePath(worldRoot, worldRelativePath);
    const ext = extLower(absolutePath);
    if (!STRUCTURED_EXTENSIONS.has(ext)) {
        throw new Error(`structured patch files must end with .yaml, .yml, or .json: ${worldRelativePath}`);
    }
    let stat;
    try {
        stat = await fs.stat(absolutePath);
    }
    catch {
        if (options.allowMissing) {
            const sourceText = "{}\n";
            return {
                exists: false,
                format: ext === ".json" ? "json" : "yaml",
                sourceText,
                parsed: {},
                sha256: hashSha256(sourceText),
            };
        }
        throw new Error(`file not found: ${worldRelativePath}`);
    }
    if (!stat.isFile()) {
        throw new Error(`target is not a file: ${worldRelativePath}`);
    }
    const loaded = await readFileWithCap(absolutePath, options.maxReadBytes);
    if (loaded.truncated) {
        throw new Error(`file exceeds maxReadBytes (${options.maxReadBytes}): ${worldRelativePath}`);
    }
    try {
        const parsed = ext === ".json" ? JSON.parse(loaded.text) : YAML.parse(loaded.text);
        return {
            exists: true,
            format: ext === ".json" ? "json" : "yaml",
            sourceText: loaded.text,
            parsed,
            sha256: hashSha256(loaded.text),
        };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`failed to parse ${worldRelativePath}: ${message}`);
    }
}
export function renderStructuredContent(format, parsed) {
    if (format === "json") {
        return `${JSON.stringify(parsed, null, 2)}\n`;
    }
    return `${YAML.stringify(parsed)}`;
}
export function supportsStructuredPatchPath(worldRelativePath) {
    return STRUCTURED_EXTENSIONS.has(extLower(worldRelativePath));
}
function tensionFromLevel(level) {
    if (level === "high") {
        return 78;
    }
    if (level === "medium") {
        return 56;
    }
    if (level === "low") {
        return 38;
    }
    return 45;
}
function pacingAdjustment(value) {
    switch (value) {
        case "escalate":
            return 10;
        case "slow-burn":
            return -8;
        case "cooldown":
            return -12;
        default:
            return 0;
    }
}
export async function runHooksQuery(params) {
    const unresolved = await loadStructuredWorldFile(params.worldRoot, "state/unresolved-hooks.yaml", {
        allowMissing: true,
        maxReadBytes: params.cfg.maxReadBytes,
    });
    const dormant = await loadStructuredWorldFile(params.worldRoot, "secrets/dormant-reveals.yaml", {
        allowMissing: true,
        maxReadBytes: params.cfg.maxReadBytes,
    });
    const unresolvedHooks = Array.isArray(toObject(unresolved.parsed).hooks)
        ? toObject(unresolved.parsed).hooks
        : [];
    const dormantReveals = Array.isArray(toObject(dormant.parsed).dormant_reveals)
        ? toObject(dormant.parsed).dormant_reveals
        : [];
    const actorIds = toStringList(params.input.actorIds);
    const sceneTags = toStringList(params.input.currentSceneTags).map((tag) => tag.toLowerCase());
    const revealBudget = typeof params.input.revealBudget === "number" && Number.isFinite(params.input.revealBudget)
        ? Math.max(0, Math.trunc(params.input.revealBudget))
        : 1;
    const adjust = pacingAdjustment(params.input.pacingTarget);
    const candidates = [];
    for (const rawHook of unresolvedHooks) {
        const hook = toObject(rawHook);
        const id = typeof hook.id === "string" ? hook.id : "unknown-hook";
        const title = typeof hook.title === "string" ? hook.title : id;
        const prerequisites = toStringList(hook.prerequisites);
        const seededClues = toStringList(toObject(hook.foreshadowing).seeded_clues);
        const satisfiedPrereq = prerequisites.filter((item) => /^(done|ok|met):/i.test(item)).length;
        const missingPrereq = Math.max(prerequisites.length - satisfiedPrereq, 0);
        const owner = typeof hook.owner === "string" ? hook.owner : "";
        const actorMatches = actorIds.filter((actorId) => owner.includes(actorId));
        const textPool = `${title} ${String(hook.next_payoff_candidate ?? "")}`.toLowerCase();
        const tagMatches = sceneTags.filter((tag) => textPool.includes(tag));
        const tensionScore = Math.max(0, Math.min(100, tensionFromLevel(hook.tension_level) + adjust + tagMatches.length * 3));
        candidates.push({
            candidateId: id,
            type: "unresolved-hook",
            title,
            sourcePath: "state/unresolved-hooks.yaml",
            prerequisiteStatus: {
                total: prerequisites.length,
                satisfied: satisfiedPrereq,
                missing: missingPrereq,
                details: prerequisites,
            },
            foreshadowStatus: {
                satisfied: seededClues.length > 0,
                clueCount: seededClues.length,
            },
            tensionScore,
            readiness: missingPrereq > 0
                ? "blocked-by-prerequisite"
                : tensionScore >= 60
                    ? "ready-for-main-review"
                    : "hold",
            matchedActors: actorMatches,
            matchedSceneTags: tagMatches,
        });
    }
    for (const rawReveal of dormantReveals) {
        const reveal = toObject(rawReveal);
        const id = typeof reveal.id === "string" ? reveal.id : "unknown-reveal";
        const title = typeof reveal.title === "string" ? reveal.title : id;
        const prereq = toObject(reveal.prerequisites);
        const required = toStringList(prereq.required);
        const prereqSatisfied = prereq.are_satisfied === true;
        const foreshadow = toObject(reveal.foreshadow);
        const clues = toStringList(foreshadow.required_clues);
        const foreshadowSatisfied = foreshadow.is_satisfied === true;
        const causality = toObject(reveal.causality);
        const causalityValidated = causality.is_validated === true;
        const targetScope = typeof reveal.target_scope === "string" ? reveal.target_scope : "";
        const actorMatches = actorIds.filter((actorId) => targetScope.includes(actorId));
        const textPool = `${title} ${String(reveal.activation_condition ?? "")}`.toLowerCase();
        const tagMatches = sceneTags.filter((tag) => textPool.includes(tag));
        const base = 50 + (foreshadowSatisfied ? 10 : -8) + (prereqSatisfied ? 12 : -10) + (causalityValidated ? 8 : -12);
        const tensionScore = Math.max(0, Math.min(100, base + adjust + tagMatches.length * 3));
        const budgetBlocked = revealBudget <= 0;
        const ready = foreshadowSatisfied && prereqSatisfied && causalityValidated && !budgetBlocked;
        candidates.push({
            candidateId: id,
            type: "dormant-reveal",
            title,
            sourcePath: "secrets/dormant-reveals.yaml",
            prerequisiteStatus: {
                total: required.length,
                satisfied: prereqSatisfied ? required.length : 0,
                missing: prereqSatisfied ? 0 : required.length,
                details: required,
            },
            foreshadowStatus: {
                satisfied: foreshadowSatisfied,
                clueCount: clues.length,
                clues,
            },
            causalityStatus: {
                validated: causalityValidated,
            },
            tensionScore,
            readiness: ready ? "ready-for-main-review" : budgetBlocked ? "budget-blocked" : "hold",
            revealBudgetBlocked: budgetBlocked,
            matchedActors: actorMatches,
            matchedSceneTags: tagMatches,
        });
    }
    candidates.sort((a, b) => {
        const aScore = typeof a.tensionScore === "number" ? a.tensionScore : 0;
        const bScore = typeof b.tensionScore === "number" ? b.tensionScore : 0;
        return bScore - aScore;
    });
    return {
        ok: true,
        worldRoot: path.resolve(params.worldRoot),
        query: {
            actorIds,
            currentSceneTags: sceneTags,
            pacingTarget: params.input.pacingTarget ?? "steady",
            revealBudget,
        },
        candidates,
        stats: {
            unresolvedHookCount: unresolvedHooks.length,
            dormantRevealCount: dormantReveals.length,
            candidateCount: candidates.length,
        },
    };
}

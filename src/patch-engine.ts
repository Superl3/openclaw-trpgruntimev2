import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { TrpgRuntimeConfig } from "./config.js";
import {
  loadStructuredWorldFile,
  normalizeWorldRelativePath,
  renderStructuredContent,
  resolveWorldAbsolutePath,
  supportsStructuredPatchPath,
} from "./world-store.js";

type PatchOp = "set" | "delete" | "append_list";

type PatchOperation = {
  op: PatchOp;
  file: string;
  pointer: string;
  value?: unknown;
  expectedSha256?: string;
};

type NormalizedPatch = {
  patchId: string;
  title: string;
  allowNewFiles: boolean;
  operations: PatchOperation[];
  digest: string;
};

type Conflict = {
  index: number;
  code: string;
  message: string;
  file?: string;
  pointer?: string;
};

type FileWorkingState = {
  file: string;
  format: "yaml" | "json";
  beforeExists: boolean;
  beforeSha256: string;
  beforeParsed: unknown;
  workingParsed: unknown;
};

type Simulation = {
  patch: NormalizedPatch;
  touchedFiles: string[];
  conflicts: Conflict[];
  diffPreview: Array<Record<string, unknown>>;
  fileStates: Map<string, FileWorkingState>;
};

type PatchCacheEntry = {
  patch: NormalizedPatch;
  worldRoot: string;
  agentId: string;
  validatedAt: string;
};

export type PatchCache = Map<string, PatchCacheEntry>;

export type PatchDryRunInput = {
  patchId?: string;
  title?: string;
  allowNewFiles?: boolean;
  operations?: unknown;
};

export type PatchApplyAuditGate = {
  approved?: boolean;
  approvedBy?: string;
  verdict?: string;
  conflictStatus?: string;
  canonAbsorptionVerdict?: string;
  note?: string;
};

export type PatchApplyInput = {
  validatedPatchId?: string;
  patchPayload?: PatchDryRunInput;
  audit?: PatchApplyAuditGate;
};

function toObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function deepClone<T>(value: T): T {
  return structuredClone(value);
}

function hashSha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function normalizePointer(pointer: string): string {
  const trimmed = pointer.trim();
  if (!trimmed || trimmed === "/") {
    return "/";
  }
  if (!trimmed.startsWith("/")) {
    throw new Error("pointer must start with '/'");
  }
  return trimmed;
}

function decodePointerToken(token: string): string {
  return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

function pointerSegments(pointer: string): string[] {
  const normalized = normalizePointer(pointer);
  if (normalized === "/") {
    return [];
  }
  return normalized
    .split("/")
    .slice(1)
    .map((token) => decodePointerToken(token));
}

function isObjectLike(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseArrayIndex(token: string): number | null {
  if (!/^\d+$/.test(token)) {
    return null;
  }
  const idx = Number(token);
  return Number.isInteger(idx) && idx >= 0 ? idx : null;
}

function getAtPointer(root: unknown, pointer: string): { exists: boolean; value: unknown } {
  const segments = pointerSegments(pointer);
  if (segments.length === 0) {
    return { exists: true, value: root };
  }

  let current: unknown = root;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      const idx = parseArrayIndex(segment);
      if (idx === null || idx >= current.length) {
        return { exists: false, value: undefined };
      }
      current = current[idx];
      continue;
    }

    if (isObjectLike(current)) {
      if (!Object.hasOwn(current, segment)) {
        return { exists: false, value: undefined };
      }
      current = current[segment];
      continue;
    }

    return { exists: false, value: undefined };
  }

  return { exists: true, value: current };
}

function setAtPointer(root: unknown, pointer: string, value: unknown): unknown {
  const segments = pointerSegments(pointer);
  if (segments.length === 0) {
    return value;
  }

  if (!isObjectLike(root) && !Array.isArray(root)) {
    throw new Error("root document must be object or array for pointer set");
  }

  let current: unknown = root;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const token = segments[i];
    const nextToken = segments[i + 1];

    if (Array.isArray(current)) {
      const idx = parseArrayIndex(token);
      if (idx === null) {
        throw new Error(`pointer segment '${token}' is not a valid array index`);
      }
      while (current.length <= idx) {
        current.push({});
      }
      if (!isObjectLike(current[idx]) && !Array.isArray(current[idx])) {
        current[idx] = parseArrayIndex(nextToken) === null ? {} : [];
      }
      current = current[idx];
      continue;
    }

    if (!isObjectLike(current)) {
      throw new Error(`pointer segment '${token}' cannot traverse primitive value`);
    }

    if (!Object.hasOwn(current, token) || current[token] === null || current[token] === undefined) {
      current[token] = parseArrayIndex(nextToken) === null ? {} : [];
    } else if (!isObjectLike(current[token]) && !Array.isArray(current[token])) {
      current[token] = parseArrayIndex(nextToken) === null ? {} : [];
    }
    current = current[token];
  }

  const leaf = segments[segments.length - 1];
  if (Array.isArray(current)) {
    if (leaf === "-") {
      current.push(value);
      return root;
    }
    const idx = parseArrayIndex(leaf);
    if (idx === null) {
      throw new Error(`pointer leaf '${leaf}' is not a valid array index`);
    }
    while (current.length <= idx) {
      current.push(null);
    }
    current[idx] = value;
    return root;
  }

  if (!isObjectLike(current)) {
    throw new Error("pointer leaf parent is not object/array");
  }
  current[leaf] = value;
  return root;
}

function deleteAtPointer(root: unknown, pointer: string): { changed: boolean; root: unknown } {
  const segments = pointerSegments(pointer);
  if (segments.length === 0) {
    return { changed: false, root };
  }

  let current: unknown = root;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const token = segments[i];
    if (Array.isArray(current)) {
      const idx = parseArrayIndex(token);
      if (idx === null || idx >= current.length) {
        return { changed: false, root };
      }
      current = current[idx];
      continue;
    }
    if (isObjectLike(current)) {
      if (!Object.hasOwn(current, token)) {
        return { changed: false, root };
      }
      current = current[token];
      continue;
    }
    return { changed: false, root };
  }

  const leaf = segments[segments.length - 1];
  if (Array.isArray(current)) {
    const idx = parseArrayIndex(leaf);
    if (idx === null || idx >= current.length) {
      return { changed: false, root };
    }
    current.splice(idx, 1);
    return { changed: true, root };
  }

  if (!isObjectLike(current) || !Object.hasOwn(current, leaf)) {
    return { changed: false, root };
  }
  delete current[leaf];
  return { changed: true, root };
}

function normalizePatchPayload(input: PatchDryRunInput, cfg: TrpgRuntimeConfig): NormalizedPatch {
  const raw = toObject(input);
  const operationsRaw = Array.isArray(raw.operations) ? raw.operations : [];

  if (operationsRaw.length === 0) {
    throw new Error("operations must include at least one entry");
  }
  if (operationsRaw.length > cfg.maxOperationsPerPatch) {
    throw new Error(
      `operations exceed maxOperationsPerPatch (${cfg.maxOperationsPerPatch}); received ${operationsRaw.length}`,
    );
  }

  const operations: PatchOperation[] = operationsRaw.map((entry, idx) => {
    const opObj = toObject(entry);
    const op = typeof opObj.op === "string" ? opObj.op.trim() : "";
    if (op !== "set" && op !== "delete" && op !== "append_list") {
      throw new Error(`operations[${idx}].op must be one of: set, delete, append_list`);
    }

    const file = typeof opObj.file === "string" ? normalizeWorldRelativePath(opObj.file) : "";
    if (!file) {
      throw new Error(`operations[${idx}].file is required`);
    }

    const pointerRaw = typeof opObj.pointer === "string" ? opObj.pointer : "/";
    const pointer = normalizePointer(pointerRaw);

    const expectedSha256 =
      typeof opObj.expectedSha256 === "string" && opObj.expectedSha256.trim()
        ? opObj.expectedSha256.trim()
        : undefined;

    const normalized: PatchOperation = {
      op,
      file,
      pointer,
      expectedSha256,
    };

    if ((op === "set" || op === "append_list") && !Object.hasOwn(opObj, "value")) {
      throw new Error(`operations[${idx}].value is required for op=${op}`);
    }

    if (Object.hasOwn(opObj, "value")) {
      normalized.value = opObj.value;
    }

    return normalized;
  });

  const allowNewFiles = raw.allowNewFiles === true;
  const title = typeof raw.title === "string" && raw.title.trim() ? raw.title.trim() : "TRPG patch";

  const digest = hashSha256(
    JSON.stringify({
      title,
      allowNewFiles,
      operations,
    }),
  );

  const patchId =
    typeof raw.patchId === "string" && raw.patchId.trim() ? raw.patchId.trim() : `trpg-${digest.slice(0, 12)}`;

  return {
    patchId,
    title,
    allowNewFiles,
    operations,
    digest,
  };
}

async function simulatePatch(params: {
  worldRoot: string;
  cfg: TrpgRuntimeConfig;
  patch: NormalizedPatch;
}): Promise<Simulation> {
  const conflicts: Conflict[] = [];
  const diffPreview: Array<Record<string, unknown>> = [];
  const fileStates = new Map<string, FileWorkingState>();
  const touched = new Set<string>();

  for (let i = 0; i < params.patch.operations.length; i += 1) {
    const operation = params.patch.operations[i];

    if (!supportsStructuredPatchPath(operation.file)) {
      conflicts.push({
        index: i,
        code: "unsupported_file_type",
        message: `only .yaml/.yml/.json files are patchable: ${operation.file}`,
        file: operation.file,
        pointer: operation.pointer,
      });
      continue;
    }

    let state = fileStates.get(operation.file);
    if (!state) {
      try {
        const loaded = await loadStructuredWorldFile(params.worldRoot, operation.file, {
          allowMissing: params.patch.allowNewFiles,
          maxReadBytes: params.cfg.maxReadBytes,
        });
        state = {
          file: operation.file,
          format: loaded.format,
          beforeExists: loaded.exists,
          beforeSha256: loaded.sha256,
          beforeParsed: deepClone(loaded.parsed),
          workingParsed: deepClone(loaded.parsed),
        };
        fileStates.set(operation.file, state);
      } catch (error) {
        conflicts.push({
          index: i,
          code: "file_load_failed",
          message: error instanceof Error ? error.message : String(error),
          file: operation.file,
          pointer: operation.pointer,
        });
        continue;
      }
    }

    if (operation.expectedSha256 && operation.expectedSha256 !== state.beforeSha256) {
      conflicts.push({
        index: i,
        code: "expected_sha_mismatch",
        message: `expectedSha256 mismatch for ${operation.file}`,
        file: operation.file,
        pointer: operation.pointer,
      });
      continue;
    }

    try {
      const before = getAtPointer(state.workingParsed, operation.pointer);

      if (operation.op === "set") {
        state.workingParsed = setAtPointer(state.workingParsed, operation.pointer, deepClone(operation.value));
      } else if (operation.op === "delete") {
        const deleted = deleteAtPointer(state.workingParsed, operation.pointer);
        if (!deleted.changed) {
          throw new Error(`pointer not found for delete: ${operation.pointer}`);
        }
        state.workingParsed = deleted.root;
      } else {
        const target = getAtPointer(state.workingParsed, operation.pointer);
        if (!target.exists || !Array.isArray(target.value)) {
          throw new Error(`append_list target must be an existing array: ${operation.pointer}`);
        }
        target.value.push(deepClone(operation.value));
      }

      const after = getAtPointer(state.workingParsed, operation.pointer);
      diffPreview.push({
        index: i,
        op: operation.op,
        file: operation.file,
        pointer: operation.pointer,
        before: before.exists ? before.value : "[missing]",
        after: after.exists ? after.value : "[missing]",
      });
      touched.add(operation.file);
    } catch (error) {
      conflicts.push({
        index: i,
        code: "operation_failed",
        message: error instanceof Error ? error.message : String(error),
        file: operation.file,
        pointer: operation.pointer,
      });
    }
  }

  return {
    patch: params.patch,
    touchedFiles: Array.from(touched),
    conflicts,
    diffPreview,
    fileStates,
  };
}

export function createPatchCache(): PatchCache {
  return new Map<string, PatchCacheEntry>();
}

function buildRollbackHint(simulation: Simulation): Record<string, unknown> {
  const operations = simulation.touchedFiles.map((file) => {
    const state = simulation.fileStates.get(file) as FileWorkingState;
    return {
      op: "set",
      file,
      pointer: "/",
      value: state.beforeParsed,
    };
  });

  return {
    note: "Use this payload with trpg_patch_apply.patchPayload to revert applied files.",
    patchPayload: {
      title: `Rollback for ${simulation.patch.patchId}`,
      allowNewFiles: true,
      operations,
    },
  };
}

function cloneForPreview(value: unknown): unknown {
  if (value === undefined) {
    return null;
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}

function sanitizePreview(preview: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return preview.map((entry) => ({
    ...entry,
    before: cloneForPreview(entry.before),
    after: cloneForPreview(entry.after),
  }));
}

export async function runPatchDryRun(params: {
  worldRoot: string;
  cfg: TrpgRuntimeConfig;
  agentId: string;
  cache: PatchCache;
  input: PatchDryRunInput;
}): Promise<Record<string, unknown>> {
  let patch: NormalizedPatch;
  try {
    patch = normalizePatchPayload(params.input, params.cfg);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      conflicts: [],
    };
  }

  const simulation = await simulatePatch({
    worldRoot: params.worldRoot,
    cfg: params.cfg,
    patch,
  });

  if (simulation.conflicts.length === 0) {
    params.cache.set(patch.patchId, {
      patch,
      worldRoot: path.resolve(params.worldRoot),
      agentId: params.agentId,
      validatedAt: new Date().toISOString(),
    });
  }

  return {
    ok: simulation.conflicts.length === 0,
    policy: { write: false },
    patchId: patch.patchId,
    touchedFiles: simulation.touchedFiles,
    conflicts: simulation.conflicts,
    normalizedPatchPayload: {
      patchId: patch.patchId,
      title: patch.title,
      allowNewFiles: patch.allowNewFiles,
      operations: patch.operations,
      digest: patch.digest,
    },
    normalizedDiffPreview: sanitizePreview(simulation.diffPreview),
    cacheStored: simulation.conflicts.length === 0,
  };
}

function parseAuditedApplyGate(input: PatchApplyInput):
  | { ok: true; gate: Required<Omit<PatchApplyAuditGate, "canonAbsorptionVerdict" | "note">> & Pick<PatchApplyAuditGate, "canonAbsorptionVerdict" | "note"> }
  | { ok: false; error: string } {
  const audit = toObject(input.audit);
  if (Object.keys(audit).length === 0) {
    return {
      ok: false,
      error:
        "audited apply requires audit metadata (approvedBy=canon-auditor, verdict=pass, conflictStatus=non-conflicting)",
    };
  }

  const approved = audit.approved === true;
  const approvedBy = typeof audit.approvedBy === "string" ? audit.approvedBy.trim() : "";
  const verdict = typeof audit.verdict === "string" ? audit.verdict.trim() : "";
  const conflictStatus = typeof audit.conflictStatus === "string" ? audit.conflictStatus.trim() : "";
  const canonAbsorptionVerdict =
    typeof audit.canonAbsorptionVerdict === "string" ? audit.canonAbsorptionVerdict.trim() : undefined;
  const note = typeof audit.note === "string" ? audit.note : undefined;

  if (!approved) {
    return { ok: false, error: "audit.approved must be true" };
  }
  if (approvedBy !== "canon-auditor") {
    return { ok: false, error: "audit.approvedBy must be canon-auditor" };
  }
  if (verdict !== "pass") {
    return { ok: false, error: "audit.verdict must be pass" };
  }
  if (conflictStatus !== "non-conflicting") {
    return { ok: false, error: "audit.conflictStatus must be non-conflicting" };
  }
  if (canonAbsorptionVerdict === "reject-hard-conflict") {
    return { ok: false, error: "audit.canonAbsorptionVerdict=reject-hard-conflict blocks apply" };
  }

  return {
    ok: true,
    gate: {
      approved,
      approvedBy,
      verdict,
      conflictStatus,
      canonAbsorptionVerdict,
      note,
    },
  };
}

function isAuditedWritableScope(file: string): boolean {
  return file.startsWith("state/") || file.startsWith("canon/");
}

function isCanonicalTarget(file: string): boolean {
  return file.startsWith("canon/");
}

export async function runPatchApply(params: {
  worldRoot: string;
  cfg: TrpgRuntimeConfig;
  agentId: string;
  cache: PatchCache;
  input: PatchApplyInput;
}): Promise<Record<string, unknown>> {
  const audited = parseAuditedApplyGate(params.input);
  if (!audited.ok) {
    return {
      ok: false,
      error: audited.error,
    };
  }

  const auditedApplyMode = params.cfg.allowPatchApply
    ? "audited-required-config-open"
    : "audited-required-config-closed";

  let patch: NormalizedPatch | null = null;

  if (typeof params.input.validatedPatchId === "string" && params.input.validatedPatchId.trim()) {
    const patchId = params.input.validatedPatchId.trim();
    const cached = params.cache.get(patchId);
    if (!cached) {
      return { ok: false, error: `validated patch id not found in cache: ${patchId}` };
    }
    if (cached.worldRoot !== path.resolve(params.worldRoot)) {
      return {
        ok: false,
        error: `validated patch worldRoot mismatch (expected ${cached.worldRoot}, got ${path.resolve(params.worldRoot)})`,
      };
    }
    if (cached.agentId !== params.agentId) {
      return {
        ok: false,
        error: `validated patch agent mismatch (expected ${cached.agentId}, got ${params.agentId})`,
      };
    }
    patch = cached.patch;
  } else if (params.input.patchPayload) {
    try {
      patch = normalizePatchPayload(params.input.patchPayload, params.cfg);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  if (!patch) {
    return { ok: false, error: "provide validatedPatchId or patchPayload" };
  }

  const simulation = await simulatePatch({
    worldRoot: params.worldRoot,
    cfg: params.cfg,
    patch,
  });

  if (simulation.conflicts.length > 0) {
    return {
      ok: false,
      patchId: patch.patchId,
      touchedFiles: simulation.touchedFiles,
      conflicts: simulation.conflicts,
      normalizedDiffPreview: sanitizePreview(simulation.diffPreview),
    };
  }

  const disallowedTargets = simulation.touchedFiles.filter((file) => !isAuditedWritableScope(file));
  if (disallowedTargets.length > 0) {
    return {
      ok: false,
      patchId: patch.patchId,
      error: "audited apply is limited to world/state/* and world/canon/* targets",
      disallowedTargets,
    };
  }

  const canonicalTargets = simulation.touchedFiles.filter((file) => isCanonicalTarget(file));
  if (canonicalTargets.length > 0 && !params.cfg.runtimeSafetyFlags.canonicalWriteBackEnabled) {
    return {
      ok: false,
      patchId: patch.patchId,
      error: "canonical write-back is disabled by runtime safety flag (canonicalWriteBackEnabled=false)",
      canonicalTargets,
    };
  }

  const checksums: Array<Record<string, unknown>> = [];

  for (const file of simulation.touchedFiles) {
    const state = simulation.fileStates.get(file) as FileWorkingState;
    const absolute = resolveWorldAbsolutePath(params.worldRoot, file);
    const rendered = renderStructuredContent(state.format, state.workingParsed);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, rendered, "utf8");

    const afterSha = hashSha256(rendered);
    checksums.push({
      file,
      format: state.format,
      beforeSha256: state.beforeSha256,
      afterSha256: afterSha,
      changed: state.beforeSha256 !== afterSha,
    });
  }

  return {
    ok: true,
    appliedPatchId: patch.patchId,
    appliedFiles: simulation.touchedFiles,
    auditedApply: {
      mode: auditedApplyMode,
      configAllowPatchApply: params.cfg.allowPatchApply,
      gate: audited.gate,
    },
    checksumLikeSummary: {
      digest: hashSha256(JSON.stringify(checksums)),
      files: checksums,
    },
    rollbackHint: buildRollbackHint(simulation),
  };
}

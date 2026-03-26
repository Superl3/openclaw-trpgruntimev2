import { spawn } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 15_000;

function redactSecrets(text) {
  return String(text ?? "")
    .replace(/(Bearer\s+)[A-Za-z0-9._\-]+/gi, "$1[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_\-]{10,}\b/g, "[REDACTED_API_KEY]")
    .replace(/\b(?:api[-_ ]?key|token|secret)\s*[:=]\s*[^\s,;]+/gi, "[REDACTED_CREDENTIAL]");
}

function resolveTimeoutMs(input) {
  const parsed = Number.parseInt(String(input ?? DEFAULT_TIMEOUT_MS), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}

function extractJsonObject(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) {
    throw new Error("Bridge process produced empty stdout");
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }
    throw new Error("Bridge stdout does not contain JSON object");
  }
}

function validateSelection(raw) {
  if (!raw || typeof raw !== "object") {
    throw new Error("Bridge selection must be an object");
  }
  const reason = typeof raw.reason === "string" ? raw.reason : null;
  if (raw.type === "button" && typeof raw.customId === "string" && raw.customId.length > 0) {
    return {
      type: "button",
      customId: raw.customId,
      ...(reason !== null ? { reason } : {}),
    };
  }
  if (raw.type === "modal" && typeof raw.customId === "string" && raw.customId.length > 0) {
    return {
      type: "modal",
      customId: raw.customId,
      ...(reason !== null ? { reason } : {}),
      ...(typeof raw.freeInput === "string" ? { freeInput: raw.freeInput } : {}),
    };
  }
  throw new Error("Bridge selection must match {type:'button'|'modal', customId, freeInput?}");
}

function sanitizeBridgeContext(context) {
  const visible = context?.visible && typeof context.visible === "object" ? context.visible : {};
  const buttons = Array.isArray(visible.buttons)
    ? visible.buttons
        .map((button) => ({
          customId: typeof button?.customId === "string" ? button.customId : null,
          label: typeof button?.label === "string" ? button.label : null,
          actionId: typeof button?.actionId === "string" ? button.actionId : null,
        }))
        .filter((button) => typeof button.customId === "string")
    : [];
  const modal = visible?.modal && typeof visible.modal.customId === "string" ? { customId: visible.modal.customId } : null;
  const recommendation =
    visible?.recommendation && typeof visible.recommendation.actionId === "string"
      ? { actionId: visible.recommendation.actionId }
      : null;
  const textSummary = typeof visible?.textSummary === "string" ? visible.textSummary.slice(0, 1500) : "";

  return {
    recommendation,
    buttons,
    modal,
    textSummary,
  };
}

export function createProcessBridgeDecisionLane(options = {}) {
  const command = typeof options.command === "string" ? options.command.trim() : "";
  if (!command) {
    throw new Error("createProcessBridgeDecisionLane requires options.command");
  }
  const args = Array.isArray(options.args) ? options.args.map((entry) => String(entry)) : [];
  const cwd = typeof options.cwd === "string" && options.cwd.trim() ? options.cwd : undefined;
  const env = options.env && typeof options.env === "object" ? { ...process.env, ...options.env } : process.env;
  const timeoutMs = resolveTimeoutMs(options.timeoutMs);

  return async function decisionLane(context) {
    return await new Promise((resolve, reject) => {
      let settled = false;
      let stdout = "";
      let stderr = "";

      const child = spawn(command, args, {
        cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });

      const timer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        child.kill("SIGKILL");
        reject(new Error(`Bridge process timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
      });
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });

      child.on("error", (error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        const reason = error instanceof Error ? error.message : String(error);
        reject(new Error(`Bridge process failed to start: ${reason}`));
      });

      child.on("close", (code, signal) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);

        if (code !== 0) {
          const stderrLine = redactSecrets(stderr.trim());
          const suffix = stderrLine ? ` stderr=${stderrLine.slice(0, 400)}` : "";
          reject(new Error(`Bridge process exited with code ${code}${signal ? ` signal=${signal}` : ""}${suffix}`));
          return;
        }

        try {
          const parsed = extractJsonObject(stdout);
          resolve(validateSelection(parsed));
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          reject(new Error(`Bridge process returned invalid selection JSON: ${reason}`));
        }
      });

      try {
        const publicContext = sanitizeBridgeContext(context);
        child.stdin.write(JSON.stringify({ visible: publicContext }));
        child.stdin.end();
      } catch (error) {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        const reason = error instanceof Error ? error.message : String(error);
        reject(new Error(`Bridge process stdin write failed: ${reason}`));
      }
    });
  };
}

import { createHash } from "node:crypto";

export type ToolSessionState = "NO_SESSION" | "ACTIVE" | "PAUSED" | "ENDED";
export type ToolActorScope = "player" | "gm" | "system";

export type GovernanceErrorCode =
  | "E_TOOL_NOT_REGISTERED"
  | "E_TOOL_NOT_ALLOWED_IN_STATE"
  | "E_SCOPE_DENIED"
  | "E_CONFIRMATION_REQUIRED"
  | "E_IDEMPOTENCY_KEY_REQUIRED"
  | "E_IDEMPOTENCY_CONFLICT"
  | "E_REQUEST_IN_FLIGHT"
  | "E_STATE_VERSION_REQUIRED"
  | "E_STATE_VERSION_CONFLICT"
  | "E_SESSION_NOT_FOUND"
  | "E_INTERNAL";

export type GovernanceErrorResult = {
  ok: false;
  error: string;
  errorCode: GovernanceErrorCode;
  recoveryHint?: string;
  details?: Record<string, unknown>;
};

export type GovernanceResult<TResult> = TResult | GovernanceErrorResult;

export type ToolActor = {
  id: string;
  scope: ToolActorScope;
};

export type GovernedToolRequest<TInput = unknown> = {
  toolName: string;
  requestId: string;
  actor: ToolActor;
  input: TInput;
  sessionId?: string;
  idempotencyKey?: string;
  expectedStateVersion?: number;
  confirm?: boolean;
};

export type GovernanceToolMeta = {
  mutatesState: boolean;
  requiresSessionStates: ToolSessionState[];
  allowedScopes: ToolActorScope[];
  requiresIdempotencyKey?: boolean;
  requiresExpectedStateVersion?: boolean;
  requiresConfirmation?: boolean;
};

export type IdempotencyRecord<TResult> = {
  payloadHash: string;
  status: "processing" | "done";
  response?: GovernanceResult<TResult>;
};

export interface IdempotencyStore<TResult> {
  get(params: { sessionId: string; toolName: string; key: string }): Promise<IdempotencyRecord<TResult> | null>;
  putProcessing(params: { sessionId: string; toolName: string; key: string; payloadHash: string }): Promise<void>;
  putDone(params: {
    sessionId: string;
    toolName: string;
    key: string;
    payloadHash: string;
    response: GovernanceResult<TResult>;
  }): Promise<void>;
}

export type GovernanceResolvers = {
  resolveSessionState: (sessionId: string) => Promise<ToolSessionState>;
  resolveStateVersion?: (sessionId: string) => Promise<number>;
};

export type RunGovernedToolParams<TInput, TResult> = {
  req: GovernedToolRequest<TInput>;
  meta: GovernanceToolMeta;
  resolvers: GovernanceResolvers;
  idempotencyStore?: IdempotencyStore<TResult>;
  execute: (req: GovernedToolRequest<TInput>) => Promise<TResult>;
};

function errorResult(params: {
  errorCode: GovernanceErrorCode;
  error: string;
  recoveryHint?: string;
  details?: Record<string, unknown>;
}): GovernanceErrorResult {
  return {
    ok: false,
    error: params.error,
    errorCode: params.errorCode,
    recoveryHint: params.recoveryHint,
    details: params.details,
  };
}

function stableNormalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => stableNormalize(entry));
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const normalized: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      normalized[key] = stableNormalize(record[key]);
    }
    return normalized;
  }

  return value;
}

function hashInputPayload(input: unknown): string {
  const stableJson = JSON.stringify(stableNormalize(input));
  return createHash("sha256").update(stableJson).digest("hex");
}

function requiresIdempotency(meta: GovernanceToolMeta): boolean {
  return meta.mutatesState || meta.requiresIdempotencyKey === true;
}

function isStateAllowed(meta: GovernanceToolMeta, state: ToolSessionState): boolean {
  return meta.requiresSessionStates.includes(state);
}

function canResolveWithoutSession(meta: GovernanceToolMeta): boolean {
  return meta.requiresSessionStates.includes("NO_SESSION");
}

export async function runGovernedTool<TInput, TResult>(
  params: RunGovernedToolParams<TInput, TResult>,
): Promise<GovernanceResult<TResult>> {
  const { req, meta, resolvers, execute } = params;

  if (!meta.allowedScopes.includes(req.actor.scope)) {
    return errorResult({
      errorCode: "E_SCOPE_DENIED",
      error: "현재 권한으로 호출 불가합니다.",
      recoveryHint: "권한(scope) 상향 또는 호출 변경",
      details: {
        actorScope: req.actor.scope,
        allowedScopes: meta.allowedScopes,
      },
    });
  }

  if (meta.requiresConfirmation && req.confirm !== true) {
    return errorResult({
      errorCode: "E_CONFIRMATION_REQUIRED",
      error: "확인 플래그가 필요한 작업입니다.",
      recoveryHint: "confirm=true 포함 후 재요청",
    });
  }

  let resolvedSessionState: ToolSessionState = "NO_SESSION";
  if (req.sessionId) {
    resolvedSessionState = await resolvers.resolveSessionState(req.sessionId);
  } else if (!canResolveWithoutSession(meta)) {
    return errorResult({
      errorCode: "E_SESSION_NOT_FOUND",
      error: "세션을 찾을 수 없습니다.",
      recoveryHint: "session_id 확인 또는 session_new",
      details: { toolName: req.toolName },
    });
  }

  if (!isStateAllowed(meta, resolvedSessionState)) {
    return errorResult({
      errorCode: "E_TOOL_NOT_ALLOWED_IN_STATE",
      error: "현재 세션 상태에서 호출 불가한 도구입니다.",
      recoveryHint: "허용 상태로 전이 후 재시도",
      details: {
        state: resolvedSessionState,
        allowed: meta.requiresSessionStates,
      },
    });
  }

  if (meta.requiresExpectedStateVersion) {
    if (typeof req.expectedStateVersion !== "number" || !Number.isFinite(req.expectedStateVersion)) {
      return errorResult({
        errorCode: "E_STATE_VERSION_REQUIRED",
        error: "expected_state_version이 필요합니다.",
        recoveryHint: "store_get으로 버전 조회 후 재요청",
      });
    }

    if (!req.sessionId) {
      return errorResult({
        errorCode: "E_SESSION_NOT_FOUND",
        error: "세션을 찾을 수 없습니다.",
        recoveryHint: "session_id 확인 또는 session_new",
      });
    }

    if (!resolvers.resolveStateVersion) {
      return errorResult({
        errorCode: "E_INTERNAL",
        error: "state version resolver가 구성되지 않았습니다.",
      });
    }

    const currentVersion = await resolvers.resolveStateVersion(req.sessionId);
    if (currentVersion !== req.expectedStateVersion) {
      return errorResult({
        errorCode: "E_STATE_VERSION_CONFLICT",
        error: "state_version 충돌이 발생했습니다.",
        recoveryHint: "최신 상태 재조회 후 dry_run부터 재실행",
        details: {
          expected: req.expectedStateVersion,
          current: currentVersion,
        },
      });
    }
  }

  if (!requiresIdempotency(meta)) {
    try {
      return await execute(req);
    } catch (error) {
      return errorResult({
        errorCode: "E_INTERNAL",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (!req.idempotencyKey) {
    return errorResult({
      errorCode: "E_IDEMPOTENCY_KEY_REQUIRED",
      error: "idempotency_key가 필요합니다.",
      recoveryHint: "고유 key를 포함해 재요청",
    });
  }

  if (!params.idempotencyStore) {
    return errorResult({
      errorCode: "E_INTERNAL",
      error: "idempotency store가 구성되지 않았습니다.",
    });
  }

  const scopedSessionId = req.sessionId ?? "NO_SESSION";
  const payloadHash = hashInputPayload(req.input);
  const existing = await params.idempotencyStore.get({
    sessionId: scopedSessionId,
    toolName: req.toolName,
    key: req.idempotencyKey,
  });

  if (existing) {
    if (existing.payloadHash !== payloadHash) {
      return errorResult({
        errorCode: "E_IDEMPOTENCY_CONFLICT",
        error: "같은 idempotency_key에 다른 payload가 감지되었습니다.",
        recoveryHint: "새 key 사용 또는 동일 payload로 재요청",
      });
    }

    if (existing.status === "processing") {
      return errorResult({
        errorCode: "E_REQUEST_IN_FLIGHT",
        error: "동일 요청이 처리 중입니다.",
        recoveryHint: "짧은 지연 후 동일 key로 재시도",
      });
    }

    if (existing.response) {
      return existing.response;
    }
  }

  await params.idempotencyStore.putProcessing({
    sessionId: scopedSessionId,
    toolName: req.toolName,
    key: req.idempotencyKey,
    payloadHash,
  });

  let response: GovernanceResult<TResult>;
  try {
    response = await execute(req);
  } catch (error) {
    response = errorResult({
      errorCode: "E_INTERNAL",
      error: error instanceof Error ? error.message : String(error),
    });
  }

  await params.idempotencyStore.putDone({
    sessionId: scopedSessionId,
    toolName: req.toolName,
    key: req.idempotencyKey,
    payloadHash,
    response,
  });

  return response;
}

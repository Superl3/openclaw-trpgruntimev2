export function jsonToolResult(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

export function runtimeError(params: {
  command?: string;
  errorCode: string;
  message: string;
  recoverable?: boolean;
  recoveryHint?: string;
}): Record<string, unknown> {
  return {
    ok: false,
    command: params.command,
    errorCode: params.errorCode,
    error: params.message,
    recoverable: params.recoverable ?? true,
    recoveryHint: params.recoveryHint,
  };
}

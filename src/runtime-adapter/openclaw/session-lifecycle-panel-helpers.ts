import { parsePanelCustomId } from "../../runtime-core/panel-mvp.js";
import { readBoolean, readInteger, readString } from "./session-lifecycle-local-helpers.js";

export type PanelRouteKey = {
  sessionId: string;
  uiVersion: number;
  sceneId: string;
  actionId: string;
};

export type ParsedPanelMessageCommitInput = {
  sessionId: string;
  dispatchId: string;
  clear: boolean;
  messageId: string | null;
  channelMessageRef?: string;
  uiVersion?: number;
  sceneId?: string;
};

export function resolvePanelRouteInput(input: Record<string, unknown>): PanelRouteKey {
  const customId = readString(input.customId);
  if (customId) {
    const parsed = parsePanelCustomId(customId);
    if (!parsed) {
      throw new Error("Invalid customId format. expected trpg:v1:<sessionId>:<uiVersion>:<sceneId>:<actionId>");
    }
    return parsed;
  }

  const sessionId = readString(input.sessionId);
  const uiVersion = readInteger(input.uiVersion);
  const sceneId = readString(input.sceneId);
  const actionId = readString(input.actionId);
  if (!sessionId || !sceneId || !actionId || !uiVersion || uiVersion < 1) {
    throw new Error("Route key is incomplete. Provide customId or all of sessionId/uiVersion/sceneId/actionId.");
  }

  return {
    sessionId,
    uiVersion,
    sceneId,
    actionId,
  };
}

export function parsePanelMessageCommitInput(input: Record<string, unknown>): ParsedPanelMessageCommitInput {
  const clear = readBoolean(input.clear, false);
  return {
    sessionId: readString(input.sessionId),
    dispatchId: readString(input.dispatchId),
    clear,
    messageId: clear ? null : readString(input.messageId),
    channelMessageRef: readString(input.channelMessageRef) || undefined,
    uiVersion: readInteger(input.uiVersion) ?? undefined,
    sceneId: readString(input.sceneId) || undefined,
  };
}

export function validatePanelMessageCommitInput(
  input: ParsedPanelMessageCommitInput,
): { ok: true } | { ok: false; errorCode: "invalid_request"; message: string } {
  if (!input.sessionId) {
    return {
      ok: false,
      errorCode: "invalid_request",
      message: "sessionId is required.",
    };
  }

  if (!input.clear && !input.messageId) {
    return {
      ok: false,
      errorCode: "invalid_request",
      message: "messageId is required unless clear=true.",
    };
  }

  return { ok: true };
}

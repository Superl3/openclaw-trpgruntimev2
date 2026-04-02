import { SESSION_DATA_SECTIONS } from "../../runtime-core/session-workspaces.js";

const SECTION_ITEMS_SCHEMA = {
  type: "string",
  enum: SESSION_DATA_SECTIONS,
} as const;

export const SESSION_NEW_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {
    channelKey: { type: "string" },
    ownerId: { type: "string" },
    actorId: { type: "string" },
    sceneId: { type: "string" },
    confirmReset: { type: "boolean" },
    confirmToken: { type: "string" },
    wipeMode: { type: "string", enum: ["ask", "force"] },
  },
} as const;

export const SESSION_SECTION_TOOL_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {
    sessionId: { type: "string" },
    channelKey: { type: "string" },
    actorId: { type: "string" },
    sections: { type: "array", items: SECTION_ITEMS_SCHEMA, minItems: 1 },
  },
} as const;

export const SESSION_RESUME_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {
    sessionId: { type: "string" },
    channelKey: { type: "string" },
    actorId: { type: "string" },
    forceRecreate: { type: "boolean" },
  },
} as const;

export const SESSION_END_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {
    sessionId: { type: "string" },
    channelKey: { type: "string" },
    actorId: { type: "string" },
    reason: { type: "string" },
  },
} as const;

export const SESSION_HELP_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {},
} as const;

export const SESSION_VERBOSE_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {
    sessionId: { type: "string" },
    channelKey: { type: "string" },
    actorId: { type: "string" },
    enabled: { type: "boolean" },
    tailCount: { type: "integer", minimum: 1, maximum: 12 },
  },
} as const;

export const PANEL_INTERACT_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {
    customId: { type: "string" },
    sessionId: { type: "string" },
    uiVersion: { type: "integer" },
    sceneId: { type: "string" },
    actionId: { type: "string" },
    actorId: { type: "string" },
    freeInput: { type: "string" },
    action: { type: "string" },
    speech: { type: "string" },
    tone: { type: "string" },
  },
} as const;

export const PANEL_MESSAGE_COMMIT_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {
    sessionId: { type: "string" },
    actorId: { type: "string" },
    dispatchId: { type: "string" },
    messageId: { type: "string" },
    channelMessageRef: { type: "string" },
    uiVersion: { type: "integer" },
    sceneId: { type: "string" },
    clear: { type: "boolean" },
  },
  required: ["sessionId"],
} as const;

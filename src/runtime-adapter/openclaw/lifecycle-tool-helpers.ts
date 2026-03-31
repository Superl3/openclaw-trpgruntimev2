import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/core";
import { SESSION_DATA_SECTIONS, type SessionDataSection } from "../../runtime-core/session-workspaces.js";

export type TrpgCommandHint = {
  command: string;
  tool: string;
  summary: string;
  example: string;
};

const TRPG_COMMAND_HINTS: TrpgCommandHint[] = [
  {
    command: "/trpg help",
    tool: "trpg_session_help",
    summary: "사용 가능한 TRPG 명령과 예시를 확인한다.",
    example: "/trpg help",
  },
  {
    command: "/trpg new",
    tool: "trpg_session_new",
    summary: "새 세션과 임시 워크스페이스를 시작한다. 기존 세션/임시데이터 정리 후 바로 재시작하려면 wipeMode=force를 사용한다.",
    example: "/trpg new wipeMode=force",
  },
  {
    command: "/trpg resume",
    tool: "trpg_session_resume",
    summary: "현재 채널의 활성 세션 패널을 복구/재생성한다.",
    example: "/trpg resume",
  },
  {
    command: "/trpg save",
    tool: "trpg_session_save",
    summary: "임시 워크스페이스 변경을 canonical 파일로 저장한다.",
    example: "/trpg save sections=[\"status\",\"inventory\"]",
  },
  {
    command: "/trpg load",
    tool: "trpg_session_load",
    summary: "canonical 파일 내용을 임시 워크스페이스로 다시 불러온다.",
    example: "/trpg load sections=[\"player\",\"scene\"]",
  },
  {
    command: "/trpg data-delete",
    tool: "trpg_session_data_delete",
    summary: "임시 워크스페이스의 선택 섹션만 삭제한다.",
    example: "/trpg data-delete sections=[\"scene\"]",
  },
  {
    command: "/trpg verbose",
    tool: "trpg_session_verbose",
    summary: "디버그 추적 표시를 토글한다.",
    example: "/trpg verbose enabled=true",
  },
  {
    command: "/trpg end",
    tool: "trpg_session_end",
    summary: "세션을 종료하고 패널을 마감한다.",
    example: "/trpg end",
  },
];

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function toObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function buildVisibleCommandHints() {
  return {
    title: "TRPG 명령 안내",
    dataManagementNote: "데이터 관리 명령 안내: /trpg save · /trpg load · /trpg data-delete (자세한 예시는 /trpg help)",
    commands: TRPG_COMMAND_HINTS,
  };
}

export function buildNewConfirmationActionHints(confirmToken: string) {
  return {
    yes: {
      label: "YES",
      intent: "기존 세션/임시데이터를 정리하고 /trpg new를 강행한다.",
      tool: "trpg_session_new",
      params: {
        confirmReset: true,
        confirmToken,
        wipeMode: "force",
      },
      manualExample: `/trpg new confirmReset=true confirmToken=${confirmToken} wipeMode=force`,
    },
    no: {
      label: "NO",
      intent: "리셋을 취소하고 현재 상태를 유지한다.",
      tool: "trpg_session_new",
      params: {
        confirmReset: false,
        wipeMode: "ask",
      },
      manualExample: "/trpg new confirmReset=false wipeMode=ask",
    },
  };
}

export function buildSessionStartActionComponents(sessionId: string, actorId: string) {
  return {
    type: "actions",
    title: "다음 단계",
    buttons: [
      {
        id: "trpg_resume",
        label: "▶️ 패널 시작/갱신",
        style: "secondary",
        tool: "trpg_session_resume",
        params: { sessionId, actorId },
      },
      {
        id: "trpg_verbose_on",
        label: "🧪 디버그 켜기",
        style: "secondary",
        tool: "trpg_session_verbose",
        params: { sessionId, actorId, enabled: true },
      },
      {
        id: "trpg_end",
        label: "🛑 세션 종료",
        style: "danger",
        tool: "trpg_session_end",
        params: { sessionId, actorId },
      },
    ],
  };
}

export function buildSessionResumeActionComponents(sessionId: string, actorId: string) {
  return {
    type: "actions",
    title: "세션 관리",
    buttons: [
      {
        id: "trpg_resume_refresh",
        label: "🔄 패널 새로고침",
        style: "secondary",
        tool: "trpg_session_resume",
        params: { sessionId, actorId, forceRecreate: true },
      },
      {
        id: "trpg_verbose_on",
        label: "🧪 디버그 켜기",
        style: "secondary",
        tool: "trpg_session_verbose",
        params: { sessionId, actorId, enabled: true },
      },
      {
        id: "trpg_verbose_off",
        label: "🧪 디버그 끄기",
        style: "secondary",
        tool: "trpg_session_verbose",
        params: { sessionId, actorId, enabled: false },
      },
      {
        id: "trpg_save_all",
        label: "💾 저장",
        style: "success",
        tool: "trpg_session_save",
        params: { sessionId, actorId, sections: SESSION_DATA_SECTIONS },
      },
      {
        id: "trpg_end",
        label: "🛑 세션 종료",
        style: "danger",
        tool: "trpg_session_end",
        params: { sessionId, actorId },
      },
    ],
  };
}

export function resolveChannelKey(params: Record<string, unknown>, ctx: OpenClawPluginToolContext): string {
  const fromParams = readString(params.channelKey);
  if (fromParams) {
    return fromParams;
  }

  const fromContextSession = readString(ctx.sessionId);
  if (fromContextSession) {
    return `session:${fromContextSession}`;
  }

  return "channel:unknown";
}

export function resolveActorId(params: Record<string, unknown>, ctx: OpenClawPluginToolContext): string {
  const fromParams = readString(params.actorId);
  if (fromParams) {
    return fromParams;
  }

  const fromContextUser = readString(ctx.userId);
  if (fromContextUser) {
    return fromContextUser;
  }

  const fromContextSession = readString(ctx.sessionId);
  if (fromContextSession) {
    return `session:${fromContextSession}`;
  }

  return "";
}

export function resolveOwnerId(params: Record<string, unknown>, ctx: OpenClawPluginToolContext): string {
  const ownerId = readString(params.ownerId);
  if (ownerId) {
    return ownerId;
  }
  return resolveActorId(params, ctx) || "owner:unknown";
}

export function resolveSessionContextId(
  params: Record<string, unknown>,
  ctx: OpenClawPluginToolContext,
  channelKey: string,
): string {
  const fromContext = readString(ctx.sessionId);
  if (fromContext) {
    return fromContext;
  }
  const fromParam = readString(params.sessionId);
  if (fromParam) {
    return fromParam;
  }

  return channelKey;
}

export function resolveSectionList(value: unknown): SessionDataSection[] {
  if (!Array.isArray(value) || value.length === 0) {
    return [...SESSION_DATA_SECTIONS];
  }

  const allowed = new Set<SessionDataSection>(SESSION_DATA_SECTIONS);
  const sections: SessionDataSection[] = [];
  for (const raw of value) {
    if (typeof raw !== "string") {
      continue;
    }
    if (!allowed.has(raw as SessionDataSection)) {
      continue;
    }
    const typed = raw as SessionDataSection;
    if (!sections.includes(typed)) {
      sections.push(typed);
    }
  }

  return sections.length > 0 ? sections : [...SESSION_DATA_SECTIONS];
}

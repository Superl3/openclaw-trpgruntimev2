declare module "openclaw/plugin-sdk/core" {
  export type OpenClawPluginToolContext = {
    agentId?: string;
    sessionId?: string;
    userId?: string;
    [key: string]: unknown;
  };

  export type OpenClawBeforePromptBuildEvent = {
    prompt: string;
    messages?: unknown[];
  };

  export type OpenClawBeforePromptBuildResult = {
    appendSystemContext?: string;
  };

  export interface OpenClawPluginApi {
    pluginConfig: unknown;
    resolvePath(input: string): string;
    logger: {
      info(message: string): void;
      warn(message: string): void;
      error?(message: string): void;
    };
    on(
      eventName: "before_prompt_build",
      handler: (
        event: OpenClawBeforePromptBuildEvent,
        hookCtx: OpenClawPluginToolContext,
      ) => Promise<OpenClawBeforePromptBuildResult | void> | OpenClawBeforePromptBuildResult | void,
    ): void;
    registerTool(
      factory: (ctx: OpenClawPluginToolContext) => {
        name: string;
        description: string;
        parameters: unknown;
        execute: (
          toolCallId: string,
          params: unknown,
        ) => Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown }>;
      },
      options: {
        name: string;
        optional?: boolean;
      },
    ): void;
  }
}

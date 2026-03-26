const STALE_ERROR_CODES = new Set(["route_expired", "route_consumed", "stale_ui_version", "stale_scene"]);

export class BlackboxGamerAgent {
  constructor(input) {
    this.tools = input.tools;
    this.ownerId = input.ownerId;
    this.channelKey = input.channelKey;
    this.defaultFreeInput = input.defaultFreeInput ?? "주변을 조사한다";
    this.decisionLane = typeof input.decisionLane === "function" ? input.decisionLane : null;
    this.traceLabel = typeof input.traceLabel === "string" && input.traceLabel.length > 0 ? input.traceLabel : "gamer-agent";
    this.logger = {
      info: typeof input.logger?.info === "function" ? input.logger.info.bind(input.logger) : () => {},
      warn: typeof input.logger?.warn === "function" ? input.logger.warn.bind(input.logger) : () => {},
      debug: typeof input.logger?.debug === "function" ? input.logger.debug.bind(input.logger) : () => {},
    };
    this.messageSeq = 0;
    this.latestPayload = null;
    this.turnSeq = 0;
    this.laneDisabled = false;
    this.laneDisableReason = null;
    this.laneDisabledEmitted = false;
  }

  emit(event, payload = {}, level = "info") {
    const fn = this.logger[level] || this.logger.info;
    fn({
      ts: new Date().toISOString(),
      label: this.traceLabel,
      event,
      ...payload,
    });
  }

  parseMcpToolResult(result) {
    const text = result?.content?.[0]?.text;
    if (typeof text !== "string") {
      throw new Error("Tool result must provide JSON text at content[0].text");
    }
    try {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== "object") {
        throw new Error("Tool result JSON must be an object");
      }
      return parsed;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid tool JSON payload: ${reason}`);
    }
  }

  getTool(name) {
    const tool = this.tools.get(name);
    if (!tool || typeof tool.execute !== "function") {
      throw new Error(`Required tool is missing: ${name}`);
    }
    return tool;
  }

  currentSessionId() {
    return this.latestPayload?.session?.sessionId || null;
  }

  visibleComponents(payload = this.latestPayload) {
    return payload?.panelDispatch?.components ?? null;
  }

  visibleButtons(payload = this.latestPayload) {
    const components = this.visibleComponents(payload);
    const blocks = Array.isArray(components?.blocks) ? components.blocks : [];
    const actionBlock = blocks.find((entry) => entry?.type === "actions");
    const buttons = Array.isArray(actionBlock?.buttons) ? actionBlock.buttons : [];
    return buttons.filter((entry) => !entry?.disabled && typeof (entry?.customId || entry?.custom_id) === "string");
  }

  summarizeVisibleText(components = this.visibleComponents()) {
    const lines = [];
    const blocks = Array.isArray(components?.blocks) ? components.blocks : [];
    for (const block of blocks) {
      if (typeof block?.title === "string") {
        lines.push(block.title);
      }
      if (typeof block?.label === "string") {
        lines.push(block.label);
      }
      if (typeof block?.text === "string") {
        lines.push(block.text);
      }
      const items = Array.isArray(block?.items) ? block.items : [];
      for (const item of items) {
        if (typeof item === "string") {
          lines.push(item);
        }
      }
    }
    return lines.filter(Boolean).slice(0, 10).join("\n").slice(0, 1200);
  }

  extractOriginalVisibleText(components = this.visibleComponents()) {
    const lines = [];
    const pushText = (value) => {
      if (typeof value === "string") {
        const next = value.trim();
        if (next) {
          lines.push(next);
        }
      }
    };

    const blocks = Array.isArray(components?.blocks) ? components.blocks : [];
    for (const block of blocks) {
      pushText(block?.text);
      pushText(block?.title);
      pushText(block?.label);
      const items = Array.isArray(block?.items) ? block.items : [];
      for (const item of items) {
        pushText(item);
      }
      const buttons = Array.isArray(block?.buttons) ? block.buttons : [];
      for (const button of buttons) {
        pushText(button?.label);
      }
    }

    const modal = components?.modal && typeof components.modal === "object" ? components.modal : null;
    pushText(modal?.title);
    pushText(modal?.text);
    pushText(modal?.label);
    pushText(modal?.submitLabel);

    return lines.join("\n").slice(0, 20_000);
  }

  classifyLaneError(error) {
    const reason = error instanceof Error ? error.message : String(error);
    const normalized = reason.toLowerCase();

    const has = (value) => normalized.includes(value);

    const authOrCreditError =
      has("401") ||
      has("403") ||
      has("unauthorized") ||
      has("forbidden") ||
      has("invalid api key") ||
      has("no usable credentials") ||
      has("authentication") ||
      has("auth") ||
      has("insufficient_quota") ||
      has("quota") ||
      has("credit") ||
      has("billing") ||
      has("payment");

    if (authOrCreditError) {
      return {
        event: "llm_lane_error",
        reason,
        category: "auth_or_credit",
        hardDisable: true,
      };
    }

    const schemaOrChoiceInvalid =
      has("decision json") ||
      has("no json object") ||
      has("not a visible button") ||
      has("not the visible modal route") ||
      has("required schema") ||
      has("invalid selection json") ||
      has("selection must") ||
      has("must be an object") ||
      has("does not contain json object");

    if (schemaOrChoiceInvalid) {
      return {
        event: "llm_choice_invalid",
        reason,
        category: "choice_or_schema",
        hardDisable: false,
      };
    }

    const infraError =
      has("timeout") ||
      has("http ") ||
      has("network") ||
      has("fetch") ||
      has("econn") ||
      has("enotfound") ||
      has("eai_") ||
      has("bridge process") ||
      has("failed to start") ||
      has("exited with code") ||
      has("socket") ||
      has("abort");

    if (infraError) {
      return {
        event: "llm_lane_error",
        reason,
        category: "infrastructure",
        hardDisable: false,
      };
    }

    return {
      event: "llm_lane_error",
      reason,
      category: "unknown",
      hardDisable: false,
    };
  }

  buildDeterministicSelection(options = {}) {
    const preferModal = options.preferModal === true;
    const freeInput = options.freeInput ?? this.defaultFreeInput;
    const components = this.visibleComponents();
    if (!components) {
      throw new Error("No visible components in current payload");
    }

    const buttons = this.visibleButtons();
    const recommendedActionId = components?.recommendation?.actionId;
    const recommendedButton =
      typeof recommendedActionId === "string"
        ? buttons.find((entry) => entry?.actionId === recommendedActionId)
        : null;
    const firstEnabledButton = buttons[0] ?? null;
    const modalSubmitCustomId = components?.modal?.submitCustomId || components?.modal?.submit_custom_id || null;

    if (preferModal && typeof modalSubmitCustomId === "string") {
      return {
        type: "modal",
        customId: modalSubmitCustomId,
        freeInput,
      };
    }

    const selectedButton = recommendedButton || firstEnabledButton;
    if (selectedButton) {
      return {
        type: "button",
        customId: selectedButton.customId || selectedButton.custom_id,
        actionId: selectedButton.actionId || null,
        label: selectedButton.label || null,
      };
    }

    if (typeof modalSubmitCustomId === "string") {
      return {
        type: "modal",
        customId: modalSubmitCustomId,
        freeInput,
      };
    }

    throw new Error("No actionable component (button/modal) is currently visible");
  }

  buildDecisionContext(options = {}) {
    const components = this.visibleComponents();
    const buttons = this.visibleButtons().map((entry) => ({
      customId: entry.customId || entry.custom_id,
      actionId: entry.actionId || null,
      label: entry.label || null,
      style: entry.style || null,
    }));
    const modalSubmitCustomId = components?.modal?.submitCustomId || components?.modal?.submit_custom_id || null;
    const recommendation = components?.recommendation?.actionId
      ? {
          actionId: components.recommendation.actionId,
        }
      : null;

    return {
      visible: {
        recommendation,
        buttons,
        modal: typeof modalSubmitCustomId === "string" ? { customId: modalSubmitCustomId } : null,
        originalText: this.extractOriginalVisibleText(components),
        textSummary: this.summarizeVisibleText(components),
      },
      metadata: {
        traceLabel: this.traceLabel,
        preferModal: options.preferModal === true,
      },
    };
  }

  validateDecisionSelection(rawSelection, options = {}) {
    if (!rawSelection || typeof rawSelection !== "object") {
      return null;
    }
    const buttons = this.visibleButtons();
    const modalSubmitCustomId =
      this.latestPayload?.panelDispatch?.components?.modal?.submitCustomId ||
      this.latestPayload?.panelDispatch?.components?.modal?.submit_custom_id ||
      null;
    const freeInput = options.freeInput ?? this.defaultFreeInput;
    const reason = typeof rawSelection?.reason === "string" && rawSelection.reason.trim() ? rawSelection.reason.trim() : null;
    const modalRequired = options.preferModal === true && typeof modalSubmitCustomId === "string";

    if (modalRequired && rawSelection.type === "button") {
      throw new Error("Decision selection button is not the visible modal route");
    }

    if (rawSelection.type === "button" && typeof rawSelection.customId === "string") {
      const matched = buttons.find((entry) => (entry.customId || entry.custom_id) === rawSelection.customId);
      if (!matched) {
        return null;
      }
      return {
        type: "button",
        customId: matched.customId || matched.custom_id,
        actionId: matched.actionId || null,
        label: matched.label || null,
        ...(reason ? { reason } : {}),
      };
    }

    if (rawSelection.type === "modal" && typeof rawSelection.customId === "string") {
      if (rawSelection.customId !== modalSubmitCustomId) {
        return null;
      }
      return {
        type: "modal",
        customId: rawSelection.customId,
        ...(reason ? { reason } : {}),
        freeInput: typeof rawSelection.freeInput === "string" ? rawSelection.freeInput : freeInput,
      };
    }

    return null;
  }

  pickNextAction(options = {}) {
    const deterministicSelection = this.buildDeterministicSelection(options);
    const decisionContext = this.buildDecisionContext(options);
    this.emit("action_candidates", {
      recommendation: decisionContext.visible.recommendation,
      buttonCount: decisionContext.visible.buttons.length,
      hasModal: Boolean(decisionContext.visible.modal),
      deterministicSelection,
    }, "debug");

    if (!this.decisionLane) {
      return deterministicSelection;
    }

    if (this.laneDisabled) {
      this.emit("llm_lane_skipped", {
        reason: this.laneDisableReason || "lane_disabled",
      }, "warn");
      this.emit("llm_choice_fallback", { selection: deterministicSelection }, "info");
      return deterministicSelection;
    }

    const resolveDecision = async () => {
      try {
        const laneSelection = await this.decisionLane(decisionContext);
        const validatedSelection = this.validateDecisionSelection(laneSelection, options);
        if (validatedSelection) {
          this.emit("llm_choice_valid", { selection: validatedSelection }, "info");
          return validatedSelection;
        }
        this.emit("llm_choice_invalid", { laneSelection }, "warn");
      } catch (error) {
        const classified = this.classifyLaneError(error);
        if (classified.event === "llm_choice_invalid") {
          this.emit("llm_choice_invalid", { error: classified.reason }, "warn");
        } else {
          this.emit("llm_lane_error", {
            error: classified.reason,
            category: classified.category,
            hardDisable: classified.hardDisable,
          }, "warn");
          if (classified.hardDisable) {
            this.laneDisabled = true;
            this.laneDisableReason = classified.reason;
            if (!this.laneDisabledEmitted) {
              this.emit("llm_lane_disabled", {
                reason: classified.reason,
                category: classified.category,
              }, "warn");
              this.laneDisabledEmitted = true;
            }
          }
        }
      }
      this.emit("llm_choice_fallback", { selection: deterministicSelection }, "info");
      return deterministicSelection;
    };

    return resolveDecision();
  }

  async startSession() {
    this.emit("session_start", {
      ownerId: this.ownerId,
      channelKey: this.channelKey,
    }, "info");
    const newTool = this.getTool("trpg_session_new");
    const payload = this.parseMcpToolResult(
      await newTool.execute("blackbox-start", {
        channelKey: this.channelKey,
        ownerId: this.ownerId,
      }),
    );
    this.latestPayload = payload;
    this.emit("session_ready", {
      ok: payload?.ok === true,
      sessionId: payload?.session?.sessionId || null,
      uiVersion: payload?.session?.uiVersion || null,
    }, "info");
    return payload;
  }

  async interact(selection) {
    this.emit("interact_request", {
      type: selection?.type || null,
      customId: selection?.customId || null,
      ...(typeof selection?.reason === "string" ? { reason: selection.reason } : {}),
      ...(selection?.type === "modal" ? { freeInput: selection?.freeInput ?? this.defaultFreeInput } : {}),
    }, "debug");
    const interactTool = this.getTool("trpg_panel_interact");
    const payload = this.parseMcpToolResult(
      await interactTool.execute("blackbox-interact", {
        customId: selection.customId,
        actorId: this.ownerId,
        ...(selection.type === "modal" ? { freeInput: selection.freeInput ?? this.defaultFreeInput } : {}),
      }),
    );
    if (payload?.ok === true) {
      this.latestPayload = payload;
    }
    this.emit("interact_result", {
      ok: payload?.ok === true,
      errorCode: payload?.errorCode || null,
    }, "debug");
    return payload;
  }

  async commitDispatch(messageId) {
    const commitTool = this.getTool("trpg_panel_message_commit");
    const sessionId = this.currentSessionId();
    if (!sessionId) {
      throw new Error("Session must be started before commitDispatch");
    }

    const template = this.latestPayload?.panelCommitTemplate?.params;
    const generatedMessageId = messageId || `msg-blackbox-${++this.messageSeq}`;
    const params = {
      sessionId,
      actorId: this.ownerId,
      dispatchId: template?.dispatchId ?? this.latestPayload?.panelDispatch?.dispatchId,
      uiVersion: template?.uiVersion ?? this.latestPayload?.session?.uiVersion,
      sceneId: template?.sceneId ?? this.latestPayload?.session?.sceneId,
      messageId: generatedMessageId,
    };
    this.emit("commit_request", {
      messageId: generatedMessageId,
      sessionId,
      dispatchId: params.dispatchId || null,
    }, "debug");
    const payload = this.parseMcpToolResult(await commitTool.execute("blackbox-commit", params));
    this.emit("commit_result", {
      ok: payload?.ok === true,
      errorCode: payload?.errorCode || null,
      messageId: generatedMessageId,
    }, "debug");
    return payload;
  }

  async recoverFromStaleOrExpiredRoute(errorPayload) {
    if (!STALE_ERROR_CODES.has(errorPayload?.errorCode)) {
      throw new Error(`Cannot recover from non-stale errorCode: ${errorPayload?.errorCode || "unknown"}`);
    }
    const resumeTool = this.getTool("trpg_session_resume");
    const sessionId = this.currentSessionId();
    if (!sessionId) {
      throw new Error("Cannot recover without a known sessionId");
    }
    this.emit("stale_recover_attempt", {
      sessionId,
      errorCode: errorPayload?.errorCode || null,
    }, "warn");
    const payload = this.parseMcpToolResult(
      await resumeTool.execute("blackbox-resume", {
        sessionId,
        actorId: this.ownerId,
      }),
    );
    this.latestPayload = payload;
    this.emit("stale_recover_result", {
      ok: payload?.ok === true,
      sessionId: payload?.session?.sessionId || sessionId,
    }, "warn");
    return payload;
  }

  async playTurn(options = {}) {
    const turnIndex = ++this.turnSeq;
    this.emit("turn_begin", { turn: turnIndex }, "info");
    const receivedPayload = this.latestPayload;
    const selection = await this.pickNextAction(options);
    let result = await this.interact(selection);
    let recovered = false;

    if (result?.ok === false && options.autoRecover !== false && STALE_ERROR_CODES.has(result?.errorCode)) {
      recovered = true;
      await this.recoverFromStaleOrExpiredRoute(result);
      const retrySelection = await this.pickNextAction(options);
      result = await this.interact(retrySelection);
      this.emit("turn_end", {
        turn: turnIndex,
        recovered,
        ok: result?.ok === true,
        selectionType: retrySelection?.type || null,
      }, "info");
      this.emit("turn_transcript", {
        turn: turnIndex,
        received: {
          sessionId: receivedPayload?.session?.sessionId || null,
          uiVersion: receivedPayload?.session?.uiVersion || null,
          sceneId: receivedPayload?.session?.sceneId || null,
          originalText: this.extractOriginalVisibleText(receivedPayload?.panelDispatch?.components ?? null),
          textSummary: this.summarizeVisibleText(receivedPayload?.panelDispatch?.components ?? null),
        },
        sent: {
          type: retrySelection?.type || null,
          customId: retrySelection?.customId || null,
          actionId: retrySelection?.actionId || null,
          label: retrySelection?.label || null,
          ...(typeof retrySelection?.reason === "string" ? { reason: retrySelection.reason } : {}),
          ...(retrySelection?.type === "modal" ? { freeInput: retrySelection?.freeInput ?? this.defaultFreeInput } : {}),
        },
        response: {
          ok: result?.ok === true,
          errorCode: result?.errorCode || null,
        },
        recovered,
      }, "info");
      return {
        selection: retrySelection,
        result,
      };
    }

    this.emit("turn_end", {
      turn: turnIndex,
      recovered,
      ok: result?.ok === true,
      selectionType: selection?.type || null,
    }, "info");
    this.emit("turn_transcript", {
      turn: turnIndex,
      received: {
        sessionId: receivedPayload?.session?.sessionId || null,
        uiVersion: receivedPayload?.session?.uiVersion || null,
        sceneId: receivedPayload?.session?.sceneId || null,
        originalText: this.extractOriginalVisibleText(receivedPayload?.panelDispatch?.components ?? null),
        textSummary: this.summarizeVisibleText(receivedPayload?.panelDispatch?.components ?? null),
      },
      sent: {
        type: selection?.type || null,
        customId: selection?.customId || null,
        actionId: selection?.actionId || null,
        label: selection?.label || null,
        ...(typeof selection?.reason === "string" ? { reason: selection.reason } : {}),
        ...(selection?.type === "modal" ? { freeInput: selection?.freeInput ?? this.defaultFreeInput } : {}),
      },
      response: {
        ok: result?.ok === true,
        errorCode: result?.errorCode || null,
      },
      recovered,
    }, "info");

    return {
      selection,
      result,
    };
  }
}

export function isStaleInteractionError(payload) {
  return STALE_ERROR_CODES.has(payload?.errorCode);
}

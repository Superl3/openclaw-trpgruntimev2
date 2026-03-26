import assert from "node:assert/strict";
import test from "node:test";
import {
  extractAssistantTextFromOpenClawJson,
  normalizeBridgeSelection,
  parseDecisionKvText,
} from "../helpers/openclaw-agent-runtime-decision-lane.mjs";

test("parseDecisionKvText parses strict KV output", () => {
  const parsed = parseDecisionKvText([
    "SELECTION_TYPE=button",
    "CHOICE_VALUE=route:advance",
    "FREE_INPUT=",
    "REASON=추천 루트를 따른다",
    "CONFIDENCE=0.81",
  ].join("\n"));

  assert.equal(parsed.selectionType, "button");
  assert.equal(parsed.choiceValue, "route:advance");
  assert.equal(parsed.freeInput, "");
});

test("extractAssistantTextFromOpenClawJson reads assistant payload content", () => {
  const payload = {
    payload: {
      messages: [
        { role: "system", content: "ignore" },
        {
          role: "assistant",
          message: {
            content: [
              {
                type: "text",
                text: "SELECTION_TYPE=modal\nCHOICE_VALUE=route:modal\nFREE_INPUT=강행 돌파\nREASON=실행\nCONFIDENCE=0.7",
              },
            ],
          },
        },
      ],
    },
  };

  const assistantText = extractAssistantTextFromOpenClawJson(payload);
  assert.match(assistantText, /SELECTION_TYPE=modal/);
  assert.match(assistantText, /CHOICE_VALUE=route:modal/);
});

test("normalizeBridgeSelection validates visible customId", () => {
  const promptContext = {
    buttons: [{ customId: "route:a" }, { customId: "route:b" }],
    modal: { customId: "route:modal" },
  };

  const buttonSelection = normalizeBridgeSelection(
    {
      selectionType: "button",
      choiceValue: "route:b",
      freeInput: "",
    },
    promptContext,
  );
  assert.deepEqual(buttonSelection, { type: "button", customId: "route:b" });

  const modalSelection = normalizeBridgeSelection(
    {
      selectionType: "modal",
      choiceValue: "route:modal",
      freeInput: "입력 텍스트",
    },
    promptContext,
  );
  assert.deepEqual(modalSelection, { type: "modal", customId: "route:modal", freeInput: "입력 텍스트" });

  assert.throws(
    () => normalizeBridgeSelection({ selectionType: "button", choiceValue: "route:missing" }, promptContext),
    /not a visible button/i,
  );
  assert.throws(
    () => normalizeBridgeSelection({ selectionType: "select", choiceValue: "opt:1" }, promptContext),
    /does not support selection type 'select'/i,
  );
});

import { LLM_CONTRACT_VERSION, emptyDriftAxisVector, } from "./llm-contracts.js";
function normalizeSignals(value) {
    return value
        .split(/\s+/g)
        .map((token) => token.trim().toLowerCase())
        .filter(Boolean)
        .slice(0, 6);
}
export class NoopIntentAnalyzer {
    async analyze(input) {
        const normalizedText = input.text.trim();
        const candidateActions = input.context.availableActions.slice(0, 3).map((actionId, index) => ({
            actionId,
            score: index === 0 ? 0.55 : 0.35 - index * 0.1,
        }));
        return {
            contractVersion: LLM_CONTRACT_VERSION,
            intent: normalizedText ? "action" : "unknown",
            confidence: normalizedText ? 0.4 : 0,
            normalizedText,
            extractedSignals: normalizeSignals(normalizedText),
            candidateActions,
            riskSignals: [],
            preResolvedClaim: false,
        };
    }
}
export class NoopPersonaDriftAnalyzer {
    async analyze(input) {
        const source = input.recentFreeInputs.join(" ").trim();
        return {
            contractVersion: LLM_CONTRACT_VERSION,
            confidence: source ? 0.35 : 0,
            driftDelta: emptyDriftAxisVector(),
            dominantSignals: normalizeSignals(source),
            notes: source ? ["checkpoint0-noop-persona-drift"] : ["checkpoint0-noop-persona-stable"],
        };
    }
}
export class NoopSceneRenderer {
    async render(input) {
        return {
            contractVersion: LLM_CONTRACT_VERSION,
            narration: `Checkpoint 0 placeholder scene render for ${input.sceneId}.`,
            panelHints: {
                fixed: "Session panel is managed by deterministic state.",
                main: "Main panel placeholder.",
                sub: "Sub panel placeholder.",
            },
            optionalActionHints: [],
        };
    }
}
export class NoopQuestHookTextRenderer {
    async render(_input) {
        return {
            contractVersion: LLM_CONTRACT_VERSION,
            overrides: [],
        };
    }
}

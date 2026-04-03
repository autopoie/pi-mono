export const MOM_DISPLAY_CONTROL_CUSTOM_TYPE = "mom-display-control";

export interface ToolResultDisplayInstruction {
	target: "tool_result";
	toolCallId: string;
	hideDefault?: boolean;
	resultText?: string;
	threadText?: string;
}

export interface UsageSummaryDisplayInstruction {
	target: "usage_summary";
	hideDefault?: boolean;
	threadText?: string;
}

export type MomDisplayInstruction = ToolResultDisplayInstruction | UsageSummaryDisplayInstruction;

export interface MomDisplayState {
	toolResults: Map<string, ToolResultDisplayInstruction>;
	usageSummary?: UsageSummaryDisplayInstruction;
}

export interface UsageSummarySlackRender {
	threadMessages: string[];
}

const INVALID_FIELD = Symbol("invalid_display_control_field");

type OptionalField<T> = T | undefined | typeof INVALID_FIELD;

export function createMomDisplayState(): MomDisplayState {
	return {
		toolResults: new Map<string, ToolResultDisplayInstruction>(),
	};
}

export function tryParseMomDisplayInstruction(details: unknown): MomDisplayInstruction | undefined {
	if (!isRecord(details) || typeof details.target !== "string") {
		return undefined;
	}

	switch (details.target) {
		case "tool_result":
			return parseToolResultInstruction(details);
		case "usage_summary":
			return parseUsageSummaryInstruction(details);
		default:
			return undefined;
	}
}

export function applyMomDisplayInstruction(state: MomDisplayState, instruction: MomDisplayInstruction): void {
	if (instruction.target === "tool_result") {
		state.toolResults.set(instruction.toolCallId, instruction);
		return;
	}

	state.usageSummary = instruction;
}

export function resolveToolResultDisplay(
	state: MomDisplayState,
	toolCallId: string,
): ToolResultDisplayInstruction | undefined {
	const instruction = state.toolResults.get(toolCallId);
	if (!instruction) {
		return undefined;
	}

	state.toolResults.delete(toolCallId);
	return instruction;
}

export function resolveUsageSummaryDisplay(state: MomDisplayState): UsageSummaryDisplayInstruction | undefined {
	const instruction = state.usageSummary;
	state.usageSummary = undefined;
	return instruction;
}

export function resolveUsageSummarySlackRender(state: MomDisplayState, summary: string): UsageSummarySlackRender {
	const instruction = resolveUsageSummaryDisplay(state);
	if (!instruction) {
		return { threadMessages: [summary] };
	}

	if (instruction.hideDefault === true) {
		return {
			threadMessages: instruction.threadText ? [instruction.threadText] : [],
		};
	}

	return {
		threadMessages: instruction.threadText ? [summary, instruction.threadText] : [summary],
	};
}

function parseToolResultInstruction(details: Record<string, unknown>): ToolResultDisplayInstruction | undefined {
	const toolCallId = typeof details.toolCallId === "string" ? details.toolCallId.trim() : "";
	if (!toolCallId) {
		return undefined;
	}

	const hideDefault = readOptionalBoolean(details, "hideDefault");
	const resultText = readOptionalString(details, "resultText");
	const threadText = readOptionalString(details, "threadText");
	if (hideDefault === INVALID_FIELD || resultText === INVALID_FIELD || threadText === INVALID_FIELD) {
		return undefined;
	}
	if (hideDefault === true && typeof resultText === "string") {
		return undefined;
	}

	return {
		target: "tool_result",
		toolCallId,
		...(hideDefault === undefined ? {} : { hideDefault }),
		...(resultText === undefined ? {} : { resultText }),
		...(threadText === undefined ? {} : { threadText }),
	};
}

function parseUsageSummaryInstruction(details: Record<string, unknown>): UsageSummaryDisplayInstruction | undefined {
	const hideDefault = readOptionalBoolean(details, "hideDefault");
	const threadText = readOptionalString(details, "threadText");
	if (hideDefault === INVALID_FIELD || threadText === INVALID_FIELD) {
		return undefined;
	}

	return {
		target: "usage_summary",
		...(hideDefault === undefined ? {} : { hideDefault }),
		...(threadText === undefined ? {} : { threadText }),
	};
}

function readOptionalBoolean(details: Record<string, unknown>, key: string): OptionalField<boolean> {
	if (!(key in details)) {
		return undefined;
	}

	return typeof details[key] === "boolean" ? details[key] : INVALID_FIELD;
}

function readOptionalString(details: Record<string, unknown>, key: string): OptionalField<string> {
	if (!(key in details)) {
		return undefined;
	}

	return typeof details[key] === "string" ? details[key] : INVALID_FIELD;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

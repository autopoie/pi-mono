import type { Model } from "@mariozechner/pi-ai";
import type { AgentSession } from "@mariozechner/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { resolveToolResultSlackRender } from "../src/agent.js";
import {
	applyMomDisplayInstruction,
	createMomDisplayState,
	MOM_DISPLAY_CONTROL_CUSTOM_TYPE,
	resolveToolResultDisplay,
	resolveUsageSummarySlackRender,
	tryParseMomDisplayInstruction,
} from "../src/display-control.js";
import { createMomExtensionBridge } from "../src/extensions.js";

interface RuntimeMessage {
	customType: string;
	content: unknown;
	display?: boolean;
	details?: unknown;
}

interface FakeRuntime {
	sendMessage: (
		message: RuntimeMessage,
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	) => void;
	setModel: (model: Model<"openai">) => Promise<boolean>;
}

interface FakeRunner {
	runtime: FakeRuntime;
	createContext: () => Record<string, unknown>;
	hasHandlers: (eventName: string) => boolean;
	emitInput: () => Promise<{ action: "continue" }>;
	emit: () => Promise<void>;
}

function createBridgeHarness() {
	const delegatedMessages: RuntimeMessage[] = [];
	const originalSendMessage = vi.fn((message: RuntimeMessage) => {
		delegatedMessages.push(message);
	});
	const fakeRuntime: FakeRuntime = {
		sendMessage: originalSendMessage,
		setModel: vi.fn(async () => false),
	};
	const fakeRunner: FakeRunner = {
		runtime: fakeRuntime,
		createContext: () => ({}),
		hasHandlers: () => false,
		emitInput: async () => ({ action: "continue" }),
		emit: async () => {},
	};
	const session = { extensionRunner: fakeRunner } as unknown as AgentSession;
	const currentModelRef = {
		current: { provider: "openai", id: "gpt-test" } as unknown as Model<"openai">,
	};

	return {
		bridge: createMomExtensionBridge(session, currentModelRef),
		delegatedMessages,
		originalSendMessage,
		fakeRuntime,
	};
}

describe("mom display control", () => {
	it("parses and consumes tool-result display overrides without mutating canonical text", () => {
		const instruction = tryParseMomDisplayInstruction({
			target: "tool_result",
			toolCallId: "tool-1",
			resultText: "[REDACTED]",
			threadText: "sanitized follow-up",
		});
		expect(instruction).toEqual({
			target: "tool_result",
			toolCallId: "tool-1",
			resultText: "[REDACTED]",
			threadText: "sanitized follow-up",
		});

		const state = createMomDisplayState();
		applyMomDisplayInstruction(state, instruction!);
		const canonicalResultText = "SECRET_TEST_VALUE";

		const render = resolveToolResultSlackRender({
			displayState: state,
			toolCallId: "tool-1",
			toolName: "read",
			isError: false,
			label: "Read file",
			argsText: "secret.txt",
			durationMs: 1200,
			resultText: canonicalResultText,
		});

		expect(canonicalResultText).toBe("SECRET_TEST_VALUE");
		expect(render.threadMessages[0]).toContain("[REDACTED]");
		expect(render.threadMessages[0]).not.toContain("SECRET_TEST_VALUE");
		expect(render.threadMessages[1]).toBe("sanitized follow-up");
		expect(resolveToolResultDisplay(state, "tool-1")).toBeUndefined();
	});

	it("rejects invalid payloads and conflicting hideDefault plus resultText instructions", () => {
		expect(tryParseMomDisplayInstruction(null)).toBeUndefined();
		expect(
			tryParseMomDisplayInstruction({
				target: "tool_result",
				toolCallId: "tool-1",
				hideDefault: true,
				resultText: "[REDACTED]",
			}),
		).toBeUndefined();
		expect(
			tryParseMomDisplayInstruction({
				target: "usage_summary",
				threadText: 42,
			}),
		).toBeUndefined();
	});

	it("renders usage summaries with append and replace semantics", () => {
		const appendState = createMomDisplayState();
		applyMomDisplayInstruction(appendState, {
			target: "usage_summary",
			threadText: "extra summary note",
		});
		expect(resolveUsageSummarySlackRender(appendState, "default summary")).toEqual({
			threadMessages: ["default summary", "extra summary note"],
		});

		const replaceState = createMomDisplayState();
		applyMomDisplayInstruction(replaceState, {
			target: "usage_summary",
			hideDefault: true,
			threadText: "replacement summary",
		});
		expect(resolveUsageSummarySlackRender(replaceState, "default summary")).toEqual({
			threadMessages: ["replacement summary"],
		});
	});

	it("consumes mom-display-control in the bridge before tool-result render planning", () => {
		const { bridge, delegatedMessages, fakeRuntime, originalSendMessage } = createBridgeHarness();
		const state = createMomDisplayState();
		bridge.setDisplayState(state);

		fakeRuntime.sendMessage({
			customType: MOM_DISPLAY_CONTROL_CUSTOM_TYPE,
			content: "ignored",
			details: {
				target: "tool_result",
				toolCallId: "tool-1",
				hideDefault: true,
				threadText: "replacement thread",
			},
		});

		expect(originalSendMessage).not.toHaveBeenCalled();
		expect(delegatedMessages).toEqual([]);

		const render = resolveToolResultSlackRender({
			displayState: state,
			toolCallId: "tool-1",
			toolName: "read",
			isError: true,
			argsText: "secret.txt",
			durationMs: 900,
			resultText: "SECRET_TEST_VALUE",
		});

		expect(render.threadMessages).toEqual(["replacement thread"]);
		expect(render.mainErrorText).toBeUndefined();
	});

	it("drops invalid mom-display-control messages instead of delegating them upstream", () => {
		const { bridge, delegatedMessages, fakeRuntime, originalSendMessage } = createBridgeHarness();
		bridge.setDisplayState(createMomDisplayState());

		fakeRuntime.sendMessage({
			customType: MOM_DISPLAY_CONTROL_CUSTOM_TYPE,
			content: "ignored",
			details: { target: "tool_result" },
		});

		expect(originalSendMessage).not.toHaveBeenCalled();
		expect(delegatedMessages).toEqual([]);
	});

	it("keeps mom-direct-response rendering and upstream delegation intact", async () => {
		const { bridge, delegatedMessages, fakeRuntime, originalSendMessage } = createBridgeHarness();
		const publishFinal = vi.fn(async () => {});
		const respondInThread = vi.fn(async () => {});

		bridge.setSlackCallbacks({
			clearThinking: vi.fn(),
			markCustomResponseHandled: vi.fn(),
			publishFinal,
			respond: vi.fn(async () => {}),
			respondInThread,
		});

		fakeRuntime.sendMessage({
			customType: "mom-direct-response",
			content: {
				mainText: "direct response ok",
				threadText: "thread response ok",
			},
			display: false,
		} as RuntimeMessage);
		await bridge.flushPendingSlackEffects();

		expect(publishFinal).toHaveBeenCalledWith("direct response ok", true);
		expect(respondInThread).toHaveBeenCalledWith("thread response ok");
		expect(originalSendMessage).toHaveBeenCalledTimes(1);
		expect(delegatedMessages).toHaveLength(1);
	});
});

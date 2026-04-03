import type { AssistantMessage, ToolResultMessage, Usage } from "@mariozechner/pi-ai";
import type { SessionEntry, SessionMessageEntry } from "@mariozechner/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { buildHistoryAccessPromptSection, buildPromptInput } from "../src/agent.js";
import {
	enqueueAssistantProgressMessages,
	refreshSessionBaseSystemPrompt,
	refreshSessionBaseSystemPromptForRun,
	scrubPersistedResponsesReplayMetadata,
	shortCircuitHandledPreflight,
} from "../src/agent-internals.js";
import type { ThreadRootMessage } from "../src/context.js";
import { resolveConversationScope } from "../src/conversation-scope.js";
import type { SlackContext } from "../src/slack.js";
import {
	MAIN_OVERFLOW_NOTE,
	MAX_MAIN_MESSAGE_LENGTH,
	MAX_THREAD_MESSAGE_LENGTH,
	publishSplitFinalSlackReply,
} from "../src/slack-message-utils.js";

function createUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
		},
	};
}

function createAssistantEntry(
	id: string,
	message: AssistantMessage,
	parentId: string | null = null,
): SessionMessageEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-04-02T16:00:00.000Z",
		message,
	};
}

function createToolResultEntry(id: string, message: ToolResultMessage, parentId: string): SessionMessageEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-04-02T16:00:01.000Z",
		message,
	};
}

describe("mom agent regressions", () => {
	it("refreshes the canonical base prompt used for extension-enabled turns", () => {
		const session = {
			_baseSystemPrompt: "stale prompt",
			_rebuildSystemPrompt: vi.fn().mockReturnValue("fresh canonical prompt"),
			getActiveToolNames: vi.fn().mockReturnValue(["bash", "read"]),
			agent: {
				state: {
					systemPrompt: "stale prompt",
				},
			},
		} as any;

		refreshSessionBaseSystemPrompt(session);

		expect(session._rebuildSystemPrompt).toHaveBeenCalledWith(["bash", "read"]);
		expect(session._baseSystemPrompt).toBe("fresh canonical prompt");
		expect(session.agent.state.systemPrompt).toBe("fresh canonical prompt");
	});

	it("returns a fatal initialization result when the AgentSession seam drifts", () => {
		expect(refreshSessionBaseSystemPromptForRun({})).toEqual({
			stopReason: "error",
			errorMessage: "Unsupported @mariozechner/pi-coding-agent AgentSession shape for mom system-prompt refresh",
			fatalInitializationError: true,
		});
	});

	it("uses a scoped history file and thread-specific guidance for mention-thread older history", () => {
		const promptSection = buildHistoryAccessPromptSection({
			conversationScope: resolveConversationScope({
				type: "mention",
				channel: "C123",
				ts: "1000.1",
				threadTs: "1000.1",
			}),
			channelPath: "/workspace/C123",
			sessionPath: "/workspace/C123/sessions/1000.1",
			historyAccess: {
				historyFile: "/workspace/C123/sessions/1000.1/history.jsonl",
				mode: "thread-history",
			},
			isDocker: true,
		});

		expect(promptSection).toContain("Slack thread rooted at `1000.1`");
		expect(promptSection).toContain("/workspace/C123/sessions/1000.1/history.jsonl");
		expect(promptSection).toContain("Do not inspect `/workspace/C123/log.jsonl` unless the user explicitly asks");
		expect(promptSection).toContain("Do not use the read tool on whole history files");
		expect(promptSection).not.toContain("tail -30 /workspace/C123/log.jsonl");
	});

	it("includes explicit root-thread message context in follow-up prompts", () => {
		const threadRootMessage: ThreadRootMessage = {
			ts: "1000.1",
			user: "bot",
			text: "EVENTROOT_1775235747",
			isBot: true,
		};
		const ctx: SlackContext = {
			message: {
				text: "what exact token was in the root message above? Reply with just the token.",
				rawText: "what exact token was in the root message above? Reply with just the token.",
				user: "U1",
				userName: "milo",
				channel: "C123",
				ts: "1001.1",
				threadTs: "1000.1",
				attachments: [],
			},
			channels: [],
			users: [],
			respond: async () => {},
			publishFinal: async () => {},
			replaceMessage: async () => {},
			respondInThread: async () => {},
			setTyping: async () => {},
			uploadFile: async () => {},
			setWorking: async () => {},
			deleteMessage: async () => {},
		};

		const { promptText } = buildPromptInput(ctx, "/workspace", threadRootMessage);

		expect(promptText).toContain("<slack_thread_root_message>");
		expect(promptText).toContain("When the user refers to the root message above, they mean this message.");
		expect(promptText).toContain("[bot]: EVENTROOT_1775235747");
		expect(promptText).toContain(
			"[milo]: what exact token was in the root message above? Reply with just the token.",
		);
	});

	it("falls back to filtered channel-log guidance when the scoped history file is unavailable", () => {
		const promptSection = buildHistoryAccessPromptSection({
			conversationScope: resolveConversationScope({
				type: "mention",
				channel: "C123",
				ts: "1000.1",
				threadTs: "1000.1",
			}),
			channelPath: "/workspace/C123",
			sessionPath: "/workspace/C123/sessions/1000.1",
			historyAccess: {
				historyFile: "/workspace/C123/log.jsonl",
				mode: "thread-filtered-channel-log",
			},
			isDocker: false,
		});

		expect(promptSection).toContain("query `/workspace/C123/log.jsonl` with an explicit thread filter");
		expect(promptSection).toContain('select(.threadRootTs == "1000.1")');
		expect(promptSection).not.toContain("history.jsonl");
	});

	it("scrubs persisted Responses replay metadata while preserving durable assistant metadata", () => {
		const openAiAssistantEntry = createAssistantEntry("assistant-openai", {
			role: "assistant",
			api: "openai-responses",
			provider: "openai",
			model: "gpt-5-mini",
			responseId: "resp_openai",
			usage: createUsage(),
			stopReason: "toolUse",
			timestamp: 1,
			content: [
				{ type: "thinking", thinking: "hidden reasoning", thinkingSignature: '{"id":"rs_openai"}' },
				{
					type: "text",
					text: "Need a tool",
					textSignature: '{"v":1,"id":"msg_openai","phase":"commentary"}',
				},
				{
					type: "toolCall",
					id: "call_openai|fc_openai",
					name: "read",
					arguments: { path: "README.md" },
				},
			],
		});
		const openAiToolResultEntry = createToolResultEntry(
			"tool-openai",
			{
				role: "toolResult",
				toolCallId: "call_openai|fc_openai",
				toolName: "read",
				content: [{ type: "text", text: "ok" }],
				isError: false,
				timestamp: 2,
			},
			"assistant-openai",
		);
		const codexAssistantEntry = createAssistantEntry(
			"assistant-codex",
			{
				role: "assistant",
				api: "openai-codex-responses",
				provider: "openai-codex",
				model: "gpt-5.2-codex",
				responseId: "resp_codex",
				usage: createUsage(),
				stopReason: "toolUse",
				timestamp: 3,
				content: [
					{ type: "thinking", thinking: "codex reasoning", thinkingSignature: '{"id":"rs_codex"}' },
					{ type: "text", text: "Need another tool", textSignature: "msg_codex" },
					{
						type: "toolCall",
						id: "call_codex|fc_codex",
						name: "edit",
						arguments: { path: "README.md" },
					},
				],
			},
			"tool-openai",
		);
		const codexToolResultEntry = createToolResultEntry(
			"tool-codex",
			{
				role: "toolResult",
				toolCallId: "call_codex|fc_codex",
				toolName: "edit",
				content: [{ type: "text", text: "patched" }],
				isError: false,
				timestamp: 4,
			},
			"assistant-codex",
		);
		const azureAssistantEntry = createAssistantEntry(
			"assistant-azure",
			{
				role: "assistant",
				api: "azure-openai-responses",
				provider: "azure-openai-responses",
				model: "gpt-5",
				responseId: "resp_azure",
				usage: createUsage(),
				stopReason: "toolUse",
				timestamp: 5,
				content: [
					{ type: "thinking", thinking: "keep me", thinkingSignature: '{"id":"rs_azure"}' },
					{ type: "text", text: "Azure text", textSignature: "msg_azure" },
					{
						type: "toolCall",
						id: "call_azure|fc_azure",
						name: "bash",
						arguments: { command: "pwd" },
					},
				],
			},
			"tool-codex",
		);
		const entries: SessionEntry[] = [
			openAiAssistantEntry,
			openAiToolResultEntry,
			codexAssistantEntry,
			codexToolResultEntry,
			azureAssistantEntry,
		];

		const stats = scrubPersistedResponsesReplayMetadata(entries);
		const openAiAssistant = openAiAssistantEntry.message as AssistantMessage;
		const openAiToolResult = openAiToolResultEntry.message as ToolResultMessage;
		const codexAssistant = codexAssistantEntry.message as AssistantMessage;
		const codexToolResult = codexToolResultEntry.message as ToolResultMessage;
		const azureAssistant = azureAssistantEntry.message as AssistantMessage;

		expect(stats).toEqual({
			assistantMessages: 2,
			thinkingBlocks: 2,
			toolCalls: 2,
			toolResults: 2,
		});
		expect(openAiAssistant.content[0]).toEqual({ type: "thinking", thinking: "hidden reasoning" });
		expect(openAiAssistant.content[1]).toEqual({
			type: "text",
			text: "Need a tool",
			textSignature: '{"v":1,"id":"msg_openai","phase":"commentary"}',
		});
		expect(openAiAssistant.content[2]).toEqual({
			type: "toolCall",
			id: "call_openai",
			name: "read",
			arguments: { path: "README.md" },
		});
		expect(openAiAssistant.responseId).toBe("resp_openai");
		expect(openAiToolResult.toolCallId).toBe("call_openai");
		expect(codexAssistant.content[0]).toEqual({ type: "thinking", thinking: "codex reasoning" });
		expect(codexAssistant.content[1]).toEqual({
			type: "text",
			text: "Need another tool",
			textSignature: "msg_codex",
		});
		expect(codexAssistant.content[2]).toEqual({
			type: "toolCall",
			id: "call_codex",
			name: "edit",
			arguments: { path: "README.md" },
		});
		expect(codexAssistant.responseId).toBe("resp_codex");
		expect(codexToolResult.toolCallId).toBe("call_codex");
		expect(azureAssistant.content[0]).toEqual({
			type: "thinking",
			thinking: "keep me",
			thinkingSignature: '{"id":"rs_azure"}',
		});
		expect(azureAssistant.content[2]).toEqual({
			type: "toolCall",
			id: "call_azure|fc_azure",
			name: "bash",
			arguments: { command: "pwd" },
		});
	});

	it("publishes oversized final replies with a continued-in-thread main message and thread overflow", async () => {
		const text = "a".repeat(MAX_MAIN_MESSAGE_LENGTH + MAX_THREAD_MESSAGE_LENGTH + 123);
		const mainMessages: string[] = [];
		const threadMessages: string[] = [];

		const result = await publishSplitFinalSlackReply({
			text,
			updateMainMessage: async (mainText) => {
				mainMessages.push(mainText);
			},
			postInThread: async (threadText) => {
				threadMessages.push(threadText);
			},
		});

		expect(result.mainText.endsWith(MAIN_OVERFLOW_NOTE)).toBe(true);
		expect(mainMessages).toEqual([result.mainText]);
		expect(threadMessages.length).toBe(2);
		expect(threadMessages.every((part) => part.length <= MAX_THREAD_MESSAGE_LENGTH)).toBe(true);
		expect(threadMessages.join("")).toBe(text.slice(MAX_MAIN_MESSAGE_LENGTH - MAIN_OVERFLOW_NOTE.length));
	});

	it("queues assistant thinking and text progress in the main message only", async () => {
		const mainMessages: string[] = [];
		const queueTasks: Array<Promise<void>> = [];
		const respondSpy = vi.fn(async (text: string) => {
			mainMessages.push(text);
		});
		const respondInThreadSpy = vi.fn(async () => {});
		const clearThinkingTimer = vi.fn();

		enqueueAssistantProgressMessages({
			content: [
				{ type: "thinking", thinking: "intermediate thought" },
				{ type: "text", text: "partial answer" },
			],
			hideThinkingBlock: false,
			clearThinkingTimer,
			queue: {
				enqueue(fn) {
					queueTasks.push(fn());
				},
			},
			publisher: {
				respond: respondSpy,
				respondInThread: respondInThreadSpy,
			},
		});
		await Promise.all(queueTasks);

		expect(mainMessages).toEqual(["_intermediate thought_", "partial answer"]);
		expect(clearThinkingTimer).toHaveBeenCalledTimes(2);
		expect(respondInThreadSpy).not.toHaveBeenCalled();
	});

	it("hides assistant thinking while still queuing assistant text progress in the main message", async () => {
		const mainMessages: string[] = [];
		const queueTasks: Array<Promise<void>> = [];
		const respondInThreadSpy = vi.fn(async () => {});

		enqueueAssistantProgressMessages({
			content: [
				{ type: "thinking", thinking: "hidden thought" },
				{ type: "text", text: "visible partial answer" },
			],
			hideThinkingBlock: true,
			clearThinkingTimer: vi.fn(),
			queue: {
				enqueue(fn) {
					queueTasks.push(fn());
				},
			},
			publisher: {
				respond: vi.fn(async (text: string) => {
					mainMessages.push(text);
				}),
				respondInThread: respondInThreadSpy,
			},
		});
		await Promise.all(queueTasks);

		expect(mainMessages).toEqual(["visible partial answer"]);
		expect(respondInThreadSpy).not.toHaveBeenCalled();
	});

	it("short-circuits handled input by flushing side effects and returning handled immediately", async () => {
		const flushPendingSlackEffectsSpy = vi.fn(async () => {});
		const flushQueueSpy = vi.fn(async () => {});

		const result = await shortCircuitHandledPreflight(
			{ action: "handled" },
			flushPendingSlackEffectsSpy,
			flushQueueSpy,
		);

		expect(result).toEqual({ stopReason: "handled" });
		expect(flushPendingSlackEffectsSpy).toHaveBeenCalledTimes(1);
		expect(flushQueueSpy).toHaveBeenCalledTimes(1);
	});

	it("does not short-circuit non-handled preflight results", async () => {
		const flushPendingSlackEffectsSpy = vi.fn(async () => {});
		const flushQueueSpy = vi.fn(async () => {});

		await expect(
			shortCircuitHandledPreflight({ action: "continue" }, flushPendingSlackEffectsSpy, flushQueueSpy),
		).resolves.toBeUndefined();
		expect(flushPendingSlackEffectsSpy).not.toHaveBeenCalled();
		expect(flushQueueSpy).not.toHaveBeenCalled();
	});
});

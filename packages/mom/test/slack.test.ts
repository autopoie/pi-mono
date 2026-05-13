import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as log from "../src/log.js";
import {
	ChannelQueue,
	hasPendingChannelCapacity,
	MAX_PENDING_CHANNEL_WORK,
	SlackBot,
	type SlackEvent,
} from "../src/slack.js";

async function flushQueue(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 10));
	await new Promise((resolve) => setTimeout(resolve, 10));
}

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
	vi.restoreAllMocks();
});

function createSlackBotHarness(params?: {
	handleEventImpl?: (event: SlackEvent) => Promise<void>;
	postConversationMessageImpl?: (channel: string, threadRootTs: string | undefined, text: string) => Promise<string>;
}) {
	const workingDir = mkdtempSync(join(tmpdir(), "mom-slack-bot-"));
	tempDirs.push(workingDir);
	const socketHandlers = new Map<string, (payload: { event: unknown; ack: () => void }) => void>();
	const processAttachments = vi.fn(() => []);
	const handleEvent = vi.fn(async (event: SlackEvent) => {
		await params?.handleEventImpl?.(event);
	});
	const handleStop = vi.fn(async () => {});
	const bot = new SlackBot(
		{
			handleEvent,
			handleStop,
		},
		{
			botToken: "bot-token",
			workingDir,
			store: {
				processAttachments,
			} as any,
		},
	);

	(bot as any).socketClient = {
		on: (eventName: string, handler: (payload: { event: unknown; ack: () => void }) => void) => {
			socketHandlers.set(eventName, handler);
		},
	};
	(bot as any).botUserId = "B1";
	(bot as any).startupTs = null;
	bot.postConversationMessage = vi.fn(
		params?.postConversationMessageImpl ?? (async () => "reply-ts"),
	) as typeof bot.postConversationMessage;
	(bot as any).setupEventHandlers();

	return {
		bot,
		workingDir,
		handleEvent,
		handleStop,
		processAttachments,
		appMentionHandler: socketHandlers.get("app_mention")!,
		messageHandler: socketHandlers.get("message")!,
	};
}

function readSlackHttpPayload(fileName: string): Record<string, unknown> {
	return JSON.parse(
		readFileSync(
			join(process.cwd(), "..", "..", "pi-mom-fixture", "fixtures", "slack-http", "payloads", fileName),
			"utf8",
		),
	) as Record<string, unknown>;
}

function getPayloadEvent(payload: Record<string, unknown>): Record<string, unknown> {
	const event = payload.event;
	if (typeof event !== "object" || event === null) {
		throw new Error("Fixture payload is missing event object");
	}
	return event as Record<string, unknown>;
}

function dispatchFixturePayload(bot: SlackBot, payload: Record<string, unknown>) {
	return bot.dispatchSlackCallbackEvent({
		ingress: "http",
		event: getPayloadEvent(payload),
		metadata: {
			ingress: "http",
			teamId: payload.team_id as string | undefined,
			apiAppId: payload.api_app_id as string | undefined,
			eventId: payload.event_id as string | undefined,
			eventTime: payload.event_time as number | undefined,
		},
	});
}

describe("mom Slack callback dispatch", () => {
	it("normalizes HTTP app mentions into channel mention work", async () => {
		const { bot, handleEvent, workingDir } = createSlackBotHarness();
		const result = dispatchFixturePayload(bot, readSlackHttpPayload("app-mention.json"));
		await flushQueue();

		expect(result).toMatchObject({
			action: "queued",
			slackEvent: {
				channel: "C_GROWTH",
				text: "test-direct-response",
				type: "mention",
			},
			scope: {
				key: "C_GROWTH:1714492800.000100",
				threadRootTs: "1714492800.000100",
			},
		});
		expect(handleEvent).toHaveBeenCalledTimes(1);
		expect(handleEvent.mock.calls[0][0]).toMatchObject({
			channel: "C_GROWTH",
			text: "test-direct-response",
			metadata: {
				ingress: "http",
				teamId: "T_KITE_FIXTURE",
				apiAppId: "A_KITE_SHARED_APP",
				eventId: "Ev_KITE_FIXTURE_APP_MENTION_001",
			},
		});

		const logEntry = JSON.parse(readFileSync(join(workingDir, "C_GROWTH", "log.jsonl"), "utf8"));
		expect(logEntry).toMatchObject({
			text: "test-direct-response",
			threadRootTs: "1714492800.000100",
			slack: {
				ingress: "http",
				teamId: "T_KITE_FIXTURE",
				apiAppId: "A_KITE_SHARED_APP",
				eventId: "Ev_KITE_FIXTURE_APP_MENTION_001",
			},
		});
	});

	it("normalizes HTTP DMs into DM work", async () => {
		const { bot, handleEvent } = createSlackBotHarness();
		const result = dispatchFixturePayload(bot, readSlackHttpPayload("dm-message.json"));
		await flushQueue();

		expect(result).toMatchObject({
			action: "queued",
			slackEvent: {
				channel: "D_ALICE_KITE",
				text: "test-direct-response",
				type: "dm",
			},
			scope: {
				key: "D_ALICE_KITE",
			},
		});
		expect(handleEvent).toHaveBeenCalledTimes(1);
	});

	it("logs non-DM channel messages without queuing work", async () => {
		const { bot, handleEvent, workingDir } = createSlackBotHarness();
		const result = dispatchFixturePayload(bot, readSlackHttpPayload("channel-message-log-only.json"));
		await flushQueue();

		expect(result).toMatchObject({ action: "logged", old: false, triggered: false });
		expect(handleEvent).not.toHaveBeenCalled();
		const logEntry = JSON.parse(readFileSync(join(workingDir, "C_GROWTH", "log.jsonl"), "utf8"));
		expect(logEntry).toMatchObject({
			text: "normal channel context for the log",
			threadRootTs: "1714492820.000300",
		});
	});

	it("preserves file-share metadata for attachment processing", async () => {
		const { bot, handleEvent, processAttachments } = createSlackBotHarness();
		const result = dispatchFixturePayload(bot, readSlackHttpPayload("file-share-dm.json"));
		await flushQueue();

		expect(result).toMatchObject({ action: "queued" });
		expect(processAttachments).toHaveBeenCalledWith(
			"D_ALICE_KITE",
			expect.arrayContaining([
				expect.objectContaining({
					name: "people.csv",
					mimetype: "text/csv",
					url_private_download: expect.stringContaining("files.slack.com"),
				}),
			]),
			"1714492830.000400",
		);
		expect(handleEvent.mock.calls[0][0].files?.[0]).toMatchObject({
			name: "people.csv",
			mimetype: "text/csv",
		});
	});

	it("routes stop commands through immediate stop handling", async () => {
		const { bot, handleEvent, handleStop } = createSlackBotHarness();
		const result = dispatchFixturePayload(bot, readSlackHttpPayload("stop-command.json"));
		await flushQueue();

		expect(result).toMatchObject({
			action: "stopped",
			slackEvent: { channel: "C_GROWTH", text: "stop" },
			scope: { key: "C_GROWTH:1714492800.000100", threadRootTs: "1714492800.000100" },
		});
		expect(handleStop).toHaveBeenCalledTimes(1);
		expect(handleEvent).not.toHaveBeenCalled();
	});

	it("ignores bot-originated messages without logging or queuing", async () => {
		const { bot, handleEvent, workingDir } = createSlackBotHarness();
		const result = dispatchFixturePayload(bot, readSlackHttpPayload("bot-message-ignore.json"));
		await flushQueue();

		expect(result).toMatchObject({ action: "ignored", reason: "bot_message" });
		expect(handleEvent).not.toHaveBeenCalled();
		expect(existsSync(join(workingDir, "C_GROWTH", "log.jsonl"))).toBe(false);
	});

	it("logs old messages without triggering queued work", async () => {
		const { bot, handleEvent, workingDir } = createSlackBotHarness();
		(bot as any).startupTs = "9999999999.000000";
		const result = dispatchFixturePayload(bot, readSlackHttpPayload("app-mention.json"));
		await flushQueue();

		expect(result).toMatchObject({ action: "logged", old: true, triggered: false });
		expect(handleEvent).not.toHaveBeenCalled();
		expect(readFileSync(join(workingDir, "C_GROWTH", "log.jsonl"), "utf8")).toContain("test-direct-response");
	});
});

describe("mom slack queueing", () => {
	it("runs a second mention thread after the first one finishes in the same channel", async () => {
		let releaseFirst!: () => void;
		const firstStarted = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});

		const handled: string[] = [];
		const queue = new ChannelQueue();

		queue.enqueue(async () => {
			handled.push("start:first task");
			await firstStarted;
			handled.push("end:first task");
		});
		queue.enqueue(async () => {
			handled.push("start:second task");
			handled.push("end:second task");
		});

		await flushQueue();
		expect(handled).toEqual(["start:first task"]);

		releaseFirst();
		await flushQueue();

		expect(handled).toEqual(["start:first task", "end:first task", "start:second task", "end:second task"]);
	});

	it("rejects new work when the shared pending backlog cap is reached", async () => {
		let releaseActive!: () => void;
		const activeRun = new Promise<void>((resolve) => {
			releaseActive = resolve;
		});
		const queue = new ChannelQueue();

		queue.enqueue(async () => {
			await activeRun;
		});
		for (let index = 0; index < MAX_PENDING_CHANNEL_WORK; index++) {
			queue.enqueue(async () => {}, { conversationKey: `C123:${index}` });
		}

		await flushQueue();
		expect(queue.size()).toBe(MAX_PENDING_CHANNEL_WORK);
		expect(hasPendingChannelCapacity(queue)).toBe(false);

		releaseActive();
		await flushQueue();
	});

	it("posts a queued acknowledgment only for later same-channel mention threads", async () => {
		let releaseActive!: () => void;
		const activeRun = new Promise<void>((resolve) => {
			releaseActive = resolve;
		});
		let startedCount = 0;
		const { bot, appMentionHandler } = createSlackBotHarness({
			handleEventImpl: async () => {
				startedCount += 1;
				if (startedCount === 1) {
					await activeRun;
				}
			},
		});

		const ack = vi.fn();
		appMentionHandler({ event: { text: "first", channel: "C123", user: "U1", ts: "1000.1" }, ack });
		appMentionHandler({ event: { text: "second", channel: "C123", user: "U1", ts: "2000.1" }, ack });
		await flushQueue();

		expect(bot.postConversationMessage).not.toHaveBeenCalledWith(
			"C123",
			"1000.1",
			"_Task queued. I'll respond here when your task kicks off._",
		);
		expect(bot.postConversationMessage).toHaveBeenCalledWith(
			"C123",
			"2000.1",
			"_Task queued. I'll respond here when your task kicks off._",
		);

		releaseActive();
		await flushQueue();
	});

	it("posts a queued acknowledgment in the DM root when later DM work waits behind active work", async () => {
		let releaseActive!: () => void;
		const activeRun = new Promise<void>((resolve) => {
			releaseActive = resolve;
		});
		let startedCount = 0;
		const { bot, messageHandler } = createSlackBotHarness({
			handleEventImpl: async () => {
				startedCount += 1;
				if (startedCount === 1) {
					await activeRun;
				}
			},
		});

		const ack = vi.fn();
		messageHandler({ event: { text: "first", channel: "D123", channel_type: "im", user: "U1", ts: "1000.1" }, ack });
		await flushQueue();
		expect(bot.postConversationMessage).not.toHaveBeenCalled();

		messageHandler({ event: { text: "second", channel: "D123", channel_type: "im", user: "U1", ts: "2000.1" }, ack });
		await flushQueue();

		expect(bot.postConversationMessage).toHaveBeenCalledTimes(1);
		expect(bot.postConversationMessage).toHaveBeenCalledWith(
			"D123",
			undefined,
			"_Task queued. I'll respond here when your task kicks off._",
		);

		releaseActive();
		await flushQueue();
	});

	it("posts queue-full replies in the correct mention thread target", async () => {
		let releaseActive!: () => void;
		const activeRun = new Promise<void>((resolve) => {
			releaseActive = resolve;
		});
		let startedCount = 0;
		const { bot, appMentionHandler } = createSlackBotHarness({
			handleEventImpl: async () => {
				startedCount += 1;
				if (startedCount === 1) {
					await activeRun;
				}
			},
		});

		const ack = vi.fn();
		appMentionHandler({ event: { text: "first", channel: "C123", user: "U1", ts: "1000.1" }, ack });
		for (let index = 0; index < MAX_PENDING_CHANNEL_WORK; index++) {
			appMentionHandler({
				event: { text: `queued-${index}`, channel: "C123", user: "U1", ts: `200${index}.1` },
				ack,
			});
		}
		appMentionHandler({ event: { text: "overflow", channel: "C123", user: "U1", ts: "3000.1" }, ack });

		expect(bot.postConversationMessage).toHaveBeenCalledWith(
			"C123",
			"3000.1",
			"_Busy. Queue full, try again later._",
		);

		releaseActive();
		await flushQueue();
	});

	it("posts queue-full replies in the DM root", async () => {
		let releaseActive!: () => void;
		const activeRun = new Promise<void>((resolve) => {
			releaseActive = resolve;
		});
		let startedCount = 0;
		const { bot, messageHandler } = createSlackBotHarness({
			handleEventImpl: async () => {
				startedCount += 1;
				if (startedCount === 1) {
					await activeRun;
				}
			},
		});

		const ack = vi.fn();
		messageHandler({ event: { text: "first", channel: "D123", channel_type: "im", user: "U1", ts: "1000.1" }, ack });
		for (let index = 0; index < MAX_PENDING_CHANNEL_WORK; index++) {
			messageHandler({
				event: { text: `queued-${index}`, channel: "D123", channel_type: "im", user: "U1", ts: `200${index}.1` },
				ack,
			});
		}
		messageHandler({
			event: { text: "overflow", channel: "D123", channel_type: "im", user: "U1", ts: "3000.1" },
			ack,
		});

		expect(bot.postConversationMessage).toHaveBeenCalledWith(
			"D123",
			undefined,
			"_Busy. Queue full, try again later._",
		);

		releaseActive();
		await flushQueue();
	});

	it("logs queue-full reply failures instead of leaving them unhandled", async () => {
		let releaseActive!: () => void;
		const activeRun = new Promise<void>((resolve) => {
			releaseActive = resolve;
		});
		let startedCount = 0;
		const warningSpy = vi.spyOn(log, "logWarning").mockImplementation(() => {});
		const { appMentionHandler } = createSlackBotHarness({
			handleEventImpl: async () => {
				startedCount += 1;
				if (startedCount === 1) {
					await activeRun;
				}
			},
			postConversationMessageImpl: async () => {
				throw new Error("post failed");
			},
		});

		const ack = vi.fn();
		appMentionHandler({ event: { text: "first", channel: "C123", user: "U1", ts: "1000.1" }, ack });
		for (let index = 0; index < MAX_PENDING_CHANNEL_WORK; index++) {
			appMentionHandler({
				event: { text: `queued-${index}`, channel: "C123", user: "U1", ts: `200${index}.1` },
				ack,
			});
		}
		appMentionHandler({ event: { text: "overflow", channel: "C123", user: "U1", ts: "3000.1" }, ack });
		await flushQueue();

		expect(warningSpy).toHaveBeenCalledWith("Queue full reply error", "post failed");

		releaseActive();
		await flushQueue();
	});

	it("events share the same pending cap as queued user work", async () => {
		let releaseActive!: () => void;
		const activeRun = new Promise<void>((resolve) => {
			releaseActive = resolve;
		});
		let startedCount = 0;
		const { bot, appMentionHandler } = createSlackBotHarness({
			handleEventImpl: async () => {
				startedCount += 1;
				if (startedCount === 1) {
					await activeRun;
				}
			},
		});

		const ack = vi.fn();
		appMentionHandler({ event: { text: "first", channel: "C123", user: "U1", ts: "1000.1" }, ack });
		for (let index = 0; index < MAX_PENDING_CHANNEL_WORK; index++) {
			appMentionHandler({
				event: { text: `queued-${index}`, channel: "C123", user: "U1", ts: `200${index}.1` },
				ack,
			});
		}

		expect(
			bot.enqueueEvent({
				type: "mention",
				channel: "C123",
				ts: "4000.1",
				user: "EVENT",
				text: "event work",
			}),
		).toBe(false);

		releaseActive();
		await flushQueue();
	});

	it("cancels queued work for one thread without touching the active run or other threads", async () => {
		let releaseFirst!: () => void;
		const firstStarted = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});

		const handled: string[] = [];
		const queue = new ChannelQueue();

		queue.enqueue(
			async () => {
				handled.push("start:first thread");
				await firstStarted;
				handled.push("end:first thread");
			},
			{ conversationKey: "C123:1000.1" },
		);
		queue.enqueue(
			async () => {
				handled.push("start:second thread");
				handled.push("end:second thread");
			},
			{ conversationKey: "C123:2000.1" },
		);
		queue.enqueue(
			async () => {
				handled.push("start:third thread");
				handled.push("end:third thread");
			},
			{ conversationKey: "C123:3000.1" },
		);

		await flushQueue();
		expect(handled).toEqual(["start:first thread"]);
		expect(queue.cancelPending("C123:2000.1")).toBe(1);

		releaseFirst();
		await flushQueue();

		expect(handled).toEqual(["start:first thread", "end:first thread", "start:third thread", "end:third thread"]);
	});

	it("cancels scheduled work before the deferred processor starts it", async () => {
		vi.useFakeTimers();
		try {
			const handled: string[] = [];
			const queue = new ChannelQueue();

			queue.enqueue(
				async () => {
					handled.push("start:scheduled thread");
				},
				{ conversationKey: "C123:1000.1" },
			);

			expect(queue.size()).toBe(0);
			expect(queue.hasInFlightWork()).toBe(true);
			expect(queue.cancelPending("C123:1000.1")).toBe(1);

			await vi.advanceTimersByTimeAsync(5);

			expect(handled).toEqual([]);
			expect(queue.hasInFlightWork()).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});
});

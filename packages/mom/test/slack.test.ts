import { mkdtempSync, rmSync } from "fs";
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

function flushQueue(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
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
			appToken: "app-token",
			botToken: "bot-token",
			workingDir,
			store: {
				processAttachments: () => [],
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
		handleEvent,
		handleStop,
		appMentionHandler: socketHandlers.get("app_mention")!,
		messageHandler: socketHandlers.get("message")!,
	};
}

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

		await Promise.resolve();
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

		await Promise.resolve();
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

		await Promise.resolve();
		expect(handled).toEqual(["start:first thread"]);
		expect(queue.cancelPending("C123:2000.1")).toBe(1);

		releaseFirst();
		await flushQueue();

		expect(handled).toEqual(["start:first thread", "end:first thread", "start:third thread", "end:third thread"]);
	});
});

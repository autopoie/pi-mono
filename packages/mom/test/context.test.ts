import type { UserMessage } from "@mariozechner/pi-ai";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
	inspectLegacyThreadHistoryState,
	prepareHistoryAccessTarget,
	readThreadRootMessage,
	syncLogToSessionManager,
} from "../src/context.js";
import { resolveConversationScope } from "../src/conversation-scope.js";
import { resolveLoggedThreadRootTs } from "../src/slack.js";

function getUserTexts(sessionManager: SessionManager): string[] {
	return sessionManager.buildSessionContext().messages.flatMap((message) => {
		if (message.role !== "user") {
			return [];
		}

		const content = (message as UserMessage).content;
		if (typeof content === "string") {
			return [content];
		}

		return content.filter((part) => part.type === "text").map((part) => part.text);
	});
}

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("mom context log sync", () => {
	it("syncs only matching-thread user messages into thread-scoped sessions", () => {
		const channelDir = mkdtempSync(join(tmpdir(), "mom-context-thread-"));
		tempDirs.push(channelDir);
		writeFileSync(
			join(channelDir, "log.jsonl"),
			`${[
				JSON.stringify({
					date: "2026-04-03T12:00:00.000Z",
					ts: "1000.1",
					user: "U1",
					userName: "alice",
					text: "already synced",
					attachments: [],
					isBot: false,
					threadRootTs: "1000.1",
				}),
				JSON.stringify({
					date: "2026-04-03T12:01:00.000Z",
					ts: "1001.1",
					user: "U2",
					userName: "bob",
					text: "same thread",
					attachments: [],
					isBot: false,
					threadRootTs: "1000.1",
				}),
				JSON.stringify({
					date: "2026-04-03T12:02:00.000Z",
					ts: "1002.1",
					user: "U3",
					userName: "carol",
					text: "current prompt",
					attachments: [],
					isBot: false,
					threadRootTs: "1000.1",
				}),
				JSON.stringify({
					date: "2026-04-03T12:03:00.000Z",
					ts: "2000.1",
					user: "U4",
					userName: "dave",
					text: "other thread",
					attachments: [],
					isBot: false,
					threadRootTs: "2000.1",
				}),
				JSON.stringify({
					date: "2026-04-03T12:04:00.000Z",
					ts: "3000.1",
					user: "bot",
					text: "ignored bot",
					attachments: [],
					isBot: true,
					threadRootTs: "1000.1",
				}),
			].join("\n")}
`,
		);

		const sessionManager = SessionManager.inMemory(channelDir);
		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "[alice]: already synced" }],
			timestamp: Date.parse("2026-04-03T12:00:00.000Z"),
		});

		const syncedCount = syncLogToSessionManager(
			sessionManager,
			channelDir,
			resolveConversationScope({
				type: "mention",
				channel: "C123",
				ts: "1002.1",
				threadTs: "1000.1",
			}),
			"1002.1",
		);

		expect(syncedCount).toBe(1);
		expect(getUserTexts(sessionManager)).toEqual(["[alice]: already synced", "[bob]: same thread"]);
	});

	it("normalizes non-DM channel log thread roots for live and backfilled messages", () => {
		expect(resolveLoggedThreadRootTs("C123", "1000.1")).toBe("1000.1");
		expect(resolveLoggedThreadRootTs("C123", "1001.1", "1000.1")).toBe("1000.1");
		expect(resolveLoggedThreadRootTs("D123", "1000.1")).toBeUndefined();
	});

	it("does not replay later same-thread messages into an earlier queued run", () => {
		const channelDir = mkdtempSync(join(tmpdir(), "mom-context-cutoff-"));
		tempDirs.push(channelDir);
		const sessionDir = join(channelDir, "sessions", "1000.1");
		mkdirSync(sessionDir, { recursive: true });
		writeFileSync(
			join(channelDir, "log.jsonl"),
			`${[
				JSON.stringify({
					date: "2026-04-03T12:00:00.000Z",
					ts: "1000.1",
					user: "U1",
					userName: "alice",
					text: "thread root",
					attachments: [],
					isBot: false,
					threadRootTs: "1000.1",
				}),
				JSON.stringify({
					date: "2026-04-03T12:01:00.000Z",
					ts: "1001.1",
					user: "U1",
					userName: "alice",
					text: "queued message 1",
					attachments: [],
					isBot: false,
					threadRootTs: "1000.1",
				}),
				JSON.stringify({
					date: "2026-04-03T12:02:00.000Z",
					ts: "1002.1",
					user: "U1",
					userName: "alice",
					text: "queued message 2",
					attachments: [],
					isBot: false,
					threadRootTs: "1000.1",
				}),
			].join("\n")}
`,
		);

		const sessionManager = SessionManager.inMemory(channelDir);
		const scope = resolveConversationScope({
			type: "mention",
			channel: "C123",
			ts: "1001.1",
			threadTs: "1000.1",
		});

		const syncedCount = syncLogToSessionManager(sessionManager, channelDir, scope, "1001.1", "1001.1");
		const historyTarget = prepareHistoryAccessTarget(channelDir, sessionDir, scope, "1001.1");

		expect(syncedCount).toBe(1);
		expect(getUserTexts(sessionManager)).toEqual(["[alice]: thread root"]);
		expect(readFileSync(historyTarget.historyFile, "utf-8").trim().split("\n")).toEqual([
			JSON.stringify({
				date: "2026-04-03T12:00:00.000Z",
				ts: "1000.1",
				user: "U1",
				userName: "alice",
				text: "thread root",
				attachments: [],
				isBot: false,
				threadRootTs: "1000.1",
			}),
		]);
	});

	it("keeps queued DM history cutoff to the triggering message timestamp", () => {
		const channelDir = mkdtempSync(join(tmpdir(), "mom-context-dm-cutoff-"));
		tempDirs.push(channelDir);
		writeFileSync(
			join(channelDir, "log.jsonl"),
			`${[
				JSON.stringify({
					date: "2026-04-03T12:00:00.000Z",
					ts: "1000.1",
					user: "U1",
					userName: "alice",
					text: "first dm",
					attachments: [],
					isBot: false,
				}),
				JSON.stringify({
					date: "2026-04-03T12:01:00.000Z",
					ts: "1001.1",
					user: "U1",
					userName: "alice",
					text: "queued dm 1",
					attachments: [],
					isBot: false,
				}),
				JSON.stringify({
					date: "2026-04-03T12:02:00.000Z",
					ts: "1002.1",
					user: "U1",
					userName: "alice",
					text: "queued dm 2",
					attachments: [],
					isBot: false,
				}),
			].join("\n")}
`,
		);

		const sessionManager = SessionManager.inMemory(channelDir);
		const scope = resolveConversationScope({
			type: "dm",
			channel: "D123",
			ts: "1001.1",
		});

		const syncedCount = syncLogToSessionManager(sessionManager, channelDir, scope, "1001.1", "1001.1");
		const historyTarget = prepareHistoryAccessTarget(channelDir, channelDir, scope, "1001.1");

		expect(syncedCount).toBe(1);
		expect(getUserTexts(sessionManager)).toEqual(["[alice]: first dm"]);
		expect(historyTarget).toEqual({
			historyFile: join(channelDir, "history.jsonl"),
			mode: "channel-history",
		});
		expect(readFileSync(historyTarget.historyFile, "utf-8").trim().split("\n")).toEqual([
			JSON.stringify({
				date: "2026-04-03T12:00:00.000Z",
				ts: "1000.1",
				user: "U1",
				userName: "alice",
				text: "first dm",
				attachments: [],
				isBot: false,
			}),
		]);
	});

	it("preserves cutoff metadata when falling back to raw channel log history", () => {
		const channelDir = mkdtempSync(join(tmpdir(), "mom-context-fallback-cutoff-"));
		tempDirs.push(channelDir);
		const blockedSessionPath = join(channelDir, "blocked-session");
		writeFileSync(blockedSessionPath, "not a directory\n");
		writeFileSync(
			join(channelDir, "log.jsonl"),
			`${JSON.stringify({
				date: "2026-04-03T12:00:00.000Z",
				ts: "1000.1",
				user: "U1",
				userName: "alice",
				text: "first dm",
				attachments: [],
				isBot: false,
			})}\n`,
		);

		const historyTarget = prepareHistoryAccessTarget(
			channelDir,
			blockedSessionPath,
			resolveConversationScope({
				type: "dm",
				channel: "D123",
				ts: "1001.1",
			}),
			"1001.1",
		);

		expect(historyTarget).toEqual({
			historyFile: join(channelDir, "log.jsonl"),
			mode: "channel-filtered-channel-log",
			cutoffSlackTs: "1001.1",
		});
	});

	it("includes a channel-root bot event message in derived thread history for replies to that root", () => {
		const channelDir = mkdtempSync(join(tmpdir(), "mom-history-event-root-"));
		tempDirs.push(channelDir);
		const sessionDir = join(channelDir, "sessions", "1000.1");
		mkdirSync(sessionDir, { recursive: true });
		writeFileSync(
			join(channelDir, "log.jsonl"),
			`${[
				JSON.stringify({
					date: "2026-04-03T12:00:00.000Z",
					ts: "1000.1",
					user: "bot",
					text: "scheduled reminder",
					attachments: [],
					isBot: true,
					threadRootTs: "1000.1",
				}),
				JSON.stringify({
					date: "2026-04-03T12:01:00.000Z",
					ts: "1001.1",
					user: "U1",
					userName: "alice",
					text: "@mom follow up",
					attachments: [],
					isBot: false,
					threadRootTs: "1000.1",
				}),
				JSON.stringify({
					date: "2026-04-03T12:02:00.000Z",
					ts: "2000.1",
					user: "bot",
					text: "other root message",
					attachments: [],
					isBot: true,
					threadRootTs: "2000.1",
				}),
			].join("\n")}
`,
		);

		const historyTarget = prepareHistoryAccessTarget(
			channelDir,
			sessionDir,
			resolveConversationScope({
				type: "mention",
				channel: "C123",
				ts: "1001.1",
				threadTs: "1000.1",
			}),
		);

		expect(readFileSync(historyTarget.historyFile, "utf-8").trim().split("\n")).toEqual([
			JSON.stringify({
				date: "2026-04-03T12:00:00.000Z",
				ts: "1000.1",
				user: "bot",
				text: "scheduled reminder",
				attachments: [],
				isBot: true,
				threadRootTs: "1000.1",
			}),
			JSON.stringify({
				date: "2026-04-03T12:01:00.000Z",
				ts: "1001.1",
				user: "U1",
				userName: "alice",
				text: "@mom follow up",
				attachments: [],
				isBot: false,
				threadRootTs: "1000.1",
			}),
		]);
	});

	it("reads the explicit root message for a thread follow-up", () => {
		const channelDir = mkdtempSync(join(tmpdir(), "mom-thread-root-message-"));
		tempDirs.push(channelDir);
		writeFileSync(
			join(channelDir, "log.jsonl"),
			`${[
				JSON.stringify({
					date: "2026-04-03T12:00:00.000Z",
					ts: "1000.1",
					user: "bot",
					text: "EVENTROOT_1775235747",
					attachments: [],
					isBot: true,
					threadRootTs: "1000.1",
				}),
				JSON.stringify({
					date: "2026-04-03T12:01:00.000Z",
					ts: "1001.1",
					user: "U1",
					userName: "alice",
					text: "follow-up question",
					attachments: [],
					isBot: false,
					threadRootTs: "1000.1",
				}),
			].join("\n")}
`,
		);

		expect(
			readThreadRootMessage(
				channelDir,
				resolveConversationScope({
					type: "mention",
					channel: "C123",
					ts: "1001.1",
					threadTs: "1000.1",
				}),
			),
		).toEqual({
			ts: "1000.1",
			user: "bot",
			userName: undefined,
			displayName: undefined,
			text: "EVENTROOT_1775235747",
			isBot: true,
		});
	});

	it("prefers the latest logged root-message revision for a thread follow-up", () => {
		const channelDir = mkdtempSync(join(tmpdir(), "mom-thread-root-latest-"));
		tempDirs.push(channelDir);
		writeFileSync(
			join(channelDir, "log.jsonl"),
			`${[
				JSON.stringify({
					date: "2026-04-03T12:00:00.000Z",
					ts: "1000.1",
					user: "bot",
					text: "draft root text",
					attachments: [],
					isBot: true,
					threadRootTs: "1000.1",
				}),
				JSON.stringify({
					date: "2026-04-03T12:00:01.000Z",
					ts: "1000.1",
					user: "bot",
					text: "final root text",
					attachments: [],
					isBot: true,
					threadRootTs: "1000.1",
				}),
			].join("\n")}
`,
		);

		expect(
			readThreadRootMessage(
				channelDir,
				resolveConversationScope({
					type: "mention",
					channel: "C123",
					ts: "1001.1",
					threadTs: "1000.1",
				}),
			),
		).toEqual({
			ts: "1000.1",
			user: "bot",
			userName: undefined,
			displayName: undefined,
			text: "final root text",
			isBot: true,
		});
	});

	it("writes a thread-scoped history file with only matching-thread user and bot lines", () => {
		const channelDir = mkdtempSync(join(tmpdir(), "mom-history-thread-"));
		tempDirs.push(channelDir);
		const sessionDir = join(channelDir, "sessions", "1000.1");
		mkdirSync(sessionDir, { recursive: true });
		writeFileSync(
			join(channelDir, "log.jsonl"),
			`${[
				JSON.stringify({
					date: "2026-04-03T12:00:00.000Z",
					ts: "1000.1",
					user: "U1",
					userName: "alice",
					text: "thread root",
					attachments: [],
					isBot: false,
					threadRootTs: "1000.1",
				}),
				JSON.stringify({
					date: "2026-04-03T12:00:05.000Z",
					ts: "1000.2",
					user: "bot",
					text: "thread reply",
					attachments: [],
					isBot: true,
					threadRootTs: "1000.1",
				}),
				JSON.stringify({
					date: "2026-04-03T12:01:00.000Z",
					ts: "2000.1",
					user: "U2",
					userName: "bob",
					text: "other thread",
					attachments: [],
					isBot: false,
					threadRootTs: "2000.1",
				}),
			].join("\n")}
`,
		);

		const historyTarget = prepareHistoryAccessTarget(
			channelDir,
			sessionDir,
			resolveConversationScope({
				type: "mention",
				channel: "C123",
				ts: "1000.1",
				threadTs: "1000.1",
			}),
		);

		expect(historyTarget).toEqual({
			historyFile: join(sessionDir, "history.jsonl"),
			mode: "thread-history",
		});
		expect(readFileSync(historyTarget.historyFile, "utf-8").trim().split("\n")).toEqual([
			JSON.stringify({
				date: "2026-04-03T12:00:00.000Z",
				ts: "1000.1",
				user: "U1",
				userName: "alice",
				text: "thread root",
				attachments: [],
				isBot: false,
				threadRootTs: "1000.1",
			}),
			JSON.stringify({
				date: "2026-04-03T12:00:05.000Z",
				ts: "1000.2",
				user: "bot",
				text: "thread reply",
				attachments: [],
				isBot: true,
				threadRootTs: "1000.1",
			}),
		]);
	});

	it("warns on first thread-scoped run when legacy channel history cannot be replayed safely", () => {
		const channelDir = mkdtempSync(join(tmpdir(), "mom-context-legacy-"));
		tempDirs.push(channelDir);
		const sessionDir = join(channelDir, "sessions", "1000.1");
		mkdirSync(sessionDir, { recursive: true });
		writeFileSync(join(channelDir, "context.jsonl"), '{"legacy":true}\n');
		writeFileSync(
			join(channelDir, "log.jsonl"),
			`${[
				JSON.stringify({
					date: "2026-04-03T13:00:00.000Z",
					ts: "1000.1",
					user: "U1",
					userName: "alice",
					text: "legacy thread root",
					attachments: [],
					isBot: false,
				}),
			].join("\n")}
`,
		);

		const legacyState = inspectLegacyThreadHistoryState(
			channelDir,
			sessionDir,
			resolveConversationScope({
				type: "mention",
				channel: "C123",
				ts: "1000.1",
				threadTs: "1000.1",
			}),
		);

		expect(legacyState).toEqual({
			hasLegacyChannelContext: true,
			hasLegacyThreadlessLogEntries: true,
			shouldWarn: true,
		});
	});

	it("ignores current event channel state when checking for legacy mention-thread warnings", () => {
		const channelDir = mkdtempSync(join(tmpdir(), "mom-context-event-state-"));
		tempDirs.push(channelDir);
		const sessionDir = join(channelDir, "sessions", "1000.1");
		mkdirSync(sessionDir, { recursive: true });
		writeFileSync(join(channelDir, "context.jsonl"), '{"event":true}\n');
		writeFileSync(
			join(channelDir, "log.jsonl"),
			`${[
				JSON.stringify({
					date: "2026-04-03T13:00:00.000Z",
					ts: "900.1",
					user: "bot",
					text: "event root message",
					attachments: [],
					isBot: true,
				}),
			].join("\n")}
`,
		);

		const legacyState = inspectLegacyThreadHistoryState(
			channelDir,
			sessionDir,
			resolveConversationScope({
				type: "mention",
				channel: "C123",
				ts: "1000.1",
				threadTs: "1000.1",
			}),
		);

		expect(legacyState).toEqual({
			hasLegacyChannelContext: true,
			hasLegacyThreadlessLogEntries: false,
			shouldWarn: false,
		});
	});

	it("keeps channel-scoped sessions aligned with the whole channel log", () => {
		const channelDir = mkdtempSync(join(tmpdir(), "mom-context-channel-"));
		tempDirs.push(channelDir);
		writeFileSync(
			join(channelDir, "log.jsonl"),
			`${[
				JSON.stringify({
					date: "2026-04-03T13:00:00.000Z",
					ts: "1000.1",
					user: "U1",
					userName: "alice",
					text: "channel root",
					attachments: [],
					isBot: false,
				}),
				JSON.stringify({
					date: "2026-04-03T13:01:00.000Z",
					ts: "1001.1",
					user: "U2",
					userName: "bob",
					text: "thread reply",
					attachments: [],
					isBot: false,
					threadRootTs: "1000.1",
				}),
				JSON.stringify({
					date: "2026-04-03T13:02:00.000Z",
					ts: "2000.1",
					user: "U3",
					userName: "carol",
					text: "other thread root",
					attachments: [],
					isBot: false,
					threadRootTs: "2000.1",
				}),
			].join("\n")}
`,
		);

		const sessionManager = SessionManager.inMemory(channelDir);
		const syncedCount = syncLogToSessionManager(
			sessionManager,
			channelDir,
			resolveConversationScope({
				type: "dm",
				channel: "D123",
				ts: "3000.1",
			}),
		);

		expect(syncedCount).toBe(3);
		expect(getUserTexts(sessionManager)).toEqual([
			"[alice]: channel root",
			"[bob]: thread reply",
			"[carol]: other thread root",
		]);
	});
});

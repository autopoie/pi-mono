import type { UserMessage } from "@mariozechner/pi-ai";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareHistoryAccessTarget, syncLogToSessionManager } from "../src/context.js";
import { resolveConversationScope } from "../src/conversation-scope.js";

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

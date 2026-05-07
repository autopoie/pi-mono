import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { type CustomEntry, type FileEntry, SessionManager } from "../../src/core/session-manager.js";

describe("SessionManager.saveCustomEntry", () => {
	it("saves custom entries and includes them in tree traversal", () => {
		const session = SessionManager.inMemory();

		// Save a message
		const msgId = session.appendMessage({ role: "user", content: "hello", timestamp: 1 });

		// Save a custom entry
		const customId = session.appendCustomEntry("my_data", { foo: "bar" });

		// Save another message
		const msg2Id = session.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "hi" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 2,
		});

		// Custom entry should be in entries
		const entries = session.getEntries();
		expect(entries).toHaveLength(3);

		const customEntry = entries.find((e) => e.type === "custom") as CustomEntry;
		expect(customEntry).toBeDefined();
		expect(customEntry.customType).toBe("my_data");
		expect(customEntry.data).toEqual({ foo: "bar" });
		expect(customEntry.id).toBe(customId);
		expect(customEntry.parentId).toBe(msgId);

		// Tree structure should be correct
		const path = session.getBranch();
		expect(path).toHaveLength(3);
		expect(path[0].id).toBe(msgId);
		expect(path[1].id).toBe(customId);
		expect(path[2].id).toBe(msg2Id);

		// buildSessionContext should work (custom entries skipped in messages)
		const ctx = session.buildSessionContext();
		expect(ctx.messages).toHaveLength(2); // only message entries
	});

	it("persists custom messages even when no assistant message exists yet", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "session-manager-custom-message-"));
		try {
			const session = SessionManager.create(tempDir, join(tempDir, "sessions"));
			session.appendCustomMessageEntry("persisted-custom-message", "direct response ok", false);

			const sessionFile = session.getSessionFile();
			expect(sessionFile).toBeDefined();
			expect(existsSync(sessionFile!)).toBe(true);

			const resumed = SessionManager.open(sessionFile!, join(tempDir, "sessions"));
			expect(resumed.buildSessionContext().messages).toContainEqual(
				expect.objectContaining({
					role: "custom",
					customType: "persisted-custom-message",
					content: "direct response ok",
					display: false,
				}),
			);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("does not duplicate an existing header-only session when custom messages trigger the first flush", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "session-manager-header-only-custom-message-"));
		try {
			const sessionDir = join(tempDir, "sessions");
			const session = SessionManager.create(tempDir, sessionDir);
			const sessionFile = session.getSessionFile();
			const header = session.getHeader();

			expect(sessionFile).toBeDefined();
			expect(header).not.toBeNull();
			writeFileSync(sessionFile!, `${JSON.stringify(header)}\n`);

			const reopened = SessionManager.open(sessionFile!, sessionDir);
			reopened.appendMessage({ role: "user", content: "hello", timestamp: 1 });
			reopened.appendCustomMessageEntry("persisted-custom-message", "direct response ok", false);

			const entries = readJsonl(sessionFile!);
			expect(entries.filter((entry) => entry.type === "session")).toHaveLength(1);
			expect(entries.map((entry) => entry.type)).toEqual(["session", "message", "custom_message"]);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});

function readJsonl(path: string): FileEntry[] {
	return readFileSync(path, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as FileEntry);
}

/**
 * Context management for mom.
 *
 * Mom keeps one log per channel and one persisted session per conversation scope:
 * - log.jsonl: Human-readable channel history for grep (no tool results)
 * - context.jsonl: Structured API messages for the active DM or channel thread session
 *
 * This module provides:
 * - syncLogToSessionManager: Syncs scoped messages from log.jsonl to SessionManager
 * - createMomSettingsManager: Creates a SettingsManager backed by workspace .pi/settings.json
 */

import type { UserMessage } from "@mariozechner/pi-ai";
import { type SessionManager, type SessionMessageEntry, SettingsManager } from "@mariozechner/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import type { ConversationScope } from "./conversation-scope.js";

// ============================================================================
// Sync log.jsonl to SessionManager
// ============================================================================

interface LogMessage {
	date?: string;
	ts?: string;
	user?: string;
	userName?: string;
	text?: string;
	isBot?: boolean;
	threadRootTs?: string;
}

interface ParsedLogLine {
	rawLine: string;
	message: LogMessage;
}

export interface HistoryAccessTarget {
	historyFile: string;
	mode: "channel-log" | "thread-history" | "thread-filtered-channel-log";
}

function readParsedLogLines(channelDir: string): ParsedLogLine[] {
	const logFile = join(channelDir, "log.jsonl");
	if (!existsSync(logFile)) {
		return [];
	}

	const parsedLines: ParsedLogLine[] = [];
	for (const rawLine of readFileSync(logFile, "utf-8").split("\n")) {
		if (!rawLine.trim()) {
			continue;
		}

		try {
			parsedLines.push({
				rawLine,
				message: JSON.parse(rawLine) as LogMessage,
			});
		} catch {
			// Skip malformed lines
		}
	}

	return parsedLines;
}

function isLogMessageInScope(message: LogMessage, scope: ConversationScope): boolean {
	if (scope.kind !== "thread") {
		return true;
	}

	return message.threadRootTs === scope.threadRootTs;
}

function normalizeUserContentForSync(content: string): string {
	let normalized = content.replace(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}\] /, "");
	const attachmentsIdx = normalized.indexOf("\n\n<slack_attachments>\n");
	if (attachmentsIdx !== -1) {
		normalized = normalized.substring(0, attachmentsIdx);
	}
	return normalized;
}

export function prepareHistoryAccessTarget(
	channelDir: string,
	sessionDir: string,
	scope: ConversationScope,
): HistoryAccessTarget {
	const channelLogFile = join(channelDir, "log.jsonl");
	if (scope.kind !== "thread") {
		return {
			historyFile: channelLogFile,
			mode: "channel-log",
		};
	}

	const historyFile = join(sessionDir, "history.jsonl");
	try {
		const scopedLines = readParsedLogLines(channelDir)
			.filter(({ message }) => isLogMessageInScope(message, scope))
			.map(({ rawLine }) => rawLine);
		writeFileSync(historyFile, scopedLines.length > 0 ? `${scopedLines.join("\n")}\n` : "", "utf-8");
		return {
			historyFile,
			mode: "thread-history",
		};
	} catch {
		return {
			historyFile: channelLogFile,
			mode: "thread-filtered-channel-log",
		};
	}
}

/**
 * Sync user messages from log.jsonl to SessionManager.
 *
 * This ensures that messages logged while mom wasn't running (channel chatter,
 * backfilled messages, messages while busy) are added to the LLM context.
 *
 * @param sessionManager - The SessionManager to sync to
 * @param channelDir - Path to channel directory containing log.jsonl
 * @param scope - Conversation scope that decides whether sync is channel-wide or thread-specific
 * @param excludeSlackTs - Slack timestamp of current message (will be added via prompt(), not sync)
 * @returns Number of messages synced
 */
export function syncLogToSessionManager(
	sessionManager: SessionManager,
	channelDir: string,
	scope: ConversationScope,
	excludeSlackTs?: string,
): number {
	const existingMessages = new Set<string>();
	for (const entry of sessionManager.getEntries()) {
		if (entry.type !== "message") {
			continue;
		}

		const msgEntry = entry as SessionMessageEntry;
		const msg = msgEntry.message as { role: string; content?: unknown };
		if (msg.role !== "user" || msg.content === undefined) {
			continue;
		}

		const content = msg.content;
		if (typeof content === "string") {
			existingMessages.add(normalizeUserContentForSync(content));
			continue;
		}
		if (!Array.isArray(content)) {
			continue;
		}

		for (const part of content) {
			if (typeof part === "object" && part !== null && "type" in part && part.type === "text" && "text" in part) {
				existingMessages.add(normalizeUserContentForSync((part as { type: "text"; text: string }).text));
			}
		}
	}

	const newMessages: Array<{ timestamp: number; message: UserMessage }> = [];
	for (const { message: logMsg } of readParsedLogLines(channelDir)) {
		const slackTs = logMsg.ts;
		const date = logMsg.date;
		if (!slackTs || !date) {
			continue;
		}
		if (excludeSlackTs && slackTs === excludeSlackTs) {
			continue;
		}
		if (logMsg.isBot || !isLogMessageInScope(logMsg, scope)) {
			continue;
		}

		const messageText = `[${logMsg.userName || logMsg.user || "unknown"}]: ${logMsg.text || ""}`;
		if (existingMessages.has(messageText)) {
			continue;
		}

		const msgTime = new Date(date).getTime() || Date.now();
		newMessages.push({
			timestamp: msgTime,
			message: {
				role: "user",
				content: [{ type: "text", text: messageText }],
				timestamp: msgTime,
			},
		});
		existingMessages.add(messageText);
	}

	if (newMessages.length === 0) {
		return 0;
	}

	newMessages.sort((a, b) => a.timestamp - b.timestamp);
	for (const { message } of newMessages) {
		sessionManager.appendMessage(message);
	}
	return newMessages.length;
}

// ============================================================================
// Settings manager for mom
// ============================================================================

type MomSettingsStorage = Parameters<typeof SettingsManager.fromStorage>[0];

class WorkspaceSettingsStorage implements MomSettingsStorage {
	private settingsPath: string;

	constructor(workspaceDir: string) {
		this.settingsPath = join(workspaceDir, ".pi", "settings.json");
	}

	withLock(scope: "global" | "project", fn: (current: string | undefined) => string | undefined): void {
		if (scope === "project") {
			// Mom stores all settings in a single workspace file.
			fn(undefined);
			return;
		}

		const current = existsSync(this.settingsPath) ? readFileSync(this.settingsPath, "utf-8") : undefined;
		const next = fn(current);
		if (next === undefined) {
			return;
		}

		const dir = dirname(this.settingsPath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
		writeFileSync(this.settingsPath, next, "utf-8");
	}
}

export function createMomSettingsManager(workspaceDir: string): SettingsManager {
	return SettingsManager.fromStorage(new WorkspaceSettingsStorage(workspaceDir));
}

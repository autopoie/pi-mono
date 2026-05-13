import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { basename, join } from "path";
import { type ConversationScope, resolveConversationScope, resolveExecutionChannelId } from "./conversation-scope.js";
import * as log from "./log.js";
import type { Attachment, ChannelStore, LoggedMessage, LoggedSlackMetadata } from "./store.js";

// ============================================================================
// Types
// ============================================================================

export interface SlackFile {
	name?: string;
	url_private_download?: string;
	url_private?: string;
	[key: string]: unknown;
}

export interface SlackAuthorization {
	enterprise_id?: string | null;
	team_id?: string | null;
	user_id?: string;
	is_bot?: boolean;
	is_enterprise_install?: boolean;
}

export interface SlackEventMetadata {
	ingress: "socket" | "http";
	teamId?: string;
	apiAppId?: string;
	eventId?: string;
	eventTime?: number;
	authorizations?: SlackAuthorization[];
	retryNum?: string;
	retryReason?: string;
}

export interface SlackEvent {
	type: "mention" | "dm";
	channel: string;
	ts: string;
	threadTs?: string;
	user: string;
	text: string;
	files?: SlackFile[];
	metadata?: SlackEventMetadata;
	/** Processed attachments with local paths (populated after logUserMessage) */
	attachments?: Attachment[];
}

export interface SlackCallbackDispatchInput {
	ingress: "socket" | "http";
	event: Record<string, unknown>;
	metadata?: SlackEventMetadata;
}

export type SlackIgnoreReason =
	| "not_initialized"
	| "invalid_event"
	| "unsupported_event_type"
	| "dm_app_mention"
	| "bot_message"
	| "message_subtype"
	| "empty_message"
	| "duplicate_mention_message";

export type SlackDispatchResult =
	| { action: "ignored"; reason: SlackIgnoreReason; metadata?: SlackEventMetadata }
	| { action: "logged"; slackEvent: SlackEvent; scope: ConversationScope; triggered: false; old: boolean }
	| { action: "stopped"; slackEvent: SlackEvent; scope: ConversationScope }
	| { action: "queued"; slackEvent: SlackEvent; scope: ConversationScope; accepted: boolean; queued: boolean };

interface SlackNormalizationResult {
	action: "event";
	slackEvent: SlackEvent;
	shouldTrigger: boolean;
}

interface SlackIgnoredNormalizationResult {
	action: "ignored";
	reason: SlackIgnoreReason;
}

export interface SlackUser {
	id: string;
	userName: string;
	displayName: string;
}

export interface SlackChannel {
	id: string;
	name: string;
}

// Types used by agent.ts
export interface ChannelInfo {
	id: string;
	name: string;
}

export interface UserInfo {
	id: string;
	userName: string;
	displayName: string;
}

export interface SlackContext {
	message: {
		text: string;
		rawText: string;
		user: string;
		userName?: string;
		channel: string;
		ts: string;
		threadTs?: string;
		attachments: Array<{ local: string }>;
		slack?: SlackEventMetadata;
	};
	channelName?: string;
	isEvent?: boolean;
	channels: ChannelInfo[];
	users: UserInfo[];
	respond: (text: string, shouldLog?: boolean) => Promise<void>;
	publishFinal: (text: string, shouldLog?: boolean) => Promise<void>;
	replaceMessage: (text: string) => Promise<void>;
	respondInThread: (text: string) => Promise<void>;
	setTyping: (isTyping: boolean) => Promise<void>;
	uploadFile: (filePath: string, title?: string) => Promise<void>;
	setWorking: (working: boolean) => Promise<void>;
	deleteMessage: () => Promise<void>;
}

export interface MomHandler {
	/**
	 * Handle an event that triggers mom (ASYNC)
	 * Events always queue and pass isEvent=true.
	 */
	handleEvent(event: SlackEvent, scope: ConversationScope, slack: SlackBot, isEvent?: boolean): Promise<void>;

	/**
	 * Handle stop command (ASYNC)
	 * Stops active or queued work that matches the requesting conversation scope.
	 */
	handleStop(event: SlackEvent, scope: ConversationScope, slack: SlackBot): Promise<void>;
}

// ============================================================================
// Per-channel queue for sequential processing against shared channel workspace state
// ============================================================================

export function resolveLoggedThreadRootTs(
	channelId: string,
	messageTs: string,
	threadRootTs?: string,
): string | undefined {
	if (channelId.startsWith("D")) {
		return undefined;
	}
	return threadRootTs ?? messageTs;
}

type QueuedWork = () => Promise<void>;

export const MAX_PENDING_CHANNEL_WORK = 5;
const CHANNEL_QUEUE_PROCESS_DELAY_MS = 5;

export function hasPendingChannelCapacity(queue: Pick<ChannelQueue, "size">): boolean {
	return queue.size() < MAX_PENDING_CHANNEL_WORK;
}

interface QueuedWorkItem {
	work: QueuedWork;
	conversationKey?: string;
}

export class ChannelQueue {
	private queue: QueuedWorkItem[] = [];
	private processing = false;
	private processScheduled = false;
	private activeWork?: QueuedWorkItem;

	enqueue(work: QueuedWork, options?: { conversationKey?: string }): void {
		this.queue.push({ work, conversationKey: options?.conversationKey });
		this.scheduleProcess();
	}

	hasInFlightWork(): boolean {
		return this.processing || this.queue.length > 0;
	}

	cancelPending(conversationKey: string): number {
		const originalLength = this.queue.length;
		this.queue = this.queue.filter((item) => item.conversationKey !== conversationKey);
		let cancelledCount = originalLength - this.queue.length;
		if (this.processScheduled && this.activeWork?.conversationKey === conversationKey) {
			this.activeWork = undefined;
			cancelledCount += 1;
		}
		return cancelledCount;
	}

	size(): number {
		return this.queue.length;
	}

	private scheduleProcess(): void {
		if (this.processing || this.processScheduled) {
			return;
		}
		const nextWork = this.queue.shift();
		if (!nextWork) {
			return;
		}
		this.processing = true;
		this.processScheduled = true;
		this.activeWork = nextWork;
		setTimeout(() => {
			this.processScheduled = false;
			void this.processActiveWork();
		}, CHANNEL_QUEUE_PROCESS_DELAY_MS);
	}

	private async processActiveWork(): Promise<void> {
		const item = this.activeWork;
		if (!item) {
			this.processing = false;
			this.scheduleProcess();
			return;
		}
		this.activeWork = undefined;
		try {
			await item.work();
		} catch (err) {
			log.logWarning("Queue error", err instanceof Error ? err.message : String(err));
		}
		this.processing = false;
		this.scheduleProcess();
	}
}

// ============================================================================
// SlackBot
// ============================================================================

export class SlackBot {
	private socketClient?: SocketModeClient;
	private webClient: WebClient;
	private handler: MomHandler;
	private workingDir: string;
	private store: ChannelStore;
	private botUserId: string | null = null;
	private startupTs: string | null = null; // Messages older than this are just logged, not processed
	private initialized = false;
	private initializePromise?: Promise<void>;

	private users = new Map<string, SlackUser>();
	private channels = new Map<string, SlackChannel>();
	private queues = new Map<string, ChannelQueue>();

	constructor(handler: MomHandler, config: { botToken: string; workingDir: string; store: ChannelStore }) {
		this.handler = handler;
		this.workingDir = config.workingDir;
		this.store = config.store;
		this.webClient = new WebClient(config.botToken);
	}

	// ==========================================================================
	// Public API
	// ==========================================================================

	async initialize(): Promise<void> {
		if (this.initialized) {
			return;
		}
		if (!this.initializePromise) {
			this.initializePromise = this.initializeRuntime().catch((error) => {
				this.initializePromise = undefined;
				this.botUserId = null;
				this.users.clear();
				this.channels.clear();
				throw error;
			});
		}
		await this.initializePromise;
	}

	async startSocketMode(appToken: string): Promise<void> {
		await this.initialize();
		this.socketClient = new SocketModeClient({ appToken });
		this.setupEventHandlers();
		await this.socketClient.start();
		this.markIngressListening();
	}

	async stopSocketMode(): Promise<void> {
		if (!this.socketClient) {
			return;
		}
		const socketClient = this.socketClient as unknown as {
			disconnect?: () => Promise<void> | void;
			close?: () => Promise<void> | void;
		};
		if (socketClient.disconnect) {
			await socketClient.disconnect();
			return;
		}
		if (socketClient.close) {
			await socketClient.close();
		}
	}

	markIngressListening(): void {
		// Record startup time - messages older than this are just logged, not processed
		this.startupTs = (Date.now() / 1000).toFixed(6);
		log.logConnected();
	}

	getUser(userId: string): SlackUser | undefined {
		return this.users.get(userId);
	}

	getChannel(channelId: string): SlackChannel | undefined {
		return this.channels.get(channelId);
	}

	getAllUsers(): SlackUser[] {
		return Array.from(this.users.values());
	}

	getAllChannels(): SlackChannel[] {
		return Array.from(this.channels.values());
	}

	async postMessage(channel: string, text: string): Promise<string> {
		const result = await this.webClient.chat.postMessage({ channel, text });
		return result.ts as string;
	}

	async updateMessage(channel: string, ts: string, text: string): Promise<void> {
		await this.webClient.chat.update({ channel, ts, text });
	}

	async deleteMessage(channel: string, ts: string): Promise<void> {
		await this.webClient.chat.delete({ channel, ts });
	}

	async postInThread(channel: string, threadTs: string, text: string): Promise<string> {
		const result = await this.webClient.chat.postMessage({ channel, thread_ts: threadTs, text });
		return result.ts as string;
	}

	async postConversationMessage(channel: string, threadRootTs: string | undefined, text: string): Promise<string> {
		if (threadRootTs) {
			return this.postInThread(channel, threadRootTs, text);
		}
		return this.postMessage(channel, text);
	}

	async uploadFile(channel: string, filePath: string, title?: string): Promise<void> {
		const fileName = title || basename(filePath);
		const fileContent = readFileSync(filePath);
		await this.webClient.files.uploadV2({
			channel_id: channel,
			file: fileContent,
			filename: fileName,
			title: fileName,
		});
	}

	/**
	 * Log a message to log.jsonl (SYNC)
	 * This is the ONLY place messages are written to log.jsonl
	 */
	logToFile(channel: string, entry: LoggedMessage): void {
		const dir = join(this.workingDir, channel);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		appendFileSync(join(dir, "log.jsonl"), `${JSON.stringify(entry)}\n`);
	}

	/**
	 * Log a bot response to log.jsonl
	 */
	logBotResponse(channel: string, text: string, ts: string, threadRootTs?: string): void {
		this.logToFile(channel, {
			date: new Date().toISOString(),
			ts,
			user: "bot",
			text,
			attachments: [],
			isBot: true,
			threadRootTs: resolveLoggedThreadRootTs(channel, ts, threadRootTs),
		});
	}

	/**
	 * Dispatches normalized Slack callback events from either Socket Mode or HTTP Events API ingress.
	 * This method performs only synchronous log/queue/stop setup and never waits for runner execution.
	 */
	dispatchSlackCallbackEvent(input: SlackCallbackDispatchInput): SlackDispatchResult {
		if (!this.botUserId) {
			return { action: "ignored", reason: "not_initialized", metadata: input.metadata };
		}

		const normalization = normalizeSlackCallbackEvent({
			event: input.event,
			botUserId: this.botUserId,
			metadata: input.metadata ?? { ingress: input.ingress },
		});
		if (normalization.action === "ignored") {
			return { action: "ignored", reason: normalization.reason, metadata: input.metadata };
		}

		const { slackEvent, shouldTrigger } = normalization;
		const scope = resolveConversationScope(slackEvent);

		// SYNC: Log to log.jsonl (ALWAYS, even for old messages)
		// Also downloads attachments in background and stores local paths
		slackEvent.attachments = this.logUserMessage(slackEvent, scope);

		// Only trigger processing for messages AFTER startup (not replayed old messages)
		if (this.startupTs && slackEvent.ts < this.startupTs) {
			log.logInfo(
				`[${slackEvent.channel}] Logged old message (pre-startup), not triggering: ${slackEvent.text.substring(0, 30)}`,
			);
			return { action: "logged", slackEvent, scope, triggered: false, old: true };
		}

		if (!shouldTrigger) {
			return { action: "logged", slackEvent, scope, triggered: false, old: false };
		}

		// Check for stop command - execute immediately, don't queue!
		if (slackEvent.text.toLowerCase().trim() === "stop") {
			void this.handler.handleStop(slackEvent, scope, this).catch((error) => {
				log.logWarning("Stop handler error", error instanceof Error ? error.message : String(error));
			});
			return { action: "stopped", slackEvent, scope };
		}

		const enqueueResult = this.enqueueConversationEvent(slackEvent, scope);
		if (!enqueueResult.accepted) {
			log.logWarning(`[${scope.key}] Queue full`, `Rejecting Slack work: ${slackEvent.text.substring(0, 50)}`);
			this.postQueueFullReply(slackEvent.channel, scope.threadRootTs);
		} else if (enqueueResult.queued) {
			this.postQueuedReply(slackEvent.channel, scope.threadRootTs);
		}

		return { action: "queued", slackEvent, scope, accepted: enqueueResult.accepted, queued: enqueueResult.queued };
	}

	// ==========================================================================
	// Events Integration
	// ==========================================================================

	/**
	 * Enqueue an event for processing. Always queues (no "already working" rejection).
	 * Returns true if enqueued, false if queue is full (max 5).
	 */
	enqueueEvent(event: SlackEvent): boolean {
		const scope = resolveConversationScope(event, { isEvent: true });
		const enqueueResult = this.enqueueConversationEvent(event, scope, { isEvent: true });
		if (!enqueueResult.accepted) {
			const executionChannelId = resolveExecutionChannelId(scope);
			log.logWarning(`Event queue full for ${executionChannelId}, discarding: ${event.text.substring(0, 50)}`);
			return false;
		}
		log.logInfo(`Enqueueing event for ${resolveExecutionChannelId(scope)}: ${event.text.substring(0, 50)}`);
		return true;
	}

	// ==========================================================================
	// Private - Event Handlers
	// ==========================================================================

	private async initializeRuntime(): Promise<void> {
		const auth = await this.webClient.auth.test();
		this.botUserId = auth.user_id as string;

		await Promise.all([this.fetchUsers(), this.fetchChannels()]);
		log.logInfo(`Loaded ${this.channels.size} channels, ${this.users.size} users`);

		await this.backfillAllChannels();
		this.initialized = true;
	}

	private getQueue(channelId: string): ChannelQueue {
		let queue = this.queues.get(channelId);
		if (!queue) {
			queue = new ChannelQueue();
			this.queues.set(channelId, queue);
		}
		return queue;
	}

	cancelQueuedConversation(scope: ConversationScope): number {
		const executionChannelId = resolveExecutionChannelId(scope);
		return this.queues.get(executionChannelId)?.cancelPending(scope.key) ?? 0;
	}

	private enqueueConversationEvent(
		event: SlackEvent,
		scope: ConversationScope,
		options?: { isEvent?: boolean },
	): { accepted: boolean; queued: boolean } {
		const executionChannelId = resolveExecutionChannelId(scope);
		const queue = this.getQueue(executionChannelId);
		if (!hasPendingChannelCapacity(queue)) {
			return { accepted: false, queued: false };
		}
		const queued = queue.hasInFlightWork();
		queue.enqueue(() => this.handler.handleEvent(event, scope, this, options?.isEvent), {
			conversationKey: scope.key,
		});
		return { accepted: true, queued };
	}

	private postQueuedReply(channel: string, threadRootTs: string | undefined): void {
		void this.postConversationMessage(
			channel,
			threadRootTs,
			"_Task queued. I'll respond here when your task kicks off._",
		).catch((error) => {
			log.logWarning("Queued reply error", error instanceof Error ? error.message : String(error));
		});
	}

	private postQueueFullReply(channel: string, threadRootTs: string | undefined): void {
		void this.postConversationMessage(channel, threadRootTs, "_Busy. Queue full, try again later._").catch(
			(error) => {
				log.logWarning("Queue full reply error", error instanceof Error ? error.message : String(error));
			},
		);
	}

	private setupEventHandlers(): void {
		if (!this.socketClient) {
			throw new Error("Socket Mode client is not configured");
		}

		// Channel @mentions
		this.socketClient.on("app_mention", ({ event, ack }: { event: unknown; ack: () => Promise<void> | void }) => {
			const eventRecord = typeof event === "object" && event !== null ? (event as Record<string, unknown>) : {};
			this.dispatchSlackCallbackEvent({
				ingress: "socket",
				event: { ...eventRecord, type: "app_mention" },
				metadata: { ingress: "socket" },
			});
			void Promise.resolve(ack()).catch((error) => {
				log.logWarning("Slack ack error", error instanceof Error ? error.message : String(error));
			});
		});

		// All messages (for logging) + DMs (for triggering)
		this.socketClient.on("message", ({ event, ack }: { event: unknown; ack: () => Promise<void> | void }) => {
			const eventRecord = typeof event === "object" && event !== null ? (event as Record<string, unknown>) : {};
			this.dispatchSlackCallbackEvent({
				ingress: "socket",
				event: { ...eventRecord, type: "message" },
				metadata: { ingress: "socket" },
			});
			void Promise.resolve(ack()).catch((error) => {
				log.logWarning("Slack ack error", error instanceof Error ? error.message : String(error));
			});
		});
	}

	/**
	 * Log a user message to log.jsonl (SYNC)
	 * Downloads attachments in background via store
	 */
	private logUserMessage(event: SlackEvent, scope: ConversationScope): Attachment[] {
		const user = this.users.get(event.user);
		// Process attachments - queues downloads in background
		const attachments = event.files ? this.store.processAttachments(event.channel, event.files, event.ts) : [];
		this.logToFile(event.channel, {
			date: new Date(parseFloat(event.ts) * 1000).toISOString(),
			ts: event.ts,
			user: event.user,
			userName: user?.userName,
			displayName: user?.displayName,
			text: event.text,
			attachments,
			isBot: false,
			threadRootTs: resolveLoggedThreadRootTs(event.channel, event.ts, scope.threadRootTs),
			slack: toLoggedSlackMetadata(event.metadata),
		});
		return attachments;
	}

	// ==========================================================================
	// Private - Backfill
	// ==========================================================================

	private getExistingTimestamps(channelId: string): Set<string> {
		const logPath = join(this.workingDir, channelId, "log.jsonl");
		const timestamps = new Set<string>();
		if (!existsSync(logPath)) return timestamps;

		const content = readFileSync(logPath, "utf-8");
		const lines = content.trim().split("\n").filter(Boolean);
		for (const line of lines) {
			try {
				const entry = JSON.parse(line);
				if (entry.ts) timestamps.add(entry.ts);
			} catch {}
		}
		return timestamps;
	}

	private async backfillChannel(channelId: string): Promise<number> {
		const existingTs = this.getExistingTimestamps(channelId);

		// Find the biggest ts in log.jsonl
		let latestTs: string | undefined;
		for (const ts of existingTs) {
			if (!latestTs || parseFloat(ts) > parseFloat(latestTs)) latestTs = ts;
		}

		type Message = {
			user?: string;
			bot_id?: string;
			text?: string;
			ts?: string;
			thread_ts?: string;
			subtype?: string;
			files?: SlackFile[];
		};
		const allMessages: Message[] = [];

		let cursor: string | undefined;
		let pageCount = 0;
		const maxPages = 3;

		do {
			const result = await this.webClient.conversations.history({
				channel: channelId,
				oldest: latestTs, // Only fetch messages newer than what we have
				inclusive: false,
				limit: 1000,
				cursor,
			});
			if (result.messages) {
				allMessages.push(...(result.messages as Message[]));
			}
			cursor = result.response_metadata?.next_cursor;
			pageCount++;
		} while (cursor && pageCount < maxPages);

		// Filter: include mom's messages, exclude other bots, skip already logged
		const relevantMessages = allMessages.filter((msg) => {
			if (!msg.ts || existingTs.has(msg.ts)) return false; // Skip duplicates
			if (msg.user === this.botUserId) return true;
			if (msg.bot_id) return false;
			if (msg.subtype !== undefined && msg.subtype !== "file_share") return false;
			if (!msg.user) return false;
			if (!msg.text && (!msg.files || msg.files.length === 0)) return false;
			return true;
		});

		// Reverse to chronological order
		relevantMessages.reverse();

		// Log each message to log.jsonl
		for (const msg of relevantMessages) {
			const isMomMessage = msg.user === this.botUserId;
			const user = this.users.get(msg.user!);
			const threadRootTs = resolveLoggedThreadRootTs(channelId, msg.ts!, msg.thread_ts);
			// Strip @mentions from text (same as live messages)
			const text = (msg.text || "").replace(/<@[A-Z0-9]+>/gi, "").trim();
			// Process attachments - queues downloads in background
			const attachments = msg.files ? this.store.processAttachments(channelId, msg.files, msg.ts!) : [];

			this.logToFile(channelId, {
				date: new Date(parseFloat(msg.ts!) * 1000).toISOString(),
				ts: msg.ts!,
				user: isMomMessage ? "bot" : msg.user!,
				userName: isMomMessage ? undefined : user?.userName,
				displayName: isMomMessage ? undefined : user?.displayName,
				text,
				attachments,
				isBot: isMomMessage,
				threadRootTs,
			});
		}

		return relevantMessages.length;
	}

	private async backfillAllChannels(): Promise<void> {
		const startTime = Date.now();

		// Only backfill channels that already have a log.jsonl (mom has interacted with them before)
		const channelsToBackfill: Array<[string, SlackChannel]> = [];
		for (const [channelId, channel] of this.channels) {
			const logPath = join(this.workingDir, channelId, "log.jsonl");
			if (existsSync(logPath)) {
				channelsToBackfill.push([channelId, channel]);
			}
		}

		log.logBackfillStart(channelsToBackfill.length);

		let totalMessages = 0;
		for (const [channelId, channel] of channelsToBackfill) {
			try {
				const count = await this.backfillChannel(channelId);
				if (count > 0) log.logBackfillChannel(channel.name, count);
				totalMessages += count;
			} catch (error) {
				log.logWarning(`Failed to backfill #${channel.name}`, String(error));
			}
		}

		const durationMs = Date.now() - startTime;
		log.logBackfillComplete(totalMessages, durationMs);
	}

	// ==========================================================================
	// Private - Fetch Users/Channels
	// ==========================================================================

	private async fetchUsers(): Promise<void> {
		let cursor: string | undefined;
		do {
			const result = await this.webClient.users.list({ limit: 200, cursor });
			const members = result.members as
				| Array<{ id?: string; name?: string; real_name?: string; deleted?: boolean }>
				| undefined;
			if (members) {
				for (const u of members) {
					if (u.id && u.name && !u.deleted) {
						this.users.set(u.id, { id: u.id, userName: u.name, displayName: u.real_name || u.name });
					}
				}
			}
			cursor = result.response_metadata?.next_cursor;
		} while (cursor);
	}

	private async fetchChannels(): Promise<void> {
		// Fetch public/private channels
		let cursor: string | undefined;
		do {
			const result = await this.webClient.conversations.list({
				types: "public_channel,private_channel",
				exclude_archived: true,
				limit: 200,
				cursor,
			});
			const channels = result.channels as Array<{ id?: string; name?: string; is_member?: boolean }> | undefined;
			if (channels) {
				for (const c of channels) {
					if (c.id && c.name && c.is_member) {
						this.channels.set(c.id, { id: c.id, name: c.name });
					}
				}
			}
			cursor = result.response_metadata?.next_cursor;
		} while (cursor);

		// Also fetch DM channels (IMs)
		cursor = undefined;
		do {
			const result = await this.webClient.conversations.list({
				types: "im",
				limit: 200,
				cursor,
			});
			const ims = result.channels as Array<{ id?: string; user?: string }> | undefined;
			if (ims) {
				for (const im of ims) {
					if (im.id) {
						// Use user's name as channel name for DMs
						const user = im.user ? this.users.get(im.user) : undefined;
						const name = user ? `DM:${user.userName}` : `DM:${im.id}`;
						this.channels.set(im.id, { id: im.id, name });
					}
				}
			}
			cursor = result.response_metadata?.next_cursor;
		} while (cursor);
	}
}

export function normalizeSlackCallbackEvent(input: {
	event: Record<string, unknown>;
	botUserId: string;
	metadata?: SlackEventMetadata;
}): SlackNormalizationResult | SlackIgnoredNormalizationResult {
	const eventType = typeof input.event.type === "string" ? input.event.type : undefined;
	if (eventType === "app_mention") {
		return normalizeAppMention(input.event, input.metadata);
	}
	if (eventType === "message") {
		return normalizeMessage(input.event, input.botUserId, input.metadata);
	}
	return { action: "ignored", reason: "unsupported_event_type" };
}

function normalizeAppMention(
	event: Record<string, unknown>,
	metadata: SlackEventMetadata | undefined,
): SlackNormalizationResult | SlackIgnoredNormalizationResult {
	const channel = typeof event.channel === "string" ? event.channel : undefined;
	const user = typeof event.user === "string" ? event.user : undefined;
	const ts = typeof event.ts === "string" ? event.ts : undefined;
	if (!channel || !user || !ts) {
		return { action: "ignored", reason: "invalid_event" };
	}
	if (channel.startsWith("D")) {
		return { action: "ignored", reason: "dm_app_mention" };
	}

	const text = typeof event.text === "string" ? event.text : "";
	return {
		action: "event",
		shouldTrigger: true,
		slackEvent: {
			type: "mention",
			channel,
			ts,
			threadTs: typeof event.thread_ts === "string" ? event.thread_ts : undefined,
			user,
			text: text.replace(/<@[A-Z0-9_]+>/gi, "").trim(),
			files: normalizeFiles(event.files),
			metadata,
		},
	};
}

function normalizeMessage(
	event: Record<string, unknown>,
	botUserId: string,
	metadata: SlackEventMetadata | undefined,
): SlackNormalizationResult | SlackIgnoredNormalizationResult {
	const user = typeof event.user === "string" ? event.user : undefined;
	if (typeof event.bot_id === "string" || !user || user === botUserId) {
		return { action: "ignored", reason: "bot_message" };
	}
	const subtype = typeof event.subtype === "string" ? event.subtype : undefined;
	if (subtype !== undefined && subtype !== "file_share") {
		return { action: "ignored", reason: "message_subtype" };
	}

	const text = typeof event.text === "string" ? event.text : "";
	const files = normalizeFiles(event.files);
	if (!text && (!files || files.length === 0)) {
		return { action: "ignored", reason: "empty_message" };
	}

	const channel = typeof event.channel === "string" ? event.channel : undefined;
	const ts = typeof event.ts === "string" ? event.ts : undefined;
	if (!channel || !ts) {
		return { action: "ignored", reason: "invalid_event" };
	}

	const isDM = event.channel_type === "im";
	const isBotMention = text.includes(`<@${botUserId}>`);
	if (!isDM && isBotMention) {
		return { action: "ignored", reason: "duplicate_mention_message" };
	}

	return {
		action: "event",
		shouldTrigger: isDM,
		slackEvent: {
			type: isDM ? "dm" : "mention",
			channel,
			ts,
			threadTs: typeof event.thread_ts === "string" ? event.thread_ts : undefined,
			user,
			text: text.replace(/<@[A-Z0-9_]+>/gi, "").trim(),
			files,
			metadata,
		},
	};
}

function normalizeFiles(value: unknown): SlackFile[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	const files = value.filter((file): file is SlackFile => typeof file === "object" && file !== null);
	return files.length > 0 ? files : undefined;
}

function toLoggedSlackMetadata(metadata: SlackEventMetadata | undefined): LoggedSlackMetadata | undefined {
	if (!metadata) {
		return undefined;
	}
	return {
		ingress: metadata.ingress,
		teamId: metadata.teamId,
		apiAppId: metadata.apiAppId,
		eventId: metadata.eventId,
		eventTime: metadata.eventTime,
	};
}

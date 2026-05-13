import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import * as log from "./log.js";
import type { SlackCallbackDispatchInput, SlackDispatchResult, SlackEventMetadata } from "./slack.js";

const MAX_SLACK_BODY_BYTES = 1024 * 1024;
const SLACK_HTTP_REQUEST_TIMEOUT_MS = 10_000;
const SLACK_HTTP_HEADERS_TIMEOUT_MS = 10_000;
const SLACK_HTTP_KEEP_ALIVE_TIMEOUT_MS = 5_000;
const DEFAULT_DEDUPE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_DEDUPE_ENTRIES = 10_000;
const SLACK_SIGNATURE_VERSION = "v0";
const SLACK_SIGNATURE_MAX_DRIFT_SECONDS = 300;

export interface SlackHttpBot {
	initialize(): Promise<void>;
	dispatchSlackCallbackEvent(input: SlackCallbackDispatchInput): SlackDispatchResult;
	markIngressListening(): void;
}

export interface SlackHttpIngressConfig {
	bot: SlackHttpBot;
	signingSecret: string;
	port: number;
	eventsPath: string;
	allowedTeamIds?: ReadonlySet<string>;
	nowSeconds?: () => number;
	deduper?: SlackEventDeduper;
}

export type SlackSignatureVerificationResult =
	| { ok: true }
	| {
			ok: false;
			reason:
				| "missing_signature"
				| "missing_timestamp"
				| "malformed_timestamp"
				| "stale_timestamp"
				| "invalid_signature";
	  };

interface SlackHttpEnvelope {
	type?: unknown;
	challenge?: unknown;
	team_id?: unknown;
	api_app_id?: unknown;
	event_id?: unknown;
	event_time?: unknown;
	authorizations?: unknown;
	event?: unknown;
}

interface DedupeEntry {
	status: "pending" | "committed";
	expiresAt: number;
	createdAt: number;
}

class HttpRequestError extends Error {
	constructor(
		public readonly statusCode: number,
		message: string,
	) {
		super(message);
	}
}

export class SlackEventDeduper {
	private ttlMs: number;
	private maxEntries: number;
	private nowMs: () => number;
	private entries = new Map<string, DedupeEntry>();

	constructor(options?: { ttlMs?: number; maxEntries?: number; nowMs?: () => number }) {
		this.ttlMs = options?.ttlMs ?? DEFAULT_DEDUPE_TTL_MS;
		this.maxEntries = options?.maxEntries ?? DEFAULT_MAX_DEDUPE_ENTRIES;
		this.nowMs = options?.nowMs ?? (() => Date.now());
	}

	reserve(eventId: string): boolean {
		this.pruneExpired();
		if (this.entries.has(eventId)) {
			return false;
		}
		const now = this.nowMs();
		this.entries.set(eventId, {
			status: "pending",
			expiresAt: now + this.ttlMs,
			createdAt: now,
		});
		this.pruneOverflow();
		return true;
	}

	commit(eventId: string): void {
		const entry = this.entries.get(eventId);
		if (!entry) {
			return;
		}
		entry.status = "committed";
		entry.expiresAt = this.nowMs() + this.ttlMs;
	}

	release(eventId: string): void {
		const entry = this.entries.get(eventId);
		if (entry?.status === "pending") {
			this.entries.delete(eventId);
		}
	}

	private pruneExpired(): void {
		const now = this.nowMs();
		for (const [eventId, entry] of this.entries) {
			if (entry.expiresAt <= now) {
				this.entries.delete(eventId);
			}
		}
	}

	private pruneOverflow(): void {
		if (this.entries.size <= this.maxEntries) {
			return;
		}
		const excessCount = this.entries.size - this.maxEntries;
		const oldestEntries = Array.from(this.entries.entries())
			.sort((left, right) => left[1].createdAt - right[1].createdAt)
			.slice(0, excessCount);
		for (const [eventId] of oldestEntries) {
			this.entries.delete(eventId);
		}
	}
}

export class SlackHttpIngress {
	private server?: Server;
	private bot: SlackHttpBot;
	private signingSecret: string;
	private port: number;
	private eventsPath: string;
	private allowedTeamIds?: ReadonlySet<string>;
	private nowSeconds: () => number;
	private deduper: SlackEventDeduper;

	constructor(config: SlackHttpIngressConfig) {
		this.bot = config.bot;
		this.signingSecret = config.signingSecret;
		this.port = config.port;
		this.eventsPath = config.eventsPath;
		this.allowedTeamIds = config.allowedTeamIds;
		this.nowSeconds = config.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
		this.deduper = config.deduper ?? new SlackEventDeduper();
	}

	async start(): Promise<void> {
		await this.bot.initialize();
		this.server = createServer((request, response) => {
			void this.handleRequest(request, response).catch((error) => {
				const message = error instanceof Error ? error.message : String(error);
				log.logWarning("Slack HTTP request error", message);
				if (!response.headersSent) {
					writeTextResponse(response, 500, "internal error");
				} else {
					response.end();
				}
			});
		});
		this.server.requestTimeout = SLACK_HTTP_REQUEST_TIMEOUT_MS;
		this.server.headersTimeout = SLACK_HTTP_HEADERS_TIMEOUT_MS;
		this.server.keepAliveTimeout = SLACK_HTTP_KEEP_ALIVE_TIMEOUT_MS;

		await new Promise<void>((resolve, reject) => {
			this.server!.once("error", reject);
			this.server!.listen(this.port, "0.0.0.0", () => {
				this.server!.off("error", reject);
				this.bot.markIngressListening();
				log.logInfo(`Slack HTTP ingress listening on 0.0.0.0:${this.getPort()}${this.eventsPath}`);
				resolve();
			});
		});
	}

	async stop(): Promise<void> {
		if (!this.server) {
			return;
		}
		const server = this.server;
		this.server = undefined;
		server.closeIdleConnections?.();
		await new Promise<void>((resolve, reject) => {
			server.close((error) => {
				if (error) {
					reject(error);
					return;
				}
				resolve();
			});
		});
	}

	getPort(): number {
		const address = this.server?.address();
		if (address && typeof address === "object") {
			return address.port;
		}
		return this.port;
	}

	private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const path = new URL(request.url ?? "/", "http://localhost").pathname;
		if (request.method === "GET" && path === "/health") {
			writeTextResponse(response, 200, "ok");
			return;
		}
		if (path !== this.eventsPath) {
			writeTextResponse(response, 404, "not found");
			return;
		}
		if (request.method !== "POST") {
			writeTextResponse(response, 405, "method not allowed");
			return;
		}

		let rawBody: Buffer;
		try {
			rawBody = await readRawBody(request, MAX_SLACK_BODY_BYTES);
		} catch (error) {
			if (error instanceof HttpRequestError) {
				writeTextResponse(response, error.statusCode, error.message);
				return;
			}
			throw error;
		}

		const verification = verifySlackRequestSignature({
			rawBody,
			signingSecret: this.signingSecret,
			signatureHeader: getHeader(request, "x-slack-signature"),
			timestampHeader: getHeader(request, "x-slack-request-timestamp"),
			nowSeconds: this.nowSeconds,
		});
		if (!verification.ok) {
			writeTextResponse(response, 401, verification.reason);
			return;
		}

		let payload: SlackHttpEnvelope;
		try {
			payload = JSON.parse(rawBody.toString("utf8")) as SlackHttpEnvelope;
		} catch {
			writeTextResponse(response, 400, "invalid json");
			return;
		}

		if (payload.type === "url_verification") {
			if (typeof payload.challenge !== "string") {
				writeTextResponse(response, 400, "invalid challenge");
				return;
			}
			writeTextResponse(response, 200, payload.challenge);
			return;
		}

		if (payload.type !== "event_callback") {
			writeTextResponse(response, 200, "ignored");
			return;
		}

		const eventId = typeof payload.event_id === "string" ? payload.event_id : undefined;
		if (!eventId || !isRecord(payload.event)) {
			writeTextResponse(response, 400, "invalid event_callback");
			return;
		}

		const teamId = typeof payload.team_id === "string" ? payload.team_id : undefined;
		if (this.allowedTeamIds && (!teamId || !this.allowedTeamIds.has(teamId))) {
			writeTextResponse(response, 200, "ignored");
			return;
		}

		if (!this.deduper.reserve(eventId)) {
			writeTextResponse(response, 200, "duplicate");
			return;
		}

		try {
			this.bot.dispatchSlackCallbackEvent({
				ingress: "http",
				event: payload.event,
				metadata: this.createMetadata(payload, request),
			});
			this.deduper.commit(eventId);
			writeTextResponse(response, 200, "ok");
		} catch (error) {
			this.deduper.release(eventId);
			const message = error instanceof Error ? error.message : String(error);
			log.logWarning("Slack HTTP dispatch error", message);
			writeTextResponse(response, 500, "dispatch error");
		}
	}

	private createMetadata(payload: SlackHttpEnvelope, request: IncomingMessage): SlackEventMetadata {
		return {
			ingress: "http",
			teamId: typeof payload.team_id === "string" ? payload.team_id : undefined,
			apiAppId: typeof payload.api_app_id === "string" ? payload.api_app_id : undefined,
			eventId: typeof payload.event_id === "string" ? payload.event_id : undefined,
			eventTime: typeof payload.event_time === "number" ? payload.event_time : undefined,
			authorizations: normalizeAuthorizations(payload.authorizations),
			retryNum: getHeader(request, "x-slack-retry-num"),
			retryReason: getHeader(request, "x-slack-retry-reason"),
		};
	}
}

export function verifySlackRequestSignature(input: {
	rawBody: Buffer;
	signingSecret: string;
	signatureHeader: string | undefined;
	timestampHeader: string | undefined;
	nowSeconds: () => number;
}): SlackSignatureVerificationResult {
	if (!input.signatureHeader) {
		return { ok: false, reason: "missing_signature" };
	}
	if (!input.timestampHeader) {
		return { ok: false, reason: "missing_timestamp" };
	}

	const timestamp = Number.parseInt(input.timestampHeader, 10);
	if (!Number.isFinite(timestamp) || timestamp.toString() !== input.timestampHeader) {
		return { ok: false, reason: "malformed_timestamp" };
	}
	if (Math.abs(input.nowSeconds() - timestamp) > SLACK_SIGNATURE_MAX_DRIFT_SECONDS) {
		return { ok: false, reason: "stale_timestamp" };
	}

	const expectedSignature = createHmac("sha256", input.signingSecret)
		.update(Buffer.concat([Buffer.from(`${SLACK_SIGNATURE_VERSION}:${input.timestampHeader}:`), input.rawBody]))
		.digest("hex");
	const expected = `${SLACK_SIGNATURE_VERSION}=${expectedSignature}`;
	if (!safeEqual(expected, input.signatureHeader)) {
		return { ok: false, reason: "invalid_signature" };
	}
	return { ok: true };
}

async function readRawBody(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
	const chunks: Buffer[] = [];
	let byteLength = 0;
	request.setTimeout(SLACK_HTTP_REQUEST_TIMEOUT_MS, () => {
		request.destroy(new HttpRequestError(408, "request timeout"));
	});

	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		byteLength += buffer.length;
		if (byteLength > maxBytes) {
			throw new HttpRequestError(413, "payload too large");
		}
		chunks.push(buffer);
	}

	return Buffer.concat(chunks);
}

function getHeader(request: IncomingMessage, name: string): string | undefined {
	const value = request.headers[name];
	if (Array.isArray(value)) {
		return value[0];
	}
	return value;
}

function writeTextResponse(response: ServerResponse, statusCode: number, body: string): void {
	response.writeHead(statusCode, {
		"content-type": "text/plain; charset=utf-8",
	});
	response.end(body);
}

function safeEqual(left: string, right: string): boolean {
	const leftBuffer = Buffer.from(left);
	const rightBuffer = Buffer.from(right);
	return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function normalizeAuthorizations(value: unknown): SlackEventMetadata["authorizations"] {
	if (!Array.isArray(value)) {
		return undefined;
	}
	return value.filter(isRecord).map((authorization) => ({
		enterprise_id:
			typeof authorization.enterprise_id === "string" || authorization.enterprise_id === null
				? authorization.enterprise_id
				: undefined,
		team_id:
			typeof authorization.team_id === "string" || authorization.team_id === null
				? authorization.team_id
				: undefined,
		user_id: typeof authorization.user_id === "string" ? authorization.user_id : undefined,
		is_bot: typeof authorization.is_bot === "boolean" ? authorization.is_bot : undefined,
		is_enterprise_install:
			typeof authorization.is_enterprise_install === "boolean" ? authorization.is_enterprise_install : undefined,
	}));
}

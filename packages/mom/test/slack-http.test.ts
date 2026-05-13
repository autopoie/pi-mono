import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { SlackBot, type SlackCallbackDispatchInput, type SlackDispatchResult } from "../src/slack.js";
import {
	SlackEventDeduper,
	type SlackHttpBot,
	SlackHttpIngress,
	verifySlackRequestSignature,
} from "../src/slack-http.js";

const FIXTURE_SIGNING_SECRET = "fixture-slack-signing-secret";
const FIXTURE_TIMESTAMP = "1714492800";
const PAYLOAD_DIR = join(process.cwd(), "..", "..", "pi-mom-fixture", "fixtures", "slack-http", "payloads");

const activeIngresses: SlackHttpIngress[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
	for (const ingress of activeIngresses.splice(0)) {
		await ingress.stop();
	}
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { force: true, recursive: true });
	}
	vi.restoreAllMocks();
});

function readPayload(fileName: string): string {
	return readFileSync(join(PAYLOAD_DIR, fileName), "utf8");
}

function signSlackRequest(rawBody: string, timestamp = FIXTURE_TIMESTAMP): string {
	const digest = createHmac("sha256", FIXTURE_SIGNING_SECRET).update(`v0:${timestamp}:${rawBody}`).digest("hex");
	return `v0=${digest}`;
}

function signedHeaders(rawBody: string, timestamp = FIXTURE_TIMESTAMP): Record<string, string> {
	return {
		"content-type": "application/json",
		"x-slack-request-timestamp": timestamp,
		"x-slack-signature": signSlackRequest(rawBody, timestamp),
	};
}

function createBot(): SlackHttpBot & { dispatches: SlackCallbackDispatchInput[] } {
	const dispatches: SlackCallbackDispatchInput[] = [];
	return {
		dispatches,
		initialize: vi.fn(async () => {}),
		markIngressListening: vi.fn(() => {}),
		dispatchSlackCallbackEvent: (input: SlackCallbackDispatchInput): SlackDispatchResult => {
			dispatches.push(input);
			return {
				action: "queued",
				accepted: true,
				queued: false,
				slackEvent: {
					type: "mention",
					channel: "C_GROWTH",
					ts: "1714492800.000100",
					user: "U_ALICE",
					text: "test-direct-response",
				},
				scope: {
					kind: "thread",
					key: "C_GROWTH:1714492800.000100",
					channelId: "C_GROWTH",
					threadRootTs: "1714492800.000100",
				},
			};
		},
	};
}

async function startIngress(params?: { allowedTeamIds?: ReadonlySet<string>; bot?: ReturnType<typeof createBot> }) {
	const bot = params?.bot ?? createBot();
	const ingress = new SlackHttpIngress({
		bot,
		signingSecret: FIXTURE_SIGNING_SECRET,
		port: 0,
		eventsPath: "/slack/events",
		nowSeconds: () => Number.parseInt(FIXTURE_TIMESTAMP, 10),
		...(params?.allowedTeamIds ? { allowedTeamIds: params.allowedTeamIds } : {}),
	});
	await ingress.start();
	activeIngresses.push(ingress);
	return { bot, ingress };
}

async function sendRequest(input: {
	ingress: SlackHttpIngress;
	method?: string;
	path?: string;
	body?: string;
	headers?: Record<string, string>;
}): Promise<{ statusCode: number; body: string }> {
	return new Promise((resolve, reject) => {
		const request = httpRequest(
			{
				host: "127.0.0.1",
				port: input.ingress.getPort(),
				method: input.method ?? "POST",
				path: input.path ?? "/slack/events",
				headers: input.headers,
			},
			(response) => {
				const chunks: Buffer[] = [];
				response.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
				response.on("end", () => {
					resolve({
						statusCode: response.statusCode ?? 0,
						body: Buffer.concat(chunks).toString("utf8"),
					});
				});
			},
		);
		request.on("error", reject);
		if (input.body) {
			request.write(input.body);
		}
		request.end();
	});
}

describe("Slack HTTP signature verification", () => {
	it("accepts a valid signature over the exact raw body", () => {
		const rawBody = readPayload("app-mention.json");
		const result = verifySlackRequestSignature({
			rawBody: Buffer.from(rawBody),
			signingSecret: FIXTURE_SIGNING_SECRET,
			signatureHeader: signSlackRequest(rawBody),
			timestampHeader: FIXTURE_TIMESTAMP,
			nowSeconds: () => Number.parseInt(FIXTURE_TIMESTAMP, 10),
		});

		expect(result).toEqual({ ok: true });
	});

	it("rejects parsed and re-stringified JSON bodies", () => {
		const rawBody = readPayload("app-mention.json");
		const rewrittenBody = JSON.stringify(JSON.parse(rawBody));
		const result = verifySlackRequestSignature({
			rawBody: Buffer.from(rewrittenBody),
			signingSecret: FIXTURE_SIGNING_SECRET,
			signatureHeader: signSlackRequest(rawBody),
			timestampHeader: FIXTURE_TIMESTAMP,
			nowSeconds: () => Number.parseInt(FIXTURE_TIMESTAMP, 10),
		});

		expect(result).toEqual({ ok: false, reason: "invalid_signature" });
	});

	it("rejects stale timestamps", () => {
		const rawBody = readPayload("app-mention.json");
		const result = verifySlackRequestSignature({
			rawBody: Buffer.from(rawBody),
			signingSecret: FIXTURE_SIGNING_SECRET,
			signatureHeader: signSlackRequest(rawBody),
			timestampHeader: FIXTURE_TIMESTAMP,
			nowSeconds: () => Number.parseInt(FIXTURE_TIMESTAMP, 10) + 301,
		});

		expect(result).toEqual({ ok: false, reason: "stale_timestamp" });
	});

	it("rejects missing signatures", () => {
		const rawBody = readPayload("app-mention.json");
		const result = verifySlackRequestSignature({
			rawBody: Buffer.from(rawBody),
			signingSecret: FIXTURE_SIGNING_SECRET,
			signatureHeader: undefined,
			timestampHeader: FIXTURE_TIMESTAMP,
			nowSeconds: () => Number.parseInt(FIXTURE_TIMESTAMP, 10),
		});

		expect(result).toEqual({ ok: false, reason: "missing_signature" });
	});
});

describe("Slack HTTP ingress", () => {
	it("returns URL verification challenges without dispatching work", async () => {
		const { bot, ingress } = await startIngress();
		const rawBody = readPayload("url-verification.json");
		const response = await sendRequest({ ingress, body: rawBody, headers: signedHeaders(rawBody) });

		expect(response).toEqual({ statusCode: 200, body: "fixture-url-verification-challenge" });
		expect(bot.dispatches).toEqual([]);
	});

	it("deduplicates event_callback payloads by event_id", async () => {
		const { bot, ingress } = await startIngress();
		const rawBody = readPayload("app-mention.json");
		const first = await sendRequest({ ingress, body: rawBody, headers: signedHeaders(rawBody) });
		const second = await sendRequest({ ingress, body: rawBody, headers: signedHeaders(rawBody) });

		expect(first.statusCode).toBe(200);
		expect(second).toEqual({ statusCode: 200, body: "duplicate" });
		expect(bot.dispatches).toHaveLength(1);
		expect(bot.dispatches[0].metadata).toMatchObject({
			ingress: "http",
			teamId: "T_KITE_FIXTURE",
			apiAppId: "A_KITE_SHARED_APP",
			eventId: "Ev_KITE_FIXTURE_APP_MENTION_001",
			eventTime: 1714492800,
		});
	});

	it("acknowledges event callbacks without waiting for downstream work", async () => {
		const workingDir = mkdtempSync(join(tmpdir(), "mom-http-ack-"));
		tempDirs.push(workingDir);
		let responseReceived = false;
		let workStartedBeforeResponse = false;
		const bot = new SlackBot(
			{
				handleEvent: vi.fn(async () => {
					if (!responseReceived) {
						workStartedBeforeResponse = true;
					}
				}),
				handleStop: vi.fn(async () => {}),
			},
			{
				botToken: "bot-token",
				workingDir,
				store: { processAttachments: () => [] } as never,
			},
		);
		(bot as never as { botUserId: string | null }).botUserId = "U_KITE_BOT";
		const ingress = new SlackHttpIngress({
			bot: {
				initialize: vi.fn(async () => {}),
				markIngressListening: vi.fn(() => {}),
				dispatchSlackCallbackEvent: (input) => bot.dispatchSlackCallbackEvent(input),
			},
			signingSecret: FIXTURE_SIGNING_SECRET,
			port: 0,
			eventsPath: "/slack/events",
			nowSeconds: () => Number.parseInt(FIXTURE_TIMESTAMP, 10),
		});
		await ingress.start();
		activeIngresses.push(ingress);

		const rawBody = readPayload("dm-message.json");
		const response = await sendRequest({ ingress, body: rawBody, headers: signedHeaders(rawBody) });
		responseReceived = true;
		await new Promise((resolve) => setImmediate(resolve));

		expect(response).toEqual({ statusCode: 200, body: "ok" });
		expect(workStartedBeforeResponse).toBe(false);
	});

	it("ignores unexpected teams when an allowlist is configured", async () => {
		const { bot, ingress } = await startIngress({ allowedTeamIds: new Set(["T_KITE_FIXTURE"]) });
		const rawBody = readPayload("shared-app-other-team.json");
		const response = await sendRequest({ ingress, body: rawBody, headers: signedHeaders(rawBody) });

		expect(response).toEqual({ statusCode: 200, body: "ignored" });
		expect(bot.dispatches).toEqual([]);
	});

	it("rejects malformed JSON after valid signature without dispatching", async () => {
		const { bot, ingress } = await startIngress();
		const rawBody = "{";
		const response = await sendRequest({ ingress, body: rawBody, headers: signedHeaders(rawBody) });

		expect(response.statusCode).toBe(400);
		expect(bot.dispatches).toEqual([]);
	});

	it("serves an unsigned health endpoint", async () => {
		const { ingress } = await startIngress();
		const response = await sendRequest({ ingress, method: "GET", path: "/health" });

		expect(response).toEqual({ statusCode: 200, body: "ok" });
	});

	it("rejects invalid signatures before dispatch", async () => {
		const { bot, ingress } = await startIngress();
		const rawBody = readPayload("app-mention.json");
		const response = await sendRequest({
			ingress,
			body: rawBody,
			headers: {
				...signedHeaders(rawBody),
				"x-slack-signature": signSlackRequest(`${rawBody} `),
			},
		});

		expect(response.statusCode).toBe(401);
		expect(bot.dispatches).toEqual([]);
	});
});

describe("SlackEventDeduper", () => {
	it("releases pending reservations after synchronous dispatch failures", () => {
		const deduper = new SlackEventDeduper({ nowMs: () => 1000 });
		expect(deduper.reserve("Ev_1")).toBe(true);
		expect(deduper.reserve("Ev_1")).toBe(false);
		deduper.release("Ev_1");
		expect(deduper.reserve("Ev_1")).toBe(true);
	});
});

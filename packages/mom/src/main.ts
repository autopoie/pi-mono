#!/usr/bin/env node

import { join, resolve } from "path";
import { type AgentRunner, createRunner } from "./agent.js";
import { type ConversationScope, resolveExecutionChannelId } from "./conversation-scope.js";
import { downloadChannel } from "./download.js";
import { createEventsWatcher } from "./events.js";
import {
	abortActiveRunAndRequestStopStatus,
	type ConversationMessageTarget,
	publishStoppedStatus,
	resolveConversationMessageTarget,
	resolveStopHandlingPlan,
} from "./execution-control.js";
import { resolveMomTrustConfig, validateStrictTrustBoundary } from "./extensions.js";
import * as log from "./log.js";
import { parseSandboxArg, type SandboxConfig, validateSandbox } from "./sandbox.js";
import {
	type MomHandler,
	type SlackBot,
	SlackBot as SlackBotClass,
	type SlackContext,
	type SlackEvent,
} from "./slack.js";
import { SlackHttpIngress } from "./slack-http.js";
import {
	MAX_MAIN_MESSAGE_LENGTH,
	MAX_THREAD_MESSAGE_LENGTH,
	publishSplitFinalSlackReply,
	THREAD_TRUNCATION_NOTE,
	TRUNCATION_NOTE,
	truncateSlackText,
} from "./slack-message-utils.js";
import { ChannelStore } from "./store.js";

const MOM_SLACK_APP_TOKEN = process.env.MOM_SLACK_APP_TOKEN;
const MOM_SLACK_BOT_TOKEN = process.env.MOM_SLACK_BOT_TOKEN;
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;

interface ParsedArgs {
	workingDir?: string;
	sandbox: SandboxConfig;
	downloadChannel?: string;
}

interface ConversationState {
	runner?: AgentRunner;
	store: ChannelStore;
	channelDir: string;
	sessionDir: string;
	conversationKey: string;
}

interface ChannelExecutionState {
	running: boolean;
	activeRunner?: AgentRunner;
	activeTarget?: ConversationMessageTarget;
	activeRunId: number;
	stopRequested: boolean;
	stopMessageTs?: string;
	stopStatusRequestId?: number;
	stopStatusPromise?: Promise<string | undefined>;
}

type SlackIngressMode = "socket" | "http";

interface SlackIngress {
	start(): Promise<void>;
	stop(): Promise<void>;
}

function parseSlackIngressMode(value: string | undefined): SlackIngressMode {
	if (!value || value === "socket") {
		return "socket";
	}
	if (value === "http") {
		return "http";
	}
	throw new Error("MOM_SLACK_INGRESS_MODE must be 'socket' or 'http'");
}

function parseHttpPort(value: string | undefined): number {
	const rawPort = value ?? "3000";
	const port = Number.parseInt(rawPort, 10);
	if (!Number.isInteger(port) || port <= 0 || port > 65535 || port.toString() !== rawPort) {
		throw new Error("PORT must be an integer from 1 to 65535");
	}
	return port;
}

function parseEventsPath(value: string | undefined): string {
	const path = value?.trim() || "/slack/events";
	if (!path.startsWith("/")) {
		throw new Error("MOM_SLACK_EVENTS_PATH must start with '/'");
	}
	return path;
}

function parseAllowedTeamIds(value: string | undefined): ReadonlySet<string> | undefined {
	const teamIds = value
		?.split(",")
		.map((teamId) => teamId.trim())
		.filter(Boolean);
	return teamIds && teamIds.length > 0 ? new Set(teamIds) : undefined;
}

function parseArgs(): ParsedArgs {
	const args = process.argv.slice(2);
	let sandbox: SandboxConfig = { type: "host" };
	let workingDir: string | undefined;
	let downloadChannelId: string | undefined;

	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg.startsWith("--sandbox=")) {
			sandbox = parseSandboxArg(arg.slice("--sandbox=".length));
		} else if (arg === "--sandbox") {
			sandbox = parseSandboxArg(args[++index] || "");
		} else if (arg.startsWith("--download=")) {
			downloadChannelId = arg.slice("--download=".length);
		} else if (arg === "--download") {
			downloadChannelId = args[++index];
		} else if (!arg.startsWith("-")) {
			workingDir = arg;
		}
	}

	return {
		workingDir: workingDir ? resolve(workingDir) : undefined,
		sandbox,
		downloadChannel: downloadChannelId,
	};
}

const parsedArgs = parseArgs();

if (parsedArgs.downloadChannel) {
	if (!MOM_SLACK_BOT_TOKEN) {
		console.error("Missing env: MOM_SLACK_BOT_TOKEN");
		process.exit(1);
	}
	await downloadChannel(parsedArgs.downloadChannel, MOM_SLACK_BOT_TOKEN);
	process.exit(0);
}

if (!parsedArgs.workingDir) {
	console.error("Usage: mom [--sandbox=host|docker:<name>] <working-directory>");
	console.error("       mom --download <channel-id>");
	process.exit(1);
}

const workingDir = parsedArgs.workingDir;
const sandbox = parsedArgs.sandbox;

let ingressMode: SlackIngressMode;
let httpPort = 3000;
let httpEventsPath = "/slack/events";
let allowedTeamIds: ReadonlySet<string> | undefined;
try {
	ingressMode = parseSlackIngressMode(process.env.MOM_SLACK_INGRESS_MODE);
	if (ingressMode === "http") {
		httpPort = parseHttpPort(process.env.PORT);
		httpEventsPath = parseEventsPath(process.env.MOM_SLACK_EVENTS_PATH);
		allowedTeamIds = parseAllowedTeamIds(process.env.MOM_SLACK_ALLOWED_TEAM_IDS);
	}
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}

if (!MOM_SLACK_BOT_TOKEN) {
	console.error("Missing env: MOM_SLACK_BOT_TOKEN");
	process.exit(1);
}
if (ingressMode === "socket" && !MOM_SLACK_APP_TOKEN) {
	console.error("Missing env: MOM_SLACK_APP_TOKEN");
	process.exit(1);
}
if (ingressMode === "http" && !SLACK_SIGNING_SECRET) {
	console.error("Missing env: SLACK_SIGNING_SECRET");
	process.exit(1);
}

process.chdir(workingDir);
await validateSandbox(sandbox);

const trustConfig = resolveMomTrustConfig(workingDir);
validateStrictTrustBoundary(workingDir, trustConfig);

log.logStartup(workingDir, sandbox.type === "host" ? "host" : `docker:${sandbox.container}`);
if (trustConfig.strict) {
	log.logInfo(`Strict trusted-extension mode enabled: ${trustConfig.trustedRoot}`);
}

const conversationStates = new Map<string, ConversationState>();
const channelExecutionStates = new Map<string, ChannelExecutionState>();

function getState(scope: ConversationScope): ConversationState {
	let state = conversationStates.get(scope.key);
	if (!state) {
		const channelDir = join(workingDir, scope.channelId);
		const sessionDir = scope.kind === "thread" ? join(channelDir, "sessions", scope.threadRootTs!) : channelDir;
		state = {
			store: new ChannelStore({ workingDir, botToken: MOM_SLACK_BOT_TOKEN! }),
			channelDir,
			sessionDir,
			conversationKey: scope.key,
		};
		conversationStates.set(scope.key, state);
	}
	return state;
}

function getChannelExecutionState(channelId: string): ChannelExecutionState {
	let state = channelExecutionStates.get(channelId);
	if (!state) {
		state = {
			running: false,
			activeRunId: 0,
			stopRequested: false,
		};
		channelExecutionStates.set(channelId, state);
	}
	return state;
}

function ensureRunner(state: ConversationState, scope: ConversationScope): AgentRunner {
	if (!state.runner) {
		state.runner = createRunner({
			sandboxConfig: sandbox,
			channelId: scope.channelId,
			conversationKey: state.conversationKey,
			conversationScope: scope,
			channelDir: state.channelDir,
			sessionDir: state.sessionDir,
			workspaceDir: workingDir,
			trustConfig,
		});
	}
	return state.runner;
}

function createSlackContext(
	event: SlackEvent,
	scope: ConversationScope,
	slack: SlackBot,
	isEvent = false,
): SlackContext {
	let messageTs: string | null = null;
	const threadMessageTs: string[] = [];
	let accumulatedText = "";
	let isWorking = true;
	let finalMessageLogged = false;
	let updatePromise = Promise.resolve();

	const workingIndicator = " ...";
	const user = slack.getUser(event.user);
	const conversationThreadRootTs = scope.threadRootTs;
	const eventFilename = isEvent ? event.text.match(/^\[EVENT:([^:]+):/)?.[1] : undefined;

	const postPrimaryMessage = async (text: string): Promise<string> => {
		return slack.postConversationMessage(event.channel, conversationThreadRootTs, text);
	};

	const updatePrimaryMessage = async (text: string): Promise<void> => {
		if (messageTs) {
			await slack.updateMessage(event.channel, messageTs, text);
			return;
		}
		messageTs = await postPrimaryMessage(text);
	};

	const respond: SlackContext["respond"] = async (text, shouldLog = false) => {
		updatePromise = updatePromise.then(async () => {
			try {
				accumulatedText = accumulatedText ? `${accumulatedText}\n${text}` : text;
				const displayText = isWorking
					? truncateSlackText(accumulatedText, MAX_MAIN_MESSAGE_LENGTH, TRUNCATION_NOTE) + workingIndicator
					: truncateSlackText(accumulatedText, MAX_MAIN_MESSAGE_LENGTH, TRUNCATION_NOTE);
				await updatePrimaryMessage(displayText);
				if (shouldLog && messageTs) {
					slack.logBotResponse(event.channel, text, messageTs, conversationThreadRootTs);
				}
			} catch (error) {
				log.logWarning("Slack respond error", error instanceof Error ? error.message : String(error));
			}
		});
		await updatePromise;
	};

	const publishFinal: SlackContext["publishFinal"] = async (text, shouldLog = false) => {
		updatePromise = updatePromise.then(async () => {
			try {
				const { mainText } = await publishSplitFinalSlackReply({
					text,
					updateMainMessage: async (nextText) => {
						accumulatedText = nextText;
						await updatePrimaryMessage(accumulatedText);
					},
					postInThread: async (overflowPart) => {
						const ts = await slack.postInThread(
							event.channel,
							conversationThreadRootTs ?? messageTs!,
							overflowPart,
						);
						threadMessageTs.push(ts);
					},
				});
				if (shouldLog && !finalMessageLogged && messageTs) {
					slack.logBotResponse(event.channel, mainText, messageTs, conversationThreadRootTs);
					finalMessageLogged = true;
				}
			} catch (error) {
				log.logWarning("Slack publishFinal error", error instanceof Error ? error.message : String(error));
			}
		});
		await updatePromise;
	};

	const respondInThread: SlackContext["respondInThread"] = async (text) => {
		updatePromise = updatePromise.then(async () => {
			try {
				const threadRootTs = conversationThreadRootTs ?? messageTs;
				if (!threadRootTs) {
					return;
				}

				const threadText = truncateSlackText(text, MAX_THREAD_MESSAGE_LENGTH, THREAD_TRUNCATION_NOTE);
				const ts = await slack.postInThread(event.channel, threadRootTs, threadText);
				threadMessageTs.push(ts);
			} catch (error) {
				log.logWarning("Slack respondInThread error", error instanceof Error ? error.message : String(error));
			}
		});
		await updatePromise;
	};

	return {
		message: {
			text: event.text,
			rawText: event.text,
			user: event.user,
			userName: user?.userName,
			channel: event.channel,
			ts: event.ts,
			threadTs: conversationThreadRootTs ?? event.threadTs,
			attachments: (event.attachments || []).map((attachment) => ({ local: attachment.local })),
			slack: event.metadata,
		},
		channelName: slack.getChannel(event.channel)?.name,
		isEvent,
		channels: slack.getAllChannels().map((channel) => ({ id: channel.id, name: channel.name })),
		users: slack.getAllUsers().map((slackUser) => ({
			id: slackUser.id,
			userName: slackUser.userName,
			displayName: slackUser.displayName,
		})),
		respond,
		publishFinal,
		replaceMessage: async (text) => publishFinal(text, false),
		respondInThread,
		setTyping: async (isTyping) => {
			if (!isTyping || messageTs) {
				return;
			}

			updatePromise = updatePromise.then(async () => {
				try {
					if (!messageTs) {
						accumulatedText = eventFilename ? `_Starting event: ${eventFilename}_` : "_Thinking_";
						messageTs = await postPrimaryMessage(`${accumulatedText}${workingIndicator}`);
					}
				} catch (error) {
					log.logWarning("Slack setTyping error", error instanceof Error ? error.message : String(error));
				}
			});
			await updatePromise;
		},
		uploadFile: async (filePath, title) => {
			await slack.uploadFile(event.channel, filePath, title);
		},
		setWorking: async (working) => {
			updatePromise = updatePromise.then(async () => {
				try {
					isWorking = working;
					if (messageTs) {
						const displayText = isWorking ? `${accumulatedText}${workingIndicator}` : accumulatedText;
						await slack.updateMessage(event.channel, messageTs, displayText);
					}
				} catch (error) {
					log.logWarning("Slack setWorking error", error instanceof Error ? error.message : String(error));
				}
			});
			await updatePromise;
		},
		deleteMessage: async () => {
			updatePromise = updatePromise.then(async () => {
				for (let index = threadMessageTs.length - 1; index >= 0; index--) {
					try {
						await slack.deleteMessage(event.channel, threadMessageTs[index]);
					} catch {
						// Ignore thread deletion failures
					}
				}
				threadMessageTs.length = 0;
				if (messageTs) {
					await slack.deleteMessage(event.channel, messageTs);
					messageTs = null;
				}
			});
			await updatePromise;
		},
	};
}

const handler: MomHandler = {
	async handleStop(event: SlackEvent, scope: ConversationScope, slack: SlackBot): Promise<void> {
		const executionState = channelExecutionStates.get(resolveExecutionChannelId(scope));
		const cancelledQueuedRuns = slack.cancelQueuedConversation(scope);
		const plan = resolveStopHandlingPlan({
			hasActiveRun: executionState?.running === true && executionState.activeRunner !== undefined,
			activeTarget: executionState?.activeTarget,
			requesterScope: scope,
			cancelledQueuedRuns,
		});

		if (plan.abortActive && executionState?.activeRunner) {
			const activeRunner = executionState.activeRunner;
			abortActiveRunAndRequestStopStatus({
				slack,
				executionState,
				requesterScope: scope,
				abort: () => activeRunner.abort(),
				onWarning: (summary, detail) => log.logWarning(`[${scope.key}] ${summary}`, detail),
			});
			return;
		}

		if (plan.postImmediateStopped) {
			await slack.postConversationMessage(event.channel, scope.threadRootTs, "_Stopped_");
			return;
		}

		await slack.postConversationMessage(event.channel, scope.threadRootTs, "_Nothing running_");
	},

	async handleEvent(event: SlackEvent, scope: ConversationScope, slack: SlackBot, isEvent = false): Promise<void> {
		const state = getState(scope);
		const runner = ensureRunner(state, scope);
		const executionState = getChannelExecutionState(resolveExecutionChannelId(scope));
		executionState.running = true;
		executionState.activeRunId += 1;
		executionState.activeRunner = runner;
		executionState.activeTarget = resolveConversationMessageTarget(scope);
		executionState.stopRequested = false;
		executionState.stopMessageTs = undefined;
		executionState.stopStatusRequestId = undefined;
		executionState.stopStatusPromise = undefined;

		log.logInfo(`[${scope.key}] Starting run: ${event.text.substring(0, 50)}`);

		try {
			const ctx = createSlackContext(event, scope, slack, isEvent);
			const result = await runner.run(ctx, state.store);
			await ctx.setWorking(false);

			if (result.fatalInitializationError) {
				state.runner = undefined;
			}

			if (result.stopReason === "aborted" && executionState.stopRequested) {
				try {
					await publishStoppedStatus({
						slack,
						executionState,
						fallbackScope: scope,
					});
				} catch (error) {
					log.logWarning(
						`[${scope.key}] Stop status update failed`,
						error instanceof Error ? error.message : String(error),
					);
				}
			}
		} catch (error) {
			log.logWarning(`[${scope.key}] Run error`, error instanceof Error ? error.message : String(error));
		} finally {
			executionState.running = false;
			executionState.activeRunner = undefined;
			executionState.activeTarget = undefined;
			executionState.stopRequested = false;
			executionState.stopMessageTs = undefined;
			executionState.stopStatusRequestId = undefined;
			executionState.stopStatusPromise = undefined;
		}
	},
};

const sharedStore = new ChannelStore({ workingDir, botToken: MOM_SLACK_BOT_TOKEN! });
const bot = new SlackBotClass(handler, {
	botToken: MOM_SLACK_BOT_TOKEN,
	workingDir,
	store: sharedStore,
});
const ingress: SlackIngress =
	ingressMode === "socket"
		? {
				start: () => bot.startSocketMode(MOM_SLACK_APP_TOKEN!),
				stop: () => bot.stopSocketMode(),
			}
		: new SlackHttpIngress({
				bot,
				signingSecret: SLACK_SIGNING_SECRET!,
				port: httpPort,
				eventsPath: httpEventsPath,
				allowedTeamIds,
			});

const eventsWatcher = createEventsWatcher(workingDir, bot);
eventsWatcher.start();

function shutdown(): void {
	log.logInfo("Shutting down...");
	eventsWatcher.stop();
	void ingress.stop().finally(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await ingress.start();

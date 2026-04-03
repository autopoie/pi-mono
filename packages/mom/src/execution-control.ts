import type { ConversationScope } from "./conversation-scope.js";
import type { SlackBot } from "./slack.js";

export interface ConversationMessageTarget {
	channelId: string;
	threadRootTs?: string;
}

export interface StopStatusState {
	stopRequested: boolean;
	stopMessageTs?: string;
	activeTarget?: ConversationMessageTarget;
	activeRunId?: number;
	stopStatusRequestId?: number;
	stopStatusPromise?: Promise<string | undefined>;
}

export interface RequestedStopStatus {
	activeTarget: ConversationMessageTarget;
	requesterTarget?: ConversationMessageTarget;
	requesterMessage?: string;
	shouldPostStopping: boolean;
	runId: number;
	requestId: number;
}

type StopStatusLogger = (summary: string, detail: string) => void;

function sameConversationMessageTarget(left: ConversationMessageTarget, right: ConversationMessageTarget): boolean {
	return left.channelId === right.channelId && left.threadRootTs === right.threadRootTs;
}

export function resolveConversationMessageTarget(scope: ConversationScope): ConversationMessageTarget {
	return {
		channelId: scope.channelId,
		threadRootTs: scope.threadRootTs,
	};
}

export function requestStopStatus(params: {
	executionState: StopStatusState;
	requesterScope: ConversationScope;
}): RequestedStopStatus {
	const { executionState, requesterScope } = params;
	const requesterTarget = resolveConversationMessageTarget(requesterScope);
	const activeTarget = executionState.activeTarget ?? requesterTarget;
	const runId = executionState.activeRunId ?? 0;

	if (executionState.stopRequested) {
		return {
			activeTarget,
			requesterTarget: sameConversationMessageTarget(activeTarget, requesterTarget) ? undefined : requesterTarget,
			requesterMessage: sameConversationMessageTarget(activeTarget, requesterTarget)
				? undefined
				: "_Stop already requested for active run in another thread._",
			shouldPostStopping: false,
			runId,
			requestId: executionState.stopStatusRequestId ?? 0,
		};
	}

	executionState.stopRequested = true;
	const requestId = (executionState.stopStatusRequestId ?? 0) + 1;
	executionState.stopStatusRequestId = requestId;
	return {
		activeTarget,
		requesterTarget: sameConversationMessageTarget(activeTarget, requesterTarget) ? undefined : requesterTarget,
		requesterMessage: sameConversationMessageTarget(activeTarget, requesterTarget)
			? undefined
			: "_Stop requested for active run in another thread._",
		shouldPostStopping: true,
		runId,
		requestId,
	};
}

export async function postRequestedStopStatus(params: {
	slack: Pick<SlackBot, "postConversationMessage">;
	executionState: StopStatusState;
	requestedStatus: RequestedStopStatus;
	onWarning?: StopStatusLogger;
}): Promise<void> {
	const { slack, executionState, requestedStatus, onWarning } = params;

	if (requestedStatus.shouldPostStopping) {
		executionState.stopStatusPromise = (async () => {
			try {
				const stopMessageTs = await slack.postConversationMessage(
					requestedStatus.activeTarget.channelId,
					requestedStatus.activeTarget.threadRootTs,
					"_Stopping..._",
				);
				if (
					executionState.activeRunId === requestedStatus.runId &&
					executionState.stopStatusRequestId === requestedStatus.requestId
				) {
					executionState.stopMessageTs = stopMessageTs;
				}
				return stopMessageTs;
			} catch (error) {
				onWarning?.("Stop status post failed", error instanceof Error ? error.message : String(error));
				return undefined;
			}
		})();
	}

	if (requestedStatus.requesterTarget && requestedStatus.requesterMessage) {
		try {
			await slack.postConversationMessage(
				requestedStatus.requesterTarget.channelId,
				requestedStatus.requesterTarget.threadRootTs,
				requestedStatus.requesterMessage,
			);
		} catch (error) {
			onWarning?.("Stop acknowledgement post failed", error instanceof Error ? error.message : String(error));
		}
	}
}

export function abortActiveRunAndRequestStopStatus(params: {
	slack: Pick<SlackBot, "postConversationMessage">;
	executionState: StopStatusState;
	requesterScope: ConversationScope;
	abort: () => void;
	onWarning?: StopStatusLogger;
}): void {
	const { slack, executionState, requesterScope, abort, onWarning } = params;
	const requestedStatus = requestStopStatus({
		executionState,
		requesterScope,
	});
	abort();
	void postRequestedStopStatus({
		slack,
		executionState,
		requestedStatus,
		onWarning,
	});
}

export async function publishStoppedStatus(params: {
	slack: Pick<SlackBot, "postConversationMessage" | "updateMessage">;
	executionState: StopStatusState;
	fallbackScope?: ConversationScope;
}): Promise<void> {
	const { slack, executionState, fallbackScope } = params;
	const activeTarget =
		executionState.activeTarget ?? (fallbackScope ? resolveConversationMessageTarget(fallbackScope) : undefined);
	if (!activeTarget) {
		return;
	}

	const settledStopMessageTs = executionState.stopStatusPromise ? await executionState.stopStatusPromise : undefined;
	const stopMessageTs = executionState.stopMessageTs ?? settledStopMessageTs;
	executionState.stopMessageTs = undefined;
	executionState.stopStatusPromise = undefined;
	executionState.stopStatusRequestId = undefined;
	if (stopMessageTs) {
		await slack.updateMessage(activeTarget.channelId, stopMessageTs, "_Stopped_");
		return;
	}

	await slack.postConversationMessage(activeTarget.channelId, activeTarget.threadRootTs, "_Stopped_");
}

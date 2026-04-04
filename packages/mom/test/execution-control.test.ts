import { describe, expect, it, vi } from "vitest";

import { resolveConversationScope } from "../src/conversation-scope.js";
import {
	abortActiveRunAndRequestStopStatus,
	canStopActiveTarget,
	isSameConversationTarget,
	postRequestedStopStatus,
	publishStoppedStatus,
	requestStopStatus,
	resolveConversationMessageTarget,
	resolveStopHandlingPlan,
	type StopStatusState,
} from "../src/execution-control.js";

function createSlackStub() {
	return {
		postConversationMessage: vi.fn(
			async (_channel: string, _threadRootTs: string | undefined, _text: string) => "stop-ts-1",
		),
		updateMessage: vi.fn(async () => {}),
	};
}

function flushPromises(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

function createChannelRootExecutionTarget(channelId: string) {
	return { channelId };
}

describe("mom execution control", () => {
	it("allows a thread to stop only its own active mention run", () => {
		const activeTarget = resolveConversationMessageTarget(
			resolveConversationScope({
				type: "mention",
				channel: "C123",
				ts: "2000.1",
				threadTs: "2000.1",
			}),
		);
		const requesterScope = resolveConversationScope({
			type: "mention",
			channel: "C123",
			ts: "2000.1",
			threadTs: "2000.1",
		});

		expect(isSameConversationTarget({ target: activeTarget, requesterScope })).toBe(true);
		expect(canStopActiveTarget({ activeTarget, requesterScope })).toBe(true);
	});

	it("does not let a different mention thread stop the active mention run", () => {
		const activeTarget = resolveConversationMessageTarget(
			resolveConversationScope({
				type: "mention",
				channel: "C123",
				ts: "2000.1",
				threadTs: "2000.1",
			}),
		);
		const requesterScope = resolveConversationScope({
			type: "mention",
			channel: "C123",
			ts: "3000.1",
			threadTs: "3000.1",
		});

		expect(isSameConversationTarget({ target: activeTarget, requesterScope })).toBe(false);
		expect(canStopActiveTarget({ activeTarget, requesterScope })).toBe(false);
	});

	it("still lets same-channel stop interrupt a channel-scoped active run", () => {
		const requesterScope = resolveConversationScope({
			type: "mention",
			channel: "C123",
			ts: "3000.1",
			threadTs: "3000.1",
		});

		expect(
			canStopActiveTarget({
				activeTarget: createChannelRootExecutionTarget("C123"),
				requesterScope,
			}),
		).toBe(true);
	});

	it("cancels queued requester work without aborting another active mention thread", () => {
		const requesterScope = resolveConversationScope({
			type: "mention",
			channel: "C123",
			ts: "3000.1",
			threadTs: "3000.1",
		});

		expect(
			resolveStopHandlingPlan({
				hasActiveRun: true,
				activeTarget: resolveConversationMessageTarget(
					resolveConversationScope({
						type: "mention",
						channel: "C123",
						ts: "2000.1",
						threadTs: "2000.1",
					}),
				),
				requesterScope,
				cancelledQueuedRuns: 1,
			}),
		).toEqual({
			abortActive: false,
			postImmediateStopped: true,
		});
	});

	it("still aborts a channel-root active run even when the requester also cancelled queued work", () => {
		const requesterScope = resolveConversationScope({
			type: "mention",
			channel: "C123",
			ts: "3000.1",
			threadTs: "3000.1",
		});

		expect(
			resolveStopHandlingPlan({
				hasActiveRun: true,
				activeTarget: createChannelRootExecutionTarget("C123"),
				requesterScope,
				cancelledQueuedRuns: 1,
			}),
		).toEqual({
			abortActive: true,
			postImmediateStopped: false,
		});
	});

	it("updates channel-root event stop status when stop is requested from a thread", async () => {
		const slack = createSlackStub();
		const executionState: StopStatusState = {
			stopRequested: false,
			activeRunId: 1,
			activeTarget: createChannelRootExecutionTarget("C123"),
		};
		const requesterScope = resolveConversationScope({
			type: "mention",
			channel: "C123",
			ts: "3000.1",
			threadTs: "3000.1",
		});

		const requestedStatus = requestStopStatus({
			executionState,
			requesterScope,
		});
		await postRequestedStopStatus({
			slack,
			executionState,
			requestedStatus,
		});
		await publishStoppedStatus({
			slack,
			executionState,
			fallbackScope: requesterScope,
		});

		expect(slack.postConversationMessage).toHaveBeenNthCalledWith(1, "C123", undefined, "_Stopping..._");
		expect(slack.postConversationMessage).toHaveBeenNthCalledWith(
			2,
			"C123",
			"3000.1",
			"_Stop requested for active run in another thread._",
		);
		expect(slack.updateMessage).toHaveBeenCalledWith("C123", "stop-ts-1", "_Stopped_");
	});

	it("aborts even if stopping status post fails", async () => {
		const slack = {
			postConversationMessage: vi.fn(async () => {
				throw new Error("status failed");
			}),
		};
		const executionState: StopStatusState = {
			stopRequested: false,
			activeRunId: 1,
			activeTarget: resolveConversationMessageTarget(
				resolveConversationScope({
					type: "mention",
					channel: "C123",
					ts: "2000.1",
					threadTs: "2000.1",
				}),
			),
		};
		const abort = vi.fn();
		const onWarning = vi.fn();

		abortActiveRunAndRequestStopStatus({
			slack,
			executionState,
			requesterScope: resolveConversationScope({
				type: "mention",
				channel: "C123",
				ts: "2000.1",
				threadTs: "2000.1",
			}),
			abort,
			onWarning,
		});

		expect(abort).toHaveBeenCalledTimes(1);
		await flushPromises();
		expect(onWarning).toHaveBeenCalledWith("Stop status post failed", "status failed");
	});

	it("aborts before cross-thread acknowledgement completes", async () => {
		let resolveAck: (() => void) | undefined;
		const ackPromise = new Promise<string>((resolve) => {
			resolveAck = () => resolve("ack-ts");
		});
		const slack = {
			postConversationMessage: vi
				.fn()
				.mockResolvedValueOnce("stop-ts-1")
				.mockImplementationOnce(() => ackPromise),
		};
		const executionState: StopStatusState = {
			stopRequested: false,
			activeRunId: 1,
			activeTarget: resolveConversationMessageTarget(
				resolveConversationScope({
					type: "mention",
					channel: "C123",
					ts: "2000.1",
					threadTs: "2000.1",
				}),
			),
		};
		const abort = vi.fn();

		abortActiveRunAndRequestStopStatus({
			slack,
			executionState,
			requesterScope: resolveConversationScope({
				type: "mention",
				channel: "C123",
				ts: "3000.1",
				threadTs: "3000.1",
			}),
			abort,
		});

		expect(abort).toHaveBeenCalledTimes(1);
		await flushPromises();
		expect(slack.postConversationMessage).toHaveBeenNthCalledWith(1, "C123", "2000.1", "_Stopping..._");
		expect(slack.postConversationMessage).toHaveBeenNthCalledWith(
			2,
			"C123",
			"3000.1",
			"_Stop requested for active run in another thread._",
		);
		resolveAck?.();
		await flushPromises();
	});

	it("waits for delayed stopping status before publishing stopped", async () => {
		let resolveStopping: ((value: string) => void) | undefined;
		const stoppingPromise = new Promise<string>((resolve) => {
			resolveStopping = resolve;
		});
		const slack = {
			postConversationMessage: vi.fn().mockImplementationOnce(() => stoppingPromise),
			updateMessage: vi.fn(async () => {}),
		};
		const executionState: StopStatusState = {
			stopRequested: false,
			activeRunId: 1,
			activeTarget: resolveConversationMessageTarget(
				resolveConversationScope({
					type: "mention",
					channel: "C123",
					ts: "2000.1",
					threadTs: "2000.1",
				}),
			),
		};
		const requestedStatus = requestStopStatus({
			executionState,
			requesterScope: resolveConversationScope({
				type: "mention",
				channel: "C123",
				ts: "2000.1",
				threadTs: "2000.1",
			}),
		});
		const postPromise = postRequestedStopStatus({
			slack,
			executionState,
			requestedStatus,
		});
		const stoppedPromise = publishStoppedStatus({
			slack,
			executionState,
			fallbackScope: resolveConversationScope({
				type: "mention",
				channel: "C123",
				ts: "2000.1",
				threadTs: "2000.1",
			}),
		});

		await flushPromises();
		expect(slack.updateMessage).not.toHaveBeenCalled();
		resolveStopping?.("stop-ts-1");
		await postPromise;
		await stoppedPromise;
		expect(slack.updateMessage).toHaveBeenCalledWith("C123", "stop-ts-1", "_Stopped_");
	});

	it("late stopping status completion cannot clobber the next run state", async () => {
		let resolveStopping: ((value: string) => void) | undefined;
		const stoppingPromise = new Promise<string>((resolve) => {
			resolveStopping = resolve;
		});
		const slack = {
			postConversationMessage: vi.fn().mockImplementationOnce(() => stoppingPromise),
		};
		const executionState: StopStatusState = {
			stopRequested: false,
			activeRunId: 1,
			activeTarget: resolveConversationMessageTarget(
				resolveConversationScope({
					type: "mention",
					channel: "C123",
					ts: "2000.1",
					threadTs: "2000.1",
				}),
			),
		};
		const requestedStatus = requestStopStatus({
			executionState,
			requesterScope: resolveConversationScope({
				type: "mention",
				channel: "C123",
				ts: "2000.1",
				threadTs: "2000.1",
			}),
		});
		const postPromise = postRequestedStopStatus({
			slack,
			executionState,
			requestedStatus,
		});

		executionState.activeRunId = 2;
		executionState.stopRequested = false;
		executionState.stopMessageTs = undefined;
		executionState.stopStatusRequestId = undefined;
		executionState.stopStatusPromise = undefined;
		executionState.activeTarget = resolveConversationMessageTarget(
			resolveConversationScope({
				type: "mention",
				channel: "C123",
				ts: "5000.1",
				threadTs: "5000.1",
			}),
		);

		resolveStopping?.("stop-ts-1");
		await postPromise;
		expect(executionState.stopMessageTs).toBeUndefined();
	});

	it("logs status failures as best-effort warnings", async () => {
		const slack = {
			postConversationMessage: vi
				.fn()
				.mockResolvedValueOnce("stop-ts-1")
				.mockRejectedValueOnce(new Error("ack failed")),
		};
		const executionState: StopStatusState = {
			stopRequested: false,
			activeRunId: 1,
			activeTarget: resolveConversationMessageTarget(
				resolveConversationScope({
					type: "mention",
					channel: "C123",
					ts: "2000.1",
					threadTs: "2000.1",
				}),
			),
		};
		const onWarning = vi.fn();

		const requestedStatus = requestStopStatus({
			executionState,
			requesterScope: resolveConversationScope({
				type: "mention",
				channel: "C123",
				ts: "3000.1",
				threadTs: "3000.1",
			}),
		});
		await postRequestedStopStatus({
			slack,
			executionState,
			requestedStatus,
			onWarning,
		});

		expect(onWarning).toHaveBeenCalledWith("Stop acknowledgement post failed", "ack failed");
	});
});

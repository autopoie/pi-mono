import { describe, expect, it } from "vitest";

import { resolveConversationScope, resolveExecutionChannelId } from "../src/conversation-scope.js";

describe("mom conversation scope", () => {
	it("uses one key per mention thread in the same channel", () => {
		const root = resolveConversationScope({
			type: "mention",
			channel: "C123",
			ts: "1000.1",
			threadTs: "1000.1",
		});
		const replyInSameThread = resolveConversationScope({
			type: "mention",
			channel: "C123",
			ts: "1005.1",
			threadTs: "1000.1",
		});
		const otherThread = resolveConversationScope({
			type: "mention",
			channel: "C123",
			ts: "2000.1",
			threadTs: "2000.1",
		});

		expect(root).toEqual({
			kind: "thread",
			key: "C123:1000.1",
			channelId: "C123",
			threadRootTs: "1000.1",
		});
		expect(replyInSameThread.key).toBe("C123:1000.1");
		expect(otherThread.key).toBe("C123:2000.1");
		expect(root.key).not.toBe(otherThread.key);
	});

	it("uses the message timestamp as the root for new mention threads", () => {
		const root = resolveConversationScope({
			type: "mention",
			channel: "C123",
			ts: "1000.1",
		});

		expect(root).toEqual({
			kind: "thread",
			key: "C123:1000.1",
			channelId: "C123",
			threadRootTs: "1000.1",
		});
	});

	it("keeps DMs channel-scoped", () => {
		const dm = resolveConversationScope({
			type: "dm",
			channel: "D123",
			ts: "3000.1",
		});

		expect(dm).toEqual({
			kind: "channel",
			key: "D123",
			channelId: "D123",
		});
	});

	it("separates per-thread session identity from per-channel execution identity", () => {
		const firstThread = resolveConversationScope({
			type: "mention",
			channel: "C123",
			ts: "1000.1",
			threadTs: "1000.1",
		});
		const secondThread = resolveConversationScope({
			type: "mention",
			channel: "C123",
			ts: "2000.1",
			threadTs: "2000.1",
		});
		const eventScope = resolveConversationScope(
			{
				type: "mention",
				channel: "C123",
				ts: "4000.1",
				threadTs: "1000.1",
			},
			{ isEvent: true },
		);

		expect(resolveExecutionChannelId(firstThread)).toBe("C123");
		expect(resolveExecutionChannelId(secondThread)).toBe("C123");
		expect(resolveExecutionChannelId(eventScope)).toBe("C123");
		expect(eventScope).toEqual({
			kind: "channel",
			key: "C123",
			channelId: "C123",
		});
	});
});

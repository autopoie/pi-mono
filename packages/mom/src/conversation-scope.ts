export interface ConversationScopeInput {
	type: "mention" | "dm";
	channel: string;
	ts: string;
	threadTs?: string;
}

export interface ConversationScope {
	kind: "channel" | "thread";
	key: string;
	channelId: string;
	threadRootTs?: string;
}

export function resolveExecutionChannelId(scope: ConversationScope): string {
	return scope.channelId;
}

export function resolveConversationScope(
	input: ConversationScopeInput,
	options?: { isEvent?: boolean },
): ConversationScope {
	if (input.type === "dm" || options?.isEvent) {
		return {
			kind: "channel",
			key: input.channel,
			channelId: input.channel,
		};
	}

	const threadRootTs = input.threadTs ?? input.ts;
	return {
		kind: "thread",
		key: `${input.channel}:${threadRootTs}`,
		channelId: input.channel,
		threadRootTs,
	};
}

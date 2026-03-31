# Extensions and trust model

`mom` supports two extension modes: strict and permissive.

## Strict mode

Set `MOM_TRUSTED_EXTENSION_ROOT` to an absolute path outside the workspace to enable strict mode.

In strict mode:
- only extensions from the trusted root are loaded
- workspace `.pi/settings.json` is still read for `defaultProvider`, `defaultModel`, and `hideThinkingBlock`
- workspace `extensions` and `packages` settings do not affect extension loading
- mom refuses to start if the workspace contains its own extension infrastructure (any `.pi/extensions` directory or `.ts`/`.js` files under an `extensions/` directory anywhere in the workspace tree)
- trusted entries are loaded deterministically from the trusted root

Symlinks within the trusted root that resolve back into the workspace are rejected.

## Permissive mode

Permissive mode is the default when `MOM_TRUSTED_EXTENSION_ROOT` is not set.

In permissive mode, `mom` loads extensions from:
- `workspace/.pi/settings.json` `extensions`, in listed order
- `workspace/.pi/extensions`, discovered deterministically

`mom` does not load extensions from `settings.packages`, the home directory, or the global agent directory.

## Discovery rules

Extension discovery follows the same rules in both modes:
- a `.ts` or `.js` file is loaded directly
- a directory contributes its immediate `.ts` and `.js` children
- an immediate subdirectory contributes its `index.ts` or `index.js` if present (no deeper recursion)
- entries within a root are sorted lexicographically by relative path
- if the same file appears more than once (after symlink resolution), only the first occurrence is kept

## Runtime behavior

Extensions run in the `mom` host process, not inside the bash sandbox.

Each run exposes Slack-aware context to extension hooks, including channel, user, thread, message, and session metadata.

Before the LLM sees a message, `mom` emits the raw Slack text as an `input` event with `source: "interactive"`. Extensions can intercept this event to handle messages directly. When an extension handles the input, the LLM is never called: no thinking indicator, tool calls, or agent turns occur for that message.

If no extension handles the raw input, `mom` formats the prompt and sends it through the normal agent path, which emits a second `input` event with `source: "extension"`. Extensions that only want to intercept raw Slack messages should ignore events where `source === "extension"`.

During a normal LLM turn, extensions can observe and modify behavior through hooks such as `input`, `before_agent_start`, `context`, `turn_start`, `turn_end`, `tool_call`, `tool_result`, `tool_execution_end`, `before_provider_request`, and `model_select`.

`tool_result` hooks mutate the stored tool result. If a handler returns patched `content` or `details`, that rewritten value is persisted in session context and can affect both later parts of the current turn and future turns. If a `tool_result` handler has already rewritten the result, `mom-display-control` cannot recover the original — it can only control how the already-final result is presented in Slack.

For Slack-only presentation changes, use `tool_execution_end` plus the mom-local display-control bridge described below.

## Built-in Slack bridge

`mom` bridges extension `pi.sendMessage(...)` calls to Slack.

### `mom-direct-response`

The built-in `mom-direct-response` custom type supports:
- `content.mainText` — primary visible Slack reply
- `content.threadText` — optional secondary thread reply

`mom` always renders this custom type to Slack, even when `display: false`.

### `mom-display-control`

`mom-display-control` controls what mom shows in Slack without affecting session context or model behavior. Display instructions apply only to the current run, use text fields in `message.details`, and ignore `display` and `deliverAs`.

`sendMessage()` requires `message.content`, but mom ignores it for this custom type.

Supported payloads:

```ts
type MomDisplayInstruction =
  | {
      target: "tool_result";
      toolCallId: string;
      hideDefault?: boolean;
      resultText?: string;
      threadText?: string;
    }
  | {
      target: "usage_summary";
      hideDefault?: boolean;
      threadText?: string;
    };
```

Semantics:
- `target: "tool_result"`
  - `resultText` replaces the result body in mom's tool-result thread reply
  - `threadText` appends when `hideDefault !== true`
  - `threadText` replaces the default tool-result thread message when `hideDefault === true`
  - `hideDefault: true` suppresses both the default tool-result thread reply and the default main-message `_Error: ..._` echo for tool failures
- `target: "usage_summary"`
  - `hideDefault: true` suppresses the default usage-summary thread reply
  - `threadText` appends when `hideDefault !== true`
  - `threadText` replaces when `hideDefault === true`

For tool-result display, send `mom-display-control` from a `tool_execution_end` hook. For usage-summary display, send it from an earlier hook such as `before_agent_start`, `turn_start`, or `turn_end`.

### Example: redact one tool result in Slack without changing the stored tool result

```ts
pi.on("tool_execution_end", async (event) => {
  if (event.toolName !== "read") {
    return;
  }

  pi.sendMessage({
    customType: "mom-display-control",
    content: "ignored",
    details: {
      target: "tool_result",
      toolCallId: event.toolCallId,
      resultText: "[REDACTED]"
    }
  });
});
```

### Example: suppress the default usage summary for the current run

```ts
pi.on("turn_start", async () => {
  pi.sendMessage({
    customType: "mom-display-control",
    content: "ignored",
    details: {
      target: "usage_summary",
      hideDefault: true
    }
  });
});
```

For other custom message types, mom renders plain-string content to the Slack reply when `display !== false`. Non-string payloads are not rendered to Slack.

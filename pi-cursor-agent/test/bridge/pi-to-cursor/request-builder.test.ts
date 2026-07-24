import assert from "node:assert/strict";
import test from "node:test";
import type { Context, Message, Model } from "@mariozechner/pi-ai";
import { ConversationStateStructure } from "../../../src/__generated__/agent/v1/agent_pb.js";
import { buildRunRequest } from "../../../src/bridge/pi-to-cursor/request-builder.js";
import { createStateStore } from "../../../src/provider/state.js";
import {
  getBlobId,
  InMemoryBlobStore,
} from "../../../src/vendor/agent-kv/index.js";

const ASSISTANT_DEFAULTS = {
  api: "cursor-agent",
  provider: "cursor-agent",
  model: "grok-code-fast-1",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop" as const,
};

function createParams(options?: {
  messages?: Message[];
  conversationState?: ConversationStateStructure;
  state?: ReturnType<typeof createStateStore>;
}) {
  const blobStore = new InMemoryBlobStore();
  const model = {
    id: "grok-code-fast-1",
    name: "Grok",
    provider: "cursor-agent",
    api: "cursor-agent",
  } as Model<"cursor-agent">;

  const context = {
    systemPrompt: "You are a helpful assistant.",
    messages: options?.messages ?? [
      { role: "user", content: "Remember BANANA42.", timestamp: 1 },
      {
        role: "assistant",
        content: [{ type: "text", text: "OK" }],
        timestamp: 2,
        ...ASSISTANT_DEFAULTS,
      },
      { role: "user", content: "What code word?", timestamp: 3 },
    ],
  } satisfies Context;

  return {
    blobStore,
    params: {
      model,
      context,
      conversationId: "test",
      blobStore,
      conversationState: options?.conversationState,
      mcpToolDefinitions: [],
      ...(options?.state ? { state: options.state } : {}),
    },
  };
}

test("preserves cached conversation state", () => {
  const bytes = new TextEncoder().encode(
    JSON.stringify({ role: "system", content: "You are a helpful assistant." }),
  );
  const cached = new ConversationStateStructure({
    rootPromptMessagesJson: [getBlobId(bytes)],
    turns: [new Uint8Array([1, 2, 3])],
    todos: [],
    pendingToolCalls: [],
    previousWorkspaceUris: [],
    fileStates: {},
    fileStatesV2: {},
    summaryArchives: [],
    turnTimings: [],
    subagentStates: {},
    selfSummaryCount: 0,
    readPaths: [],
  });

  const { params } = createParams({ conversationState: cached });
  const result = buildRunRequest(params);
  assert.equal(result.conversationState, cached);
});

test("seeds turns from prior messages when no cached state", () => {
  const { params, blobStore } = createParams();
  const result = buildRunRequest(params);

  assert.equal(result.conversationState.turns.length, 1);
  assert.ok(blobStore.store.size > 0);
  assert.equal(result.initialRequest.message.case, "runRequest");
});

test("reconstruction includes thinking and tool call blocks", () => {
  const state = createStateStore(() => {});
  state.rememberAssistantContent({
    timestamp: 2,
    blocks: [
      { type: "thinking", thinking: "Let me check." },
      { type: "text", text: "Checking..." },
      {
        type: "toolCall",
        id: "tc-1",
        name: "read",
        arguments: { path: "a.ts" },
      },
    ],
  });
  state.rememberToolCallMeta({
    toolCallId: "tc-1",
    cursorExecType: "read",
    piToolName: "read",
    piToolArgs: { path: "a.ts" },
    assistantTimestamp: 2,
  });

  const { params, blobStore } = createParams({
    messages: [
      { role: "user", content: "Read a.ts", timestamp: 1 },
      {
        role: "assistant",
        content: [{ type: "text", text: "Checking..." }],
        timestamp: 2,
        ...ASSISTANT_DEFAULTS,
      },
      {
        role: "toolResult",
        toolCallId: "tc-1",
        toolName: "read",
        content: [{ type: "text", text: "const x = 1;" }],
        isError: false,
        timestamp: 3,
      },
      { role: "user", content: "What is in a.ts?", timestamp: 4 },
    ],
    state,
  });

  const result = buildRunRequest(params);
  assert.equal(result.conversationState.turns.length, 1);
  assert.ok(blobStore.store.size >= 4);
});

test("tool result uses exec type label from stored meta", () => {
  const state = createStateStore(() => {});
  state.rememberToolCallMeta({
    toolCallId: "tc-sh",
    cursorExecType: "shell",
    piToolName: "bash",
    piToolArgs: { command: "echo hi" },
    assistantTimestamp: 2,
  });

  const { params } = createParams({
    messages: [
      { role: "user", content: "Run echo", timestamp: 1 },
      {
        role: "assistant",
        content: [{ type: "text", text: "Running..." }],
        timestamp: 2,
        ...ASSISTANT_DEFAULTS,
      },
      {
        role: "toolResult",
        toolCallId: "tc-sh",
        toolName: "bash",
        content: [{ type: "text", text: "hi" }],
        isError: false,
        timestamp: 3,
      },
      { role: "user", content: "Done?", timestamp: 4 },
    ],
    state,
  });

  assert.equal(buildRunRequest(params).conversationState.turns.length, 1);
});

test("reconstruction works without state", () => {
  const { params } = createParams({
    messages: [
      { role: "user", content: "Hi", timestamp: 1 },
      {
        role: "assistant",
        content: [{ type: "text", text: "Hello!" }],
        timestamp: 2,
        ...ASSISTANT_DEFAULTS,
      },
      { role: "user", content: "Bye", timestamp: 3 },
    ],
  });

  assert.equal(buildRunRequest(params).conversationState.turns.length, 1);
});

function getActionUserText(result: ReturnType<typeof buildRunRequest>): string {
  assert.equal(result.initialRequest.message.case, "runRequest");
  const runRequest = result.initialRequest.message.value;
  assert.equal(runRequest.action?.action.case, "userMessageAction");
  const userMessage = runRequest.action?.action.value.userMessage;
  assert.ok(userMessage);
  return userMessage.text;
}

test("joins trailing consecutive user messages for the Cursor action", () => {
  const roster =
    "<system-reminder>\nYou can launch separate helper agents\n<subagent-roster>\n- `scout`: Fast recon\n</subagent-roster>\n</system-reminder>";
  const { params } = createParams({
    messages: [
      { role: "user", content: "push to github", timestamp: 1 },
      { role: "user", content: roster, timestamp: 2 },
    ],
  });

  const result = buildRunRequest(params);
  assert.equal(getActionUserText(result), `push to github\n\n${roster}`);
  // Prompt + roster are the open turn; do not seed a history turn for the prompt alone.
  assert.equal(result.conversationState.turns.length, 0);
});

test("keeps prior completed turns when trailing custom user notes follow a new prompt", () => {
  const roster = "<system-reminder>\nsubagent roster\n</system-reminder>";
  const { params } = createParams({
    messages: [
      { role: "user", content: "Remember BANANA42.", timestamp: 1 },
      {
        role: "assistant",
        content: [{ type: "text", text: "OK" }],
        timestamp: 2,
        ...ASSISTANT_DEFAULTS,
      },
      { role: "user", content: "What code word?", timestamp: 3 },
      { role: "user", content: roster, timestamp: 4 },
    ],
  });

  const result = buildRunRequest(params);
  assert.equal(getActionUserText(result), `What code word?\n\n${roster}`);
  assert.equal(result.conversationState.turns.length, 1);
});

test("single trailing user message still becomes the action unchanged", () => {
  const { params } = createParams({
    messages: [{ role: "user", content: "hello", timestamp: 1 }],
  });

  const result = buildRunRequest(params);
  assert.equal(getActionUserText(result), "hello");
  assert.equal(result.conversationState.turns.length, 0);
});

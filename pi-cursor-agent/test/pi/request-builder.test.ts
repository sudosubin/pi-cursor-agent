import assert from "node:assert/strict";
import test from "node:test";
import type { Context, Message, Model } from "@mariozechner/pi-ai";
import { ConversationStateStructure } from "../../src/__generated__/agent/v1/agent_pb.js";
import { buildRunRequest } from "../../src/pi/request-builder.js";
import {
  getBlobId,
  InMemoryBlobStore,
} from "../../src/vendor/agent-kv/index.js";

function createParams(options?: {
  messages?: Message[];
  conversationState?: ConversationStateStructure;
}) {
  const blobStore = new InMemoryBlobStore();

  const model = {
    id: "grok-code-fast-1",
    name: "Grok Code Fast 1",
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
        api: "cursor-agent",
        provider: "cursor-agent",
        model: "grok-code-fast-1",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
          },
        },
        stopReason: "stop",
      },
      {
        role: "user",
        content: "What code word did I ask you to remember?",
        timestamp: 3,
      },
    ],
  } satisfies Context;

  return {
    blobStore,
    params: {
      model,
      context,
      conversationId: "test-conversation",
      blobStore,
      conversationState: options?.conversationState,
      mcpToolDefinitions: [],
    },
  };
}

function createMatchingCachedState(systemPrompt: string) {
  const systemPromptBytes = new TextEncoder().encode(
    JSON.stringify({
      role: "system",
      content: systemPrompt,
    }),
  );

  const cachedTurn = new Uint8Array([1, 2, 3]);

  return new ConversationStateStructure({
    rootPromptMessagesJson: [getBlobId(systemPromptBytes)],
    turns: [cachedTurn],
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
}

test("buildRunRequest preserves cached conversation turns when system prompt matches", () => {
  const cachedState = createMatchingCachedState("You are a helpful assistant.");
  const { params } = createParams({ conversationState: cachedState });

  const result = buildRunRequest(params);

  assert.equal(result.conversationState, cachedState);
  assert.deepEqual(result.conversationState.turns, cachedState.turns);
});

test("buildRunRequest seeds turns from prior messages when no cached state exists", () => {
  const { params, blobStore } = createParams();

  const result = buildRunRequest(params);

  assert.equal(result.conversationState.turns.length, 1);
  assert.equal(result.conversationState.turns[0]?.length, 32);
  assert.equal(blobStore.store.size > 0, true);
  assert.equal(result.initialRequest.message.case, "runRequest");

  const runRequest = result.initialRequest.message.value;
  assert.ok(runRequest.action);
  assert.equal(runRequest.action.action.case, "userMessageAction");
});

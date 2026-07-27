import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  requestToolExecution,
  resolveToolResult,
} from "../../src/bridge/cursor-to-pi/tool-bridge.js";
import {
  ensureAgentStore,
  hasAgentStore,
  retainOnlyAgentStore,
} from "../../src/lib/agent-store/index.js";
import {
  getLiveSession,
  LiveEventChannel,
  retainOnlyLiveSession,
  setLiveSession,
} from "../../src/provider/agent-stream-hook.js";
import {
  retainOnlyActiveSessionMemory,
  terminateSession,
} from "../../src/provider/session-lifecycle.js";

function createLiveSession(label: string) {
  return {
    channel: new LiveEventChannel(label),
    cursorRunPromise: Promise.resolve(),
    flushSessionState: async () => {},
    sendConversationActions: async () => {},
    abort: () => {},
    startTime: Date.now(),
  };
}

test("retainOnlyLiveSession keeps only the selected live session", () => {
  setLiveSession("session-a", createLiveSession("session-a"));
  setLiveSession("session-b", createLiveSession("session-b"));

  retainOnlyLiveSession("session-a");

  assert.ok(getLiveSession("session-a"));
  assert.equal(getLiveSession("session-b"), undefined);

  retainOnlyLiveSession(null);
  assert.equal(getLiveSession("session-a"), undefined);
});

test("retainOnlyAgentStore keeps only the selected in-memory store", async () => {
  const baseDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "pi-cursor-agent-store-test-"),
  );

  try {
    await ensureAgentStore(baseDir, "session-a");
    await ensureAgentStore(baseDir, "session-b");

    assert.equal(hasAgentStore("session-a"), true);
    assert.equal(hasAgentStore("session-b"), true);

    retainOnlyAgentStore("session-a");
    assert.equal(hasAgentStore("session-a"), true);
    assert.equal(hasAgentStore("session-b"), false);

    retainOnlyAgentStore(null);
    assert.equal(hasAgentStore("session-a"), false);
  } finally {
    retainOnlyAgentStore(null);
    await fs.rm(baseDir, { recursive: true, force: true });
  }
});

test("terminateSession aborts the live session and rejects pending tool results", async () => {
  let abortReason: string | undefined;
  let flushed = 0;
  let resolveRun!: () => void;
  const cursorRunPromise = new Promise<void>((resolve) => {
    resolveRun = resolve;
  });

  const session = {
    channel: new LiveEventChannel("session-a"),
    cursorRunPromise,
    flushSessionState: async () => {
      flushed += 1;
    },
    sendConversationActions: async () => {},
    abort: (reason?: string) => {
      abortReason = reason;
      resolveRun();
    },
    startTime: Date.now(),
  };
  setLiveSession("session-a", session);

  const pending = requestToolExecution(session.channel, {
    toolCallId: "call-a",
    cursorExecType: "read",
    piToolName: "read",
    piToolArgs: { path: "README.md" },
  });

  await terminateSession("session-a", "Session ended");

  await assert.rejects(pending, /Session ended/);
  assert.equal(abortReason, "Session ended");
  assert.equal(flushed, 1);
  assert.equal(getLiveSession("session-a"), undefined);
});

test("retainOnlyActiveSessionMemory keeps the active session and rejects others", async () => {
  const sessionA = createLiveSession("session-a");
  const sessionB = createLiveSession("session-b");
  setLiveSession("session-a", sessionA);
  setLiveSession("session-b", sessionB);

  const channelA = new LiveEventChannel("session-a");
  const channelB = new LiveEventChannel("session-b");
  const keepPending = requestToolExecution(channelA, {
    toolCallId: "call-keep",
    cursorExecType: "read",
    piToolName: "read",
    piToolArgs: { path: "README.md" },
  });
  const dropPending = requestToolExecution(channelB, {
    toolCallId: "call-drop",
    cursorExecType: "read",
    piToolName: "read",
    piToolArgs: { path: "README.md" },
  });

  retainOnlyActiveSessionMemory("session-a", "Session ended");

  assert.ok(getLiveSession("session-a"));
  assert.equal(getLiveSession("session-b"), undefined);
  await assert.rejects(dropPending, /Session ended/);

  resolveToolResult({
    role: "toolResult",
    toolCallId: "call-keep",
    toolName: "read",
    content: [],
    isError: false,
    timestamp: Date.now(),
  });
  await assert.doesNotReject(keepPending);

  retainOnlyActiveSessionMemory(null, "Session ended");
});

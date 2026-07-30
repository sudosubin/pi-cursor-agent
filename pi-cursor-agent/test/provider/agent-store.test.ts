import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEntry } from "@mariozechner/pi-coding-agent";
import { ConversationStateStructure } from "../../src/__generated__/agent/v1/agent_pb.js";
import {
  ensureAgentStore,
  evictAgentStore,
  isExternallyManagedSubagentSession,
  restoreAgentStoreFromBranch,
} from "../../src/provider/agent-store.js";

const SNAPSHOT_TYPE = "pi-cursor-agent:state";
const SUBAGENT_BOUNDARY_TYPE = "subagent_boundary";
const SUBAGENT_MARKER_TYPE = "pi-subagents_launch_metadata";
const SESSION_STARTED_AT = "2026-01-02T00:00:00.000Z";
const AFTER_SESSION_START = "2026-01-02T00:00:01.000Z";
const BEFORE_SESSION_START = "2026-01-01T00:00:00.000Z";

interface BranchEntry {
  id: string;
  type: string;
  customType?: string;
  data?: unknown;
  timestamp?: string;
}

function snapshot(
  agentId: string,
  options: { root?: string; promptByte?: number } = {},
): BranchEntry {
  const state = new ConversationStateStructure({
    rootPromptMessagesJson: [new Uint8Array([options.promptByte ?? 1])],
  });
  return {
    id: `snapshot-${agentId}`,
    type: "custom",
    customType: SNAPSHOT_TYPE,
    data: {
      version: 1,
      agentId,
      latestRootBlobId: options.root ?? "",
      conversationState: Buffer.from(state.toBinary()).toString("base64"),
    },
  };
}

function subagentBoundary(id: string = crypto.randomUUID()): BranchEntry {
  return {
    id,
    type: "custom_message",
    customType: SUBAGENT_BOUNDARY_TYPE,
  };
}

function subagentMarker(
  id: string = crypto.randomUUID(),
  timestamp = AFTER_SESSION_START,
): BranchEntry {
  return {
    id,
    type: "custom",
    customType: SUBAGENT_MARKER_TYPE,
    data: {},
    timestamp,
  };
}

async function withStore(
  branchEntries: BranchEntry[],
  sessionEntries: BranchEntry[],
  verify: (store: Awaited<ReturnType<typeof ensureAgentStore>>) => void,
  sessionStartedAt?: string,
  isSubagentSession = false,
): Promise<void> {
  const sessionId = crypto.randomUUID();

  try {
    await restoreAgentStoreFromBranch(
      sessionId,
      branchEntries as SessionEntry[],
      sessionEntries as SessionEntry[],
      sessionStartedAt,
      isSubagentSession,
    );
    verify(await ensureAgentStore(sessionId));
  } finally {
    await evictAgentStore(sessionId, { persist: false });
  }
}

test("ignores inherited snapshots before launch metadata becomes visible", async () => {
  const parentSnapshot = snapshot("parent-agent");
  const isManagedSubagentSession = isExternallyManagedSubagentSession(
    "/sessions/managed-subagent.jsonl",
    "/sessions/child/../managed-subagent.jsonl",
  );

  assert.equal(isManagedSubagentSession, true);
  await withStore(
    [parentSnapshot],
    [parentSnapshot],
    (store) => {
      assert.notEqual(store.getId(), "parent-agent");
      assert.equal(
        store.getConversationStateStructure().rootPromptMessagesJson.length,
        0,
      );
    },
    SESSION_STARTED_AT,
    isManagedSubagentSession,
  );
});

test("ignores inherited snapshots in boundary-disabled subagent sessions", async () => {
  for (const root of ["", "01020304"]) {
    const parentSnapshot = snapshot("parent-agent", { root });
    const sessionEntries = [parentSnapshot, subagentMarker()];

    await withStore(
      [parentSnapshot],
      sessionEntries,
      (store) => {
        assert.notEqual(store.getId(), "parent-agent");
        assert.equal(
          store.getConversationStateStructure().rootPromptMessagesJson.length,
          0,
        );
      },
      SESSION_STARTED_AT,
      true,
    );
  }
});

test("restores a child snapshot after resume metadata is appended", async () => {
  const childSnapshot = snapshot("child-agent", { promptByte: 2 });
  const entries = [
    snapshot("parent-agent"),
    subagentBoundary(),
    subagentMarker("initial-launch"),
    childSnapshot,
    subagentMarker("resume-override", "2026-01-02T00:00:03.000Z"),
  ];

  await withStore(
    entries,
    entries,
    (store) => {
      assert.equal(store.getId(), "child-agent");
      assert.deepEqual(
        Array.from(
          store.getConversationStateStructure().rootPromptMessagesJson[0] ?? [],
        ),
        [2],
      );
    },
    SESSION_STARTED_AT,
    true,
  );
});

test("restores ordinary forks opened inside a subagent process", async () => {
  const entries = [snapshot("fork-agent", { root: "01020304", promptByte: 9 })];
  const isManagedSubagentSession = isExternallyManagedSubagentSession(
    "/sessions/ordinary-fork.jsonl",
    "/sessions/managed-subagent.jsonl",
  );

  assert.equal(isManagedSubagentSession, false);
  await withStore(
    entries,
    entries,
    (store) => {
      assert.equal(store.getId(), "fork-agent");
      assert.deepEqual(
        Array.from(
          store.getConversationStateStructure().rootPromptMessagesJson[0] ?? [],
        ),
        [9],
      );
    },
    SESSION_STARTED_AT,
    isManagedSubagentSession,
  );
});

test("the current launch marker partitions boundary-disabled nested forks", async () => {
  const firstChildSnapshot = snapshot("first-child");
  const entries = [
    subagentBoundary("inherited-boundary"),
    subagentMarker("inherited-launch", BEFORE_SESSION_START),
    firstChildSnapshot,
    subagentMarker("nested-launch"),
  ];

  await withStore(
    [firstChildSnapshot],
    entries,
    (store) => {
      assert.notEqual(store.getId(), "first-child");
      assert.equal(
        store.getConversationStateStructure().rootPromptMessagesJson.length,
        0,
      );
    },
    SESSION_STARTED_AT,
    true,
  );
});

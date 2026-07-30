import { resolve } from "node:path";
import type { SessionEntry } from "@mariozechner/pi-coding-agent";
import { ConversationStateStructure } from "../__generated__/agent/v1/agent_pb";
import {
  applySnapshotToStore,
  deleteAgentStore as deleteStore,
  ensureAgentStore as ensureStore,
  persistAgentStore as persistStore,
} from "../lib/agent-store";
import { type AgentStore, fromHex, toHex } from "../vendor/agent-kv";
import { PI_CURSOR_AGENT_CACHE_DIR } from "./env";

export const CURSOR_STATE_ENTRY_TYPE = "pi-cursor-agent:state";

export const isExternallyManagedSubagentSession = (
  activeSessionFile: string | undefined,
  managedSessionFile: string | undefined,
): boolean =>
  Boolean(
    activeSessionFile &&
      managedSessionFile &&
      resolve(activeSessionFile) === resolve(managedSessionFile),
  );

const SUBAGENT_BOUNDARY_ENTRY_TYPE = "subagent_boundary";
const SUBAGENT_LAUNCH_METADATA_ENTRY_TYPE = "pi-subagents_launch_metadata";

interface AgentStoreSnapshot {
  version: 1;
  agentId: string;
  latestRootBlobId: string;
  conversationState?: string;
}

const isAgentStoreSnapshot = (value: unknown): value is AgentStoreSnapshot => {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const snapshot = value as Partial<AgentStoreSnapshot>;
  return (
    snapshot.version === 1 &&
    typeof snapshot.agentId === "string" &&
    typeof snapshot.latestRootBlobId === "string"
  );
};

const findProvenanceBoundaryIndex = (
  sessionEntries: SessionEntry[],
  sessionStartedAt?: string,
): number => {
  const startedAt = sessionStartedAt
    ? Date.parse(sessionStartedAt)
    : Number.NaN;
  if (Number.isFinite(startedAt)) {
    const launchIndex = sessionEntries.findIndex(
      (entry) =>
        entry.type === "custom" &&
        entry.customType === SUBAGENT_LAUNCH_METADATA_ENTRY_TYPE &&
        Date.parse(entry.timestamp) >= startedAt,
    );
    if (launchIndex >= 0) {
      return launchIndex;
    }
  }

  for (let i = sessionEntries.length - 1; i >= 0; i--) {
    const entry = sessionEntries[i];
    if (
      entry?.type === "custom_message" &&
      entry.customType === SUBAGENT_BOUNDARY_ENTRY_TYPE
    ) {
      return i;
    }
  }
  return -1;
};

const findSnapshot = (
  branchEntries: SessionEntry[],
  sessionEntries: SessionEntry[],
  sessionStartedAt: string | undefined,
  isSubagentSession: boolean,
): AgentStoreSnapshot | null => {
  const boundaryIndex = findProvenanceBoundaryIndex(
    sessionEntries,
    sessionStartedAt,
  );
  if (isSubagentSession && boundaryIndex < 0) {
    return null;
  }

  for (let i = branchEntries.length - 1; i >= 0; i--) {
    const entry = branchEntries[i];
    if (
      entry?.type !== "custom" ||
      entry.customType !== CURSOR_STATE_ENTRY_TYPE ||
      !isAgentStoreSnapshot(entry.data)
    ) {
      continue;
    }

    if (boundaryIndex >= 0) {
      const snapshotIndex = sessionEntries.findIndex(
        (candidate) => candidate.id === entry.id,
      );
      if (snapshotIndex < boundaryIndex) {
        return null;
      }
    }

    return entry.data;
  }
  return null;
};

export const ensureAgentStore = async (
  sessionId: string,
): Promise<AgentStore> => {
  const entry = await ensureStore(PI_CURSOR_AGENT_CACHE_DIR, sessionId);
  return entry.store;
};

export const persistAgentStore = async (
  sessionId: string,
): Promise<AgentStoreSnapshot | null> => {
  const entry = await persistStore(PI_CURSOR_AGENT_CACHE_DIR, sessionId);
  if (!entry) {
    return null;
  }

  const {
    store,
    jsonStore: { metadata },
  } = entry;
  const snapshot: AgentStoreSnapshot = {
    version: 1,
    agentId: metadata.agentId,
    latestRootBlobId: toHex(metadata.latestRootBlobId),
  };

  try {
    const bytes = store.getConversationStateStructure().toBinary();
    if (bytes.length > 0) {
      snapshot.conversationState = Buffer.from(bytes).toString("base64");
    }
  } catch {}

  return snapshot;
};

export const evictAgentStore = async (
  sessionId: string,
  options?: { persist?: boolean },
): Promise<void> => {
  try {
    if (options?.persist !== false) {
      await persistStore(PI_CURSOR_AGENT_CACHE_DIR, sessionId);
    }
  } finally {
    deleteStore(sessionId);
  }
};

export const restoreAgentStoreFromBranch = async (
  sessionId: string,
  branchEntries: SessionEntry[],
  sessionEntries: SessionEntry[] = branchEntries,
  sessionStartedAt?: string,
  isSubagentSession = false,
): Promise<void> => {
  const snapshot = findSnapshot(
    branchEntries,
    sessionEntries,
    sessionStartedAt,
    isSubagentSession,
  );
  if (!snapshot) {
    return;
  }

  const storeEntry = await ensureStore(PI_CURSOR_AGENT_CACHE_DIR, sessionId);
  const rootBlobId = snapshot.latestRootBlobId
    ? fromHex(snapshot.latestRootBlobId)
    : new Uint8Array();

  storeEntry.jsonStore.metadata.agentId = snapshot.agentId;

  if (snapshot.conversationState) {
    try {
      const conversationState = ConversationStateStructure.fromBinary(
        Buffer.from(snapshot.conversationState, "base64"),
      );
      await storeEntry.store.handleCheckpoint(null, conversationState);
      return;
    } catch {}
  }

  if (rootBlobId.length > 0) {
    await applySnapshotToStore(storeEntry, snapshot.agentId, rootBlobId);
  }
};

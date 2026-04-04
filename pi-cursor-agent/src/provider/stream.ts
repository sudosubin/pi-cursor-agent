import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  createAssistantMessageEventStream,
  type Model,
  type ToolCall as PiToolCall,
  type SimpleStreamOptions,
  type TextContent,
  type ThinkingContent,
} from "@mariozechner/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import type { ConversationStateStructure } from "../__generated__/agent/v1/agent_pb";
import {
  AskQuestionRejected,
  AskQuestionResult,
} from "../__generated__/agent/v1/ask_question_tool_pb";
import AgentService from "../api/agent-service";
import {
  LocalResourceProvider,
  type PiToolContext,
} from "../bridge/cursor-to-pi/local-resource-provider";
import {
  rejectPendingForSession,
  type ToolExecRequest,
} from "../bridge/cursor-to-pi/tool-bridge";
import { preparePiContext } from "../bridge/pi-context";
import {
  buildRunRequest,
  getContextTools,
} from "../bridge/pi-to-cursor/request-builder";
import { CURSOR_API_URL, CURSOR_CLIENT_VERSION } from "../lib/env";
import {
  AgentConnectClient,
  type CheckpointHandler,
  type InteractionListener,
} from "../vendor/agent-client";
import type {
  CoreInteractionQuery,
  CoreInteractionResponse,
  CoreInteractionUpdate,
} from "../vendor/agent-core";
import {
  CURSOR_STATE_ENTRY_TYPE,
  ensureAgentStore,
  evictAgentStore,
  persistAgentStore,
} from "./agent-store";
import {
  type ContentEvent,
  deleteLiveSession,
  getLiveSession,
  LiveEventChannel,
  type LiveSession,
  setLiveSession,
} from "./agent-stream-hook";
import { toCursorId } from "./model-mapping";
import { type CursorStateStore, createOverlayState } from "./state";

function createCheckpointHandler(
  handler: (checkpoint: ConversationStateStructure) => void,
): CheckpointHandler {
  return {
    handleCheckpoint(
      _ctx: unknown,
      checkpoint: ConversationStateStructure,
    ): Promise<void> {
      handler(checkpoint);
      return Promise.resolve();
    },
  };
}

const QUERY_REJECTION_REASON = "Not supported";

function createInteractionListenerAdapter(
  onUpdate: (update: CoreInteractionUpdate) => void,
): InteractionListener {
  return {
    async sendUpdate(
      _ctx: unknown,
      update: CoreInteractionUpdate,
    ): Promise<void> {
      onUpdate(update);
    },
    async query(
      _ctx: unknown,
      query: CoreInteractionQuery,
    ): Promise<CoreInteractionResponse> {
      switch (query.type) {
        case "ask-question-request":
          return {
            result: new AskQuestionResult({
              result: {
                case: "rejected",
                value: new AskQuestionRejected({
                  reason: QUERY_REJECTION_REASON,
                }),
              },
            }),
          };
        case "web-search-request":
        case "web-fetch-request":
        case "exa-search-request":
        case "exa-fetch-request":
        case "switch-mode-request":
          return { approved: false, reason: QUERY_REJECTION_REASON };
        case "create-plan-request":
          return {
            result: {
              planUri: "",
              result: {
                case: "error",
                value: { error: QUERY_REJECTION_REASON },
              },
            },
          } as CoreInteractionResponse;
        case "setup-vm-environment-request":
          return {} as CoreInteractionResponse;
        default:
          return { approved: false, reason: QUERY_REJECTION_REASON };
      }
    },
  };
}

type CursorAssistantMessage = AssistantMessage & {
  duration?: number;
  ttft?: number;
};

interface LiveContentState {
  currentText: TextContent | null;
  currentThinking: ThinkingContent | null;
}

function finalizeText(
  state: LiveContentState,
  output: CursorAssistantMessage,
  stream: AssistantMessageEventStream,
): void {
  if (!state.currentText) return;
  stream.push({
    type: "text_end",
    contentIndex: output.content.indexOf(state.currentText),
    content: state.currentText.text,
    partial: output,
  });
  state.currentText = null;
}

function finalizeThinking(
  state: LiveContentState,
  output: CursorAssistantMessage,
  stream: AssistantMessageEventStream,
): void {
  if (!state.currentThinking) return;
  stream.push({
    type: "thinking_end",
    contentIndex: output.content.indexOf(state.currentThinking),
    content: state.currentThinking.thinking,
    partial: output,
  });
  state.currentThinking = null;
}

function pushContentEvent(
  event: ContentEvent,
  state: LiveContentState,
  output: CursorAssistantMessage,
  stream: AssistantMessageEventStream,
): void {
  switch (event.kind) {
    case "text-delta": {
      finalizeThinking(state, output, stream);
      if (!state.currentText) {
        state.currentText = { type: "text", text: "" };
        output.content.push(state.currentText);
        stream.push({
          type: "text_start",
          contentIndex: output.content.length - 1,
          partial: output,
        });
      }
      state.currentText.text += event.text;
      stream.push({
        type: "text_delta",
        contentIndex: output.content.indexOf(state.currentText),
        delta: event.text,
        partial: output,
      });
      break;
    }
    case "thinking-delta": {
      finalizeText(state, output, stream);
      if (!state.currentThinking) {
        state.currentThinking = { type: "thinking", thinking: "" };
        output.content.push(state.currentThinking);
        stream.push({
          type: "thinking_start",
          contentIndex: output.content.length - 1,
          partial: output,
        });
      }
      state.currentThinking.thinking += event.text;
      stream.push({
        type: "thinking_delta",
        contentIndex: output.content.indexOf(state.currentThinking),
        delta: event.text,
        partial: output,
      });
      break;
    }
    case "thinking-completed": {
      finalizeThinking(state, output, stream);
      break;
    }
  }
}

function finalizeAllContent(
  state: LiveContentState,
  output: CursorAssistantMessage,
  stream: AssistantMessageEventStream,
): void {
  finalizeText(state, output, stream);
  finalizeThinking(state, output, stream);
}

async function consumeUntilBoundary(
  channel: LiveEventChannel,
  output: CursorAssistantMessage,
  stream: AssistantMessageEventStream,
  usageState: { sawTokenDelta: boolean },
  setFirstTokenTime: () => void,
): Promise<{
  reason: "toolUse" | "stop";
  tools: ToolExecRequest[];
}> {
  const contentState: LiveContentState = {
    currentText: null,
    currentThinking: null,
  };

  while (true) {
    const event = await channel.next();

    if (event === null) {
      finalizeAllContent(contentState, output, stream);
      return { reason: "stop", tools: [] };
    }

    switch (event.kind) {
      case "content": {
        setFirstTokenTime();
        pushContentEvent(event.data, contentState, output, stream);
        break;
      }

      case "tool-exec-request": {
        finalizeAllContent(contentState, output, stream);
        return { reason: "toolUse", tools: [event.request] };
      }

      case "token-delta": {
        usageState.sawTokenDelta = true;
        output.usage.output += event.tokens;
        output.usage.totalTokens = output.usage.input + output.usage.output;
        break;
      }

      case "cursor-done": {
        finalizeAllContent(contentState, output, stream);
        return { reason: "stop", tools: [] };
      }
    }
  }
}

function serializeContentBlocks(
  content: CursorAssistantMessage["content"],
): unknown[] {
  return content.map((block) => {
    switch (block.type) {
      case "text":
        return { type: "text", text: block.text };
      case "thinking":
        return { type: "thinking", thinking: block.thinking };
      case "toolCall":
        return {
          type: "toolCall",
          id: block.id,
          name: block.name,
          arguments: block.arguments,
        };
      default:
        return { type: (block as { type: string }).type };
    }
  });
}

function emitToolCalls(
  tools: ToolExecRequest[],
  output: CursorAssistantMessage,
  stream: AssistantMessageEventStream,
  state: CursorStateStore,
): void {
  for (const request of tools) {
    state.rememberToolCallMeta({
      toolCallId: request.toolCallId,
      cursorExecType: request.cursorExecType,
      piToolName: request.piToolName,
      piToolArgs: request.piToolArgs,
      assistantTimestamp: output.timestamp,
    });

    const block: PiToolCall = {
      type: "toolCall",
      id: request.toolCallId,
      name: request.piToolName,
      arguments: request.piToolArgs,
    };
    output.content.push(block);
    const idx = output.content.length - 1;
    stream.push({ type: "toolcall_start", contentIndex: idx, partial: output });
    stream.push({
      type: "toolcall_end",
      contentIndex: idx,
      toolCall: block,
      partial: output,
    });
  }
}

export function streamCursorAgent(
  pi: ExtensionAPI,
  getCtx: () => ExtensionContext | null,
  state: CursorStateStore,
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();

  (async () => {
    const sessionId = options?.sessionId ?? "default";

    const output: CursorAssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };
    let session: LiveSession | undefined;

    try {
      session = getLiveSession(sessionId);

      if (!session) {
        const apiKey = options?.apiKey;
        if (!apiKey) {
          throw new Error(
            "Cursor API key (access token) is required. Run /login cursor or set CURSOR_ACCESS_TOKEN.",
          );
        }

        const agentStore = await ensureAgentStore(sessionId);
        const cwd = getCtx()?.cwd ?? process.cwd();
        const requestContextTools = getContextTools(context);

        const channel = new LiveEventChannel(sessionId);
        const sessionAbortController = new AbortController();
        const sessionSignal = options?.signal
          ? AbortSignal.any([options.signal, sessionAbortController.signal])
          : sessionAbortController.signal;

        const piToolCtx: PiToolContext = {
          cwd,
          signal: sessionSignal,
          getActiveTools: () => new Set(pi.getActiveTools()),
          getCtx,
          getChannel: () => channel,
        };

        const piContext = await preparePiContext(context.systemPrompt ?? "");

        const resources = new LocalResourceProvider({
          ctx: piToolCtx,
          requestContextTools,
          cursorRules: piContext.rules,
        });

        const blobStore = agentStore.getBlobStore();
        const cursorModelId = toCursorId(model.id, options?.reasoning);
        const overlayState = createOverlayState(state);
        const { initialRequest, conversationState } = buildRunRequest({
          model: { ...model, id: cursorModelId },
          context,
          conversationId: agentStore.getId(),
          blobStore,
          conversationState: agentStore.getConversationStateStructure(),
          mcpToolDefinitions: requestContextTools,
          state: overlayState,
          systemPromptOverride: piContext.cleanedPrompt,
        });
        agentStore.conversationStateStructure = conversationState;

        let lastFlushedRootBlobId: string | undefined;
        const flushSessionState = async () => {
          const snapshot = await persistAgentStore(sessionId);
          if (!snapshot || snapshot.latestRootBlobId === lastFlushedRootBlobId)
            return;
          lastFlushedRootBlobId = snapshot.latestRootBlobId;
          pi.appendEntry(CURSOR_STATE_ENTRY_TYPE, snapshot);
        };

        const handleInteractionUpdate = (update: CoreInteractionUpdate) => {
          switch (update.type) {
            case "text-delta":
              channel.push({
                kind: "content",
                data: { kind: "text-delta", text: update.text },
              });
              return;
            case "thinking-delta":
              channel.push({
                kind: "content",
                data: { kind: "thinking-delta", text: update.text },
              });
              return;
            case "thinking-completed":
              channel.push({
                kind: "content",
                data: { kind: "thinking-completed", text: "" },
              });
              return;
            case "token-delta":
              channel.push({ kind: "token-delta", tokens: update.tokens });
              return;
            default:
              return;
          }
        };

        const baseUrl = model.baseUrl || CURSOR_API_URL;
        const agentService = new AgentService(baseUrl, {
          accessToken: apiKey,
          clientVersion: CURSOR_CLIENT_VERSION,
          clientType: "cli",
        });
        const connectClient = new AgentConnectClient(agentService.rpcClient);
        const interactionListener = createInteractionListenerAdapter(
          handleInteractionUpdate,
        );
        const checkpointHandler = createCheckpointHandler(
          (checkpoint: ConversationStateStructure) => {
            void agentStore.handleCheckpoint(null, checkpoint);
          },
        );
        checkpointHandler.getLatestCheckpoint = () =>
          agentStore.getConversationStateStructure();

        const runOptions: Parameters<typeof connectClient.run>[1] = {
          interactionListener,
          resources,
          blobStore,
          checkpointHandler,
          signal: sessionSignal,
        };

        const cursorRunPromise = connectClient
          .run(initialRequest, runOptions)
          .then(() => channel.push({ kind: "cursor-done" }))
          .catch(() => channel.push({ kind: "cursor-done" }))
          .finally(() => channel.markDone());

        session = {
          channel,
          cursorRunPromise,
          flushSessionState,
          abort: (reason) => {
            sessionAbortController.abort(
              reason ? new Error(reason) : new Error("Session ended"),
            );
          },
          startTime: Date.now(),
        };
        setLiveSession(sessionId, session);
      }

      if (!session) {
        throw new Error(`Failed to initialize live session: ${sessionId}`);
      }
      const liveSession = session;

      const usageState = { sawTokenDelta: false };
      let firstTokenTimeCaptured = false;

      stream.push({ type: "start", partial: output });

      const result = await consumeUntilBoundary(
        liveSession.channel,
        output,
        stream,
        usageState,
        () => {
          if (!firstTokenTimeCaptured) {
            firstTokenTimeCaptured = true;
            if (!liveSession.firstTokenTime) {
              liveSession.firstTokenTime = Date.now();
            }
          }
        },
      );

      output.duration = Date.now() - liveSession.startTime;
      if (liveSession.firstTokenTime) {
        output.ttft = liveSession.firstTokenTime - liveSession.startTime;
      }
      output.usage.cost = {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      };

      if (result.reason === "toolUse" && result.tools.length > 0) {
        emitToolCalls(result.tools, output, stream, state);
        output.stopReason = "toolUse";

        state.rememberAssistantContent({
          timestamp: output.timestamp,
          blocks: serializeContentBlocks(output.content),
        });
        try {
          await session.flushSessionState();
        } catch {}

        stream.push({
          type: "done",
          reason: "toolUse",
          message: { ...output },
        });
      } else {
        output.stopReason = "stop";

        state.rememberAssistantContent({
          timestamp: output.timestamp,
          blocks: serializeContentBlocks(output.content),
        });
        let flushed = false;
        try {
          await session.flushSessionState();
          flushed = true;
        } catch {}
        deleteLiveSession(sessionId);
        await session.cursorRunPromise.catch(() => {});
        await evictAgentStore(sessionId, { persist: !flushed }).catch(() => {});
        stream.push({ type: "done", reason: "stop", message: output });
      }
      stream.end();
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage =
        error instanceof Error ? error.message : String(error);
      let flushed = false;
      try {
        if (session) {
          await session.flushSessionState();
          flushed = true;
          await session.cursorRunPromise.catch(() => {});
        }
      } catch {}
      deleteLiveSession(sessionId);
      rejectPendingForSession(
        sessionId,
        `Stream error: ${output.errorMessage}`,
      );
      await evictAgentStore(sessionId, { persist: !flushed }).catch(() => {});
      stream.push({
        type: "error",
        reason: output.stopReason === "aborted" ? "aborted" : "error",
        error: { ...output },
      });
      stream.end();
    }
  })();

  return stream;
}

import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  createAssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
  type TextContent,
  type ThinkingContent,
} from "@mariozechner/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import type { ConversationStateStructure } from "./__generated__/agent/v1/agent_pb";
import {
  AskQuestionRejected,
  AskQuestionResult,
} from "./__generated__/agent/v1/ask_question_tool_pb";
import AgentService from "./api/agent-service";
import { CURSOR_API_URL, CURSOR_CLIENT_VERSION } from "./lib/env";
import {
  CURSOR_STATE_ENTRY_TYPE,
  ensureAgentStore,
  persistAgentStore,
} from "./pi/agent-store";
import {
  LocalResourceProvider,
  type PiToolContext,
  type ToolExecEvent,
} from "./pi/local-resource-provider";
import { toCursorId } from "./pi/model-mapping";
import { buildRunRequest, getContextTools } from "./pi/request-builder";
import {
  AgentConnectClient,
  type CheckpointHandler,
  type InteractionListener,
} from "./vendor/agent-client";
import type {
  CoreInteractionQuery,
  CoreInteractionResponse,
  CoreInteractionUpdate,
} from "./vendor/agent-core";

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

const QUERY_REJECTION_REASON = "Not supported by pi-cursor-agent";

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

type ToolExecStreamEvent =
  | {
      type: "tool_exec_start";
      toolCallId: string;
      toolName: string;
      args: Record<string, unknown>;
    }
  | {
      type: "tool_exec_end";
      toolCallId: string;
      toolName: string;
      result: { content: unknown; details: unknown };
      isError: boolean;
    };

type StreamWithToolExecEvents = AssistantMessageEventStream & {
  push(event: ToolExecStreamEvent): void;
};

type CursorAssistantMessage = AssistantMessage & {
  duration?: number;
  ttft?: number;
};

export function streamCursorAgent(
  pi: ExtensionAPI,
  getCtx: () => ExtensionContext | null,
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const streamWithToolExecEvents = stream as StreamWithToolExecEvents;

  (async () => {
    const startTime = Date.now();
    let firstTokenTime: number | undefined;

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

    const sessionId = options?.sessionId ?? "default";

    let lastFlushedRootBlobId: string | undefined;
    const flushSessionState = async () => {
      const snapshot = await persistAgentStore(sessionId);
      if (!snapshot || snapshot.latestRootBlobId === lastFlushedRootBlobId) {
        return;
      }
      lastFlushedRootBlobId = snapshot.latestRootBlobId;
      pi.appendEntry(CURSOR_STATE_ENTRY_TYPE, snapshot);
    };

    try {
      const apiKey = options?.apiKey;
      if (!apiKey) {
        throw new Error(
          "Cursor API key (access token) is required. Run /login cursor or set CURSOR_ACCESS_TOKEN.",
        );
      }

      const agentStore = await ensureAgentStore(sessionId);
      const cwd = getCtx()?.cwd ?? process.cwd();
      const requestContextTools = getContextTools(context);

      let onToolExec: ((event: ToolExecEvent) => void) | undefined;

      const piToolCtx: PiToolContext = {
        cwd,
        ...(options?.signal ? { signal: options.signal } : {}),
        getActiveTools: () => new Set(pi.getActiveTools()),
        getCtx,
        onToolExec: (event) => onToolExec?.(event),
      };

      const resources = new LocalResourceProvider({
        ctx: piToolCtx,
        requestContextTools,
      });

      const blobStore = agentStore.getBlobStore();
      const cursorModelId = toCursorId(model.id, options?.reasoning);
      const { initialRequest, conversationState } = buildRunRequest({
        model: { ...model, id: cursorModelId },
        context,
        conversationId: agentStore.getId(),
        blobStore,
        conversationState: agentStore.getConversationStateStructure(),
        mcpToolDefinitions: requestContextTools,
      });
      agentStore.conversationStateStructure = conversationState;

      stream.push({ type: "start", partial: output });

      let currentTextBlock: TextContent | null = null;
      let currentThinkingBlock: ThinkingContent | null = null;
      const usageState = { sawTokenDelta: false };

      const finalizeTextBlock = () => {
        if (!currentTextBlock) return;
        stream.push({
          type: "text_end",
          contentIndex: output.content.indexOf(currentTextBlock),
          content: currentTextBlock.text,
          partial: output,
        });
        currentTextBlock = null;
      };

      const finalizeThinkingBlock = () => {
        if (!currentThinkingBlock) return;
        stream.push({
          type: "thinking_end",
          contentIndex: output.content.indexOf(currentThinkingBlock),
          content: currentThinkingBlock.thinking,
          partial: output,
        });
        currentThinkingBlock = null;
      };

      onToolExec = (event: ToolExecEvent) => {
        if (event.type === "start") {
          finalizeTextBlock();
          finalizeThinkingBlock();
          streamWithToolExecEvents.push({
            type: "tool_exec_start",
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            args: event.args,
          });
        } else {
          streamWithToolExecEvents.push({
            type: "tool_exec_end",
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            result: {
              content: event.result.content,
              details: event.result.details,
            },
            isError: event.result.isError,
          });
        }
      };

      const handleInteractionUpdate = (update: CoreInteractionUpdate) => {
        switch (update.type) {
          case "text-delta": {
            if (!firstTokenTime) firstTokenTime = Date.now();
            finalizeThinkingBlock();
            const delta = update.text;
            if (!currentTextBlock) {
              currentTextBlock = { type: "text", text: "" };
              output.content.push(currentTextBlock);
              stream.push({
                type: "text_start",
                contentIndex: output.content.length - 1,
                partial: output,
              });
            }
            currentTextBlock.text += delta;
            stream.push({
              type: "text_delta",
              contentIndex: output.content.indexOf(currentTextBlock),
              delta,
              partial: output,
            });
            return;
          }

          case "thinking-delta": {
            if (!firstTokenTime) firstTokenTime = Date.now();
            finalizeTextBlock();
            const delta = update.text;
            if (!currentThinkingBlock) {
              currentThinkingBlock = { type: "thinking", thinking: "" };
              output.content.push(currentThinkingBlock);
              stream.push({
                type: "thinking_start",
                contentIndex: output.content.length - 1,
                partial: output,
              });
            }
            currentThinkingBlock.thinking += delta;
            stream.push({
              type: "thinking_delta",
              contentIndex: output.content.indexOf(currentThinkingBlock),
              delta,
              partial: output,
            });
            return;
          }

          case "thinking-completed": {
            finalizeThinkingBlock();
            return;
          }

          case "turn-ended": {
            output.stopReason = "stop";
            return;
          }

          case "token-delta": {
            usageState.sawTokenDelta = true;
            output.usage.output += update.tokens;
            output.usage.totalTokens = output.usage.input + output.usage.output;
            return;
          }
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
          if (usageState.sawTokenDelta) return;
          const usedTokens = checkpoint.tokenDetails?.usedTokens ?? 0;
          if (usedTokens > 0 && output.usage.output !== usedTokens) {
            output.usage.output = usedTokens;
            output.usage.totalTokens = output.usage.input + output.usage.output;
          }
        },
      );
      checkpointHandler.getLatestCheckpoint = () =>
        agentStore.getConversationStateStructure();

      const runOptions: Parameters<typeof connectClient.run>[1] = {
        interactionListener,
        resources,
        blobStore,
        checkpointHandler,
      };
      if (options?.signal) runOptions.signal = options.signal;

      await connectClient.run(initialRequest, runOptions);

      finalizeTextBlock();
      finalizeThinkingBlock();

      output.usage.cost = {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      };
      output.duration = Date.now() - startTime;
      if (firstTokenTime) {
        output.ttft = firstTokenTime - startTime;
      }

      try {
        await flushSessionState();
      } catch {
        // ignore persistence errors
      }
      stream.push({ type: "done", reason: "stop", message: output });
      stream.end();
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage =
        error instanceof Error ? error.message : String(error);
      output.duration = Date.now() - startTime;
      if (firstTokenTime) output.ttft = firstTokenTime - startTime;
      const errorReason = output.stopReason === "aborted" ? "aborted" : "error";
      try {
        await flushSessionState();
      } catch {
        // ignore persistence errors
      }
      stream.push({
        type: "error",
        reason: errorReason,
        error: output,
      });
      stream.end();
    }
  })();

  return stream;
}

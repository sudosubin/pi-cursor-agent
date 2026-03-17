import { type JsonValue, Value } from "@bufbuild/protobuf";
import type {
  Api,
  Context,
  Message,
  Model,
  TextContent,
  Tool,
  ToolResultMessage,
} from "@mariozechner/pi-ai";
import {
  AgentClientMessage,
  AgentConversationTurnStructure,
  AgentRunRequest,
  AssistantMessage as AssistantMessageProto,
  ConversationAction,
  type ConversationStateStructure,
  ConversationStateStructure as ConversationStateStructureClass,
  ConversationStep,
  ConversationTurnStructure,
  ModelDetails,
  UserMessage,
  UserMessageAction,
} from "../__generated__/agent/v1/agent_pb";
import {
  type McpToolDefinition,
  McpToolDefinition as McpToolDefinitionClass,
  McpTools,
} from "../__generated__/agent/v1/mcp_pb";
import { type BlobStore, getBlobId } from "../vendor/agent-kv";
import { toolResultToText } from "./utils/tool-result";

const CURSOR_NATIVE_TOOL_NAMES = new Set([
  "bash",
  "read",
  "write",
  "delete",
  "ls",
  "grep",
  "lsp",
  "todo_write",
]);

type ContextWithTools = Context & { tools?: Tool[] };

function extractUserMessageText(msg: Message): string {
  if (msg.role !== "user") return "";
  if (typeof msg.content === "string") return msg.content.trim();
  return msg.content
    .filter((c): c is TextContent => c.type === "text")
    .map((c) => c.text)
    .join("\n")
    .trim();
}

function extractAssistantMessageText(msg: Message): string {
  if (msg.role !== "assistant") return "";
  if (!Array.isArray(msg.content)) return "";
  return msg.content
    .filter((c): c is TextContent => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

function storeBlob(blobStore: BlobStore, bytes: Uint8Array): Uint8Array {
  const blobId = getBlobId(bytes);
  void blobStore.setBlob(null, blobId, bytes);
  return new Uint8Array(Array.from(blobId));
}

function buildConversationTurns(
  messages: Message[],
  blobStore: BlobStore,
): Uint8Array[] {
  const turns: Uint8Array[] = [];

  let i = 0;
  while (i < messages.length) {
    const msg = messages[i];
    if (!msg || msg.role !== "user") {
      i++;
      continue;
    }

    let isLastUserMessage = true;
    for (let j = i + 1; j < messages.length; j++) {
      if (messages[j]?.role === "user") {
        isLastUserMessage = false;
        break;
      }
    }
    if (isLastUserMessage) break;

    const userText = extractUserMessageText(msg);
    if (!userText) {
      i++;
      continue;
    }

    const userMessage = new UserMessage({
      text: userText,
      messageId: crypto.randomUUID(),
    });
    const userMessageBlobId = storeBlob(blobStore, userMessage.toBinary());

    const stepBlobIds: Uint8Array[] = [];
    i++;
    while (i < messages.length && messages[i]?.role !== "user") {
      const stepMsg = messages[i];
      if (!stepMsg) {
        i++;
        continue;
      }

      if (stepMsg.role === "assistant") {
        const text = extractAssistantMessageText(stepMsg);
        if (text) {
          const step = new ConversationStep({
            message: {
              case: "assistantMessage",
              value: new AssistantMessageProto({ text }),
            },
          });
          stepBlobIds.push(storeBlob(blobStore, step.toBinary()));
        }
      } else if (stepMsg.role === "toolResult") {
        const text = toolResultToText(stepMsg as ToolResultMessage);
        if (text) {
          const step = new ConversationStep({
            message: {
              case: "assistantMessage",
              value: new AssistantMessageProto({
                text: `[Tool Result]\n${text}`,
              }),
            },
          });
          stepBlobIds.push(storeBlob(blobStore, step.toBinary()));
        }
      }

      i++;
    }

    const agentTurn = new AgentConversationTurnStructure({
      userMessage: userMessageBlobId as Uint8Array<ArrayBuffer>,
      steps: stepBlobIds as Uint8Array<ArrayBuffer>[],
    });
    const turn = new ConversationTurnStructure({
      turn: { case: "agentConversationTurn", value: agentTurn },
    });
    turns.push(storeBlob(blobStore, turn.toBinary()));
  }

  return turns;
}

function buildMcpToolDefinitions(
  tools: Tool[] | undefined,
): McpToolDefinition[] {
  if (!tools || tools.length === 0) {
    return [];
  }

  const advertisedTools = tools.filter(
    (tool) => !CURSOR_NATIVE_TOOL_NAMES.has(tool.name),
  );
  if (advertisedTools.length === 0) {
    return [];
  }

  return advertisedTools.map((tool) => {
    const jsonSchema = tool.parameters as Record<string, unknown> | undefined;
    const schemaValue: JsonValue =
      jsonSchema && typeof jsonSchema === "object"
        ? (jsonSchema as JsonValue)
        : { type: "object", properties: {}, required: [] };
    const inputSchema = new Uint8Array(Value.fromJson(schemaValue).toBinary());
    return new McpToolDefinitionClass({
      name: tool.name,
      description: tool.description,
      providerIdentifier: "pi-agent",
      toolName: tool.name,
      inputSchema,
    });
  });
}

interface BuildRunRequestParams {
  model: Model<Api>;
  context: Context;
  conversationId: string;
  blobStore: BlobStore;
  conversationState: ConversationStateStructure | undefined;
  mcpToolDefinitions?: McpToolDefinition[];
}

interface BuildRunRequestResult {
  initialRequest: AgentClientMessage;
  conversationState: ConversationStateStructure;
}

export function buildRunRequest(
  params: BuildRunRequestParams,
): BuildRunRequestResult {
  const systemPromptJson = JSON.stringify({
    role: "system",
    content: params.context.systemPrompt || "You are a helpful assistant.",
  });
  const systemPromptBytes = new TextEncoder().encode(systemPromptJson);
  const systemPromptId = getBlobId(systemPromptBytes);
  void params.blobStore.setBlob(null, systemPromptId, systemPromptBytes);

  const lastMessage = params.context.messages.at(-1);
  const userText = lastMessage ? extractUserMessageText(lastMessage) : "";
  if (!userText) {
    throw new Error("Cannot send empty user message to Cursor API");
  }

  const userMessage = new UserMessage({
    text: userText,
    messageId: crypto.randomUUID(),
  });

  const action = new ConversationAction({
    action: {
      case: "userMessageAction",
      value: new UserMessageAction({ userMessage }),
    },
  });

  const cached = params.conversationState;
  const turns = buildConversationTurns(
    params.context.messages,
    params.blobStore,
  );

  const conversationState =
    cached && cached.rootPromptMessagesJson.length > 0
      ? cached
      : new ConversationStateStructureClass({
          rootPromptMessagesJson: [systemPromptId],
          turns,
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

  const modelDetails = new ModelDetails({
    modelId: params.model.id,
    displayModelId: params.model.id,
    displayName: params.model.name,
  });

  const mcpToolDefinitions = params.mcpToolDefinitions ?? [];
  const runRequest = new AgentRunRequest({
    conversationState,
    action,
    modelDetails,
    conversationId: params.conversationId,
    mcpTools: new McpTools({ mcpTools: mcpToolDefinitions }),
  });

  const initialRequest = new AgentClientMessage({
    message: { case: "runRequest", value: runRequest },
  });

  return {
    initialRequest,
    conversationState,
  };
}

export function getContextTools(context: Context): McpToolDefinition[] {
  return buildMcpToolDefinitions((context as ContextWithTools).tools);
}

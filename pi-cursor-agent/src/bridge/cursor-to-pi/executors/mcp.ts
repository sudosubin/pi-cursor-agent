import { Value } from "@bufbuild/protobuf";
import type { ToolResultMessage } from "@mariozechner/pi-ai";
import type {
  McpArgs,
  McpResult,
} from "../../../__generated__/agent/v1/mcp_tool_pb";
import {
  McpError,
  McpResult as McpResultClass,
  McpSuccess,
  McpTextContent,
  McpToolNotFound,
  McpToolResultContentItem,
} from "../../../__generated__/agent/v1/mcp_tool_pb";
import type { Executor } from "../../../vendor/agent-exec";
import { toolResultToText } from "../../shared/tool-result";
import {
  decodeToolCallId,
  type PiToolContext,
} from "../local-resource-provider/types";
import { requestToolExecution } from "../tool-bridge";

/**
 * Decode a single MCP arg value from bytes.
 * Cursor encodes arg values as protobuf Value binary; fall back to raw JSON.
 */
function decodeMcpArgValue(bytes: Uint8Array): unknown {
  try {
    return Value.fromBinary(bytes).toJson();
  } catch {
    try {
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return new TextDecoder().decode(bytes);
    }
  }
}

/** Decode all MCP args from map<string, bytes> to a plain object. */
function decodeMcpArgs(args: {
  [key: string]: Uint8Array;
}): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    result[key] = decodeMcpArgValue(value);
  }
  return result;
}

/** Convert a Pi ToolResultMessage to a Cursor McpResult. */
function buildMcpResultFromToolResult(result: ToolResultMessage): McpResult {
  const text = toolResultToText(result);
  return new McpResultClass({
    result: {
      case: "success",
      value: new McpSuccess({
        content: [
          new McpToolResultContentItem({
            content: {
              case: "text",
              value: new McpTextContent({ text: text || "(no output)" }),
            },
          }),
        ],
        isError: result.isError,
      }),
    },
  });
}

export class LocalMcpExecutor implements Executor<McpArgs, McpResult> {
  private readonly ctx: PiToolContext;

  constructor(ctx: PiToolContext) {
    this.ctx = ctx;
  }

  async execute(_ctx: unknown, args: McpArgs): Promise<McpResult> {
    const toolCallId = decodeToolCallId(args.toolCallId);
    const toolName = args.toolName || args.name;

    if (!toolName) {
      return new McpResultClass({
        result: {
          case: "error",
          value: new McpError({ error: "No tool name provided" }),
        },
      });
    }

    if (!this.ctx.getActiveTools().has(toolName)) {
      return new McpResultClass({
        result: {
          case: "toolNotFound",
          value: new McpToolNotFound({
            name: toolName,
            availableTools: [...this.ctx.getActiveTools()],
          }),
        },
      });
    }

    const piToolArgs = decodeMcpArgs(args.args);

    try {
      const piResult = await requestToolExecution(
        this.ctx.getChannel?.() ?? null,
        {
          toolCallId,
          cursorExecType: "mcp",
          piToolName: toolName,
          piToolArgs,
        },
      );
      return buildMcpResultFromToolResult(piResult);
    } catch (error) {
      return new McpResultClass({
        result: {
          case: "error",
          value: new McpError({
            error: error instanceof Error ? error.message : String(error),
          }),
        },
      });
    }
  }
}

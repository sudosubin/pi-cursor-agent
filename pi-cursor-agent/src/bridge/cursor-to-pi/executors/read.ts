import type { ToolResultMessage } from "@mariozechner/pi-ai";
import type {
  ReadArgs,
  ReadResult,
} from "../../../__generated__/agent/v1/read_exec_pb";
import {
  ReadError,
  ReadFileNotFound,
  ReadRejected,
  ReadResult as ReadResultClass,
  ReadSuccess,
} from "../../../__generated__/agent/v1/read_exec_pb";
import type { Executor } from "../../../vendor/agent-exec";
import {
  toolResultToText,
  toolResultWasTruncated,
} from "../../shared/tool-result";
import type { PiToolContext } from "../local-resource-provider/types";
import { decodeToolCallId } from "../local-resource-provider/types";
import { requestToolExecution } from "../tool-bridge";

/** True when Pi's read tool failed because the path is missing (maps to Cursor ReadFileNotFound). */
function isMissingFileReadError(message: string): boolean {
  const m = message.trim();
  if (!m) return false;
  if (/\bENOENT\b/.test(m)) return true;
  if (/no such file or directory/i.test(m)) return true;
  return false;
}

export function buildReadResultFromToolResult(
  path: string,
  result: ToolResultMessage,
): ReadResult {
  const text = toolResultToText(result);
  if (result.isError) {
    if (isMissingFileReadError(text)) {
      return new ReadResultClass({
        result: {
          case: "fileNotFound",
          value: new ReadFileNotFound({ path }),
        },
      });
    }
    return new ReadResultClass({
      result: {
        case: "error",
        value: new ReadError({ path, error: text || "Read failed" }),
      },
    });
  }
  const totalLines = text ? text.split("\n").length : 0;
  return new ReadResultClass({
    result: {
      case: "success",
      value: new ReadSuccess({
        path,
        totalLines,
        fileSize: BigInt(Buffer.byteLength(text, "utf-8")),
        truncated: toolResultWasTruncated(result),
        output: { case: "content", value: text },
      }),
    },
  });
}

function buildReadRejectedResult(path: string, reason: string): ReadResult {
  return new ReadResultClass({
    result: { case: "rejected", value: new ReadRejected({ path, reason }) },
  });
}

export class LocalReadExecutor implements Executor<ReadArgs, ReadResult> {
  private readonly ctx: PiToolContext;

  constructor(ctx: PiToolContext) {
    this.ctx = ctx;
  }

  async execute(_ctx: unknown, args: ReadArgs): Promise<ReadResult> {
    const toolCallId = decodeToolCallId(args.toolCallId);

    if (!this.ctx.getActiveTools().has("read")) {
      return buildReadRejectedResult(args.path, "Tool not available");
    }

    const piResult = await requestToolExecution(
      this.ctx.getChannel?.() ?? null,
      {
        toolCallId,
        cursorExecType: "read",
        piToolName: "read",
        piToolArgs: { path: args.path },
      },
    );

    return buildReadResultFromToolResult(args.path, piResult);
  }
}

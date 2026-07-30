import assert from "node:assert/strict";
import test from "node:test";
import type { ToolResultMessage } from "@mariozechner/pi-ai";
import { buildReadResultFromToolResult } from "../../../src/bridge/cursor-to-pi/executors/read.js";

function errResult(text: string): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: "t1",
    toolName: "read",
    content: [{ type: "text", text }],
    isError: true,
    timestamp: 1,
  };
}

test("ENOENT maps to ReadResult fileNotFound", () => {
  const r = buildReadResultFromToolResult(
    "missing.txt",
    errResult("ENOENT: no such file or directory, access '/tmp/missing.txt'"),
  );
  assert.equal(r.result.case, "fileNotFound");
  if (r.result.case === "fileNotFound") {
    assert.equal(r.result.value.path, "missing.txt");
  }
});

test("generic read error stays ReadError", () => {
  const r = buildReadResultFromToolResult(
    "x.txt",
    errResult("Something else went wrong"),
  );
  assert.equal(r.result.case, "error");
  if (r.result.case === "error") {
    assert.match(r.result.value.error, /Something else/);
  }
});

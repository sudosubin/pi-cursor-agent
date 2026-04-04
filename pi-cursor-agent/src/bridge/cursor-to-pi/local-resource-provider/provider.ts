import type { CursorRule } from "../../../__generated__/agent/v1/cursor_rules_pb";
import type { McpToolDefinition } from "../../../__generated__/agent/v1/mcp_pb";
import {
  backgroundShellResource,
  computerUseResource,
  deleteResource,
  diagnosticsResource,
  fetchResource,
  grepResource,
  hookExecutorResource,
  listMcpResourcesResource,
  lsResource,
  mcpResource,
  RegistryResourceAccessor,
  readMcpResourceResource,
  readResource,
  recordScreenResource,
  requestContextResource,
  shellResource,
  shellStreamResource,
  writeResource,
  writeShellStdinResource,
} from "../../../vendor/agent-exec";
import { LocalDeleteExecutor } from "../executors/delete";
import { LocalGrepExecutor } from "../executors/grep";
import { LocalHookExecutorImpl } from "../executors/hook";
import { LocalLsExecutor } from "../executors/ls";
import { LocalMcpExecutor } from "../executors/mcp";
import { LocalReadExecutor } from "../executors/read";
import { LocalRequestContextExecutor } from "../executors/request-context";
import { LocalShellExecutor } from "../executors/shell";
import { LocalShellStreamExecutor } from "../executors/shell-stream";
import {
  StubBackgroundShellExecutor,
  StubComputerUseExecutor,
  StubDiagnosticsExecutor,
  StubFetchExecutor,
  StubListMcpResourcesExecutor,
  StubReadMcpResourceExecutor,
  StubRecordScreenExecutor,
  StubWriteShellStdinExecutor,
} from "../executors/stubs";
import { LocalWriteExecutor } from "../executors/write";
import type { PiToolContext } from "./types";

interface LocalResourceProviderOptions {
  ctx: PiToolContext;
  requestContextTools?: McpToolDefinition[];
  workspacePaths?: string[];
  cursorRules?: CursorRule[];
}

export class LocalResourceProvider extends RegistryResourceAccessor {
  constructor(options: LocalResourceProviderOptions) {
    super();
    const { ctx, requestContextTools = [], workspacePaths } = options;
    const resolvedWorkspacePaths = workspacePaths ?? [ctx.cwd];

    // hook-executor
    this.register(hookExecutorResource, new LocalHookExecutorImpl());

    // request-context
    this.register(
      requestContextResource,
      new LocalRequestContextExecutor(
        requestContextTools,
        resolvedWorkspacePaths,
        options.cursorRules ?? [],
      ),
    );

    // read, write, delete
    this.register(readResource, new LocalReadExecutor(ctx));
    this.register(writeResource, new LocalWriteExecutor(ctx));
    this.register(deleteResource, new LocalDeleteExecutor(ctx));

    // shell (unary + stream)
    const shellExecutor = new LocalShellExecutor(ctx);
    this.register(shellResource, shellExecutor);
    this.register(shellStreamResource, new LocalShellStreamExecutor(ctx));

    // grep, ls
    this.register(grepResource, new LocalGrepExecutor(ctx));
    this.register(lsResource, new LocalLsExecutor(ctx));

    // stubs (not implemented)
    this.register(backgroundShellResource, new StubBackgroundShellExecutor());
    this.register(writeShellStdinResource, new StubWriteShellStdinExecutor());
    this.register(fetchResource, new StubFetchExecutor());
    this.register(diagnosticsResource, new StubDiagnosticsExecutor());
    this.register(mcpResource, new LocalMcpExecutor(ctx));
    this.register(listMcpResourcesResource, new StubListMcpResourcesExecutor());
    this.register(readMcpResourceResource, new StubReadMcpResourceExecutor());
    this.register(recordScreenResource, new StubRecordScreenExecutor());
    this.register(computerUseResource, new StubComputerUseExecutor());
  }
}

import os from "node:os";
import type { CursorRule } from "../../../__generated__/agent/v1/cursor_rules_pb";
import type { McpToolDefinition } from "../../../__generated__/agent/v1/mcp_pb";
import { GitRepoInfo } from "../../../__generated__/agent/v1/repo_pb";
import type { RequestContextArgs } from "../../../__generated__/agent/v1/request_context_exec_pb";
import {
  RequestContext,
  RequestContextEnv,
  RequestContextError,
  RequestContextResult,
  RequestContextSuccess,
} from "../../../__generated__/agent/v1/request_context_exec_pb";
import type { Executor } from "../../../vendor/agent-exec";
import {
  getGitBranch,
  getGitRemoteUrl,
  getGitRepoPath,
  getGitStatus,
  LocalGitExecutor,
} from "../../../vendor/local-exec";

export class LocalRequestContextExecutor
  implements Executor<RequestContextArgs, RequestContextResult>
{
  private readonly tools: McpToolDefinition[];
  private readonly workspacePaths: string[];
  private readonly rules: CursorRule[];
  private readonly gitExecutor: LocalGitExecutor;

  constructor(
    tools: McpToolDefinition[],
    workspacePaths: string[],
    rules: CursorRule[] = [],
  ) {
    this.tools = tools;
    this.workspacePaths = workspacePaths;
    this.rules = rules;
    this.gitExecutor = new LocalGitExecutor();
  }

  async execute(
    _ctx: unknown,
    _args: RequestContextArgs,
  ): Promise<RequestContextResult> {
    try {
      const [gitRepos, env] = await Promise.all([
        this.collectGitRepos(),
        this.computeEnv(),
      ]);

      const requestContext = new RequestContext({
        rules: this.rules,
        env,
        repositoryInfo: [],
        tools: this.tools,
        gitRepos,
        projectLayouts: [],
        mcpInstructions: [],
        fileContents: {},
        customSubagents: [],
      });

      return new RequestContextResult({
        result: {
          case: "success",
          value: new RequestContextSuccess({ requestContext }),
        },
      });
    } catch (error) {
      return new RequestContextResult({
        result: {
          case: "error",
          value: new RequestContextError({
            error: error instanceof Error ? error.message : String(error),
          }),
        },
      });
    }
  }

  private async collectGitRepos(): Promise<GitRepoInfo[]> {
    const seen = new Set<string>();
    const repos: GitRepoInfo[] = [];

    for (const workspacePath of this.workspacePaths) {
      const repoPath = await getGitRepoPath(this.gitExecutor, workspacePath);
      if (!repoPath || seen.has(repoPath)) continue;
      seen.add(repoPath);

      const [status, branchName, remoteUrl] = await Promise.all([
        getGitStatus(this.gitExecutor, repoPath),
        getGitBranch(this.gitExecutor, repoPath),
        getGitRemoteUrl(this.gitExecutor, repoPath),
      ]);

      const info: ConstructorParameters<typeof GitRepoInfo>[0] = {
        path: repoPath,
        status: status ?? "",
        branchName: branchName ?? "",
      };
      if (remoteUrl) info.remoteUrl = remoteUrl;
      repos.push(new GitRepoInfo(info));
    }

    return repos;
  }

  private async computeEnv(): Promise<RequestContextEnv> {
    const osVersion = `${os.platform()} ${os.release()}`;
    const shell = process.env["SHELL"] || "";

    let timeZone: string | undefined;
    try {
      timeZone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      timeZone = undefined;
    }

    return new RequestContextEnv({
      osVersion,
      workspacePaths: this.workspacePaths,
      shell,
      sandboxEnabled: false,
      timeZone: timeZone ?? "",
    });
  }
}

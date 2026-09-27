import {
  AppServerCodexRunner,
  type CodexHistoryMessage,
  type CodexGoal,
  type CodexGoalRunInput,
  type CodexModelOption,
  type CodexRunnerInput,
  type CodexRuntimeInfo,
  type CodexSessionListOptions,
  type CodexSessionSummary
} from "./app-server-runner.js";
import { CodexExecRunner, type CodexRunResult } from "./exec-runner.js";
import { createIsolatedCodexHome } from "./isolated-home.js";
import type { CodexExecSandbox } from "./sandbox.js";

export type CodexBackend = "auto" | "app-server" | "exec";

export type HybridCodexRunnerOptions = {
  backend: CodexBackend;
  codexBin?: string;
  execSandbox?: CodexExecSandbox;
  isolateMcp?: boolean;
  timeoutMs?: number;
};

export class HybridCodexRunner {
  private readonly appServer: AppServerCodexRunner;
  private readonly exec: CodexExecRunner;
  private readonly isolatedHome?: ReturnType<typeof createIsolatedCodexHome>;

  constructor(private readonly options: HybridCodexRunnerOptions) {
    this.isolatedHome = options.isolateMcp === false ? undefined : createIsolatedCodexHome();
    this.appServer = new AppServerCodexRunner({
      codexBin: options.codexBin,
      codexHome: this.isolatedHome?.path,
      requestTimeoutMs: options.timeoutMs
    });
    this.exec = new CodexExecRunner({
      codexBin: options.codexBin,
      codexHome: this.isolatedHome?.path,
      sandbox: options.execSandbox,
      timeoutMs: options.timeoutMs
    });
  }

  async run(input: CodexRunnerInput): Promise<CodexRunResult> {
    const requiresAppServerForStreaming = Boolean(input.onDelta || input.onProgress);
    if (this.options.backend === "exec" && !requiresAppServerForStreaming) {
      return this.exec.run(input);
    }
    try {
      return await this.appServer.run(input);
    } catch (error) {
      if (this.options.backend === "app-server") {
        throw error;
      }
      const fallback = await this.exec.run({
        ...input,
        onDelta: undefined,
        onProgress: undefined
      });
      return {
        ...fallback,
        text: `Warning: Codex app-server was unavailable, used codex exec fallback.\n\n${fallback.text}`
      };
    }
  }

  async stop(threadId?: string): Promise<void> {
    await Promise.all([
      this.appServer.stop(threadId),
      this.exec.stop(threadId)
    ]);
  }

  async getHistory(threadId: string): Promise<CodexHistoryMessage[]> {
    return this.appServer.getHistory(threadId);
  }

  async getRuntimeInfo(cwd: string, threadId?: string): Promise<CodexRuntimeInfo> {
    return this.appServer.getRuntimeInfo(cwd, threadId);
  }

  async listModels(): Promise<CodexModelOption[]> {
    return this.appServer.listModels();
  }

  async listCodexSessions(options?: CodexSessionListOptions): Promise<CodexSessionSummary[]> {
    return this.appServer.listCodexSessions(options);
  }

  async readCodexSession(threadId: string): Promise<CodexSessionSummary | undefined> {
    return this.appServer.readCodexSession(threadId);
  }

  async getGoal(threadId: string): Promise<CodexGoal | undefined> {
    return this.appServer.getGoal(threadId);
  }

  async setGoal(input: CodexGoalRunInput): Promise<{ threadId: string; goal: CodexGoal }> {
    return this.appServer.setGoal(input);
  }

  async clearGoal(threadId: string): Promise<boolean> {
    return this.appServer.clearGoal(threadId);
  }

  close(): void {
    this.appServer.close();
    this.exec.close();
    this.isolatedHome?.cleanup();
  }
}

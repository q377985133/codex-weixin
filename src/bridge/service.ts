import path from "node:path";

import { AccessController } from "./access.js";
import { parseActionBlocks } from "./actions.js";
import { buildPrompt, buildPromptPreview, chunkText, parsePrompt } from "./format.js";
import { PromptBuffer } from "./prompt-buffer.js";
import type {
  CodexGoal,
  CodexGoalStatus,
  CodexModelOption,
  CodexRuntimeInfo,
  CodexSessionSummary
} from "../codex/app-server-runner.js";
import { HybridCodexRunner } from "../codex/runner.js";
import { isWorkspaceAllowed, type CodexWeixinConfig } from "../state/config.js";
import { RuntimeStateStore, type ManagedSession } from "../state/runtime-state.js";
import { WeixinApiClient, isStaleContextError, type FetchLike } from "../weixin/api.js";
import { downloadInboundAttachments, InboundMediaTooLargeError, sendLocalMediaFile } from "../weixin/media.js";
import type { NormalizedWeixinMessage } from "../weixin/messages.js";
import type { PromptBufferItem } from "./prompt-buffer.js";

export type BridgeServiceOptions = {
  config: CodexWeixinConfig;
  stateStore: RuntimeStateStore;
  weixin: WeixinApiClient;
  runner?: HybridCodexRunner;
  listCodexModels?: () => Promise<CodexModelOption[]>;
  inboundDir?: string;
  mediaFetch?: FetchLike;
  onTurnStatus?: (status: { senderId: string; sessionId: string; active: boolean }) => void;
};

export class BridgeService {
  private readonly access: AccessController;
  private readonly buffers: PromptBuffer;
  private readonly runner: HybridCodexRunner;

  constructor(private readonly options: BridgeServiceOptions) {
    this.access = new AccessController({
      allowedSenderIds: options.config.allowedSenderIds,
      pairedSenderIds: options.stateStore.listPairedSenderIds()
    });
    this.buffers = new PromptBuffer({
      maxItems: options.config.maxBufferItems,
      ttlMs: options.config.promptBufferTtlMs
    });
    this.runner = options.runner ?? new HybridCodexRunner({
      backend: options.config.codexBackend,
      codexBin: options.config.codexBin,
      execSandbox: options.config.codexExecSandbox
    });
  }

  async handleMessage(message: NormalizedWeixinMessage): Promise<void> {
    if (message.contextToken) {
      this.options.stateStore.rememberContextToken(message.senderId, message.contextToken);
    }

    const access = this.access.requireAccess(message.senderId);
    if (!access.allowed) {
      await this.reply(message.senderId, access.message);
      return;
    }
    this.options.stateStore.setPairedSenderIds(this.access.listPairedSenderIds());
    this.options.stateStore.ensureActiveSession(message.senderId, this.options.config.defaultCwd);

    const command = parseCommand(message.text);
    if (command) {
      await this.handleCommand(message, command);
      return;
    }

    const items = await this.promptItemsFromMessageWithNotice(message);
    if (!items) return;

    if (this.buffers.isActive(message.senderId)) {
      for (const item of items) {
        this.buffers.append(message.senderId, item);
      }
      await this.reply(message.senderId, "Buffered. Send /prompt done when ready.");
      return;
    }

    await this.runCodexTurn(message, "", items);
  }

  private async handleCommand(message: NormalizedWeixinMessage, command: { name: string; arg: string }): Promise<void> {
    switch (command.name) {
      case "help":
      case "h":
        await this.reply(message.senderId, helpText());
        return;
      case "status":
      case "where":
        await this.reply(message.senderId, await this.statusText(message.senderId));
        return;
      case "bind":
        await this.bindWorkspace(message.senderId, command.arg);
        return;
      case "new":
        this.options.stateStore.createSession(message.senderId, this.options.stateStore.getWorkspace(message.senderId) ?? this.options.config.defaultCwd);
        await this.reply(message.senderId, "Created a new Codex session for the next message.");
        return;
      case "resume":
        await this.handleResumeCommand(message.senderId, command.arg);
        return;
      case "sessions":
        await this.handleSessionsCommand(message.senderId, command.arg);
        return;
      case "session":
        await this.handleSessionCommand(message.senderId, command.arg);
        return;
      case "goal":
        await this.handleGoalCommand(message.senderId, command.arg);
        return;
      case "model":
        await this.handleModelCommand(message.senderId, command.arg);
        return;
      case "effort":
        await this.handleEffortCommand(message.senderId, command.arg);
        return;
      case "stream":
        await this.handleStreamCommand(message.senderId, command.arg);
        return;
      case "prompt":
        await this.handlePromptCommand(message.senderId, command.arg);
        return;
      case "stop":
        await this.runner.stop(this.options.stateStore.getThread(message.senderId));
        await this.reply(message.senderId, "Stop signal sent.");
        return;
      default:
        await this.reply(message.senderId, `Unknown command: /${command.name}. Send /help.`);
    }
  }

  private async bindWorkspace(senderId: string, rawPath: string): Promise<void> {
    if (!rawPath.trim()) {
      await this.reply(senderId, "Usage: /bind <absolute-workspace-path>");
      return;
    }
    const workspace = path.resolve(rawPath.trim());
    if (!isWorkspaceAllowed(workspace, this.options.config.allowedWorkspaces)) {
      await this.reply(senderId, `Workspace is not allowed: ${workspace}`);
      return;
    }
    this.options.stateStore.setWorkspace(senderId, workspace);
    await this.reply(senderId, `Bound to workspace:\n${workspace}`);
  }

  private async handleResumeCommand(senderId: string, arg: string): Promise<void> {
    const sessions = this.options.stateStore.listSessions().filter((session) => session.senderId === senderId);
    const input = arg.trim();
    if (!input) {
      const activeId = this.options.stateStore.getActiveSession(senderId)?.id;
      const previews = await Promise.all(sessions.map((session) => this.sessionPromptPreview(session)));
      const lines = ["历史会话（最近更新优先）："];
      for (const [index, session] of sessions.entries()) {
        lines.push(
          `[R${index + 1}] ${session.id === activeId ? "【当前】" : ""}${session.title}`,
          `   最近内容：${previews[index]}（${formatSessionTime(session.updatedAt)}）`
        );
      }
      lines.push(
        "",
        "发送 /resume R1 这类切换编号继续会话；R1 是切换编号，“会话 6”等是会话名称。",
        "发送 /sessions [关键词] 可搜索并接入其他 Codex 会话。"
      );
      for (const chunk of chunkText(lines.join("\n"))) {
        await this.reply(senderId, chunk);
      }
      return;
    }
    if (/^\d+$/.test(input)) {
      await this.reply(senderId, "请使用列表中 R 开头的切换编号，例如 /resume R1；不要使用会话名称里的数字。");
      return;
    }
    const match = /^r([1-9]\d*)$/i.exec(input);
    if (match) {
      const selected = sessions[Number(match[1]) - 1];
      if (!selected) {
        await this.reply(senderId, "没有这个切换编号。发送 /resume 查看可用的 R 编号。");
        return;
      }
      await this.activateManagedSession(senderId, selected, input.toUpperCase());
      return;
    }

    const managedMatch = sessions.find((session) => session.title.toLowerCase() === input.toLowerCase());
    if (managedMatch) {
      await this.activateManagedSession(senderId, managedMatch, input);
      return;
    }

    const resolved = await this.resolveCodexSession(input);
    if (resolved.status === "selected") {
      await this.importCodexSession(senderId, resolved.session, input);
      return;
    }
    if (resolved.status === "candidates") {
      await this.reply(
        senderId,
        [
          "找到多个匹配的 Codex 会话：",
          formatCodexSessionList(resolved.sessions),
          "",
          "请发送 /session S1 这类编号接入，或输入更完整的会话名称。"
        ].join("\n")
      );
      return;
    }
    if (resolved.status === "error") {
      await this.reply(senderId, `无法搜索 Codex 会话：${resolved.message}`);
      return;
    }
    await this.reply(senderId, "没有找到这个会话。发送 /sessions [关键词] 搜索其他 Codex 会话。");
  }

  private async activateManagedSession(senderId: string, session: ManagedSession, label: string): Promise<void> {
    const preview = await this.sessionPromptPreview(session);
    this.options.stateStore.activateSession(session.id);
    await this.reply(senderId, [
      `已通过 ${label} 切换到：${session.title}`,
      `最近内容：${preview}`,
      session.threadId ? "下一条消息将继续该历史会话。" : "该会话尚无历史内容，下一条消息将创建新上下文。"
    ].join("\n"));
  }

  private async handleSessionsCommand(senderId: string, arg: string): Promise<void> {
    const query = arg.trim();
    const sessions = await this.listCodexSessions(query || undefined);
    if (!sessions) {
      await this.reply(senderId, "无法读取 Codex 会话列表。请确认 Codex app-server 可用。");
      return;
    }
    if (!sessions.length) {
      await this.reply(senderId, query ? `没有找到包含“${query}”的 Codex 会话。` : "没有找到可接入的 Codex 会话。");
      return;
    }
    const activeThreadId = this.options.stateStore.getThread(senderId);
    const lines = [
      query ? `Codex 会话（关键词：${query}）：` : "Codex 全局会话（最近更新优先）：",
      formatCodexSessionList(sessions, activeThreadId),
      "",
      "发送 /session S1 接入，或直接发送 /resume <会话名称>。"
    ];
    for (const chunk of chunkText(lines.join("\n"))) {
      await this.reply(senderId, chunk);
    }
  }

  private async handleSessionCommand(senderId: string, arg: string): Promise<void> {
    const input = arg.trim();
    if (!input) {
      await this.handleSessionsCommand(senderId, "");
      return;
    }
    const resolved = await this.resolveCodexSession(input);
    if (resolved.status === "selected") {
      await this.importCodexSession(senderId, resolved.session, input);
      return;
    }
    if (resolved.status === "candidates") {
      await this.reply(senderId, [
        "找到多个匹配的 Codex 会话：",
        formatCodexSessionList(resolved.sessions),
        "",
        "请发送 /session S1 这类编号接入，或输入更完整的会话名称。"
      ].join("\n"));
      return;
    }
    if (resolved.status === "error") {
      await this.reply(senderId, `无法搜索 Codex 会话：${resolved.message}`);
      return;
    }
    await this.reply(senderId, "没有找到这个 Codex 会话。发送 /sessions [关键词] 搜索。");
  }

  private async listCodexSessions(searchTerm?: string): Promise<CodexSessionSummary[] | undefined> {
    try {
      return await this.runner.listCodexSessions({ searchTerm, limit: 40 });
    } catch (error) {
      console.warn(`Codex session list unavailable: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  private async resolveCodexSession(input: string): Promise<
    | { status: "selected"; session: CodexSessionSummary }
    | { status: "candidates"; sessions: CodexSessionSummary[] }
    | { status: "none" }
    | { status: "error"; message: string }
  > {
    const code = /^s([1-9]\d*)$/i.exec(input);
    const sessions = await this.listCodexSessions(code ? undefined : input);
    if (!sessions) {
      return { status: "error", message: "Codex app-server 不可用" };
    }
    if (code) {
      const selected = sessions[Number(code[1]) - 1];
      return selected ? { status: "selected", session: selected } : { status: "none" };
    }
    const exact = sessions.filter((session) => session.title.toLowerCase() === input.toLowerCase());
    if (exact.length === 1) {
      return { status: "selected", session: exact[0] };
    }
    if (sessions.length === 1) {
      return { status: "selected", session: sessions[0] };
    }
    if (sessions.length > 1) {
      return { status: "candidates", sessions };
    }
    if (isUuid(input)) {
      try {
        const session = await this.runner.readCodexSession(input);
        return session ? { status: "selected", session } : { status: "none" };
      } catch (error) {
        return { status: "error", message: error instanceof Error ? error.message : String(error) };
      }
    }
    return { status: "none" };
  }

  private async importCodexSession(senderId: string, codexSession: CodexSessionSummary, label: string): Promise<void> {
    const workspace = codexSession.workspace || this.options.config.defaultCwd;
    if (!isWorkspaceAllowed(workspace, this.options.config.allowedWorkspaces)) {
      await this.reply(senderId, [
        `该 Codex 会话位于未授权工作目录：${workspace}`,
        "请先在 Web 设置中把该目录加入允许的工作目录，再重新发送接入命令。"
      ].join("\n"));
      return;
    }

    const existing = this.options.stateStore.listSessions().find((session) => (
      session.senderId === senderId && session.threadId === codexSession.id
    ));
    if (existing) {
      this.options.stateStore.activateSession(existing.id);
      await this.reply(senderId, [
        `已通过 ${label} 切换到已有会话：${existing.title}`,
        `Codex thread：${codexSession.id}`,
        "下一条消息将继续该会话。"
      ].join("\n"));
      return;
    }

    const session = this.options.stateStore.createSession(senderId, workspace, codexSession.title);
    this.options.stateStore.setSessionThread(session.id, codexSession.id);
    this.options.stateStore.setSessionPromptPreview(session.id, codexSession.preview);
    await this.reply(senderId, [
      `已接入 Codex 会话：${codexSession.title}`,
      `来源：${formatCodexSource(codexSession.source)}`,
      `工作目录：${workspace}`,
      `最近内容：${codexSession.preview}`,
      "下一条消息将继续该 thread。"
    ].join("\n"));
  }

  private async sessionPromptPreview(session: ManagedSession): Promise<string> {
    if (session.lastPromptPreview) return session.lastPromptPreview;
    if (!session.threadId) return "尚未开始对话";
    try {
      const history = await this.runner.getHistory(session.threadId);
      const lastUserMessage = [...history].reverse().find((message) => message.role === "user");
      if (!lastUserMessage) return "暂无内容摘要";
      const parsed = parsePrompt(lastUserMessage.text);
      const preview = buildPromptPreview(parsed.text, parsed.attachments);
      if (!preview) return "暂无内容摘要";
      this.options.stateStore.setSessionPromptPreview(session.id, preview);
      return preview;
    } catch (error) {
      console.warn(`Unable to read Codex history for session ${session.id}: ${error instanceof Error ? error.message : String(error)}`);
      return "历史摘要暂不可用";
    }
  }

  private async handlePromptCommand(senderId: string, arg: string): Promise<void> {
    const sub = arg.trim().toLowerCase();
    if (sub === "start") {
      const result = this.buffers.start(senderId);
      await this.reply(senderId, result.status === "started" ? "Prompt buffer started." : "Prompt buffer is already active.");
      return;
    }
    if (sub === "done") {
      const flushed = this.buffers.done(senderId);
      if (flushed.status === "empty") {
        await this.reply(senderId, "Prompt buffer is empty.");
        return;
      }
      await this.runCodexTurn({ id: "buffer", senderId, text: "", attachments: [], raw: {} }, "", flushed.items);
      return;
    }
    await this.reply(senderId, "Usage: /prompt start or /prompt done");
  }

  private async handleModelCommand(senderId: string, arg: string): Promise<void> {
    const models = await this.listCodexModels();
    const input = arg.trim();
    if (!input) {
      const runtime = await this.effectiveRuntime(senderId);
      const session = this.options.stateStore.getActiveSession(senderId);
      const lines = [
        `当前模型：${runtime.model ?? "Codex 默认"}${session?.model ? "（本会话）" : "（继承 Web/Codex 设置）"}`
      ];
      if (models.length) {
        lines.push("", "可用模型：", ...models.map((model, index) => `${index + 1}. ${model.displayName}（${model.model}）`));
        lines.push("", "发送 /model <序号或模型 ID> 切换；/model default 恢复继承设置。");
      } else {
        lines.push("", "暂时无法读取模型列表。仍可发送 /model <完整模型 ID> 切换。", "/model default 恢复继承设置。");
      }
      await this.reply(senderId, lines.join("\n"));
      return;
    }
    if (input.toLowerCase() === "default") {
      this.options.stateStore.setModelOverride(senderId);
      const runtime = await this.effectiveRuntime(senderId);
      await this.reply(senderId, `已恢复继承 Web/Codex 模型设置。\n当前模型：${runtime.model ?? "Codex 默认"}`);
      return;
    }

    const selected = selectModel(models, input);
    if (!selected && (models.length || !isPlausibleModelId(input))) {
      await this.reply(senderId, "模型不存在。发送 /model 查看可用模型，或使用 /model default 恢复继承设置。");
      return;
    }
    const currentRuntime = await this.effectiveRuntime(senderId);
    const model = selected?.model ?? input;
    this.options.stateStore.setModelOverride(senderId, model);
    let adjustedEffort: string | undefined;
    if (currentRuntime.effort && selected?.supportedEfforts.length && !selected.supportedEfforts.some((option) => option.effort === currentRuntime.effort)) {
      adjustedEffort = selected.supportedEfforts.some((option) => option.effort === selected.defaultEffort)
        ? selected.defaultEffort
        : selected.supportedEfforts[0]?.effort;
      this.options.stateStore.setEffortOverride(senderId, adjustedEffort);
    }
    await this.reply(senderId, [
      `本会话模型已切换为：${selected?.displayName ?? model}（${model}）`,
      ...(adjustedEffort ? [`原来的推理强度不受该模型支持，已自动调整为：${formatEffort(adjustedEffort)}`] : []),
      "下一条消息开始生效。"
    ].join("\n"));
  }

  private async handleEffortCommand(senderId: string, arg: string): Promise<void> {
    const models = await this.listCodexModels();
    const runtime = await this.effectiveRuntime(senderId);
    const model = models.find((option) => option.model === runtime.model);
    const efforts = availableEfforts(model, models);
    const input = arg.trim();
    if (!input) {
      const session = this.options.stateStore.getActiveSession(senderId);
      await this.reply(senderId, [
        `当前推理强度：${formatEffort(runtime.effort)}${session?.effort ? "（本会话）" : "（继承 Web/Codex 设置）"}`,
        `当前模型：${runtime.model ?? "Codex 默认"}`,
        "",
        "可用推理强度：",
        ...efforts.map((effort, index) => `${index + 1}. ${formatEffort(effort)}`),
        "",
        "发送 /effort <序号或英文值> 切换；/effort default 恢复继承设置。"
      ].join("\n"));
      return;
    }
    if (input.toLowerCase() === "default") {
      this.options.stateStore.setEffortOverride(senderId);
      const nextRuntime = await this.effectiveRuntime(senderId);
      await this.reply(senderId, `已恢复继承 Web/Codex 推理强度设置。\n当前推理强度：${formatEffort(nextRuntime.effort)}`);
      return;
    }
    const effort = selectEffort(efforts, input);
    if (!effort) {
      await this.reply(senderId, "该模型不支持这个推理强度。发送 /effort 查看可用选项。");
      return;
    }
    this.options.stateStore.setEffortOverride(senderId, effort);
    await this.reply(senderId, `本会话推理强度已切换为：${formatEffort(effort)}\n下一条消息开始生效。`);
  }

  private async handleStreamCommand(senderId: string, arg: string): Promise<void> {
    const input = arg.trim().toLowerCase();
    const session = this.options.stateStore.getActiveSession(senderId);
    const inherited = this.options.config.streamReplies;
    if (!input) {
      const effective = session?.streamReplies ?? inherited;
      const source = typeof session?.streamReplies === "boolean" ? "本会话设置" : "继承全局";
      await this.reply(senderId, `当前过程进度：${effective ? "开启" : "关闭"}（${source}）\n发送 /stream on、/stream off 或 /stream default 切换。`);
      return;
    }
    if (input === "default") {
      this.options.stateStore.setStreamRepliesOverride(senderId);
      await this.reply(senderId, `已恢复继承全局设置。当前过程进度：${inherited ? "开启" : "关闭"}。`);
      return;
    }
    if (input !== "on" && input !== "off") {
      await this.reply(senderId, "用法：/stream on、/stream off 或 /stream default");
      return;
    }
    const enabled = input === "on";
    this.options.stateStore.setStreamRepliesOverride(senderId, enabled);
    await this.reply(senderId, `本会话过程进度已${enabled ? "开启" : "关闭"}。`);
  }

  private async handleGoalCommand(senderId: string, arg: string): Promise<void> {
    const input = arg.trim();
    const threadId = this.options.stateStore.getThread(senderId);
    if (!input) {
      if (!threadId) {
        await this.reply(senderId, "当前会话还没有 Codex thread。先发送一条普通消息或使用 /goal <目标> 创建目标。");
        return;
      }
      try {
        const goal = await this.runner.getGoal(threadId);
        await this.reply(senderId, goal ? formatGoal(goal) : "当前 Codex 会话没有目标。发送 /goal <目标> 设置。");
      } catch (error) {
        await this.reply(senderId, `无法读取目标：${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }

    const [action, ...rest] = input.split(/\s+/);
    const actionName = action.toLowerCase();
    if (actionName === "pause" || actionName === "resume" || actionName === "clear" || actionName === "status" || actionName === "budget") {
      await this.handleGoalControlCommand(senderId, actionName, rest.join(" "));
      return;
    }

    const objective = actionName === "edit" ? rest.join(" ").trim() : input;
    if (!objective) {
      await this.reply(senderId, "用法：/goal edit <新的目标>。");
      return;
    }
    if (objective.length > 4_000) {
      await this.reply(senderId, "目标最多 4000 个字符。较长说明请写入文件，再让目标引用该文件。");
      return;
    }
    await this.startGoal(senderId, { objective, status: "active" });
  }

  private async handleGoalControlCommand(senderId: string, action: string, arg: string): Promise<void> {
    const threadId = this.options.stateStore.getThread(senderId);
    if (!threadId) {
      await this.reply(senderId, "当前会话还没有 Codex thread。先发送 /goal <目标>。");
      return;
    }
    if (action === "status") {
      try {
        const goal = await this.runner.getGoal(threadId);
        await this.reply(senderId, goal ? formatGoal(goal) : "当前 Codex 会话没有目标。");
      } catch (error) {
        await this.reply(senderId, `无法读取目标：${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }
    if (action === "budget") {
      const budgetInput = arg.trim().toLowerCase();
      if (!budgetInput) {
        await this.reply(senderId, "用法：/goal budget <正整数> 或 /goal budget off。");
        return;
      }
      const tokenBudget = budgetInput === "off" ? null : Number(budgetInput);
      if (tokenBudget !== null && (!Number.isInteger(tokenBudget) || tokenBudget <= 0)) {
        await this.reply(senderId, "目标 token 预算必须是正整数，或使用 off 清除。");
        return;
      }
      await this.startGoal(senderId, { status: "active", tokenBudget }, false);
      return;
    }
    if (action === "clear") {
      try {
        const cleared = await this.runner.clearGoal(threadId);
        await this.reply(senderId, cleared ? "已清除当前目标。" : "当前会话没有可清除的目标。");
      } catch (error) {
        await this.reply(senderId, `无法清除目标：${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }

    const status: CodexGoalStatus = action === "pause" ? "paused" : "active";
    await this.startGoal(senderId, { status }, false);
  }

  private async startGoal(
    senderId: string,
    goalInput: { objective?: string; status: CodexGoalStatus; tokenBudget?: number | null },
    announce = true
  ): Promise<void> {
    const session = this.options.stateStore.ensureActiveSession(senderId, this.options.config.defaultCwd);
    const workspace = session.workspace ?? this.options.config.defaultCwd;
    const progressEnabled = session.streamReplies ?? this.options.config.streamReplies;
    const sentProgress = new Set<string>();
    const targetThreadId = session.threadId;
    const shouldObserve = goalInput.status === "active";
    if (shouldObserve) {
      this.options.onTurnStatus?.({ senderId, sessionId: session.id, active: true });
    }
    try {
      const result = await this.runner.setGoal({
        cwd: workspace,
        threadId: targetThreadId,
        model: session.model ?? this.options.config.model,
        effort: session.effort ?? this.options.config.effort,
        ...goalInput,
        ...(shouldObserve ? {
          onProgress: async (progress: string) => {
            if (!progressEnabled) return;
            const text = progress.trim();
            if (!text || sentProgress.has(text)) return;
            sentProgress.add(text);
            await this.reply(senderId, `【目标进度】${text}`);
          },
          onFinal: async (runResult) => {
            await this.sendCodexResult(senderId, runResult);
          },
          onError: async (error: Error) => {
            await this.reply(senderId, `目标执行失败：${error.message}`);
          },
          onStopped: async () => {
            this.options.onTurnStatus?.({ senderId, sessionId: session.id, active: false });
          }
        } : {})
      });
      this.options.stateStore.setThread(senderId, result.threadId);
      if (announce) {
        await this.reply(senderId, [
          `目标已设置：${result.goal.objective}`,
          `状态：${formatGoalStatus(result.goal.status)}`,
          result.goal.status === "active"
            ? "Codex 目标模式已启动，后续自动回合的最终回复会继续发送到这里。"
            : "下一条消息或 /goal resume 可继续推进。"
        ].join("\n"));
      } else {
        await this.reply(senderId, [
          `目标已更新。`,
          `状态：${formatGoalStatus(result.goal.status)}`,
          `目标：${result.goal.objective}`,
          formatGoalBudget(result.goal)
        ].filter(Boolean).join("\n"));
      }
    } catch (error) {
      if (shouldObserve) {
        this.options.onTurnStatus?.({ senderId, sessionId: session.id, active: false });
      }
      throw error;
    }
  }

  private async promptItemsFromMessage(message: NormalizedWeixinMessage): Promise<PromptBufferItem[]> {
    const items: PromptBufferItem[] = [];
    if (message.text.trim()) {
      items.push({ kind: "text", text: message.text });
    }
    const attachments = message.attachments ?? [];
    if (!attachments.length) {
      return items;
    }
    try {
      const downloaded = await downloadInboundAttachments({
        rootDir: this.options.inboundDir ?? path.join(this.options.config.defaultCwd, ".codex-weixin-inbound"),
        senderId: message.senderId,
        messageId: message.id,
        attachments,
        maxBytes: this.options.config.maxInboundBytes,
        fetch: this.options.mediaFetch
      });
      for (const attachment of downloaded) {
        items.push({
          kind: attachment.kind,
          path: attachment.path,
          label: attachment.label
        });
      }
    } catch (error) {
      if (error instanceof InboundMediaTooLargeError) throw error;
      items.push({
        kind: "text",
        text: `[WeChat attachment download failed: ${error instanceof Error ? error.message : String(error)}]`
      });
    }
    return items;
  }

  private async promptItemsFromMessageWithNotice(message: NormalizedWeixinMessage): Promise<PromptBufferItem[] | undefined> {
    try {
      return await this.promptItemsFromMessage(message);
    } catch (error) {
      if (!(error instanceof InboundMediaTooLargeError)) throw error;
      const maxMiB = Math.floor(error.maxBytes / (1024 * 1024));
      await this.reply(message.senderId, `附件超过 ${maxMiB} MiB 上限，请压缩或裁剪后重新发送。`);
      return undefined;
    }
  }

  private async runCodexTurn(message: NormalizedWeixinMessage, text: string, attachments: PromptBufferItem[] = []): Promise<void> {
    const session = this.options.stateStore.ensureActiveSession(message.senderId, this.options.config.defaultCwd);
    const promptPreview = buildPromptPreview(text, attachments);
    if (promptPreview) {
      this.options.stateStore.setSessionPromptPreview(session.id, promptPreview);
    }
    const workspace = this.options.stateStore.getWorkspace(message.senderId) ?? this.options.config.defaultCwd;
    let currentThreadId = this.options.stateStore.getThread(message.senderId) || undefined;
    const progressEnabled = session.streamReplies ?? this.options.config.streamReplies;
    const sentProgress = new Set<string>();
    this.options.onTurnStatus?.({ senderId: message.senderId, sessionId: session.id, active: true });
    try {
      await this.withTyping(message.senderId, async () => {
        console.log(`[codex-weixin] starting Codex turn for ${message.senderId} in ${workspace}`);
        const run = () => this.runner.run({
          prompt: buildPrompt(text, attachments),
          cwd: workspace,
          threadId: currentThreadId,
          model: session.model ?? this.options.config.model,
          effort: session.effort ?? this.options.config.effort,
          ...(progressEnabled ? {
            onProgress: async (progress: string) => {
              const progressText = progress.trim();
              if (!progressText || sentProgress.has(progressText)) return;
              sentProgress.add(progressText);
              await this.reply(message.senderId, `【进度】${progressText}`);
            }
          } : {})
        });
        let result: Awaited<ReturnType<HybridCodexRunner["run"]>>;
        try {
          result = await run();
        } catch (error) {
          if (!currentThreadId || !isArchivedThreadError(error)) {
            throw error;
          }
          console.warn(`[codex-weixin] archived Codex thread ${currentThreadId}; starting a fresh thread`);
          this.options.stateStore.setThread(message.senderId, "");
          currentThreadId = undefined;
          result = await run();
        }
        console.log(`[codex-weixin] Codex turn completed for ${message.senderId}; text=${result.text.length} chars`);
        await this.sendCodexResult(message.senderId, result);
      });
    } finally {
      this.options.onTurnStatus?.({ senderId: message.senderId, sessionId: session.id, active: false });
    }
  }

  private async sendCodexResult(
    senderId: string,
    result: { text: string; threadId?: string }
  ): Promise<void> {
    if (result.threadId) {
      this.options.stateStore.setThread(senderId, result.threadId);
    }
    const parsed = parseActionBlocks(result.text);
    const remaining = chunkText(parsed.visibleText);
    if (remaining.length) {
      for (const chunk of remaining) {
        await this.reply(senderId, chunk);
      }
    }
    for (const action of parsed.actions.send) {
      await this.sendLocalMedia(senderId, action);
    }
  }

  private async sendLocalMedia(senderId: string, action: { type: "image" | "file" | "video"; path: string }): Promise<void> {
    try {
      await sendLocalMediaFile({
        client: this.options.weixin,
        toUserId: senderId,
        contextToken: this.options.stateStore.getContextToken(senderId),
        filePath: action.path,
        kind: action.type
      });
    } catch (error) {
      await this.reply(senderId, `[codex-weixin] Failed to send ${action.type}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async withTyping(senderId: string, run: () => Promise<void>): Promise<void> {
    const sendTyping = async (typing: boolean) => {
      try {
        await this.options.weixin.sendTyping({
          toUserId: senderId,
          contextToken: this.options.stateStore.getContextToken(senderId),
          typing
        });
      } catch (error) {
        console.warn(`WeChat typing indicator failed for ${senderId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    };

    await sendTyping(true);
    const timer = setInterval(() => {
      void sendTyping(true);
    }, 5_000);
    try {
      await run();
    } finally {
      clearInterval(timer);
      await sendTyping(false);
    }
  }

  private async statusText(senderId: string): Promise<string> {
    const session = this.options.stateStore.getActiveSession(senderId);
    const workspace = session?.workspace ?? this.options.config.defaultCwd;
    const runtime = await this.effectiveRuntime(senderId);
    return [
      "codex-weixin status",
      `sender: ${senderId}`,
      `session: ${session?.title ?? "(new)"}`,
      `workspace: ${workspace}`,
      `thread: ${session?.threadId || "(new)"}`,
      `backend: ${this.options.config.codexBackend}`,
      `exec sandbox: ${this.options.config.codexExecSandbox ?? "(Codex default)"}`,
      `model: ${runtime.model ?? "(Codex default)"}`,
      `effort: ${runtime.effort ?? "(Codex default)"}`,
      `stream replies: ${(session?.streamReplies ?? this.options.config.streamReplies) ? "on" : "off"}${typeof session?.streamReplies === "boolean" ? " (session)" : " (global)"}`
    ].join("\n");
  }

  private async listCodexModels(): Promise<CodexModelOption[]> {
    try {
      return await (this.options.listCodexModels?.() ?? this.runner.listModels());
    } catch (error) {
      console.warn(`Codex model list unavailable: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  private async effectiveRuntime(senderId: string): Promise<CodexRuntimeInfo> {
    const session = this.options.stateStore.getActiveSession(senderId);
    const workspace = session?.workspace ?? this.options.config.defaultCwd;
    let runtime: CodexRuntimeInfo = {};
    try {
      runtime = await this.runner.getRuntimeInfo(workspace, session?.threadId);
    } catch (error) {
      console.warn(`Codex runtime info unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
    return {
      model: session?.model ?? this.options.config.model ?? runtime.model,
      effort: session?.effort ?? this.options.config.effort ?? runtime.effort,
      provider: runtime.provider
    };
  }

  private async reply(senderId: string, text: string): Promise<void> {
    const contextToken = this.options.stateStore.getContextToken(senderId);
    try {
      console.log(`[codex-weixin] sending reply to ${senderId}; text=${text.length} chars`);
      await this.options.weixin.sendText({ toUserId: senderId, text, contextToken });
      console.log(`[codex-weixin] sent reply to ${senderId}`);
    } catch (error) {
      if (isStaleContextError(error)) {
        console.warn(`WeChat context token is stale for ${senderId}; ask user to send a fresh message.`);
        return;
      }
      throw error;
    }
  }

  allowSender(senderId: string): void {
    this.access.allow(senderId);
    this.options.stateStore.setPairedSenderIds(this.access.listPairedSenderIds());
  }

  removeSender(senderId: string): void {
    this.access.remove(senderId);
    this.options.stateStore.setPairedSenderIds(this.access.listPairedSenderIds());
  }

  listAllowedSenders(): string[] {
    return this.access.listPairedSenderIds();
  }
}

function isArchivedThreadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /thread\/(?:resume|loaded)|session .* is archived|is archived/i.test(message);
}

function parseCommand(text: string): { name: string; arg: string } | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) {
    return undefined;
  }
  const [name, ...rest] = trimmed.slice(1).split(/\s+/);
  return { name: name.toLowerCase(), arg: rest.join(" ") };
}

function helpText(): string {
  return [
    "codex-weixin commands:",
    "/help - show commands",
    "/status - show current binding",
    "/bind <absolute-path> - bind this chat to a workspace",
    "/new - create a new managed Codex session",
    "/resume [R-number] - list or switch historical sessions",
    "/sessions [keyword] - search and import other local Codex sessions",
    "/session <S-number|id|name> - switch to a Codex session",
    "/goal [objective] - set, edit, pause, resume, clear, or inspect a Codex goal",
    "/model [number|model-id|default] - view or switch this session's model",
    "/effort [number|level|default] - view or switch reasoning effort",
    "/stream [on|off|default] - view or switch streaming replies",
    "/prompt start - buffer multiple WeChat messages",
    "/prompt done - submit buffered prompt",
    "/stop - interrupt the current Codex task"
  ].join("\n");
}

function formatSessionTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const fallbackEfforts = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

function selectModel(models: CodexModelOption[], input: string): CodexModelOption | undefined {
  if (/^\d+$/.test(input)) {
    return models[Number(input) - 1];
  }
  const normalized = input.toLowerCase();
  return models.find((model) => model.model.toLowerCase() === normalized);
}

function isPlausibleModelId(input: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(input);
}

function availableEfforts(model: CodexModelOption | undefined, models: CodexModelOption[]): string[] {
  const advertised = model?.supportedEfforts.length
    ? model.supportedEfforts.map((option) => option.effort)
    : models.flatMap((option) => option.supportedEfforts.map((effort) => effort.effort));
  return advertised.length ? [...new Set(advertised)] : fallbackEfforts;
}

function selectEffort(efforts: string[], input: string): string | undefined {
  if (/^\d+$/.test(input)) {
    return efforts[Number(input) - 1];
  }
  const normalized = input.toLowerCase();
  return efforts.find((effort) => effort.toLowerCase() === normalized);
}

function formatEffort(effort?: string): string {
  if (!effort) return "Codex 默认";
  const labels: Record<string, string> = {
    minimal: "最小",
    low: "低",
    medium: "中",
    high: "高",
    xhigh: "超高",
    max: "最大",
    ultra: "极高"
  };
  return labels[effort] ? `${labels[effort]}（${effort}）` : effort;
}

function formatCodexSessionList(sessions: CodexSessionSummary[], activeThreadId?: string): string {
  return sessions.map((session, index) => {
    const current = session.id === activeThreadId ? "【当前】" : "";
    const model = session.model ? `，${session.model}` : "";
    return [
      `[S${index + 1}] ${current}${session.title}`,
      `   来源：${formatCodexSource(session.source)}${model}｜更新：${formatSessionTime(session.updatedAt)}`,
      `   目录：${session.workspace || "未知"}`,
      `   摘要：${session.preview}`
    ].join("\n");
  }).join("\n\n");
}

function formatCodexSource(source: string): string {
  const labels: Record<string, string> = {
    cli: "Codex CLI",
    vscode: "Codex Desktop",
    appServer: "Codex app-server",
    exec: "Codex exec",
    unknown: "Codex"
  };
  return labels[source] ?? source;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function formatGoal(goal: CodexGoal): string {
  return [
    "当前 Codex 目标：",
    goal.objective,
    `状态：${formatGoalStatus(goal.status)}`,
    `进度：${goal.tokensUsed} tokens · ${formatDuration(goal.timeUsedSeconds)}`,
    formatGoalBudget(goal)
  ].filter(Boolean).join("\n");
}

function formatGoalBudget(goal: CodexGoal): string {
  return goal.tokenBudget === undefined
    ? "预算：未设置"
    : `预算：${goal.tokensUsed}/${goal.tokenBudget} tokens`;
}

function formatGoalStatus(status: CodexGoalStatus): string {
  const labels: Record<CodexGoalStatus, string> = {
    active: "进行中",
    paused: "已暂停",
    blocked: "受阻，需要处理",
    usageLimited: "用量受限",
    budgetLimited: "达到预算上限",
    complete: "已完成"
  };
  return `${labels[status]}（${status}）`;
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0 秒";
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const remaining = total % 60;
  if (hours) return `${hours} 小时 ${minutes} 分`;
  if (minutes) return `${minutes} 分 ${remaining} 秒`;
  return `${remaining} 秒`;
}

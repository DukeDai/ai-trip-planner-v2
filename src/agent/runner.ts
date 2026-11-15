import { Command } from "@langchain/langgraph";
import type { BaseCheckpointSaver, BaseStore } from "@langchain/langgraph";
import type { AppConfig } from "../config.ts";
import type { TripMeta } from "../core/types.ts";
import type { TripStore } from "../core/trips.ts";
import type { TravelData } from "../data/providers.ts";
import type { TripRepository } from "../core/persist.ts";
import { buildTripAgent } from "./build.ts";

export interface AgentEvent {
  type: string;
  [key: string]: unknown;
}

export interface RunContext {
  config: AppConfig;
  trips: TripStore;
  data: TravelData;
  checkpointer: BaseCheckpointSaver;
  store?: BaseStore;
  /** 外部取数落库仓储 */
  repo?: TripRepository | null;
}

interface ToolCallInfo {
  name: string;
  args: Record<string, unknown>;
  id: string;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") return block;
        if (block && typeof block === "object") {
          const b = block as { type?: string; text?: string };
          if (b.type === "text" && typeof b.text === "string") return b.text;
        }
        return "";
      })
      .join("");
  }
  return "";
}

function isMessageLike(v: unknown): boolean {
  return Boolean(v && typeof v === "object" && "content" in (v as Record<string, unknown>));
}

function toolCallsOf(message: unknown): ToolCallInfo[] {
  if (!message || typeof message !== "object") return [];
  const calls = (message as { tool_calls?: unknown }).tool_calls;
  if (!Array.isArray(calls)) return [];
  const out: ToolCallInfo[] = [];
  for (const c of calls) {
    if (!c || typeof c !== "object") continue;
    const cc = c as { name?: string; args?: unknown; id?: string };
    out.push({
      name: String(cc.name ?? ""),
      args: (cc.args && typeof cc.args === "object" ? cc.args : {}) as Record<string, unknown>,
      id: String(cc.id ?? "")
    });
  }
  return out;
}

function chunkEntries(chunk: unknown): { mode: string; payload: unknown }[] {
  if (Array.isArray(chunk) && chunk.length === 2 && typeof chunk[0] === "string") {
    return [{ mode: chunk[0], payload: chunk[1] }];
  }
  if (chunk && typeof chunk === "object") {
    const obj = chunk as Record<string, unknown>;
    const modes = ["messages", "updates", "values"].filter((m) => m in obj);
    if (modes.length > 0) {
      return modes.map((m) => ({ mode: m, payload: obj[m] }));
    }
  }
  return [];
}

interface PendingTool {
  name: string;
  startedAt: number;
  args: Record<string, unknown>;
}

export interface InterruptInfo {
  interruptId: string;
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
}

/**
 * 从 checkpointer 里捞出该行程当前挂起的 HITL。
 * 有了 PG 之后，挂起状态存在 checkpoint 里 —— 即使是另一个进程/另一次重启发起的规划，
 * 这里也能认出来并继续（不再依赖进程内的 interrupts map）。
 */
export async function findTripInterrupt(ctx: RunContext, trip: TripMeta): Promise<InterruptInfo | null> {
  const workspace = ctx.trips.workspace(trip.id);
  const { agent } = buildTripAgent({
    config: ctx.config,
    trip,
    workspace,
    data: ctx.data,
    checkpointer: ctx.checkpointer,
    store: ctx.store,
    repo: ctx.repo ?? null,
    onApproved: () => {
      ctx.trips.update(trip.id, { status: "approved" });
    }
  });
  return findInterrupt(agent, trip.id);
}

export async function* streamTurn(
  ctx: RunContext,
  trip: TripMeta,
  message: string
): AsyncGenerator<AgentEvent> {
  const workspace = ctx.trips.workspace(trip.id);
  const { agent } = buildTripAgent({
    config: ctx.config,
    trip,
    workspace,
    data: ctx.data,
    checkpointer: ctx.checkpointer,
    store: ctx.store,
    repo: ctx.repo ?? null,
    onApproved: () => {
      ctx.trips.update(trip.id, { status: "approved" });
    }
  });

  const threadId = trip.id;
  const pending = new Map<string, PendingTool>();
  let subagents = new Map<string, string>();
  let lastTodos: unknown[] = [];

  yield { type: "status", phase: "clarify", message: "开始规划：" + trip.destination + " " + trip.startDate + "→" + trip.endDate };

  const stream = await agent.stream(
    { messages: [{ role: "user", content: message }] },
    {
      configurable: { thread_id: threadId },
      streamMode: ["messages", "updates", "values"]
    }
  );

  for await (const chunk of stream) {
    for (const { mode, payload } of chunkEntries(chunk)) {
      if (mode === "messages") {
        // LangGraph 的 messages 模式吐的是 [message, metadata] 元组
        const raw = Array.isArray(payload) ? payload[0] : payload;
        if (!isMessageLike(raw)) continue;
        const calls = toolCallsOf(raw);
        if (calls.length === 0) {
          const t = textOf((raw as { content?: unknown }).content);
          if (t) yield { type: "token", text: t };
        }
        continue;
      }

      if (mode === "updates") {
        const updates = (payload ?? {}) as Record<string, unknown>;
        for (const [, stateUpdate] of Object.entries(updates)) {
          if (!stateUpdate || typeof stateUpdate !== "object") continue;
          const su = stateUpdate as { messages?: unknown[]; todos?: unknown };
          for (const m of su.messages ?? []) {
            const calls = toolCallsOf(m);
            for (const call of calls) {
              pending.set(call.id, { name: call.name, startedAt: Date.now(), args: call.args });
              if (call.name === "task") {
                const st = String(call.args.subagent_type ?? call.args.subagentType ?? "subagent");
                subagents.set(st, "running");
                yield { type: "subagent", name: st, status: "running" };
                continue;
              }
              if (call.name === "write_todos") {
                const todos = (call.args.todos ?? call.args.todosList ?? []) as unknown[];
                if (Array.isArray(todos) && todos.length > 0) {
                  lastTodos = todos;
                  yield { type: "todo", todos: normalizeTodos(todos) };
                }
                continue;
              }
              yield { type: "tool", name: call.name, status: "running", input: call.args };
            }
          }
          for (const m of su.messages ?? []) {
            if (!m || typeof m !== "object") continue;
            const tm = m as { _getType?: () => string; content?: unknown; tool_call_id?: string; status?: string };
            const type = typeof tm._getType === "function" ? tm._getType() : "";
            if (!type.toLowerCase().includes("tool")) continue;
            const id = String(tm.tool_call_id ?? "");
            const info = pending.get(id);
            const ms = info ? Date.now() - info.startedAt : undefined;
            const body = textOf(tm.content);
            const failed = tm.status === "error" || /^(error|失败)/i.test(body.slice(0, 40));
            pending.delete(id);
            if (info?.name === "task") {
              // 用 tool_call 的参数定位具体子代理，避免并发时张冠李戴
              const st = String(info.args.subagent_type ?? info.args.subagentType ?? "subagent");
              subagents.set(st, failed ? "error" : "ok");
              yield {
                type: "subagent",
                name: st,
                status: failed ? "error" : "ok",
                summary: body.slice(0, 400),
                ms
              };
              continue;
            }
            if (info?.name === "write_file") {
              const path = String(
                info.args.path ??
                  info.args.file_path ??
                  info.args.filePath ??
                  info.args.filename ??
                  ""
              );
              if (path) yield { type: "artifact", name: path.replace(/^\/+/, "") };
            }
            yield {
              type: "tool",
              name: info?.name ?? "tool",
              status: failed ? "error" : "ok",
              outputPreview: body.slice(0, 600),
              ms
            };
          }
          if (Array.isArray(su.todos) && su.todos.length > 0) {
            lastTodos = su.todos;
            yield { type: "todo", todos: normalizeTodos(su.todos) };
          }
        }
        continue;
      }

      if (mode === "values") {
        const state = (payload ?? {}) as { todos?: unknown };
        if (Array.isArray(state.todos) && state.todos.length > 0) {
          lastTodos = state.todos;
          yield { type: "todo", todos: normalizeTodos(state.todos) };
        }
      }
    }
  }

  const interrupt = await findInterrupt(agent, threadId);
  if (interrupt) {
    yield {
      type: "interrupt",
      interruptId: interrupt.interruptId,
      toolCallId: interrupt.toolCallId,
      kind: "finalize",
      title: "行程待确认",
      details: buildInterruptDetails(interrupt),
      budget: buildInterruptBudget(interrupt),
      toolArgs: interrupt.args
    };
    return;
  }

  // 产物同步入库：agent 用 write_file 写的是磁盘，这里兜住落库
  await ctx.trips.syncArtifactsToRepo(trip.id);
  const plan = ctx.trips.readPlan(trip.id);
  yield { type: "done", plan };
}

export async function* resumeTurn(
  ctx: RunContext,
  trip: TripMeta,
  interruptInfo: InterruptInfo,
  approved: boolean,
  reason?: string
): AsyncGenerator<AgentEvent> {
  const workspace = ctx.trips.workspace(trip.id);
  const { agent } = buildTripAgent({
    config: ctx.config,
    trip,
    workspace,
    data: ctx.data,
    checkpointer: ctx.checkpointer,
    store: ctx.store,
    repo: ctx.repo ?? null,
    onApproved: () => {
      ctx.trips.update(trip.id, { status: "approved" });
    }
  });

  // HumanInTheLoopMiddleware 的续跑契约：resume 必须是 { decisions: [...] }，
  // 且 decisions 数量要与被挂起的工具调用数量一致。
  const decision = approved
    ? { type: "approve" }
    : { type: "reject", message: reason ?? "用户驳回，请修改后重新提交" };

  const stream = await agent.stream(new Command({ resume: { decisions: [decision] } }), {
    configurable: { thread_id: trip.id },
    streamMode: ["messages", "updates", "values"]
  });

  for await (const chunk of stream) {
    for (const { mode, payload } of chunkEntries(chunk)) {
      if (mode === "messages") {
        const raw = Array.isArray(payload) ? payload[0] : payload;
        if (!isMessageLike(raw)) continue;
        const calls = toolCallsOf(raw);
        if (calls.length > 0) continue;
        const t = textOf((raw as { content?: unknown }).content);
        if (t) yield { type: "token", text: t };
      }
    }
  }

  const next = await findInterrupt(agent, trip.id);
  if (next) {
    yield {
      type: "interrupt",
      interruptId: next.interruptId,
      toolCallId: next.toolCallId,
      kind: "finalize",
      title: approved ? "仍需确认" : "已驳回，重新提交",
      details: buildInterruptDetails(next),
      budget: buildInterruptBudget(next),
      toolArgs: next.args
    };
    return;
  }
  await ctx.trips.syncArtifactsToRepo(trip.id);
  const plan = ctx.trips.readPlan(trip.id);
  yield { type: "done", plan, approved };
}

function normalizeTodos(todos: unknown[]): { content: string; status: string }[] {
  const out: { content: string; status: string }[] = [];
  for (const t of todos) {
    if (!t || typeof t !== "object") continue;
    const todo = t as { content?: unknown; task?: unknown; status?: unknown };
    const content = String(todo.content ?? todo.task ?? "");
    if (!content) continue;
    out.push({ content, status: String(todo.status ?? "pending") });
  }
  return out;
}

type StateReadable = {
  getState: (config: { configurable: { thread_id: string } }) => Promise<unknown>;
};

export async function findInterrupt(agent: unknown, threadId: string): Promise<InterruptInfo | null> {
  try {
    const getter = agent as StateReadable;
    const state = (await getter.getState({ configurable: { thread_id: threadId } })) as {
      tasks?: { interrupts?: unknown[] }[];
      messages?: unknown[];
    };
    // 待执行的工具调用（被 HITL 挂起的那一个）——它的参数里才有摘要与预算
    let pendingArgs: Record<string, unknown> | null = null;
    let pendingToolCallId = "";
    for (const m of state?.messages ?? []) {
      for (const call of toolCallsOf(m)) {
        if (call.name === "finalize_itinerary") {
          pendingArgs = call.args;
          pendingToolCallId = call.id;
        }
      }
    }
    for (const task of state?.tasks ?? []) {
      for (const raw of task?.interrupts ?? []) {
        const it = raw as { id?: string; value?: unknown };
        const value = it?.value as {
          actionRequests?: { name?: string; args?: unknown; description?: string }[];
        } | undefined;
        if (!value) continue;
        // HumanInTheLoopMiddleware 的中断载荷：{ actionRequests, reviewConfigs }
        const request = value.actionRequests?.[0];
        const args =
          pendingArgs ??
          (request?.args as Record<string, unknown> | undefined) ??
          {};
        const toolName = request?.name ?? "finalize_itinerary";
        const toolCallId = pendingToolCallId || "finalize_itinerary";
        return {
          interruptId: String(it.id ?? toolCallId),
          toolCallId,
          toolName,
          args
        };
      }
    }
  } catch {
    return null;
  }
  return null;
}

function buildInterruptDetails(info: InterruptInfo): string[] {
  const details: string[] = [];
  const summary = info.args.summary;
  if (typeof summary === "string" && summary.trim()) {
    for (const line of summary.split("\n")) {
      if (line.trim()) details.push(line.trim());
    }
  }
  const extra = info.args.details;
  if (Array.isArray(extra)) {
    for (const d of extra) {
      const s = String(d).trim();
      if (s) details.push(s);
    }
  }
  if (details.length === 0) details.push("行程已就绪，等待人工确认后定稿");
  return details;
}

function buildInterruptBudget(info: InterruptInfo): { planned: number; total: number; delta: number; currency: string } | null {
  // 预算可以由工具参数直接带，也可以从 summary 文本里解析出「差额」字样
  const b = info.args.budget;
  if (!b || typeof b !== "object") return null;
  const obj = b as { planned?: unknown; total?: unknown; delta?: unknown; currency?: unknown };
  return {
    planned: Number(obj.planned ?? 0),
    total: Number(obj.total ?? 0),
    delta: Number(obj.delta ?? 0),
    currency: String(obj.currency ?? "CNY")
  };
}

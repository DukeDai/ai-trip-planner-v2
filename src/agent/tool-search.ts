import { createMiddleware, tool, type AgentMiddleware, type ModelRequest } from "langchain";
import { z } from "zod";
import { ALWAYS_VISIBLE_TOOLS, GATED_TOOLS, TOOL_CATALOG, catalogByDomain, type ToolCatalogEntry } from "./tool-catalog.ts";

/**
 * 本地 tool search。
 *
 * 为什么不用 provider 原生的 `providerToolSearchMiddleware`：
 * 它只支持 OpenAI gpt-5.4+ / Claude Sonnet 4+，本项目当前模型是 MiniMax-M3，调用会直接抛错。
 * 所以这里自己实现一套 —— 而且比 provider 原生更可控：
 *   1. 细粒度目录（tool-catalog.ts）按数据域组织；
 *   2. `tool_search` 元工具让模型主动检索并装载；
 *   3. middleware 按对话上下文对目录打分，只把当前真正用得上的工具挂给模型，
 *      已经用过的工具保持可见（sticky），避免"查过一次就消失"。
 *
 * 开关：`TRIP_TOOL_SEARCH=local|provider|none`（见 config.ts）。
 */

export interface ToolSearchRuntime {
  /** 模型主动检索装载的工具名集合 */
  loaded: Set<string>;
}

function fmt(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (typeof b === "string") return b;
        if (b && typeof b === "object" && "text" in b) return String((b as { text: unknown }).text);
        return "";
      })
      .join("");
  }
  return "";
}

/**
 * 检索评分：把对话上下文（用户诉求 + 最近工具调用及其参数）与目录关键词比对。
 * 参数里往往带着 todo 文本（「查住宿区域」「查京都天气」），是最准的检索信号。
 */
export function scoreCatalog(context: string): { entry: ToolCatalogEntry; score: number }[] {
  const hay = context.toLowerCase();
  const out: { entry: ToolCatalogEntry; score: number }[] = [];
  for (const entry of TOOL_CATALOG) {
    let score = 0;
    for (const kw of entry.keywords) {
      if (!kw) continue;
      if (hay.includes(kw.toLowerCase())) score += kw.length >= 3 ? 3 : 2;
    }
    if (score > 0) out.push({ entry, score });
  }
  return out.sort((a, b) => b.score - a.score);
}

/** 从模型请求里收集检索上下文：最近的用户诉求 + 最近工具调用的名字与参数 */
export function collectContext(messages: unknown[]): string {
  const parts: string[] = [];
  const humans: string[] = [];
  for (const m of messages) {
    const msg = m as { _getType?: () => string; content?: unknown; tool_calls?: { name?: string; args?: unknown }[] };
    const type = typeof msg._getType === "function" ? msg._getType() : "";
    if (type === "human") {
      const t = textOf(msg.content);
      if (t) humans.push(t);
      continue;
    }
    if (Array.isArray(msg.tool_calls)) {
      for (const c of msg.tool_calls) {
        if (c?.name) parts.push(String(c.name));
        if (c?.args) {
          try {
            parts.push(JSON.stringify(c.args));
          } catch {
            /* ignore */
          }
        }
      }
    }
  }
  // 最近两条用户诉求 + 最近 12 条消息里的工具调用
  for (const h of humans.slice(-2)) parts.push(h);
  return parts.join(" ").toLowerCase();
}

/** `tool_search` 元工具：按关键词/数据域检索目录，并把命中的工具装载进运行时 */
export function createToolSearchTool(runtime: ToolSearchRuntime) {
  return tool(
    async ({ query, domain }) => {
      const q = String(query ?? "").trim().toLowerCase();
      const pool = catalogByDomain(domain);
      const scored = pool
        .map((entry) => {
          let score = 0;
          for (const kw of entry.keywords) {
            if (q.includes(kw.toLowerCase())) score += kw.length >= 3 ? 3 : 2;
          }
          if (q.includes(entry.tool.toLowerCase())) score += 5;
          if (q.includes(entry.domain.toLowerCase())) score += 4;
          if (q.includes(entry.title)) score += 3;
          return { entry, score };
        })
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score);
      const hits = (scored.length > 0 ? scored : pool.map((entry) => ({ entry, score: 0 })))
        .slice(0, 6)
        .map((x) => x.entry);
      for (const h of hits) runtime.loaded.add(h.tool);
      return fmt({
        ok: true,
        query,
        domain: domain ?? null,
        matched: hits.map((h) => ({
          id: h.id,
          tool: h.tool,
          title: h.title,
          summary: h.summary,
          whenToUse: h.whenToUse,
          args: h.args,
          example: h.example
        })),
        note: "以上工具已装载，下一步直接调用同名工具；不需要的工具就别用"
      });
    },
    {
      name: "tool_search",
      description:
        "检索工具目录并装载所需工具。用法：tool_search({ query: '想做什么' })。" +
        "query 用自然语言写，如「找京都的寺庙」「算两点通勤多久」「查当地货币」「找本地替代方案」。" +
        "返回的工具名可以直接调用。工具太多时先检索再调用，能显著减少误用。",
      schema: z.object({
        query: z.string().describe("想完成的事（自然语言）"),
        domain: z
          .string()
          .optional()
          .describe("可选数据域：geo / poi:sight / poi:food / poi:stay / poi:transport / weather / route / country / budget / alternative")
      })
    }
  );
}

/**
 * 本地检索中间件：按上下文裁剪挂给模型的工具列表。
 * 流程类工具（review/submit/finalize）与元工具（tool_search）始终可见；
 * 数据类工具按目录打分命中才可见，已装载过的工具保持可见。
 */
export function createLocalToolSearchMiddleware(
  runtime: ToolSearchRuntime,
  options: { maxTools?: number } = {}
): AgentMiddleware {
  const maxTools = options.maxTools ?? 7;
  return createMiddleware({
    name: "LocalToolSearch",
    wrapModelCall: async (request: ModelRequest, handler) => {
      const context = collectContext(request.messages as unknown[]);
      const scored = scoreCatalog(context);
      const selected = new Set<string>(ALWAYS_VISIBLE_TOOLS);
      for (const name of runtime.loaded) selected.add(name);
      for (const { entry } of scored.slice(0, maxTools)) selected.add(entry.tool);
      if (scored.length === 0) {
        // 上下文里检索不到信号时给一个最小可用集合，避免模型无工具可用
        selected.add("search_sights");
        selected.add("search_food");
      }
      const tools = request.tools.filter(
        (t) => selected.has(String(t.name)) || !GATED_TOOLS.has(String(t.name))
      );
      return handler({ ...request, tools });
    }
  }) as AgentMiddleware;
}

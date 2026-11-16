import { createMiddleware, type AgentMiddleware } from "langchain";
import { ToolMessage } from "@langchain/core/messages";

/**
 * 工具防护中间件 —— 防「一个坏参数打死整趟规划」。
 *
 * ## 实测事故（2026-11-16 京都 E2E）
 *
 * 模型给 `grep` 传了一个含 null 字节的 pattern：
 * `[\x00-\b\x0B\f\x0E-\x1F]`
 * deepagents 的 `FilesystemBackend.ripgrepSearch` 把 pattern 原样塞进 `spawn("rg", args)`，
 * Node 的 `child_process.spawn` 拒绝带 null 字节的参数 → `ERR_INVALID_ARG_VALUE`。
 *
 * 关键在于**异常会逃逸**：deepagents 的 `createGrepTool` 没有 try/catch，
 * 工具函数抛出的错误一路冒泡成未捕获的 Promise rejection，
 * Node 24 的默认行为是**直接终止进程** —— 整趟规划、checkpoint、SSE 全没了。
 *
 * 所以这里做三件事：
 *   1. **净化参数**：把控制字符（含 null 字节）从文件系统类工具的字符串参数里剥掉。
 *      `grep` 本来就是**字面量**搜索（rg -F），模型却常写正则字符类 ——
 *      pattern 里含控制字符时判为无效调用，直接回一条「grep 是字面量搜索」的提示，
 *      既不会进 `spawn`，也省掉一次注定匹配不到的白跑。
 *   2. **兜住异常**：任何工具抛错都转成 `status:"error"` 的 ToolMessage，
 *      模型能读到错误并自己改，而不是整轮跑挂。
 *   3. **空 pattern 拦截**：净化后 pattern 变成空串会让 rg 匹配每一行，
 *      属于无效调用，同样直接回一条让模型重写。
 */

/** 会把参数原样拼进子进程 argv 的文件系统类工具 */
const FILESYSTEM_TOOLS = new Set(["grep", "glob", "ls", "read_file", "write_file", "edit_file"]);

/**
 * 剥掉控制字符，保留 \t \n \r（这三个在文本里有意义）。
 * 注意保留 null 字节之外的控制字符也会一并剥掉 —— 它们对 rg 也没用。
 */
export function stripControlChars(input: string): string {
  // eslint-disable-next-line no-control-regex
  return input.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
}

export interface SanitizeResult {
  args: Record<string, unknown>;
  /** 被改过的参数名 */
  changed: string[];
  /** 净化后是否变成无效调用（pattern 含控制字符或净化后为空） */
  invalid: boolean;
}

/** 净化某个工具调用的参数 */
export function sanitizeToolArgs(toolName: string, args: Record<string, unknown>): SanitizeResult {
  if (!FILESYSTEM_TOOLS.has(toolName)) {
    return { args, changed: [], invalid: false };
  }
  const changed: string[] = [];
  const next: Record<string, unknown> = { ...args };
  for (const [key, value] of Object.entries(next)) {
    if (typeof value !== "string") continue;
    const cleaned = stripControlChars(value);
    if (cleaned !== value) {
      next[key] = cleaned;
      changed.push(key);
    }
  }
  // pattern 里出现控制字符 → 模型把它当正则写了，但 grep 是**字面量**搜索。
  // 这种 pattern 永远匹配不到东西，白跑一次搜索没有意义，直接判为无效调用。
  const patternHadControlChars = changed.includes("pattern");
  // 净化后 pattern 变成空串 → 同样是无效调用
  const patternEmptied =
    typeof next.pattern === "string" && (next.pattern as string).trim() === "";
  const invalid = patternHadControlChars || patternEmptied;
  return { args: next, changed, invalid };
}

/**
 * 单次运行内的改稿次数上限。
 *
 * 为什么要有：审查通过后主代理常常继续打磨，每次改稿都换掉 planHash → 又触发新一轮审查
 * → 于是「审一轮→改一轮」无限循环（实测上海 E2E 改稿 250 次、审查 16 轮，
 * 一趟 2 天的行程跑了 27 分钟）。
 *
 * 到顶后 edit_file 直接被挡，并明确告诉模型「别再改了，去 submit → finalize」。
 * 这样既能止损，又不会像硬截断那样把行程丢在半路。
 */
const MAX_EDIT_CALLS = 300;

/**
 * 工具防护中间件：净化参数 + 兜住工具异常 + 改稿次数预算。
 */
export function createToolGuardMiddleware(): AgentMiddleware {
  // 计数器闭包在中间件实例里 → 每次 buildTripAgent 一轮
  let editCalls = 0;
  return createMiddleware({
    name: "ToolGuard",
    wrapToolCall: async (request: any, handler: any) => {
      const name = String(request?.toolCall?.name ?? "");
      const rawArgs = (request?.toolCall?.args ?? {}) as Record<string, unknown>;
      const { args, changed, invalid } = sanitizeToolArgs(name, rawArgs);

      if (name === "edit_file" || name === "write_file") {
        editCalls++;
        if (editCalls > MAX_EDIT_CALLS) {
          return new ToolMessage({
            content:
              `改稿次数已达上限（本次运行 ${MAX_EDIT_CALLS} 次）—— 不要再改 /itinerary.json 了。` +
              `行程结构已由审查确认，剩余待确认项写进 risks / unconfirmed 即可。` +
              `**立刻调用 submit_itinerary，然后 finalize_itinerary**。`,
            tool_call_id: request.toolCall.id,
            name,
            status: "error"
          });
        }
      }

      if (invalid) {
        const sanitized = typeof args.pattern === "string" ? args.pattern : "";
        return new ToolMessage({
          content:
            `工具 ${name} 的参数无效：pattern 里含控制字符（模型多半把它当正则写了）。` +
            `grep 是**字面量**搜索，不是正则 —— 直接写要找的那几个字即可。` +
            (sanitized ? `（已净化为 "${sanitized}"，但这样匹配不到东西，请换成普通关键词）` : ""),
          tool_call_id: request.toolCall.id,
          name,
          status: "error"
        });
      }

      const nextRequest = changed.length
        ? { ...request, toolCall: { ...request.toolCall, args } }
        : request;

      try {
        return await handler(nextRequest);
      } catch (err) {
        // 工具内部的异常不能逃逸 —— 逃逸会变成未捕获拒绝并终止整个进程
        const message = err instanceof Error ? err.message : String(err);
        return new ToolMessage({
          content:
            `工具 ${name} 执行失败：${message}。` +
            `这是工具内部错误，行程规划本身没有失败 —— 请换个写法或换用其它工具继续，不要重复同样的调用。`,
          tool_call_id: request.toolCall.id,
          name,
          status: "error"
        });
      }
    }
  }) as AgentMiddleware;
}

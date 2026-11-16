import { ChatAnthropic } from "@langchain/anthropic";
import { ChatOpenAI } from "@langchain/openai";
import { createDeepAgent, FilesystemBackend, createHarnessProfile, registerHarnessProfile } from "deepagents";
import { providerToolSearchMiddleware, type AgentMiddleware } from "langchain";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BaseCheckpointSaver, BaseStore } from "@langchain/langgraph";
import type { AppConfig } from "../config.ts";
import type { TripMeta } from "../core/types.ts";
import type { TripWorkspace } from "../core/trips.ts";
import type { TravelData } from "../data/providers.ts";
import type { TripRepository } from "../core/persist.ts";
import { MAIN_SYSTEM_PROMPT, SUBAGENTS } from "./prompts.ts";
import { createTools, type ReviewerRunner } from "./tools.ts";
import { runReview } from "./reviewer.ts";
import { createLocalToolSearchMiddleware, createToolSearchTool, type ToolSearchRuntime } from "./tool-search.ts";
import { createToolGuardMiddleware } from "./tool-guard.ts";
import { GATED_TOOLS } from "./tool-catalog.ts";

export const SUBAGENT_NAMES = SUBAGENTS.map((s) => s.name);

/**
 * 关掉 deepagents 自动注入的 `general-purpose` 子代理。
 *
 * 为什么要关：它拥有**主代理的全部工具**（含 grep / glob / write_file），
 * 而本项目的取数已经拆成 4 个专职子代理（transport / stay / sights / food）。
 * 实测（2026-11-16 京都 E2E）general-purpose 既容易挂死，
 * 也是「一个含 null 字节的 grep 参数打死整趟规划」的来源。
 *
 * deepagents 只在 harness profile 里开放这个开关，
 * 所以按 provider 注册一份「禁用 general-purpose」的 profile。
 */
let generalPurposeDisabled = false;
export function disableGeneralPurposeSubagent(): void {
  if (generalPurposeDisabled) return;
  generalPurposeDisabled = true;
  for (const provider of ["anthropic", "openai"]) {
    try {
      registerHarnessProfile(
        provider,
        createHarnessProfile({ generalPurposeSubagent: { enabled: false } })
      );
    } catch {
      // 注册失败也不能影响主流程 —— 顶多退回到「有 general-purpose」的旧行为
    }
  }
}

const SUBAGENT_TOOLS: Record<string, string[]> = {
  transport: ["geocode_place", "search_transport_hub", "measure_travel_time", "get_daily_weather"],
  stay: ["geocode_place", "search_lodging", "measure_travel_time"],
  sights: ["geocode_place", "search_sights", "get_daily_weather"],
  food: ["search_food", "geocode_place"]
};

function bearerFetch(token: string) {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(
      init?.headers ?? (typeof Request !== "undefined" && input instanceof Request ? input.headers : undefined)
    );
    headers.delete("x-api-key");
    headers.set("authorization", "Bearer " + token);
    return fetch(input, { ...init, headers });
  };
}

export function createModel(
  config: AppConfig,
  options: { model?: string; thinking?: "enabled" | "disabled"; timeoutMs?: number } = {}
): BaseChatModel {
  const { provider, baseURL, apiKey } = config.llm;
  const model = options.model ?? config.llm.model;
  const thinking = options.thinking ?? config.llm.thinking;
  // 模型调用必须有上限：实测有过一次子代理调用挂死 7 分钟，把整趟规划拖死
  const timeoutMs = options.timeoutMs ?? 240_000;
  if (provider === "openai") {
    return new ChatOpenAI({
      model,
      apiKey,
      temperature: 0,
      maxTokens: 8192,
      timeout: timeoutMs,
      maxRetries: 1,
      configuration: { baseURL }
    });
  }
  // Anthropic 协议：SDK 会在 baseURL 后拼 /v1/messages，因此 baseURL 不要带结尾的 /v1
  const normalized = baseURL.replace(/\/v1\/?$/, "");
  return new ChatAnthropic({
    model,
    apiKey: "bearer-proxy",
    temperature: 0,
    maxTokens: 8192,
    thinking: thinking === "enabled" ? { type: "enabled", budget_tokens: 4096 } : { type: "disabled" },
    clientOptions: {
      baseURL: normalized,
      timeout: timeoutMs,
      maxRetries: 1,
      fetch: bearerFetch(apiKey)
    }
  });
}

export interface BuildAgentOptions {
  config: AppConfig;
  trip: TripMeta;
  workspace: TripWorkspace;
  data: TravelData;
  checkpointer: BaseCheckpointSaver;
  store?: BaseStore;
  /** 外部取数落库仓储 */
  repo?: TripRepository | null;
  onApproved?: (summary: string) => void;
  /** 用户本次的原始诉求（给 reviewer 判断需求匹配度） */
  userRequest?: string;
}

export function buildTripAgent(opts: BuildAgentOptions) {
  disableGeneralPurposeSubagent();
  // virtualMode=true：把工具里的 "/xxx" 当作行程目录内的虚拟路径，
  // 拒绝 .. / ~ 穿越，并保证解析结果仍在 rootDir 内（默认 virtualMode=false 会直接放行整机绝对路径）。
  const backend = new FilesystemBackend({ rootDir: opts.workspace.dir, virtualMode: true });

  // 子代理与审查器都用独立模型实例 + 关闭思考，压掉延迟与 token
  const workerModel = createModel(opts.config, {
    model: opts.config.llm.subagentModel,
    thinking: "disabled",
    timeoutMs: 180_000
  });
  const reviewerModel = createModel(opts.config, {
    model: opts.config.llm.subagentModel,
    thinking: "disabled",
    timeoutMs: 180_000
  });

  const reviewer: ReviewerRunner = (input) => runReview({ model: reviewerModel, ...input });

  const tools = createTools({
    data: opts.data,
    workspace: opts.workspace,
    repo: opts.repo ?? null,
    tripId: opts.trip.id,
    onApproved: opts.onApproved,
    reviewer,
    requirements: {
      origin: opts.trip.origin,
      destination: opts.trip.destination,
      startDate: opts.trip.startDate,
      endDate: opts.trip.endDate,
      travelers: opts.trip.travelers,
      budgetTotal: opts.trip.budgetTotal,
      currency: opts.trip.currency,
      preferences: opts.trip.preferences,
      userRequest: opts.userRequest
    }
  });

  // 本地 tool search：元工具 + 按上下文裁剪工具列表的中间件
  const toolSearchRuntime: ToolSearchRuntime = { loaded: new Set<string>() };
  const toolSearchTool = createToolSearchTool(toolSearchRuntime);
  const allTools = [...tools, toolSearchTool];

  const middleware: AgentMiddleware[] = [];
  // 工具防护：净化含控制字符的参数 + 兜住工具内部异常（异常逃逸会终止整个进程）
  const toolGuard = createToolGuardMiddleware();
  middleware.push(toolGuard);
  const mode = opts.config.llm.toolSearch;
  if (mode === "provider") {
    // provider 原生 tool search：只支持 OpenAI gpt-5.4+ / Claude Sonnet 4+，换模型时可开
    middleware.push(
      providerToolSearchMiddleware({
        searchableTools: allTools.filter((t) => GATED_TOOLS.has(t.name))
      })
    );
  } else if (mode === "local") {
    middleware.push(createLocalToolSearchMiddleware(toolSearchRuntime));
  }

  const subagents = SUBAGENTS.map((spec) => ({
    name: spec.name,
    description: spec.description,
    systemPrompt: spec.systemPrompt,
    tools: tools.filter((t) => (SUBAGENT_TOOLS[spec.name] ?? []).includes(t.name)),
    model: workerModel,
    skills: ["/skills/"],
    // 自定义 middleware 不会自动传给非 forked 子代理 —— 必须显式挂上，
    // 否则子代理里的 grep 参数问题照样能打死整个进程（实测京都就是这么挂的）。
    middleware: [toolGuard]
  }));

  const agent = createDeepAgent({
    model: createModel(opts.config),
    tools: allTools,
    systemPrompt: MAIN_SYSTEM_PROMPT,
    subagents,
    skills: ["/skills/"],
    memory: ["/AGENTS.md"],
    backend,
    middleware,
    interruptOn: {
      finalize_itinerary: {
        allowedDecisions: ["approve", "reject"],
        description: "行程定稿需要人工确认：放行后才会写入定稿产物"
      }
    },
    checkpointer: opts.checkpointer,
    store: opts.store,
    name: "trip-pilot"
  });

  return { agent, backend, tools: allTools };
}

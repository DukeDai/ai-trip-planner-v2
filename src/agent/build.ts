import { ChatAnthropic } from "@langchain/anthropic";
import { ChatOpenAI } from "@langchain/openai";
import { createDeepAgent, FilesystemBackend } from "deepagents";
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
import { GATED_TOOLS } from "./tool-catalog.ts";

export const SUBAGENT_NAMES = SUBAGENTS.map((s) => s.name);

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
  options: { model?: string; thinking?: "enabled" | "disabled" } = {}
): BaseChatModel {
  const { provider, baseURL, apiKey } = config.llm;
  const model = options.model ?? config.llm.model;
  const thinking = options.thinking ?? config.llm.thinking;
  if (provider === "openai") {
    return new ChatOpenAI({
      model,
      apiKey,
      temperature: 0,
      maxTokens: 8192,
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
  // virtualMode=true：把工具里的 "/xxx" 当作行程目录内的虚拟路径，
  // 拒绝 .. / ~ 穿越，并保证解析结果仍在 rootDir 内（默认 virtualMode=false 会直接放行整机绝对路径）。
  const backend = new FilesystemBackend({ rootDir: opts.workspace.dir, virtualMode: true });

  // 子代理与审查器都用独立模型实例 + 关闭思考，压掉延迟与 token
  const workerModel = createModel(opts.config, {
    model: opts.config.llm.subagentModel,
    thinking: "disabled"
  });
  const reviewerModel = createModel(opts.config, {
    model: opts.config.llm.subagentModel,
    thinking: "disabled"
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
    skills: ["/skills/"]
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

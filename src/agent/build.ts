import { ChatAnthropic } from "@langchain/anthropic";
import { ChatOpenAI } from "@langchain/openai";
import { createDeepAgent, FilesystemBackend } from "deepagents";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BaseCheckpointSaver, BaseStore } from "@langchain/langgraph";
import type { AppConfig } from "../config.ts";
import type { TripMeta } from "../core/types.ts";
import type { TripWorkspace } from "../core/trips.ts";
import type { TravelData } from "../data/providers.ts";
import type { TripRepository } from "../core/persist.ts";
import { MAIN_SYSTEM_PROMPT, SUBAGENTS } from "./prompts.ts";
import { createTools } from "./tools.ts";

export const SUBAGENT_NAMES = SUBAGENTS.map((s) => s.name);

const SUBAGENT_TOOLS: Record<string, string[]> = {
  transport: ["geocode", "search_places", "get_route", "get_weather"],
  stay: ["geocode", "search_places", "get_route"],
  sights: ["geocode", "search_places", "get_weather"],
  food: ["search_places", "geocode"]
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
}

export function buildTripAgent(opts: BuildAgentOptions) {
  // virtualMode=true：把工具里的 "/xxx" 当作行程目录内的虚拟路径，
  // 拒绝 .. / ~ 穿越，并保证解析结果仍在 rootDir 内（默认 virtualMode=false 会直接放行整机绝对路径）。
  const backend = new FilesystemBackend({ rootDir: opts.workspace.dir, virtualMode: true });
  const tools = createTools({
    data: opts.data,
    workspace: opts.workspace,
    repo: opts.repo ?? null,
    tripId: opts.trip.id,
    onApproved: opts.onApproved
  });

  // 子代理只做资料收集：用独立模型实例 + 关闭思考，压掉延迟与 token
  const subagentModel = createModel(opts.config, {
    model: opts.config.llm.subagentModel,
    thinking: "disabled"
  });

  const subagents = SUBAGENTS.map((spec) => ({
    name: spec.name,
    description: spec.description,
    systemPrompt: spec.systemPrompt,
    tools: tools.filter((t) => (SUBAGENT_TOOLS[spec.name] ?? []).includes(t.name)),
    model: subagentModel,
    skills: ["/skills/"]
  }));

  const agent = createDeepAgent({
    model: createModel(opts.config),
    tools,
    systemPrompt: MAIN_SYSTEM_PROMPT,
    subagents,
    skills: ["/skills/"],
    memory: ["/AGENTS.md"],
    backend,
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

  return { agent, backend, tools };
}

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type LlmProvider = "anthropic" | "openai";

export interface LlmConfig {
  provider: LlmProvider;
  model: string;
  baseURL: string;
  apiKey: string;
  keySource: "env" | "mcode-auth" | "none";
  /** 是否开启模型的思考模式。关闭可显著降低延迟与 token 消耗 */
  thinking: "enabled" | "disabled";
  /** 子代理专用模型（留空则与主模型相同） */
  subagentModel?: string;
}

export interface PgConfig {
  /** 连接串；为空则整体退化为纯内存模式 */
  url: string;
  /** 独立 schema 名，不与业务库既有表混在一起 */
  schema: string;
}

export interface AppConfig {
  port: number;
  host: string;
  dataDir: string;
  tripsDir: string;
  cacheDir: string;
  skillsDir: string;
  llm: LlmConfig;
  pg: PgConfig;
  amapKey?: string;
  webSearchKey?: string;
}

const DEFAULT_ANTHROPIC_BASE = "https://agent.minimax.cn/mavis/api/v1/llm/v1";
const DEFAULT_OPENAI_BASE = "https://api.openai.com/v1";

/**
 * 开发便利：不设 TRIP_LLM_API_KEY 时，从本机 MCode 登录态读取一个未过期的 access token。
 * 绝不打印 token 内容。
 */
export function readLocalRuntimeToken(): { token: string; expiresAt: number } | null {
  const candidates = [
    path.join(os.homedir(), ".minimax", "auth", "prod", "cn", "mcode-public", "auth.json"),
    path.join(os.homedir(), ".minimax", "auth", "prod", "us", "mcode-public", "auth.json"),
  ];
  for (const file of candidates) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8")) as {
        records?: Record<string, { accessToken?: string; expiresAtMs?: number }>;
      };
      for (const rec of Object.values(raw.records ?? {})) {
        if (!rec?.accessToken) continue;
        const expiresAt = typeof rec.expiresAtMs === "number" ? rec.expiresAtMs : Number.MAX_SAFE_INTEGER;
        if (expiresAt < Date.now() + 60_000) continue;
        return { token: rec.accessToken, expiresAt };
      }
    } catch {
      // 忽略：文件不存在或格式变化
    }
  }
  return null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const provider: LlmProvider = env.TRIP_LLM_PROVIDER === "openai" ? "openai" : "anthropic";
  const model =
    env.TRIP_LLM_MODEL ?? (provider === "anthropic" ? "MiniMax-M3" : "gpt-4.1-mini");
  const baseURL =
    env.TRIP_LLM_BASE_URL ?? (provider === "anthropic" ? DEFAULT_ANTHROPIC_BASE : DEFAULT_OPENAI_BASE);

  let apiKey = env.TRIP_LLM_API_KEY ?? "";
  let keySource: LlmConfig["keySource"] = "env";
  if (!apiKey) {
    const local = readLocalRuntimeToken();
    if (local) {
      apiKey = local.token;
      keySource = "mcode-auth";
    } else {
      keySource = "none";
    }
  }

  const dataDir = path.resolve(env.TRIP_DATA_DIR ?? "./data");
  // TRIP_PG_URL 为空 => 纯内存模式（无 PG 也能跑）；否则用 PG 存 checkpoint/产物/取数快照
  const pgUrl = env.TRIP_PG_URL?.trim() || "";
  const pg: PgConfig = {
    url: pgUrl,
    schema: env.TRIP_PG_SCHEMA?.trim() || "trip_pilot"
  };
  return {
    port: Number(env.TRIP_PORT ?? 8787),
    host: env.TRIP_HOST ?? "127.0.0.1",
    dataDir,
    tripsDir: path.join(dataDir, "trips"),
    cacheDir: path.join(dataDir, "cache"),
    skillsDir: path.resolve(env.TRIP_SKILLS_DIR ?? "./src/agent/skills"),
    llm: {
      provider,
      model,
      baseURL,
      apiKey,
      keySource,
      thinking: env.TRIP_LLM_THINKING === "enabled" ? "enabled" : "disabled",
      subagentModel: env.TRIP_LLM_SUBAGENT_MODEL?.trim() || undefined
    },
    pg,
    amapKey: env.AMAP_KEY?.trim() || undefined,
    webSearchKey: env.TRIP_WEB_SEARCH_KEY?.trim() || undefined,
  };
}

export class ConfigError extends Error {}

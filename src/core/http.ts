import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface FetchJsonOptions {
  timeoutMs?: number;
  retries?: number;
  cacheTtlSec?: number;
  headers?: Record<string, string>;
  method?: "GET" | "POST";
  body?: unknown;
  /** 缓存目录；不提供则不缓存 */
  cacheDir?: string;
}

export interface FetchJsonResult<T> {
  ok: boolean;
  status: number;
  data?: T;
  error?: string;
  fromCache?: boolean;
}

const DEFAULT_UA = "TripPilot/0.1 (+https://localhost)";

/** 按 host 的最小请求间隔（毫秒）。Photon/Nominatim/Overpass 都有每秒 1 次的限流，
 *  子代理并发检索时容易被 429 或直接断连 —— 这里用串行闸门把它们排好队。 */
const HOST_RATE_LIMITS: Record<string, number> = {
  "photon.komoot.io": 1200,
  "nominatim.openstreetmap.org": 1100,
  "overpass-api.de": 1200,
  "restapi.amap.com": 350,
  "api.open-meteo.com": 200,
  "geocoding-api.open-meteo.com": 200,
  "router.project-osrm.org": 350,
  "restcountries.com": 350,
  "wttr.in": 1200
};

function cacheKey(url: string, method: string, body?: unknown): string {
  const h = crypto.createHash("sha256");
  h.update(method + "|" + url + "|" + (body === undefined ? "" : JSON.stringify(body)));
  return h.digest("hex");
}

function readCache<T>(dir: string, key: string, ttlSec: number): T | null {
  if (!dir) return null;
  const file = path.join(dir, key + ".json");
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { at: number; payload: T };
    if (Date.now() - raw.at > ttlSec * 1000) return null;
    return raw.payload;
  } catch {
    return null;
  }
}

function writeCache(dir: string, key: string, payload: unknown): void {
  if (!dir) return;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, key + ".json"),
      JSON.stringify({ at: Date.now(), payload }),
      "utf8"
    );
  } catch {
    // 缓存失败不影响主流程
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class HttpClient {
  readonly cacheDir: string | undefined;
  private readonly hostGate = new Map<string, { nextAt: number }>();
  /** 熔断器：某 host 连续失败 2 次后跳过 60 秒，避免子代理在死源上空等 */
  private readonly breaker = new Map<string, { failures: number; openUntil: number }>();

  constructor(options: { cacheDir?: string } = {}) {
    this.cacheDir = options.cacheDir;
  }

  private breakerCheck(url: string): { blocked: boolean; reason?: string } {
    let host: string;
    try {
      host = new URL(url).host;
    } catch {
      return { blocked: false };
    }
    const state = this.breaker.get(host);
    if (state && state.openUntil > Date.now()) {
      return { blocked: true, reason: host + " 连续失败已熔断（" + Math.ceil((state.openUntil - Date.now()) / 1000) + "s 内跳过）" };
    }
    return { blocked: false };
  }

  private breakerReport(url: string, ok: boolean): void {
    let host: string;
    try {
      host = new URL(url).host;
    } catch {
      return;
    }
    const state = this.breaker.get(host) ?? { failures: 0, openUntil: 0 };
    if (ok) {
      state.failures = 0;
      state.openUntil = 0;
    } else {
      state.failures += 1;
      if (state.failures >= 2) state.openUntil = Date.now() + 60_000;
    }
    this.breaker.set(host, state);
  }

  /** 同一 host 的请求排队，避免触发对端限流 */
  private async waitForHost(url: string): Promise<void> {
    let host: string;
    try {
      host = new URL(url).host;
    } catch {
      return;
    }
    const interval = HOST_RATE_LIMITS[host];
    if (!interval) return;
    const state = this.hostGate.get(host) ?? { nextAt: 0 };
    const now = Date.now();
    const wait = Math.max(0, state.nextAt - now);
    state.nextAt = now + wait + interval;
    this.hostGate.set(host, state);
    if (wait > 0) await sleep(wait);
  }

  async json<T>(url: string, options: FetchJsonOptions = {}): Promise<FetchJsonResult<T>> {
    const method = options.method ?? "GET";
    const timeoutMs = options.timeoutMs ?? 12_000;
    const retries = options.retries ?? 2;
    const ttl = options.cacheTtlSec ?? 6 * 3600;
    const key = cacheKey(url, method, options.body);

    if (method === "GET" && this.cacheDir) {
      const cached = readCache<T>(this.cacheDir, key, ttl);
      if (cached !== null && cached !== undefined) {
        return { ok: true, status: 200, data: cached, fromCache: true };
      }
    }

    const gate = this.breakerCheck(url);
    if (gate.blocked) {
      return { ok: false, status: 0, error: gate.reason };
    }

    let lastError = "";
    let lastStatus = 0;
    let succeeded = false;
    for (let attempt = 0; attempt <= retries; attempt++) {
      await this.waitForHost(url);
      try {
        const res = await fetch(url, {
          method,
          headers: {
            "User-Agent": DEFAULT_UA,
            Accept: "application/json",
            ...(options.headers ?? {}),
          },
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
          signal: AbortSignal.timeout(timeoutMs),
        });
        lastStatus = res.status;
        const text = await res.text();
        if (!res.ok) {
          lastError = `HTTP ${res.status}: ${text.slice(0, 180)}`;
          // 429 与 5xx 视为可重试；其余 4xx 直接失败
          if (res.status < 500 && res.status !== 429) {
            return { ok: false, status: res.status, error: lastError };
          }
        } else {
          let data: T;
          try {
            data = JSON.parse(text) as T;
          } catch {
            return { ok: false, status: res.status, error: "响应不是合法 JSON：" + text.slice(0, 120) };
          }
          if (method === "GET" && this.cacheDir) writeCache(this.cacheDir, key, data);
          succeeded = true;
          this.breakerReport(url, true);
          return { ok: true, status: res.status, data };
        }
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
      if (attempt < retries) await sleep(500 * Math.pow(2, attempt) + Math.floor(Math.random() * 250));
    }
    this.breakerReport(url, succeeded);
    return { ok: false, status: lastStatus, error: lastError || "请求失败" };
  }

  async text(url: string, options: FetchJsonOptions = {}): Promise<FetchJsonResult<string>> {
    const res = await this.json<unknown>(url, options);
    if (!res.ok || res.data === undefined) {
      return { ok: false, status: res.status, error: res.error };
    }
    return { ok: true, status: res.status, data: typeof res.data === "string" ? res.data : JSON.stringify(res.data) };
  }
}

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { InMemoryStore, MemorySaver } from "@langchain/langgraph";
import { loadConfig } from "../config.ts";
import { HttpClient } from "../core/http.ts";
import { TripStore, buildProfileMarkdown } from "../core/trips.ts";
import { TravelData } from "../data/providers.ts";
import { streamTurn, resumeTurn, type InterruptInfo, type RunContext } from "../agent/runner.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "../..");
const webDir = path.join(projectRoot, "web");
const skillsSourceDir = path.join(projectRoot, "src", "agent", "skills");

const config = loadConfig();
fs.mkdirSync(config.tripsDir, { recursive: true });
fs.mkdirSync(config.cacheDir, { recursive: true });

const trips = new TripStore(config.tripsDir);
const httpClient = new HttpClient({ cacheDir: config.cacheDir });
const data = new TravelData(httpClient, { amapKey: config.amapKey });
const checkpointer = new MemorySaver();
const store = new InMemoryStore();
const interrupts = new Map<string, InterruptInfo>();

const runContext: RunContext = { config, trips, data, checkpointer, store };

/** 把技能目录复制进行程工作区（skills 通过后端相对路径加载） */
function seedWorkspace(tripId: string): void {
  const target = path.join(trips.dir(tripId), "skills");
  try {
    fs.cpSync(skillsSourceDir, target, { recursive: true });
  } catch (err) {
    console.error("[TripPilot] 复制技能目录失败:", err);
  }
}

function json(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".woff2": "font/woff2"
};

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): boolean {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const target = path.resolve(webDir, rel);
  if (target !== webDir && !target.startsWith(webDir + path.sep)) return false;
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return false;
  const ext = path.extname(target);
  const download = req.url?.includes("download=1");
  res.writeHead(200, {
    "Content-Type": MIME[ext] ?? "application/octet-stream",
    "Cache-Control": "no-cache"
  });
  if (download) {
    res.setHeader("Content-Disposition", 'attachment; filename="' + path.basename(target) + '"');
  }
  fs.createReadStream(target).pipe(res);
  return true;
}

function sseHeaders(res: http.ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
}

function writeSse(res: http.ServerResponse, payload: unknown): void {
  res.write("data: " + JSON.stringify(payload) + "\n\n");
}

let healthCache: { at: number; payload: unknown } | null = null;

async function healthPayload(): Promise<unknown> {
  if (healthCache && Date.now() - healthCache.at < 60_000) return healthCache.payload;
  const probes: { name: string; url: string }[] = [
    { name: "open-meteo", url: "https://api.open-meteo.com/v1/forecast?latitude=39.9&longitude=116.4&daily=weather_code" },
    { name: "photon", url: "https://photon.komoot.io/api/?q=test&limit=1" },
    { name: "osrm", url: "https://router.project-osrm.org/route/v1/driving/116.4,39.9;116.5,40.0?overview=false" },
    { name: "restcountries", url: "https://restcountries.com/v3.1/alpha/cn?fields=name" }
  ];
  const dataSources = await Promise.all(
    probes.map(async (p) => {
      const t0 = Date.now();
      try {
        const res = await fetch(p.url, { signal: AbortSignal.timeout(6000) });
        return { name: p.name, status: res.ok ? "up" : "degraded", ms: Date.now() - t0, note: res.ok ? undefined : "HTTP " + res.status };
      } catch (err) {
        return { name: p.name, status: "down", ms: Date.now() - t0, note: err instanceof Error ? err.message : String(err) };
      }
    })
  );
  const payload = {
    ok: true,
    llm: {
      provider: config.llm.provider,
      model: config.llm.model,
      baseURL: config.llm.baseURL,
      keySource: config.llm.keySource
    },
    dataSources: [
      ...dataSources,
      { name: "amap", status: config.amapKey ? "up" : "off", note: config.amapKey ? "已配置 Key" : "未配置 AMAP_KEY（可选）：POI 走 Wikidata/OSM/种子库" },
      { name: "offline-seed", status: "up", note: "内置离线种子库始终可用" }
    ]
  };
  healthCache = { at: Date.now(), payload };
  return payload;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const pathname = url.pathname;

  try {
    if (pathname === "/api/health" && req.method === "GET") {
      json(res, 200, await healthPayload());
      return;
    }

    if (pathname === "/api/trips" && req.method === "POST") {
      const body = await readJsonBody(req);
      const destination = String(body.destination ?? "").trim();
      const startDate = String(body.startDate ?? "").trim();
      const endDate = String(body.endDate ?? "").trim();
      if (!destination || !startDate || !endDate) {
        json(res, 400, { error: { code: "BAD_REQUEST", message: "缺少目的地或起止日期" } });
        return;
      }
      const trip = trips.create({
        title: body.title ? String(body.title) : undefined,
        destination,
        startDate,
        endDate,
        travelers: Number(body.travelers ?? 2),
        budgetTotal: Number(body.budgetTotal ?? 0),
        currency: body.currency ? String(body.currency) : "CNY",
        preferences: Array.isArray(body.preferences) ? body.preferences.map(String) : []
      });
      trips.writeProfile(trip.id, buildProfileMarkdown(trip));
      seedWorkspace(trip.id);
      json(res, 201, { trip });
      return;
    }

    if (pathname === "/api/trips" && req.method === "GET") {
      json(res, 200, { trips: trips.list() });
      return;
    }

    const tripMatch = pathname.match(/^\/api\/trips\/([^/]+)$/);
    if (tripMatch && req.method === "GET") {
      const trip = trips.get(tripMatch[1]);
      if (!trip) {
        json(res, 404, { error: { code: "NOT_FOUND", message: "行程不存在" } });
        return;
      }
      json(res, 200, { trip, plan: trips.readPlan(trip.id), files: trips.listArtifacts(trip.id) });
      return;
    }

    const fileMatch = pathname.match(/^\/api\/trips\/([^/]+)\/files\/(.+)$/);
    if (fileMatch && req.method === "GET") {
      const tripId = fileMatch[1];
      const name = decodeURIComponent(fileMatch[2]);
      const content = trips.readArtifact(tripId, name);
      if (content === null) {
        json(res, 404, { error: { code: "NOT_FOUND", message: "文件不存在" } });
        return;
      }
      const ext = path.extname(name);
      const mime = ext === ".json" ? "application/json; charset=utf-8" : ext === ".csv" ? "text/csv; charset=utf-8" : "text/markdown; charset=utf-8";
      res.writeHead(200, { "Content-Type": mime, "Cache-Control": "no-cache" });
      res.end(content);
      return;
    }

    const chatMatch = pathname.match(/^\/api\/trips\/([^/]+)\/chat$/);
    if (chatMatch && req.method === "POST") {
      const trip = trips.get(chatMatch[1]);
      if (!trip) {
        json(res, 404, { error: { code: "NOT_FOUND", message: "行程不存在" } });
        return;
      }
      const body = await readJsonBody(req);
      const message = String(body.message ?? "").trim();
      if (!message) {
        json(res, 400, { error: { code: "BAD_REQUEST", message: "消息不能为空" } });
        return;
      }
      sseHeaders(res);
      const keepAlive = setInterval(() => res.write(": ping\n\n"), 15_000);
      try {
        for await (const event of streamTurn(runContext, trip, message)) {
          if (event.type === "interrupt") {
            const info = event as unknown as {
              interruptId: string;
              toolCallId?: string;
              toolArgs?: Record<string, unknown>;
            };
            interrupts.set(trip.id, {
              interruptId: String(info.interruptId),
              toolCallId: String(info.toolCallId ?? info.interruptId),
              toolName: "finalize_itinerary",
              args: info.toolArgs ?? {}
            });
          }
          writeSse(res, event);
        }
      } catch (err) {
        writeSse(res, { type: "error", code: "AGENT_ERROR", message: err instanceof Error ? err.message : String(err) });
        writeSse(res, { type: "done", plan: trips.readPlan(trip.id) });
      } finally {
        clearInterval(keepAlive);
        res.end();
      }
      return;
    }

    const approveMatch = pathname.match(/^\/api\/trips\/([^/]+)\/approve$/);
    if (approveMatch && req.method === "POST") {
      const trip = trips.get(approveMatch[1]);
      if (!trip) {
        json(res, 404, { error: { code: "NOT_FOUND", message: "行程不存在" } });
        return;
      }
      const body = await readJsonBody(req);
      const approved = body.approved === true;
      const reason = body.reason ? String(body.reason) : undefined;
      const info = interrupts.get(trip.id);
      if (!info) {
        json(res, 409, { error: { code: "NO_PENDING_INTERRUPT", message: "当前没有待确认的动作" } });
        return;
      }
      sseHeaders(res);
      const keepAlive = setInterval(() => res.write(": ping\n\n"), 15_000);
      try {
        for await (const event of resumeTurn(runContext, trip, info, approved, reason)) {
          if (event.type === "interrupt") {
            const next = event as unknown as {
              interruptId: string;
              toolCallId?: string;
              toolArgs?: Record<string, unknown>;
            };
            interrupts.set(trip.id, {
              interruptId: String(next.interruptId),
              toolCallId: String(next.toolCallId ?? next.interruptId),
              toolName: "finalize_itinerary",
              args: next.toolArgs ?? {}
            });
          } else if (event.type === "done") {
            interrupts.delete(trip.id);
          }
          writeSse(res, event);
        }
      } catch (err) {
        writeSse(res, { type: "error", code: "AGENT_ERROR", message: err instanceof Error ? err.message : String(err) });
        writeSse(res, { type: "done", plan: trips.readPlan(trip.id) });
      } finally {
        clearInterval(keepAlive);
        res.end();
      }
      return;
    }

    if (req.method === "GET" && serveStatic(req, res, pathname)) return;

    json(res, 404, { error: { code: "NOT_FOUND", message: "没有这个接口：" + pathname } });
  } catch (err) {
    console.error("[TripPilot] 请求处理失败:", err);
    json(res, 500, { error: { code: "INTERNAL", message: err instanceof Error ? err.message : String(err) } });
  }
});

server.listen(config.port, config.host, () => {
  console.log("[TripPilot] http://" + config.host + ":" + config.port);
  console.log("[TripPilot] 模型:", config.llm.provider + ":" + config.llm.model, "凭证来源:", config.llm.keySource);
  console.log("[TripPilot] 数据目录:", config.dataDir);
  if (!config.llm.apiKey) {
    console.warn("[TripPilot] 警告：未找到模型凭证，请设置 TRIP_LLM_API_KEY");
  }
});

process.on("SIGINT", () => {
  server.close(() => process.exit(0));
});

/**
 * 第二轮 E2E：真实 API + 真实模型，跑三个目的地。
 *   node scripts/e2e-round2.ts shanghai   上海本地 1 晚
 *   node scripts/e2e-round2.ts kyoto      上海 → 京都 3 天（高成本反例）
 *   node scripts/e2e-round2.ts suzhou     上海 → 苏州（中距离）
 */
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../src/config.ts";
import { connectDb } from "../src/core/db.ts";
import { TripRepository } from "../src/core/persist.ts";
import { HttpClient } from "../src/core/http.ts";
import { TripStore, buildProfileMarkdown } from "../src/core/trips.ts";
import { TravelData } from "../src/data/providers.ts";
import { MemorySaver, InMemoryStore } from "@langchain/langgraph";
import { streamTurn } from "../src/agent/runner.ts";
import { validatePlan } from "../src/core/schema.ts";
import { installProcessGuard } from "../src/core/process-guard.ts";

const SCENARIOS: Record<
  string,
  {
    origin: string;
    destination: string;
    startDate: string;
    endDate: string;
    travelers: number;
    budgetTotal: number;
    preferences: string[];
    brief: string;
  }
> = {
  shanghai: {
    origin: "上海",
    destination: "上海",
    startDate: "2026-11-20",
    endDate: "2026-11-21",
    travelers: 2,
    budgetTotal: 3000,
    preferences: ["历史", "美食"],
    brief:
      "从上海出发，目的地就是上海，2026-11-20 到 2026-11-21 共 1 晚 2 天，2 人，总预算 3000 元。" +
      "偏好历史建筑与本地美食，节奏轻松，不要赶，无忌口。信息已经给全，别再追问，" +
      "直接开始调研并给出完整行程单（含 itinerary.json / itinerary.md / budget.csv / packing.md / bookings.md）。"
  },
  kyoto: {
    origin: "上海",
    destination: "京都",
    startDate: "2026-11-20",
    endDate: "2026-11-22",
    travelers: 2,
    budgetTotal: 20000,
    preferences: ["历史", "自然"],
    brief:
      "从上海出发，目的地是京都，2026-11-20 到 2026-11-22 共 3 天 2 晚，2 人，总预算 20000 元。" +
      "想看京都的古寺和红叶，节奏中等，无忌口。信息已经给全，别再追问，" +
      "直接开始调研并给出完整行程单（含 itinerary.json / itinerary.md / budget.csv / packing.md / bookings.md）。"
  },
  suzhou: {
    origin: "上海",
    destination: "苏州",
    startDate: "2026-11-20",
    endDate: "2026-11-22",
    travelers: 2,
    budgetTotal: 6000,
    preferences: ["历史", "美食"],
    brief:
      "从上海出发，目的地是苏州，2026-11-20 到 2026-11-22 共 3 天 2 晚，2 人，总预算 6000 元。" +
      "偏好古典园林与本地美食，节奏轻松，无忌口。信息已经给全，别再追问，" +
      "直接开始调研并给出完整行程单（含 itinerary.json / itinerary.md / budget.csv / packing.md / bookings.md）。"
  }
};

const which = process.argv[2] ?? "shanghai";
const sc = SCENARIOS[which];
if (!sc) {
  console.error("未知场景：" + which + "，可选：" + Object.keys(SCENARIOS).join(" / "));
  process.exit(2);
}

installProcessGuard();

const config = loadConfig();
fs.mkdirSync(config.tripsDir, { recursive: true });
fs.mkdirSync(config.cacheDir, { recursive: true });

let db: Awaited<ReturnType<typeof connectDb>> | null = null;
if (config.pg.url) {
  db = await connectDb({ url: config.pg.url, schema: config.pg.schema });
  console.log("[e2e2] PG 已连接:", db.schema);
}
const repo = new TripRepository(db);
const trips = new TripStore(config.tripsDir, repo);
const data = new TravelData(new HttpClient({ cacheDir: config.cacheDir }), { amapKey: config.amapKey });

const trip = trips.create({
  origin: sc.origin,
  destination: sc.destination,
  startDate: sc.startDate,
  endDate: sc.endDate,
  travelers: sc.travelers,
  budgetTotal: sc.budgetTotal,
  currency: "CNY",
  preferences: sc.preferences
});
trips.writeProfile(trip.id, buildProfileMarkdown(trip));
await trips.persistTrip(trip);
fs.cpSync(path.join(process.cwd(), "src/agent/skills"), path.join(trips.dir(trip.id), "skills"), { recursive: true });

const ctx = {
  config,
  trips,
  data,
  checkpointer: db ? db.saver : new MemorySaver(),
  store: db ? db.store : new InMemoryStore(),
  repo
};

console.log("[e2e2] 场景:", which, "| tripId:", trip.id, "| toolSearch:", config.llm.toolSearch);

const t0 = Date.now();
let tokens = 0;
let toolCount = 0;
const toolNames = new Map<string, number>();
let subCount = 0;
for await (const ev of streamTurn(ctx, trip, sc.brief)) {
  if (ev.type === "token") {
    tokens++;
    continue;
  }
  if (ev.type === "tool") {
    toolCount++;
    const n = String(ev.name);
    toolNames.set(n, (toolNames.get(n) ?? 0) + 1);
    console.log("[tool]", n, ev.status, ev.ms ? ev.ms + "ms" : "");
    continue;
  }
  if (ev.type === "subagent") {
    subCount++;
    console.log("[subagent]", ev.name, ev.status, ev.summary ? String(ev.summary).slice(0, 100) : "");
    continue;
  }
  if (ev.type === "todo") {
    const todos = (ev.todos ?? []) as { content: string; status: string }[];
    console.log("[todo]", todos.filter((t) => t.status === "completed").length + "/" + todos.length);
    continue;
  }
  if (ev.type === "token") continue;
  console.log("[" + ev.type + "]", JSON.stringify(ev).slice(0, 300));
}
console.log("\n[e2e2] 用时", ((Date.now() - t0) / 1000).toFixed(1), "s | token", tokens, "| tool", toolCount, "| subagent", subCount);
console.log("[e2e2] 工具分布:", [...toolNames.entries()].map(([k, v]) => k + "×" + v).join(", "));

// ---------- 审计 ----------
const plan = trips.readPlan(trip.id);
console.log("\n=== 产物审计 ===");
const issues = plan ? validatePlan(plan) : [{ path: "(root)", message: "没有 itinerary.json" }];
console.log("机器校验:", issues.length === 0 ? "通过" : issues.map((i) => i.path + " → " + i.message).join(" | "));

if (plan) {
  console.log("天数:", plan.days.length, "| 总额:", plan.budget.total, "| 上限:", plan.budget.planned, "| 差额:", plan.budget.delta);
  console.log("风险:", plan.risks.length, "| 未确认:", plan.unconfirmed.length, "| 本地替代:", (plan.alternatives ?? []).length);
  for (const alt of plan.alternatives ?? []) {
    console.log(
      "  · " + alt.decision + " | 采用 " + alt.chosenCost + " vs 本地 " + alt.localCost +
      "（差 " + alt.costDelta + "） | 建议 " + alt.recommendation + " | " + alt.rationale.slice(0, 120)
    );
  }
  let noSource = 0;
  let noCity = 0;
  let unverifiedMissing = 0;
  for (const d of plan.days) {
    for (const a of d.activities) {
      if (!a.source) noSource++;
      if (!a.city) noCity++;
      if (a.verified === false && !plan.unconfirmed.some((u) => u.item.includes(a.title) || a.title.includes(u.item))) {
        unverifiedMissing++;
      }
    }
  }
  console.log("条目缺 source:", noSource, "| 缺 city:", noCity, "| verified=false 未进 unconfirmed:", unverifiedMissing);
}

// 假数据扫描：
//  - itinerary.json 里任何条目的 source 提到「种子库」= 硬失败（行程单引用了不存在的源）
//  - 其它产物里出现旧标签「内置离线种子库（需复核）」= 硬失败
//  - 其它产物里只是提到「种子库」（比如声明「未使用任何离线种子库」）= 只记信息，不算失败
const artifacts = trips.listArtifacts(trip.id).filter((a) => !a.name.includes("skills/"));
let seedHits = 0;
let seedMentions = 0;
for (const art of artifacts) {
  const content = trips.readArtifact(trip.id, art.name) ?? "";
  const hardBad = art.name === "itinerary.json"
    ? /"source"\s*:\s*"[^"]*种子库/.test(content)
    : content.includes("内置离线种子库（需复核）");
  if (hardBad) {
    seedHits++;
    console.log("!! 硬失败：产物引用了内置假数据:", art.name);
  } else if (content.includes("种子库")) {
    seedMentions++;
    console.log("   （仅提及，未引用）", art.name);
  }
}
console.log("产物数:", artifacts.length, "| 引用假数据的产物:", seedHits, "| 仅提及的产物:", seedMentions);
console.log("产物清单:", artifacts.map((a) => a.name + "(" + a.bytes + "B)").join(", "));

// 交付物完整性（SPEC §10 五个文件）
const required = ["itinerary.json", "itinerary.md", "budget.csv", "packing.md", "bookings.md"];
const names = new Set(artifacts.map((a) => a.name));
const missing = required.filter((f) => !names.has(f));
console.log("交付物完整性:", missing.length === 0 ? "齐备" : "缺 " + missing.join(", "));

// 审查报告
const reportRaw = trips.readArtifact(trip.id, "review/report.json");
if (reportRaw) {
  const rep = JSON.parse(reportRaw) as {
    approved: boolean;
    round: number;
    summary: string;
    scores: Record<string, number>;
    blocking: { title: string }[];
    warnings: { title: string }[];
    localAlternatives: { decision: string; suggestion: string; costDelta?: number }[];
  };
  console.log("\n=== 审查报告 ===");
  console.log("approved:", rep.approved, "| round:", rep.round, "| scores:", JSON.stringify(rep.scores));
  console.log("summary:", rep.summary);
  console.log("blocking:", rep.blocking.map((b) => b.title).join(" | ") || "（无）");
  console.log("warnings:", rep.warnings.map((b) => b.title).join(" | ") || "（无）");
  for (const la of rep.localAlternatives) {
    console.log("  · 建议:", la.decision, "→", la.suggestion.slice(0, 160), "| 成本差", la.costDelta ?? "未量化");
  }
} else {
  console.log("\n=== 审查报告 === 缺失（未调用 review_itinerary）");
}
console.log("\n[tripId]", trip.id);

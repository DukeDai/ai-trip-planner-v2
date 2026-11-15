import { loadConfig } from "../src/config.ts";
import { HttpClient } from "../src/core/http.ts";
import { TripStore, buildProfileMarkdown } from "../src/core/trips.ts";
import { TravelData } from "../src/data/providers.ts";
import { MemorySaver, InMemoryStore } from "@langchain/langgraph";
import { streamTurn } from "../src/agent/runner.ts";
import fs from "node:fs";
import path from "node:path";

const config = loadConfig();
fs.mkdirSync(config.tripsDir, { recursive: true });
fs.mkdirSync(config.cacheDir, { recursive: true });
const trips = new TripStore(config.tripsDir);
const data = new TravelData(new HttpClient({ cacheDir: config.cacheDir }), { amapKey: config.amapKey });

const trip = trips.create({
  destination: "北京",
  startDate: "2026-11-20",
  endDate: "2026-11-22",
  travelers: 2,
  budgetTotal: 8000,
  currency: "CNY",
  preferences: ["历史", "美食"]
});
trips.writeProfile(trip.id, buildProfileMarkdown(trip));
fs.cpSync(path.join(process.cwd(), "src/agent/skills"), path.join(trips.dir(trip.id), "skills"), { recursive: true });

const ctx = { config, trips, data, checkpointer: new MemorySaver(), store: new InMemoryStore() };
const brief =
  "帮我规划这趟北京行程。信息已经给全，别再追问：2026-11-20 到 2026-11-22 共 3 天，2 人，" +
  "总预算 8000 元（已含住宿，不含大交通），从北京出发（住市区，不含机票），" +
  "偏好历史建筑与本地美食，节奏中等，每天不要超过 3 个点位。直接开始调研并给出完整行程单。";

const t0 = Date.now();
let tokens = 0;
let toolCount = 0;
let subCount = 0;
for await (const ev of streamTurn(ctx, trip, brief)) {
  if (ev.type === "token") {
    tokens++;
    continue;
  }
  if (ev.type === "tool") {
    toolCount++;
    console.log("[tool]", ev.name, ev.status, ev.ms ? ev.ms + "ms" : "");
    continue;
  }
  if (ev.type === "subagent") {
    subCount++;
    console.log("[subagent]", ev.name, ev.status, ev.summary ? String(ev.summary).slice(0, 120) : "");
    continue;
  }
  if (ev.type === "todo") {
    const todos = (ev.todos ?? []) as { content: string; status: string }[];
    console.log("[todo]", todos.filter((t) => t.status === "completed").length + "/" + todos.length, todos.map((t) => t.status[0]).join(""));
    continue;
  }
  console.log("[" + ev.type + "]", JSON.stringify(ev).slice(0, 400));
}
console.log("\n[e2e] 用时", ((Date.now() - t0) / 1000).toFixed(1), "s | token", tokens, "| tool", toolCount, "| subagent", subCount);
const plan = trips.readPlan(trip.id);
console.log("[e2e] itinerary.json:", plan ? "有" : "无");
if (plan) {
  console.log("[e2e] 天数:", plan.days.length, "| 总额:", plan.budget.total, "| 上限:", plan.budget.planned, "| 差额:", plan.budget.delta);
  console.log("[e2e] 未确认:", plan.unconfirmed.length, "| 风险:", plan.risks.length);
}
console.log("[e2e] 产物:", trips.listArtifacts(trip.id).filter((a) => !a.name.includes("skills/")).map((a) => a.name + "(" + a.bytes + ")").join(", "));
console.log("[e2e] tripId:", trip.id);

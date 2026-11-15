/**
 * 第二轮定向集成检查：
 *   1. tool_search 能检索目录并装载工具
 *   2. reviewer 能抓出「先在京都吃早餐、再从上海机场出发」这类矛盾
 *   3. reviewer 能给出本地替代建议 + 成本差
 *   4. submit_itinerary 的审查门禁真的拦得住
 *   5. 改稿 → 重新审查 → 通过 → 提交
 *
 * 用法：node scripts/smoke-round2.ts
 */
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../src/config.ts";
import { HttpClient } from "../src/core/http.ts";
import { TripStore, buildProfileMarkdown } from "../src/core/trips.ts";
import { TravelData } from "../src/data/providers.ts";
import { createTools } from "../src/agent/tools.ts";
import { createToolSearchTool } from "../src/agent/tool-search.ts";
import { createModel } from "../src/agent/build.ts";
import { runReview } from "../src/agent/reviewer.ts";

const config = loadConfig();
fs.mkdirSync(config.tripsDir, { recursive: true });
fs.mkdirSync(config.cacheDir, { recursive: true });
const trips = new TripStore(config.tripsDir, null);
const data = new TravelData(new HttpClient({ cacheDir: config.cacheDir }), { amapKey: config.amapKey });

const trip = trips.create({
  origin: "上海",
  destination: "京都",
  startDate: "2026-11-20",
  endDate: "2026-11-22",
  travelers: 2,
  budgetTotal: 20000,
  currency: "CNY",
  preferences: ["历史", "自然"]
});
trips.writeProfile(trip.id, buildProfileMarkdown(trip));
const workspace = trips.workspace(trip.id);

const reviewerModel = createModel(config, { model: config.llm.subagentModel, thinking: "disabled" });

const tools = createTools({
  data,
  workspace,
  repo: null,
  tripId: trip.id,
  reviewer: (input) => runReview({ model: reviewerModel, ...input }),
  requirements: {
    origin: trip.origin,
    destination: trip.destination,
    startDate: trip.startDate,
    endDate: trip.endDate,
    travelers: trip.travelers,
    budgetTotal: trip.budgetTotal,
    currency: trip.currency,
    preferences: trip.preferences,
    userRequest: "从上海出发去京都玩 3 天，2 人，预算 20000 元，想看古寺和红叶"
  }
});

const byName = (name: string) => {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error("缺少工具 " + name);
  return t as unknown as { invoke: (args: Record<string, unknown>) => Promise<unknown> };
};

// ---- 1. tool_search ----
const runtime = { loaded: new Set<string>() };
const searchTool = createToolSearchTool(runtime);
const hit = JSON.parse(
  String(await (searchTool as unknown as { invoke: (a: Record<string, unknown>) => Promise<unknown> }).invoke({ query: "找本地的替代玩法" }))
) as { matched: { tool: string }[] };
console.log("[1] tool_search 命中:", hit.matched.map((m) => m.tool).join(", "));
console.log("    已装载:", [...runtime.loaded].join(", "));

// ---- 2. 故意写一份自相矛盾的行程单（DD 说的反例） ----
const broken = {
  tripId: trip.id,
  origin: "上海",
  destination: "京都",
  startDate: "2026-11-20",
  endDate: "2026-11-22",
  travelers: { count: 2, budgetTotal: 20000, currency: "CNY" },
  days: [
    {
      day: 1,
      date: "2026-11-20",
      theme: "京都古都",
      totalCost: 12000,
      activities: [
        {
          time: "07:30",
          title: "京都早餐（先吃）",
          type: "food",
          location: "京都站",
          durationMin: 60,
          costPerPerson: 80,
          costTotal: 160,
          notes: "",
          source: "Wikidata",
          fetchedAt: "2026-11-16T00:00:00.000Z",
          confidence: "medium",
          needsBooking: false,
          verified: true,
          city: "京都",
          lat: 35.0116,
          lon: 135.7681
        },
        {
          time: "09:30",
          title: "上海浦东国际机场出发",
          type: "transport",
          location: "浦东新区",
          durationMin: 90,
          costPerPerson: 5500,
          costTotal: 11000,
          notes: "",
          source: "Wikidata",
          fetchedAt: "2026-11-16T00:00:00.000Z",
          confidence: "medium",
          needsBooking: true,
          bookingLeadDays: 30,
          verified: true,
          city: "上海",
          lat: 31.1443,
          lon: 121.8083,
          fromCity: "上海",
          toCity: "京都"
        }
      ]
    },
    {
      day: 2,
      date: "2026-11-21",
      theme: "红叶",
      totalCost: 0,
      activities: [
        {
          time: "09:00",
          title: "伏见稻荷大社",
          type: "sight",
          location: "伏见区",
          durationMin: 120,
          costPerPerson: 0,
          costTotal: 0,
          notes: "",
          source: "Wikidata",
          fetchedAt: "2026-11-16T00:00:00.000Z",
          confidence: "medium",
          needsBooking: false,
          verified: true,
          city: "京都",
          lat: 34.9671,
          lon: 135.7727
        }
      ]
    },
    {
      day: 3,
      date: "2026-11-22",
      theme: "返程",
      totalCost: 0,
      activities: [
        {
          time: "10:00",
          title: "岚山竹林",
          type: "sight",
          location: "岚山区",
          durationMin: 90,
          costPerPerson: 0,
          costTotal: 0,
          notes: "",
          source: "Wikidata",
          fetchedAt: "2026-11-16T00:00:00.000Z",
          confidence: "medium",
          needsBooking: false,
          verified: true,
          city: "京都",
          lat: 35.0094,
          lon: 135.6668
        }
      ]
    }
  ],
  budget: {
    lines: [{ category: "transport", label: "往返机票", amount: 11000, unit: "CNY", confidence: "medium" }],
    total: 11000,
    planned: 20000,
    delta: -9000
  },
  risks: [],
  unconfirmed: []
};

workspace.write("itinerary.json", JSON.stringify(broken, null, 2));

// ---- 3. reviewer 审查（应当抓出矛盾） ----
const t0 = Date.now();
const review = JSON.parse(String(await byName("review_itinerary").invoke({}))) as {
  approved: boolean;
  round: number;
  summary: string;
  scores: Record<string, number>;
  blocking: { code: string; title: string; detail: string }[];
  warnings: { title: string }[];
  localAlternatives: { decision: string; suggestion: string; costDelta?: number; reason: string }[];
};
console.log("\n[2] reviewer 耗时", ((Date.now() - t0) / 1000).toFixed(1), "s | approved =", review.approved, "| round =", review.round);
console.log("    summary:", review.summary);
console.log("    scores:", JSON.stringify(review.scores));
console.log("    blocking:");
for (const b of review.blocking) console.log("      -", b.code, b.title, "|", b.detail.slice(0, 160));
console.log("    warnings:", review.warnings.map((w) => w.title).join(" | ") || "（无）");
console.log("    localAlternatives:");
for (const la of review.localAlternatives) {
  console.log("      -", la.decision, "→", la.suggestion, "| 成本差", la.costDelta ?? "未量化", "|", la.reason.slice(0, 160));
}

// ---- 4. 提交应被拦下 ----
const submit1 = JSON.parse(String(await byName("submit_itinerary").invoke({}))) as {
  ok: boolean;
  issues?: { path: string; message: string }[];
  gate?: string[];
};
console.log("\n[3] submit（应当被拦） ok =", submit1.ok);
console.log("    issues:", (submit1.issues ?? []).map((i) => i.path).join(", ") || "（无）");
console.log("    gate:", (submit1.gate ?? []).join(" | ") || "（无）");

// ---- 5. 改稿：先跨城交通、后目的地活动，并补本地替代 ----
const fixed = JSON.parse(JSON.stringify(broken)) as typeof broken;
fixed.days[0].activities = [
  fixed.days[0].activities[1],
  {
    ...fixed.days[0].activities[0],
    time: "19:00",
    title: "京都晚餐（落地后）",
    location: "京都站周边"
  }
];
fixed.days[0].activities[0].time = "08:00";
fixed.alternatives = [
  {
    decision: "上海 → 京都 3 天",
    fromCity: "上海",
    toCity: "京都",
    chosen: "上海浦东飞关西机场 + 特急到京都",
    localAlternative: "上海本地：外滩、豫园、武康路、佘山国家森林公园",
    chosenCost: 11000,
    localCost: 1200,
    costDelta: 9800,
    chosenTime: "单程飞行约 2.5 小时 + 特急 80 分钟",
    localTime: "市内地铁合计约 90 分钟",
    experienceGain: "京都的千年古寺与红叶是上海没有的，但相似氛围在上海的古典园林也能部分获得",
    recommendation: "downgrade",
    rationale: "跨城成本是本地替代的 9 倍；若核心诉求只是红叶与古寺氛围，建议降级为上海本地方案"
  }
];
fixed.risks = [
  {
    level: "medium",
    title: "跨城性价比偏低",
    mitigation: "上海 → 京都 单程机票约 5500 元/人，是本地替代的 9 倍；预算敏感建议改为上海本地方案（成本差约 9800 元）"
  }
];
workspace.write("itinerary.json", JSON.stringify(fixed, null, 2));

const review2 = JSON.parse(String(await byName("review_itinerary").invoke({}))) as {
  approved: boolean;
  round: number;
  blocking: { title: string }[];
};
console.log("\n[4] 改稿后重新审查 approved =", review2.approved, "| round =", review2.round);
if (review2.blocking.length) for (const b of review2.blocking) console.log("      - ", b.title);

const submit2 = JSON.parse(String(await byName("submit_itinerary").invoke({}))) as {
  ok: boolean;
  issues?: { path: string; message: string }[];
  gate?: string[];
  summary?: Record<string, unknown>;
};
console.log("\n[5] submit（改稿后） ok =", submit2.ok);
if (!submit2.ok) {
  console.log("    issues:", (submit2.issues ?? []).map((i) => i.path + " → " + i.message).join(" | ") || "（无）");
  console.log("    gate:", (submit2.gate ?? []).join(" | ") || "（无）");
} else {
  console.log("    summary:", JSON.stringify(submit2.summary));
}
console.log("\n[tripId]", trip.id);

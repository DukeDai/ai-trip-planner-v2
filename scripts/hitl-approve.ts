import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../src/config.ts";
import { HttpClient } from "../src/core/http.ts";
import { TripStore, buildProfileMarkdown } from "../src/core/trips.ts";
import { TravelData } from "../src/data/providers.ts";
import { MemorySaver, InMemoryStore, Command } from "@langchain/langgraph";
import { buildTripAgent } from "../src/agent/build.ts";
import { findInterrupt } from "../src/agent/runner.ts";

const config = loadConfig();
const trips = new TripStore(config.tripsDir);
const data = new TravelData(new HttpClient({ cacheDir: config.cacheDir }), { amapKey: config.amapKey });
const source = "data/trips/trip-20261115-3bb123/itinerary.json";
const trip = trips.create({ destination: "北京", startDate: "2026-11-20", endDate: "2026-11-22", travelers: 2, budgetTotal: 8000, currency: "CNY" });
trips.writeProfile(trip.id, buildProfileMarkdown(trip));
fs.cpSync(path.join(process.cwd(), "src/agent/skills"), path.join(trips.dir(trip.id), "skills"), { recursive: true });
trips.writeArtifact(trip.id, "itinerary.json", fs.readFileSync(source, "utf8"));

const checkpointer = new MemorySaver();
const workspace = trips.workspace(trip.id);
const { agent } = buildTripAgent({
  config, trip, workspace, data, checkpointer, store: new InMemoryStore(),
  onApproved: () => { trips.update(trip.id, { status: "approved" }); }
});

console.log("=== 第 1 段：触发定稿 ===");
const stream = await agent.stream(
  { messages: [{ role: "user", content: "行程已写好并通过校验，请直接调用 finalize_itinerary 提交定稿。summary 写主线与预算差额，details 列出需人工确认的点。" }] },
  { configurable: { thread_id: trip.id }, streamMode: ["updates"] }
);
for await (const chunk of stream) {
  const payload = Array.isArray(chunk) ? chunk[1] : chunk;
  for (const [node, upd] of Object.entries(payload ?? {})) {
    if (node !== "tools") continue;
    for (const m of ((upd as { messages?: unknown[] })?.messages ?? [])) {
      const mm = m as { content?: unknown };
      console.log("  tool_result:", JSON.stringify(mm.content).slice(0, 140));
    }
  }
}
const pending = await findInterrupt(agent, trip.id);
console.log("挂起:", pending ? "是" : "否");
if (!pending) { console.log("FAIL: 未挂起"); process.exit(1); }
console.log("  工具:", pending.toolName);
console.log("  summary:", String(pending.args.summary ?? "").slice(0, 150));
console.log("  details 条数:", Array.isArray(pending.args.details) ? pending.args.details.length : 0);

console.log("\n=== 第 2 段：放行 ===");
const t0 = Date.now();
const approveStream = await agent.stream(
  new Command({ resume: { decisions: [{ type: "approve" }] } }),
  { configurable: { thread_id: trip.id }, streamMode: ["messages", "updates"] }
);
for await (const chunk of approveStream) {
  const payload = Array.isArray(chunk) ? chunk[1] : chunk;
  if (Array.isArray(payload)) {
    const msg = payload[0] as { content?: unknown };
    const text = typeof msg?.content === "string" ? msg.content : "";
    if (text) console.log("  agent:", text.slice(0, 200));
    continue;
  }
  for (const [node, upd] of Object.entries(payload ?? {})) {
    if (node !== "tools") continue;
    for (const m of ((upd as { messages?: unknown[] })?.messages ?? [])) {
      const mm = m as { content?: unknown };
      console.log("  tool_result:", JSON.stringify(mm.content).slice(0, 220));
    }
  }
}
console.log("放行耗时", ((Date.now() - t0) / 1000).toFixed(1), "s");
console.log("approved.json:", trips.readArtifact(trip.id, "approved.json")?.slice(0, 300) ?? "无");
console.log("行程状态:", trips.get(trip.id)?.status);

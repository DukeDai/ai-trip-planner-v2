import { connectDb } from "../src/core/db.ts";
import { TripRepository, toStoredPlace, toCandidate } from "../src/core/persist.ts";
import { TravelData } from "../src/data/providers.ts";
import { HttpClient } from "../src/core/http.ts";
import { createTools } from "../src/agent/tools.ts";
import { loadConfig } from "../src/config.ts";

const config = loadConfig();
const url = process.env.TRIP_PG_URL || config.pg.url;
if (!url) { console.log("没有 TRIP_PG_URL"); process.exit(1); }

const db = await connectDb({ url, schema: "trip_pilot" });
const repo = new TripRepository(db);
console.log("[1] PG 已连接，schema =", db.schema);

// 真实行程（走 TripStore 的有序落库路径）
const { TripStore } = await import("../src/core/trips.ts");
const trips = new TripStore(config.tripsDir, repo);
const trip = trips.create({ destination: "北京", startDate: "2026-11-20", endDate: "2026-11-22", travelers: 2, budgetTotal: 8000, currency: "CNY" });
await trips.persistTrip(trip);
console.log("[1b] 行程已入库:", trip.id);

const rows = await db.query<Record<string, unknown>>(
  "select table_name from information_schema.tables where table_schema = $1 order by 1",
  [db.schema]
);
console.log("[2] 自动建表:", rows.map((r) => String(r.table_name)).join(", "));

const http = new HttpClient({ cacheDir: config.cacheDir });
const data = new TravelData(http, { amapKey: config.amapKey });

// ---- 场景 A：真实取数 → 落库 ----
const res = await data.searchPlaces("故宫博物院", "北京", 5);
console.log("[3] 外部取数:", res.availability, res.provenance.source, (res.data ?? []).length, "条");
if (res.ok && res.data) {
  await repo.upsertPlaces(res.data.map((c) => toStoredPlace(c, res.provenance.fetchedAt)));
  await repo.saveSnapshot(trip.id, {
    tool: "search_places",
    queryKey: "search_places|北京|故宫博物院",
    provider: res.provenance.provider,
    fetchedAt: res.provenance.fetchedAt,
    confidence: res.provenance.confidence,
    availability: res.availability,
    payload: res.data
  });
}
const stored = await repo.findPlaces("故宫", "北京", 5);
console.log("[4] place_index 落库:", stored.length, "条 |", stored.map((p) => p.name + "(" + p.source + ")").join(", "));
const snap = await repo.latestSnapshot("search_places", "search_places|北京|故宫博物院");
console.log("[5] source_snapshots:", snap ? snap.provider + " @ " + snap.fetchedAt + " · " + (Array.isArray(snap.payload) ? snap.payload.length + " 条" : "") : "无");

// ---- 场景 B：断源兜底（外部全挂） ----
const brokenHttp = {
  async json() { return { ok: false, status: 0, error: "fetch failed（模拟断网）" }; }
};
const brokenData = new TravelData(brokenHttp as never, {});
const workspace = {
  tripId: "pgcheck",
  dir: config.dataDir,
  read: () => null,
  write: () => ({ bytes: 0 }),
  list: () => []
};
const toolList = createTools({ data: brokenData, workspace, repo, tripId: trip.id });
const byName = (n: string) => toolList.find((x) => x.name === n);

const localFirst = await byName("search_places")!.invoke({ query: "故宫", city: "北京" });
const localPayload = JSON.parse(String(localFirst));
console.log("[6] 断源 + 本地命中 →", localPayload.availability, "|", localPayload.provenance?.source ?? "(无)");

const noLocal = await byName("search_places")!.invoke({ query: "维也纳音乐厅", city: "维也纳" });
const fbPayload = JSON.parse(String(noLocal));
console.log("[7] 断源 + 无本地 →", fbPayload.availability, "| source:", fbPayload.provenance?.source ?? "(无)", "| error:", String(fbPayload.error ?? "").slice(0, 60));

// ---- 场景 B2：天气走快照兜底（天气没有本地表，只有快照） ----
const goodData = new TravelData(http, {});
const goodTools = createTools({ data: goodData, workspace, repo, tripId: trip.id });
const goodByName = (n: string) => goodTools.find((x) => x.name === n);
const wOk = JSON.parse(String(await goodByName("get_weather")!.invoke({
  latitude: 39.9163, longitude: 116.3972, startDate: "2026-11-20", endDate: "2026-11-22"
})));
console.log("[7b] 天气首次取数:", wOk.availability, "|", (wOk.data ?? []).map((d: { date: string; weatherText: string }) => d.date + " " + d.weatherText).join(", "));

const wFallback = JSON.parse(String(await byName("get_weather")!.invoke({
  latitude: 39.9163, longitude: 116.3972, startDate: "2026-11-20", endDate: "2026-11-22"
})));
console.log("[7c] 断源后天气:", wFallback.availability, "|", wFallback.provenance?.source, "|", String(wFallback.error ?? "").slice(0, 50));

// ---- 场景 C：checkpoint 落 PG ----
console.log("[8] saver 类型:", db.saver.constructor.name, "| store 类型:", db.store.constructor.name);
await db.close();

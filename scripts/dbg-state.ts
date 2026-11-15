import { loadConfig } from "../src/config.ts";
import { connectDb } from "../src/core/db.ts";
import { TripRepository } from "../src/core/persist.ts";
import { TripStore } from "../src/core/trips.ts";
import { TravelData } from "../src/data/providers.ts";
import { HttpClient } from "../src/core/http.ts";
import { buildTripAgent } from "../src/agent/build.ts";

const config = loadConfig();
const db = await connectDb({ url: config.pg.url, schema: config.pg.schema });
const repo = new TripRepository(db);
const trips = new TripStore(config.tripsDir, repo);
const trip = await trips.getAsync("trip-20261115-807338");
console.log("trip:", trip?.id, trip?.title);

const { agent } = buildTripAgent({
  config,
  trip: trip!,
  workspace: trips.workspace(trip!.id),
  data: new TravelData(new HttpClient({ cacheDir: config.cacheDir }), { amapKey: config.amapKey }),
  checkpointer: db.saver,
  store: db.store,
  repo
});

const state = (await agent.getState({ configurable: { thread_id: trip!.id } })) as Record<string, unknown>;
console.log("state.next =", JSON.stringify(state.next));
const tasks = (state.tasks ?? []) as { interrupts?: unknown[] }[];
console.log("state.tasks 数量 =", tasks.length);
console.log("tasks[0].interrupts =", JSON.stringify(tasks[0]?.interrupts ?? null).slice(0, 600));
console.log("state.messages 条数 =", ((state.messages ?? []) as unknown[]).length);
const msgs = (state.messages ?? []) as { tool_calls?: { name: string; args: unknown }[] }[];
const last = msgs[msgs.length - 1];
console.log("最后一条消息 tool_calls =", JSON.stringify(last?.tool_calls ?? null).slice(0, 300));
await db.close();

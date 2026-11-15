import assert from "node:assert/strict";
import test from "node:test";
import type { TripRepository, StoredPlace, SnapshotRecord } from "../src/core/persist.ts";
import { createTools } from "../src/agent/tools.ts";
import type { TravelData } from "../src/data/providers.ts";
import type { TripWorkspace } from "../src/core/trips.ts";
import type { PlaceCandidate, ToolEnvelope } from "../src/core/types.ts";

/** 假仓储：记录调用，模拟 PG 里的数据 */
function fakeRepo(opts: { places?: StoredPlace[]; snapshot?: SnapshotRecord | null } = {}) {
  const calls = {
    findPlaces: 0,
    upsertPlaces: 0,
    saveSnapshot: 0,
    getRoute: 0,
    saveRoute: 0,
    latestSnapshot: 0
  };
  let snapshot = opts.snapshot ?? null;
  const repo = {
    enabled: true,
    schema: "fake",
    async findPlaces() {
      calls.findPlaces++;
      return opts.places ?? [];
    },
    async upsertPlaces() {
      calls.upsertPlaces++;
    },
    async saveSnapshot() {
      calls.saveSnapshot++;
    },
    async latestSnapshot() {
      calls.latestSnapshot++;
      return snapshot;
    },
    async getRoute() {
      calls.getRoute++;
      return null;
    },
    async saveRoute() {
      calls.saveRoute++;
    },
    async upsertTrip() {},
    async getTrip() {
      return null;
    },
    async listTrips() {
      return [];
    },
    async saveArtifact() {},
    async loadArtifacts() {
      return [];
    },
    async savePreference() {},
    async listPreferences() {
      return [];
    },
    setSnapshot(s: SnapshotRecord | null) {
      snapshot = s;
    }
  } as unknown as TripRepository;
  return { repo, calls };
}

function fakeData(over: Partial<Record<string, unknown>> = {}) {
  const state = {
    searchCalls: 0,
    weatherCalls: 0,
    routeCalls: 0,
    ...over
  };
  const data = {
    async searchPlaces(): Promise<ToolEnvelope<PlaceCandidate[]>> {
      state.searchCalls++;
      return {
        ok: false,
        availability: "unavailable",
        data: null,
        provenance: { provider: "x", source: "x", fetchedAt: new Date().toISOString(), confidence: "low" },
        error: "模拟断网"
      };
    },
    async weather(): Promise<ToolEnvelope<never[]>> {
      state.weatherCalls++;
      return {
        ok: false,
        availability: "unavailable",
        data: null,
        provenance: { provider: "open-meteo", source: "open-meteo", fetchedAt: new Date().toISOString(), confidence: "low" },
        error: "模拟断网"
      };
    },
    async route(): Promise<ToolEnvelope<never>> {
      state.routeCalls++;
      return {
        ok: false,
        availability: "unavailable",
        data: null,
        provenance: { provider: "osrm", source: "osrm", fetchedAt: new Date().toISOString(), confidence: "low" },
        error: "模拟断网"
      };
    },
    async geocode() {
      return {
        ok: false,
        availability: "unavailable",
        data: null,
        provenance: { provider: "x", source: "x", fetchedAt: new Date().toISOString(), confidence: "low" },
        error: "模拟断网"
      };
    },
    async countryFacts() {
      return {
        ok: false,
        availability: "unavailable",
        data: null,
        provenance: { provider: "x", source: "x", fetchedAt: new Date().toISOString(), confidence: "low" },
        error: "模拟断网"
      };
    }
  } as unknown as TravelData;
  return { data, state };
}

const workspace: TripWorkspace = {
  tripId: "t1",
  dir: "/tmp",
  read: () => null,
  write: () => ({ bytes: 0 }),
  list: () => []
};

function toolByName(list: { name: string }[], name: string) {
  const t = list.find((x) => x.name === name);
  assert.ok(t, "缺少工具 " + name);
  return t as unknown as { invoke: (args: Record<string, unknown>) => Promise<unknown> };
}

test("本地优先：地点库命中时不请求外部源", async () => {
  const { repo, calls } = fakeRepo({
    places: [
      {
        placeId: "wd:Q2047427|wd",
        name: "故宫博物院",
        kind: "museum",
        city: "北京",
        lat: 39.9156,
        lng: 116.3908,
        source: "Wikidata",
        sourceRef: "Q2047427",
        openingHours: { text: "约 08:30-17:00" },
        ticketMin: 40,
        ticketMax: 60,
        ticketCurrency: "CNY",
        businessStatus: "active",
        sourceDetail: { confidence: "medium" },
        fetchedAt: new Date().toISOString()
      }
    ]
  });
  const { data, state } = fakeData();
  const tools = createTools({ data, workspace, repo, tripId: "t1" });
  const out = JSON.parse(String(await toolByName(tools, "search_sights").invoke({ query: "故宫", city: "北京" })));
  assert.equal(state.searchCalls, 0, "本地命中不应请求外部源");
  assert.equal(out.availability, "ok");
  assert.equal(out.data[0].name, "故宫博物院");
  assert.match(out.provenance.source, /本地地点库/);
  assert.ok(calls.findPlaces > 0);
});

test("取数即落库：外部成功后写快照与地点索引", async () => {
  const { repo, calls } = fakeRepo();
  const okData = {
    async searchPlaces() {
      return {
        ok: true,
        availability: "ok",
        data: [
          {
            id: "Q1",
            name: "某景点",
            category: "sight",
            lat: 1,
            lon: 2,
            source: "Wikidata",
            confidence: "medium",
            verified: false
          }
        ],
        provenance: { provider: "Wikidata", source: "Wikidata", fetchedAt: "2026-11-15T00:00:00.000Z", confidence: "medium" }
      };
    }
  } as unknown as TravelData;
  const tools = createTools({ data: okData, workspace, repo, tripId: "t1" });
  const out = JSON.parse(String(await toolByName(tools, "search_sights").invoke({ query: "某景点" })));
  assert.equal(out.ok, true);
  assert.equal(calls.upsertPlaces, 1, "应写入地点索引");
  assert.equal(calls.saveSnapshot, 1, "应写入取数快照");
});

test("断源兜底：外部不可用且有存档时返回存档并标注", async () => {
  const { repo } = fakeRepo({
    snapshot: {
      tool: "get_daily_weather",
      queryKey: "get_daily_weather|39.9,116.4|2026-11-20,2026-11-22",
      provider: "open-meteo",
      fetchedAt: new Date().toISOString(),
      confidence: "high",
      availability: "ok",
      payload: [{ date: "2026-11-20", weatherText: "晴" }]
    }
  });
  const { data } = fakeData();
  const tools = createTools({ data, workspace, repo, tripId: "t1" });
  const out = JSON.parse(
    String(
      await toolByName(tools, "get_daily_weather").invoke({
        latitude: 39.9,
        longitude: 116.4,
        startDate: "2026-11-20",
        endDate: "2026-11-22"
      })
    )
  );
  assert.equal(out.availability, "degraded");
  assert.match(out.provenance.source, /存档兜底/);
  assert.match(out.provenance.source, /open-meteo/);
  assert.equal(out.provenance.confidence, "low", "存档兜底必须下调置信度");
  assert.ok(out.error, "必须说明实时源失败原因");
});

test("断源且无存档：如实返回 unavailable，不编数据", async () => {
  const { repo } = fakeRepo({ snapshot: null });
  const { data } = fakeData();
  const tools = createTools({ data, workspace, repo, tripId: "t1" });
  const out = JSON.parse(
    String(
      await toolByName(tools, "get_daily_weather").invoke({
        latitude: 1,
        longitude: 2,
        startDate: "2026-11-20",
        endDate: "2026-11-21"
      })
    )
  );
  assert.equal(out.availability, "unavailable");
  assert.equal(out.data, null);
});

test("无仓储（纯内存模式）时行为不变，不会崩", async () => {
  const { data } = fakeData();
  const tools = createTools({ data, workspace, repo: null, tripId: null });
  const out = JSON.parse(
    String(
      await toolByName(tools, "get_daily_weather").invoke({
        latitude: 1,
        longitude: 2,
        startDate: "2026-11-20",
        endDate: "2026-11-21"
      })
    )
  );
  assert.equal(out.availability, "unavailable");
});

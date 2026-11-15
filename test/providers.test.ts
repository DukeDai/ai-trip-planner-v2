import assert from "node:assert/strict";
import test from "node:test";
import type { HttpClient } from "../src/core/http.ts";
import { TravelData, haversineMeters } from "../src/data/providers.ts";

type Handler = (url: string) => { status?: number; body: unknown } | null;

function fakeHttp(handler: Handler) {
  return {
    async json<T>(url: string): Promise<{ ok: boolean; status: number; data?: T; error?: string; fromCache?: boolean }> {
      const hit = handler(url);
      if (!hit) return { ok: false, status: 404, error: "not stubbed" };
      if (hit.status && hit.status >= 400) return { ok: false, status: hit.status, error: "http " + hit.status };
      return { ok: true, status: 200, data: hit.body as T };
    }
  } as unknown as HttpClient;
}

test("geocode：open-meteo 命中时返回坐标与来源", async () => {
  const http = fakeHttp((url) => {
    if (url.includes("geocoding-api.open-meteo.com")) {
      return { body: { results: [{ name: "巴黎", latitude: 48.85, longitude: 2.35, country: "法国" }] } };
    }
    return null;
  });
  const data = new TravelData(http);
  const res = await data.geocode("巴黎");
  assert.equal(res.ok, true);
  assert.equal(res.availability, "ok");
  assert.equal(res.data?.[0].lat, 48.85);
  assert.equal(res.provenance.source, "Open-Meteo 地理编码");
  assert.ok(res.provenance.fetchedAt);
});

test("geocode：全部源失败时返回 unavailable 而不是抛错", async () => {
  const http = fakeHttp(() => null);
  const data = new TravelData(http);
  const res = await data.geocode("不存在的地方");
  assert.equal(res.ok, false);
  assert.equal(res.availability, "unavailable");
  assert.equal(res.data, null);
  assert.match(res.error ?? "", /不可用/);
});

test("search_places：只走真实 API，不再注入任何种子库数据", async () => {
  const http = fakeHttp((url) => {
    if (url.includes("photon.komoot.io")) {
      return {
        body: {
          features: [
            {
              properties: { name: "故宫博物院", city: "北京", osm_value: "tourism=museum", osm_id: 1 },
              geometry: { coordinates: [116.39083, 39.91556] }
            }
          ]
        }
      };
    }
    return null;
  });
  const data = new TravelData(http);
  const res = await data.searchPlaces("故宫", "北京");
  assert.equal(res.ok, true);
  const names = (res.data ?? []).map((p) => p.name);
  assert.ok(names.includes("故宫博物院"));
  const merged = (res.data ?? []).find((p) => p.name === "故宫博物院");
  assert.ok(merged);
  assert.ok(merged?.source.includes("Photon"));
  // 第二轮：不允许再有内置种子库兜底 —— 查不到就是查不到
  assert.ok(!merged?.source.includes("种子库"), "source 不应再出现种子库：" + merged?.source);
  assert.equal(merged?.openingHours, undefined, "没有真实来源就不该凭空补出营业时间");
  assert.equal(merged?.ticketRange, undefined, "没有真实来源就不该凭空补出票价");
  assert.equal(merged?.verified, false);
});

test("search_places：所有源都取不到时如实返回 unavailable", async () => {
  const http = fakeHttp(() => null);
  const data = new TravelData(http);
  const res = await data.searchPlaces("完全查不到的点", "火星");
  assert.equal(res.availability, "unavailable");
  assert.equal(res.data, null);
  assert.match(res.error ?? "", /没有可用 POI 数据源/);
});

test("weather：解析逐日预报并映射天气文本", async () => {
  const http = fakeHttp((url) => {
    if (url.includes("api.open-meteo.com")) {
      return {
        body: {
          daily: {
            time: ["2026-11-20", "2026-11-21"],
            weather_code: [0, 61],
            temperature_2m_max: [18, 15],
            temperature_2m_min: [5, 4],
            precipitation_probability_max: [0, 70],
            wind_speed_10m_max: [9, 14],
            sunrise: ["2026-11-20T06:52:00", "2026-11-21T06:53:00"],
            sunset: ["2026-11-20T17:02:00", "2026-11-20T17:03:00"]
          }
        }
      };
    }
    return null;
  });
  const data = new TravelData(http);
  const res = await data.weather(39.9, 116.4, "2026-11-20", "2026-11-21");
  assert.equal(res.ok, true);
  assert.equal(res.data?.length, 2);
  assert.equal(res.data?.[0].weatherText, "晴");
  assert.equal(res.data?.[1].weatherText, "小雨");
  assert.equal(res.data?.[1].precipitationProb, 70);
  assert.equal(res.provenance.confidence, "high");
});

test("weather：空数据返回 unavailable 并提示可能超出预报范围", async () => {
  const http = fakeHttp((url) => (url.includes("open-meteo") ? { body: { daily: { time: [] } } } : null));
  const data = new TravelData(http);
  const res = await data.weather(39.9, 116.4, "2030-01-01", "2030-01-02");
  assert.equal(res.availability, "unavailable");
  assert.match(res.error ?? "", /预报范围/);
});

test("route：OSRM 可用时给出真实距离与时长", async () => {
  const http = fakeHttp((url) => {
    if (url.includes("router.project-osrm.org")) {
      return { body: { routes: [{ distance: 12000, duration: 1500 }] } };
    }
    return null;
  });
  const data = new TravelData(http);
  const res = await data.route(39.9, 116.4, 40.0, 116.6, "driving");
  assert.equal(res.ok, true);
  assert.equal(res.data?.distanceMeters, 12000);
  assert.equal(res.data?.durationMinutes, 25);
  assert.equal(res.data?.estimated, false);
});

test("route：路网不可用时降级为直线估算并标注", async () => {
  const http = fakeHttp(() => null);
  const data = new TravelData(http);
  const res = await data.route(39.9, 116.4, 40.0, 116.6, "walking");
  assert.equal(res.availability, "degraded");
  assert.equal(res.data?.estimated, true);
  assert.ok((res.data?.durationMinutes ?? 0) > 0);
});

test("countryFacts：RestCountries 命中", async () => {
  const http = fakeHttp((url) => {
    if (url.includes("restcountries")) {
      return {
        body: [
          {
            name: { common: "法国" },
            cca3: "FRA",
            capital: ["巴黎"],
            currencies: { EUR: { name: "欧元" } },
            languages: { fra: "法语" },
            timezones: ["UTC+1"],
            region: "Europe",
            car: { side: "right" }
          }
        ]
      };
    }
    return null;
  });
  const data = new TravelData(http);
  const res = await data.countryFacts("法国");
  assert.equal(res.ok, true);
  assert.equal(res.data?.code, "FRA");
  assert.equal(res.data?.currencies[0], "欧元");
  assert.equal(res.provenance.confidence, "high");
});

test("countryFacts：在线源失败时回退内置事实表并如实标注来源", async () => {
  const http = fakeHttp(() => null);
  const data = new TravelData(http);
  const res = await data.countryFacts("日本");
  assert.equal(res.availability, "degraded");
  assert.equal(res.data?.code, "JPN");
  assert.equal(res.data?.currencies[0], "JPY");
  assert.equal(res.data?.source, "内置事实表（非 API）");
  assert.equal(res.provenance.source, "内置事实表（非 API）");
});

test("haversine：北京到上海量级正确", () => {
  const d = haversineMeters(39.9042, 116.4074, 31.2304, 121.4737);
  assert.ok(d > 1_000_000 && d < 1_200_000, "实际 " + d);
});

import type { HttpClient } from "../core/http.ts";
import type {
  Confidence,
  CountryFacts,
  PlaceCandidate,
  RouteResult,
  ToolEnvelope,
  WeatherDay
} from "../core/types.ts";
import { COUNTRY_FACT_SOURCE, matchCountryFact } from "./country-facts.ts";
import { searchWikidata, wikipediaSummary } from "./wikidata.ts";

const WMO_TEXT: Record<number, string> = {
  0: "晴", 1: "晴间多云", 2: "多云", 3: "阴", 45: "雾", 48: "雾凇",
  51: "毛毛雨", 53: "小雨", 55: "中雨", 56: "冻雨", 57: "冻雨",
  61: "小雨", 63: "中雨", 65: "大雨", 66: "冻雨", 67: "冻雨",
  71: "小雪", 73: "中雪", 75: "大雪", 77: "雪粒",
  80: "阵雨", 81: "强阵雨", 82: "暴雨", 85: "阵雪", 86: "强阵雪",
  95: "雷阵雨", 96: "雷阵雨伴冰雹", 99: "强雷暴伴冰雹"
};

export interface GeoResult {
  name: string;
  lat: number;
  lon: number;
  country?: string;
  admin1?: string;
  timezone?: string;
  source: string;
  confidence: Confidence;
}

export interface TravelDataOptions {
  amapKey?: string;
}

function now(): string {
  return new Date().toISOString();
}

function envelope<T>(
  availability: "ok" | "degraded" | "unavailable",
  data: T | null,
  provenance: { provider: string; source: string; confidence: Confidence; url?: string; note?: string },
  error?: string
): ToolEnvelope<T> {
  return {
    ok: availability !== "unavailable",
    availability,
    data,
    provenance: { ...provenance, fetchedAt: now() },
    error
  };
}

export function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export class TravelData {
  private readonly http: HttpClient;
  private readonly options: TravelDataOptions;

  constructor(http: HttpClient, options: TravelDataOptions = {}) {
    this.http = http;
    this.options = options;
  }

  async geocode(name: string): Promise<ToolEnvelope<GeoResult[]>> {
    const errors: string[] = [];
    const openMeteoUrl =
      "https://geocoding-api.open-meteo.com/v1/search?name=" +
      encodeURIComponent(name) +
      "&count=8&language=zh&format=json";
    const om = await this.http.json<{ results?: Record<string, unknown>[] }>(openMeteoUrl, {
      timeoutMs: 8000,
      retries: 1
    });
    if (om.ok) {
      const rows = om.data?.results ?? [];
      const parsed: GeoResult[] = rows
        .map((r) => ({
          name: String(r.name ?? name),
          lat: Number(r.latitude),
          lon: Number(r.longitude),
          country: r.country ? String(r.country) : undefined,
          admin1: r.admin1 ? String(r.admin1) : undefined,
          timezone: r.timezone ? String(r.timezone) : undefined,
          source: "open-meteo-geocoding",
          confidence: "medium" as Confidence
        }))
        .filter((g) => Number.isFinite(g.lat) && Number.isFinite(g.lon));
      if (parsed.length > 0) {
        return envelope("ok", parsed, {
          provider: "open-meteo-geocoding",
          source: "Open-Meteo 地理编码",
          confidence: "medium",
          url: openMeteoUrl,
          note: om.fromCache ? "命中本地缓存" : undefined
        });
      }
      errors.push("open-meteo-geocoding: 无结果");
    } else {
      errors.push("open-meteo-geocoding: " + (om.error ?? "未知错误"));
    }

    // Nominatim 作为第二级地理编码源
    const nomGeoUrl =
      "https://nominatim.openstreetmap.org/search?q=" +
      encodeURIComponent(name) +
      "&format=jsonv2&limit=8&addressdetails=1";
    const nomGeo = await this.http.json<Record<string, unknown>[]>(nomGeoUrl, {
      timeoutMs: 8000,
      retries: 1
    });
    if (nomGeo.ok && Array.isArray(nomGeo.data) && nomGeo.data.length > 0) {
      const parsed: GeoResult[] = nomGeo.data
        .map((row) => {
          const addr = (row.address ?? {}) as Record<string, string>;
          return {
            name: String(row.name ?? addr.city ?? name),
            lat: Number(row.lat),
            lon: Number(row.lon),
            country: addr.country,
            admin1: addr.state ?? addr.province,
            source: "nominatim",
            confidence: "medium" as Confidence
          };
        })
        .filter((g) => Number.isFinite(g.lat) && Number.isFinite(g.lon));
      if (parsed.length > 0) {
        return envelope("ok", parsed, {
          provider: "nominatim",
          source: "OpenStreetMap (Nominatim)",
          confidence: "medium",
          url: nomGeoUrl
        });
      }
    } else {
      errors.push("nominatim: " + (nomGeo.error ?? "无结果"));
    }

    const photonUrl =
      "https://photon.komoot.io/api/?q=" + encodeURIComponent(name) + "&limit=8&lang=zh";
    const ph = await this.http.json<{ features?: Record<string, unknown>[] }>(photonUrl, {
      timeoutMs: 8000,
      retries: 1
    });
    if (ph.ok) {
      const feats = ph.data?.features ?? [];
      const parsed: GeoResult[] = feats
        .map((f) => {
          const props = (f.properties ?? {}) as Record<string, unknown>;
          const geom = (f.geometry ?? {}) as { coordinates?: number[] };
          const coords = geom.coordinates ?? [];
          return {
            name: String(props.name ?? name),
            lat: Number(coords[1]),
            lon: Number(coords[0]),
            country: props.country ? String(props.country) : undefined,
            admin1: props.state ? String(props.state) : undefined,
            source: "photon",
            confidence: "medium" as Confidence
          };
        })
        .filter((g) => Number.isFinite(g.lat) && Number.isFinite(g.lon));
      if (parsed.length > 0) {
        return envelope("ok", parsed, {
          provider: "photon",
          source: "OpenStreetMap (Photon)",
          confidence: "medium",
          url: photonUrl
        });
      }
      errors.push("photon: 无结果");
    } else {
      errors.push("photon: " + (ph.error ?? "未知错误"));
    }

    return envelope<GeoResult[]>(
      "unavailable",
      null,
      { provider: "geocode", source: "geocode", confidence: "low" },
      "地理编码不可用：" + errors.join("；")
    );
  }

  async searchPlaces(
    query: string,
    city?: string,
    limit = 8
  ): Promise<ToolEnvelope<PlaceCandidate[]>> {
    const out: PlaceCandidate[] = [];
    const notes: string[] = [];

    if (this.options.amapKey) {
      const amapUrl =
        "https://restapi.amap.com/v3/place/text?keywords=" +
        encodeURIComponent(query) +
        (city ? "&city=" + encodeURIComponent(city) : "") +
        "&extensions=all&offset=" +
        String(Math.min(limit, 25)) +
        "&page=1&key=" +
        this.options.amapKey;
      const am = await this.http.json<{ pois?: Record<string, unknown>[] }>(amapUrl, {
        timeoutMs: 9000,
        retries: 1
      });
      if (am.ok && am.data?.pois) {
        for (const poi of am.data.pois) {
          const loc = (poi.location ?? {}) as { lon?: string; lat?: string };
          const biz = (poi.biz_ext ?? {}) as Record<string, unknown>;
          out.push({
            id: String(poi.id ?? ""),
            name: String(poi.name ?? query),
            category: String(poi.type ?? ""),
            city,
            address: poi.address ? String(poi.address) : undefined,
            lat: Number(loc.lat),
            lon: Number(loc.lon),
            openingHours: typeof biz.open_time === "string" ? biz.open_time : undefined,
            avgCost: typeof biz.avg_price === "string" ? Number(biz.avg_price) : undefined,
            rating: typeof biz.rating === "string" ? Number(biz.rating) : undefined,
            source: "高德地图",
            confidence: "high",
            verified: true
          });
        }
      } else {
        notes.push("高德不可用：" + (am.error ?? "无结果"));
      }
    }

    // 2) Wikidata：结构化事实（坐标 / 官网 / 开放起始时间 / 一句话描述）
    const wd = await searchWikidata(this.http, query, limit);
    if (wd.error) {
      notes.push(wd.error);
    }
    for (const p of wd.places) {
      out.push({
        id: p.id,
        name: p.name,
        category: p.description ?? "unknown",
        city,
        lat: p.lat,
        lon: p.lon,
        openingHours: p.openingHours,
        source: "Wikidata",
        confidence: "medium",
        verified: false,
        tips: [p.description, p.website ? "官网 " + p.website : undefined].filter(Boolean).join("｜") || undefined
      });
    }

    // 3) Photon（OSM 名称检索）
    const photonUrl =
      "https://photon.komoot.io/api/?q=" +
      encodeURIComponent(query) +
      "&limit=" +
      String(limit) +
      "&lang=zh";
    const ph = await this.http.json<{ features?: Record<string, unknown>[] }>(photonUrl, {
      timeoutMs: 8000,
      retries: 1
    });
    if (ph.ok) {
      const feats = ph.data?.features ?? [];
      for (const f of feats) {
        const props = (f.properties ?? {}) as Record<string, unknown>;
        const geom = (f.geometry ?? {}) as { coordinates?: number[] };
        const coords = geom.coordinates ?? [];
        const osmValue = String(props.osm_value ?? "");
        const head = osmValue.split("=")[0];
        if (osmValue && !/^(tourism|amenity|leisure|historic|natural|shop)$/.test(head)) continue;
        out.push({
          id: String(props.osm_id ?? props.name ?? query),
          name: String(props.name ?? query),
          category: osmValue || "unknown",
          city: props.city ? String(props.city) : undefined,
          address: [props.street, props.housenumber, props.city].filter(Boolean).join(" ") || undefined,
          lat: Number(coords[1]),
          lon: Number(coords[0]),
          source: "OpenStreetMap (Photon)",
          confidence: "medium",
          verified: false
        });
      }
    } else {
      notes.push("Photon 不可用：" + (ph.error ?? "未知错误"));
    }

    // 4) Nominatim（OSM 检索 + extratags 里的 opening_hours）
    if (out.length < 2) {
      const nomUrl =
        "https://nominatim.openstreetmap.org/search?q=" +
        encodeURIComponent(query) +
        "&format=jsonv2&limit=" +
        String(limit) +
        "&extratags=1&namedetails=1&addressdetails=1";
      const nom = await this.http.json<Record<string, unknown>[]>(nomUrl, {
        timeoutMs: 9000,
        retries: 1
      });
      if (nom.ok && Array.isArray(nom.data)) {
        for (const row of nom.data) {
          const extra = (row.extratags ?? {}) as Record<string, string>;
          const addr = (row.address ?? {}) as Record<string, string>;
          out.push({
            id: String(row.osm_id ?? row.place_id ?? query),
            name: String(row.name ?? query),
            category: String(row.category ?? row.type ?? "unknown"),
            city: addr.city ?? addr.town ?? addr.county,
            address: typeof row.display_name === "string" ? row.display_name : undefined,
            lat: Number(row.lat),
            lon: Number(row.lon),
            openingHours: extra.opening_hours,
            source: "OpenStreetMap (Nominatim)",
            confidence: "medium",
            verified: false
          });
        }
      } else {
        notes.push("Nominatim 不可用：" + (nom.error ?? "无结果"));
      }
    }

    const deduped: PlaceCandidate[] = [];
    for (const c of out) {
      if (!Number.isFinite(c.lat) || !Number.isFinite(c.lon)) continue;
      // 同一地点的不同来源坐标常有几十米偏差：按「名称相近 + 距离 250m 内」判定为同一处
      const existing = deduped.find((e) => {
        const sameName =
          e.name === c.name || e.name.includes(c.name) || c.name.includes(e.name) ||
          (e.name.length > 2 && c.name.length > 2 && (e.name.includes(c.name.slice(0, 3)) || c.name.includes(e.name.slice(0, 3))));
        if (!sameName) return false;
        return haversineMeters(e.lat, e.lon, c.lat, c.lon) <= 250;
      });
      if (!existing) {
        deduped.push(c);
        continue;
      }
      // 同一地点被多个源命中：合并而不是丢弃，缺的字段用后到的源补上
      if (!existing.openingHours && c.openingHours) existing.openingHours = c.openingHours;
      if (!existing.ticketRange && c.ticketRange) existing.ticketRange = c.ticketRange;
      if (existing.avgCost === undefined && c.avgCost !== undefined) existing.avgCost = c.avgCost;
      if (existing.rating === undefined && c.rating !== undefined) existing.rating = c.rating;
      if (existing.durationMin === undefined && c.durationMin !== undefined) existing.durationMin = c.durationMin;
      if (!existing.tips && c.tips) existing.tips = c.tips;
      if (!existing.address && c.address) existing.address = c.address;
      if (!existing.city && c.city) existing.city = c.city;
      if (!existing.source.includes(c.source)) existing.source = existing.source + " + " + c.source;
      if (existing.confidence !== "high" && c.confidence === "high") existing.confidence = "high";
    }

    if (deduped.length === 0) {
      return envelope<PlaceCandidate[]>(
        "unavailable",
        null,
        { provider: "places", source: "places", confidence: "low" },
        "没有可用 POI 数据源" + (notes.length ? "：" + notes.join("；") : "")
      );
    }
    // 5) 维基百科一句话描述：给前两个条目补人话介绍（拿不到就算了）
    for (const c of deduped.slice(0, 2)) {
      if (c.tips) continue;
      const wp = await wikipediaSummary(this.http, c.name);
      if (wp?.description) c.tips = wp.description;
    }

    const best = deduped[0];
    return envelope(
      deduped.some((c) => c.confidence === "high") ? "ok" : "degraded",
      deduped,
      {
        provider: best.source,
        source: best.source,
        confidence: best.confidence,
        note: notes.length ? notes.join("；") : undefined
      }
    );
  }

  async weather(
    lat: number,
    lon: number,
    startDate: string,
    endDate: string
  ): Promise<ToolEnvelope<WeatherDay[]>> {
    const url =
      "https://api.open-meteo.com/v1/forecast?latitude=" +
      lat +
      "&longitude=" +
      lon +
      "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max,sunrise,sunset" +
      "&timezone=auto&start_date=" +
      startDate +
      "&end_date=" +
      endDate;
    const res = await this.http.json<{ daily?: Record<string, unknown> }>(url, {
      timeoutMs: 10000,
      retries: 2
    });
    if (!res.ok) {
      return envelope<WeatherDay[]>(
        "unavailable",
        null,
        { provider: "open-meteo", source: "open-meteo", confidence: "low", url },
        "天气数据不可用：" + (res.error ?? "未知错误")
      );
    }
    const daily = res.data?.daily;
    const times = (daily?.time ?? []) as string[];
    if (!daily || times.length === 0) {
      return envelope<WeatherDay[]>(
        "unavailable",
        null,
        { provider: "open-meteo", source: "open-meteo", confidence: "low", url },
        "天气数据为空（日期可能超出预报范围，通常只覆盖未来 16 天）"
      );
    }
    const pick = (key: string, i: number): number => {
      const arr = daily[key];
      return Array.isArray(arr) ? Number(arr[i] ?? 0) : 0;
    };
    const str = (key: string, i: number): string | undefined => {
      const arr = daily[key];
      return Array.isArray(arr) ? String(arr[i] ?? "").slice(11, 16) || undefined : undefined;
    };
    const days: WeatherDay[] = times.map((date, i) => {
      const code = pick("weather_code", i);
      return {
        date,
        weatherCode: code,
        weatherText: WMO_TEXT[code] ?? "未知",
        tempMax: pick("temperature_2m_max", i),
        tempMin: pick("temperature_2m_min", i),
        precipitationProb: pick("precipitation_probability_max", i),
        windMax: pick("wind_speed_10m_max", i),
        sunrise: str("sunrise", i),
        sunset: str("sunset", i)
      };
    });
    return envelope("ok", days, {
      provider: "open-meteo",
      source: "Open-Meteo 逐日预报",
      confidence: "high",
      url,
      note: res.fromCache ? "命中本地缓存" : undefined
    });
  }

  async route(
    fromLat: number,
    fromLon: number,
    toLat: number,
    toLon: number,
    mode: "walking" | "driving" | "cycling" = "driving"
  ): Promise<ToolEnvelope<RouteResult>> {
    const straight = haversineMeters(fromLat, fromLon, toLat, toLon);
    if (mode === "driving") {
      const url =
        "https://router.project-osrm.org/route/v1/driving/" +
        fromLon +
        "," +
        fromLat +
        ";" +
        toLon +
        "," +
        toLat +
        "?overview=false&steps=false";
      const res = await this.http.json<{ routes?: { distance: number; duration: number }[] }>(url, {
        timeoutMs: 9000,
        retries: 1
      });
      const route = res.ok ? res.data?.routes?.[0] : undefined;
      if (route && Number.isFinite(route.distance)) {
        return envelope(
          "ok",
          {
            distanceMeters: Math.round(route.distance),
            durationMinutes: Math.round(route.duration / 60),
            mode,
            estimated: false,
            source: "OSRM",
            confidence: "medium"
          },
          { provider: "osrm", source: "OSRM 路网", confidence: "medium", url }
        );
      }
    }
    const factor = mode === "walking" ? 1.3 : mode === "cycling" ? 1.15 : 1.25;
    const speed = mode === "walking" ? 4.8 : mode === "cycling" ? 16 : 30;
    const meters = straight * factor;
    return envelope(
      "degraded",
      {
        distanceMeters: Math.round(meters),
        durationMinutes: Math.max(1, Math.round((meters / 1000 / speed) * 60)),
        mode,
        estimated: true,
        source: "直线距离估算",
        confidence: "low"
      },
      { provider: "estimate", source: "直线距离 × 经验系数估算", confidence: "low" },
      "路网服务不可用，仅给出直线估算"
    );
  }

  async countryFacts(country: string): Promise<ToolEnvelope<CountryFacts>> {
    const url =
      "https://restcountries.com/v3.1/name/" +
      encodeURIComponent(country) +
      "?fields=name,cca3,capital,currencies,languages,timezones,region,car";
    const res = await this.http.json<Record<string, unknown>[]>(url, {
      timeoutMs: 9000,
      retries: 1
    });
    if (res.ok && Array.isArray(res.data) && res.data.length > 0) {
      const c = res.data[0];
      const currencies = (c.currencies ?? {}) as Record<string, { name?: string }>;
      const languages = (c.languages ?? {}) as Record<string, string>;
      const car = (c.car ?? {}) as { side?: string };
      const capital = (c.capital ?? []) as string[];
      return envelope(
        "ok",
        {
          name: String((c.name as { common?: string })?.common ?? country),
          code: String(c.cca3 ?? ""),
          capital: capital[0],
          currencies: Object.values(currencies).map((x) => x.name ?? "未知"),
          languages: Object.values(languages),
          timezones: (c.timezones ?? []) as string[],
          drivingSide: car.side,
          region: c.region ? String(c.region) : undefined,
          source: "RestCountries",
          confidence: "high"
        },
        { provider: "restcountries", source: "RestCountries", confidence: "high", url }
      );
    }
    // 兜底：内置事实表（**非 API**）。只放国家级元数据，不含任何 POI/票价/开放时间。
    const fact = matchCountryFact(country);
    if (fact) {
      return envelope(
        "degraded",
        {
          name: fact.name,
          code: fact.code,
          capital: fact.capital,
          currencies: fact.currencies,
          languages: fact.languages,
          timezones: fact.timezones,
          drivingSide: fact.drivingSide,
          region: fact.region,
          source: COUNTRY_FACT_SOURCE,
          confidence: "medium"
        },
        { provider: "offline-facts", source: COUNTRY_FACT_SOURCE, confidence: "medium" },
        "RestCountries 不可用，使用内置事实表（非 API）"
      );
    }
    return envelope<CountryFacts>(
      "unavailable",
      null,
      { provider: "restcountries", source: "restcountries", confidence: "low", url },
      "国别信息不可用：" + (res.error ?? "未匹配到该国家")
    );
  }
}

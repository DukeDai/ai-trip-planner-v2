import { tool } from "langchain";
import { z } from "zod";
import type { TravelData } from "../data/providers.ts";
import { haversineMeters } from "../data/providers.ts";
import type { TripWorkspace } from "../core/trips.ts";
import type { TripRepository } from "../core/persist.ts";
import { toCandidate, toStoredPlace } from "../core/persist.ts";
import { validatePlan, planHash } from "../core/schema.ts";
import { runReview, type ReviewFact, type ReviewReport, type ReviewRequirements } from "./reviewer.ts";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

export type ReviewerRunner = (input: {
  plan: unknown;
  planHash: string;
  round: number;
  facts: ReviewFact[];
  requirements: ReviewRequirements;
}) => Promise<ReviewReport>;

export interface ToolDeps {
  data: TravelData;
  workspace: TripWorkspace;
  /** 外部取数落库仓储（无 PG 时为 null） */
  repo?: TripRepository | null;
  /** 当前行程 id，用于把取数快照关联到行程 */
  tripId?: string | null;
  /** HITL 放行后回调：定稿落盘 + 行程状态置为 approved */
  onApproved?: (summary: string) => void;
  /** 审查器（没配就不能提交行程） */
  reviewer?: ReviewerRunner | null;
  /** 需求摘要，供 reviewer 判断「需求匹配度」 */
  requirements?: ReviewRequirements;
}

function fmt(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function ageMinutes(fetchedAt: string): number {
  const t = Date.parse(fetchedAt);
  if (Number.isNaN(t)) return -1;
  return Math.max(0, Math.round((Date.now() - t) / 60000));
}

/**
 * 把工具返回的信封压成紧凑事实（写进 research/facts.json）。
 * 审查员只看这份事实包 —— 保证它审的是「工具真取到的数据」，不是模型的脑补。
 */
function compactEnvelope(envelope: unknown): unknown {
  const e = (envelope ?? {}) as Record<string, unknown>;
  const prov = (e.provenance ?? {}) as Record<string, unknown>;
  const inner = e.data;
  let compactInner: unknown = null;
  if (Array.isArray(inner)) {
    // 数组既可能是 POI 列表，也可能是逐日天气 —— 两种字段都要留住
    compactInner = inner.slice(0, 12).map((x) => {
      const o = (x ?? {}) as Record<string, unknown>;
      const picked: Record<string, unknown> = {};
      for (const key of [
        "name",
        "city",
        "category",
        "openingHours",
        "ticketRange",
        "avgCost",
        "lat",
        "lon",
        "source",
        "confidence",
        "verified",
        "date",
        "weatherText",
        "weatherCode",
        "tempMax",
        "tempMin",
        "precipitationProb",
        "windMax",
        "sunrise",
        "sunset"
      ]) {
        if (o[key] !== undefined && o[key] !== null) picked[key] = o[key];
      }
      return picked;
    });
  } else if (inner && typeof inner === "object") {
    const o = inner as Record<string, unknown>;
    compactInner = {
      name: o.name,
      date: o.date,
      weatherText: o.weatherText,
      tempMax: o.tempMax,
      tempMin: o.tempMin,
      precipitationProb: o.precipitationProb,
      distanceMeters: o.distanceMeters,
      durationMinutes: o.durationMinutes,
      mode: o.mode,
      currencies: o.currencies,
      languages: o.languages,
      timezones: o.timezones,
      drivingSide: o.drivingSide
    };
  }
  return {
    availability: e.availability,
    error: e.error,
    provenance: { provider: prov.provider, source: prov.source, confidence: prov.confidence, note: prov.note },
    data: compactInner
  };
}

/**
 * 工具层的统一取数策略（三段式）：
 *   1. 本地优先 —— 落过库的数据直接用，不重复打外网
 *   2. 取到即落库 —— 每次外部取数都写快照，附来源/时间/置信度
 *   3. 存档兜底 —— 外网挂掉时用最近一次存档返回，并如实标注「存档 + 多久之前 + 置信度下调」
 * 这样即使实时源限流、抖动、宕机，行程也不会开天窗。
 */
export function createTools(deps: ToolDeps) {
  const repo = deps.repo ?? null;
  const tripId = deps.tripId ?? null;

  // 事实包：工具真实取到的数据，供 reviewer 审查（只读，不臆测）
  const facts: ReviewFact[] = [];
  try {
    const raw = deps.workspace.read("research/facts.json");
    if (raw) {
      const parsed = JSON.parse(raw) as ReviewFact[];
      if (Array.isArray(parsed)) facts.push(...parsed);
    }
  } catch {
    /* 事实包损坏就当空的 */
  }

  const recordFact = (toolName: string, kind: string, query: string | undefined, envelope: unknown): void => {
    facts.push({
      tool: toolName,
      kind,
      at: new Date().toISOString(),
      query,
      data: compactEnvelope(envelope)
    });
    try {
      deps.workspace.write("research/facts.json", JSON.stringify(facts, null, 2));
    } catch {
      /* 写不进去不影响主流程 */
    }
  };

  const saveSnapshot = async (
    toolName: string,
    queryKey: string,
    res: {
      provenance: { provider: string; source: string; url?: string; fetchedAt: string; confidence: string };
      availability: string;
    },
    payload: unknown
  ): Promise<void> => {
    if (!repo) return;
    await repo.saveSnapshot(tripId, {
      tool: toolName,
      queryKey,
      provider: res.provenance.provider,
      url: res.provenance.url,
      fetchedAt: res.provenance.fetchedAt,
      confidence: res.provenance.confidence,
      availability: res.availability,
      payload
    });
  };

  const fallback = async (
    toolName: string,
    queryKey: string,
    failedMessage: string
  ): Promise<string | null> => {
    if (!repo) return null;
    const snap = await repo.latestSnapshot(toolName, queryKey);
    if (!snap) return null;
    const mins = ageMinutes(snap.fetchedAt);
    return fmt({
      ok: true,
      availability: "degraded",
      data: snap.payload,
      provenance: {
        provider: snap.provider,
        source: "存档兜底 · " + snap.provider + "（" + (mins >= 0 ? mins + " 分钟前" : "时间未知") + "取回）",
        confidence: "low",
        fetchedAt: snap.fetchedAt,
        note: "实时源不可用，此结果来自本地存档，请按存档时间判断时效"
      },
      error: failedMessage
    });
  };

  /** 检索 + 兜底检索词：某个词查不到就换同域的词再试 */
  const searchWithFallback = async (
    query: string,
    city: string | undefined,
    limit: number,
    fallbacks: string[]
  ): Promise<{ res: Awaited<ReturnType<TravelData["searchPlaces"]>>; usedQuery: string; tried: string[] }> => {
    const tried: string[] = [];
    let last: Awaited<ReturnType<TravelData["searchPlaces"]>> | null = null;
    for (const q of [query, ...fallbacks]) {
      if (!q || q.trim().length === 0) continue;
      tried.push(q);
      const res = await deps.data.searchPlaces(q, city, limit);
      last = res;
      if (res.ok && res.data && res.data.length > 0) return { res, usedQuery: q, tried };
    }
    if (!last) throw new Error("检索词为空");
    return { res: last, usedQuery: query, tried };
  };

  // ---- 地理编码 ----
  const geocodePlace = tool(
    async ({ name }) => {
      const key = "geocode|" + name;
      const res = await deps.data.geocode(name);
      recordFact("geocode_place", "geo", name, res);
      if (res.ok && res.data) {
        await saveSnapshot("geocode_place", key, res, res.data);
        return fmt(res);
      }
      const fb = await fallback("geocode_place", key, "地理编码不可用：" + (res.error ?? "未知错误"));
      return fb ?? fmt(res);
    },
    {
      name: "geocode_place",
      description:
        "把地名/景点名解析成坐标与行政区信息。查天气、算通勤、写行程单的 city/lat/lon 之前先调用它定位。返回带 source 与 fetchedAt。",
      schema: z.object({
        name: z.string().describe("地名，如「巴黎」「慕田峪长城」「京都」")
      })
    }
  );

  // ---- 四类 POI 检索（细粒度） ----
  const makeSearchTool = (opts: {
    name: string;
    kind: string;
    description: string;
    fallbacks: string[];
    queryHint: string;
  }) =>
    tool(
      async ({ city, query, limit }) => {
        const n = limit ?? 8;
        const q = (query ?? "").trim() || opts.fallbacks[0];
        const key = opts.name + "|" + (city ?? "") + "|" + q;

        const local = (await repo?.findPlaces(q, city, n)) ?? [];
        if (local.length > 0) {
          const env = {
            ok: true,
            availability: "ok",
            data: local.map(toCandidate),
            provenance: {
              provider: "place_index",
              source: "本地地点库（已落库，未再请求外网）",
              confidence: "medium",
              fetchedAt: local[0].fetchedAt,
              note: "命中本地存档，取回时间 " + ageMinutes(local[0].fetchedAt) + " 分钟前"
            }
          };
          recordFact(opts.name, opts.kind, q + (city ? "@" + city : ""), env);
          return fmt(env);
        }

        const { res, usedQuery, tried } = await searchWithFallback(q, city, n, opts.fallbacks);
        recordFact(opts.name, opts.kind, usedQuery + (city ? "@" + city : ""), res);
        if (res.ok && res.data) {
          const fetchedAt = res.provenance.fetchedAt;
          await repo?.upsertPlaces(res.data.map((c) => toStoredPlace(c, fetchedAt)));
          await saveSnapshot(opts.name, key, res, res.data);
          const out = {
            ...res,
            note: tried.length > 1 ? "实际检索词：" + tried.join(" / ") : undefined
          };
          return fmt(out);
        }
        const fb = await fallback(opts.name, key, "POI 检索不可用：" + (res.error ?? "未知错误"));
        return fb ?? fmt(res);
      },
      {
        name: opts.name,
        description: opts.description,
        schema: z.object({
          city: z.string().optional().describe("城市名，用于限定范围，如「京都」"),
          query: z.string().describe(opts.queryHint),
          limit: z.number().int().min(1).max(25).optional().describe("返回条数，默认 8")
        })
      }
    );

  const searchSights = makeSearchTool({
    name: "search_sights",
    kind: "poi:sight",
    description:
      "检索景点：博物馆、公园、古迹、寺庙、自然景观、街区、艺术区、夜景等。返回坐标、开放时间、票价区间、来源与置信度。" +
      "取不到的条目会如实标 verified=false，必须写进行程单的 unconfirmed，不许用记忆补全。",
    fallbacks: ["博物馆", "公园", "古迹", "景点"],
    queryHint: "具体检索词，如「寺庙」「古城」「博物馆」「艺术区」"
  });

  const searchFood = makeSearchTool({
    name: "search_food",
    kind: "poi:food",
    description:
      "检索餐饮：餐厅、小吃、市集、早市、夜市、咖啡馆、特色菜、当地必吃。返回人均参考价、开放时间、来源与置信度。",
    fallbacks: ["餐厅", "小吃", "美食", "市集"],
    queryHint: "具体检索词，如「拉面」「早餐」「火锅」「市场」"
  });

  const searchLodging = makeSearchTool({
    name: "search_lodging",
    kind: "poi:stay",
    description:
      "检索住宿：酒店、民宿、客栈、青年旅舍以及可作为住宿区的街区线索。用于选住宿区域与核算住宿预算占比。",
    fallbacks: ["酒店", "民宿", "客栈", "旅馆"],
    queryHint: "具体检索词，如「酒店」「温泉旅馆」「民宿」"
  });

  const searchTransportHub = makeSearchTool({
    name: "search_transport_hub",
    kind: "poi:transport",
    description:
      "检索交通枢纽：机场、火车站、高铁站、客运站、码头、地铁站。用于安排到达、离开与接驳。",
    fallbacks: ["机场", "火车站", "地铁站", "客运站"],
    queryHint: "具体检索词，如「机场」「火车站」「国际航班」"
  });

  // ---- 天气 ----
  const getDailyWeather = tool(
    async ({ latitude, longitude, startDate, endDate }) => {
      const key = "get_daily_weather|" + latitude + "," + longitude + "|" + startDate + "," + endDate;
      const res = await deps.data.weather(latitude, longitude, startDate, endDate);
      recordFact("get_daily_weather", "weather", startDate + "→" + endDate, res);
      if (res.ok && res.data) {
        await saveSnapshot("get_daily_weather", key, res, res.data);
        return fmt(res);
      }
      const fb = await fallback("get_daily_weather", key, "天气数据不可用：" + (res.error ?? "未知错误"));
      return fb ?? fmt(res);
    },
    {
      name: "get_daily_weather",
      description:
        "查目的地逐日天气预报（最高/最低温、天气、降水概率、风速、日出日落）。" +
        "预报通常只覆盖未来约 16 天，超出范围会返回 unavailable —— 此时改写「出行前复核」，不要编天气。",
      schema: z.object({
        latitude: z.number().describe("纬度"),
        longitude: z.number().describe("经度"),
        startDate: z.string().describe("起始日期 YYYY-MM-DD"),
        endDate: z.string().describe("结束日期 YYYY-MM-DD")
      })
    }
  );

  // ---- 通勤时间/距离 ----
  const measureTravelTime = tool(
    async ({ fromPlace, fromLat, fromLon, toPlace, toLat, toLon, mode }) => {
      const m = mode ?? "driving";
      let fl = fromLat;
      let fo = fromLon;
      let tl = toLat;
      let to = toLon;
      let resolvedFrom = fromPlace ?? "";
      let resolvedTo = toPlace ?? "";

      if ((fl === undefined || fo === undefined) && fromPlace) {
        const g = await deps.data.geocode(fromPlace);
        recordFact("geocode_place", "geo", fromPlace, g);
        const hit = g.ok && g.data && g.data[0];
        if (hit) {
          fl = hit.lat;
          fo = hit.lon;
          resolvedFrom = hit.name;
        }
      }
      if ((tl === undefined || to === undefined) && toPlace) {
        const g = await deps.data.geocode(toPlace);
        recordFact("geocode_place", "geo", toPlace, g);
        const hit = g.ok && g.data && g.data[0];
        if (hit) {
          tl = hit.lat;
          to = hit.lon;
          resolvedTo = hit.name;
        }
      }
      if (fl === undefined || fo === undefined || tl === undefined || to === undefined) {
        return fmt({
          ok: false,
          availability: "unavailable",
          data: null,
          error: "起点或终点无法定位：给出地名（fromPlace/toPlace）或坐标（fromLat/fromLon/toLat/toLon）"
        });
      }

      const fromKey = fl.toFixed(4) + "," + fo.toFixed(4);
      const toKey = tl.toFixed(4) + "," + to.toFixed(4);
      const snapKey = fromKey + "->" + toKey + "|" + m;
      // 事实标签必须带上可核对的端点，否则审查员无法把路线对应回行程
      const routeLabel =
        (resolvedFrom || fromKey) + " → " + (resolvedTo || toKey);

      const cached = await repo?.getRoute(fromKey, toKey, m);
      if (cached) {
        const env = {
          ok: true,
          availability: "ok",
          data: {
            distanceMeters: Math.round(cached.distanceKm * 1000),
            durationMinutes: cached.durationMin,
            mode: m,
            estimated: false,
            source: "本地路线缓存 · " + cached.source,
            confidence: "medium"
          },
          provenance: {
            provider: "route_cache",
            source: "本地路线缓存（已落库，未再请求外网）",
            confidence: "medium",
            note: "缓存来源 " + cached.source
          }
        };
        recordFact("measure_travel_time", "route", routeLabel, env);
        return fmt(env);
      }

      const res = await deps.data.route(fl, fo, tl, to, m);
      recordFact("measure_travel_time", "route", routeLabel, res);
      if (res.ok && res.data) {
        await repo?.saveRoute({
          fromKey,
          toKey,
          mode: m,
          durationMin: res.data.durationMinutes,
          distanceKm: res.data.distanceMeters / 1000,
          source: res.data.source
        });
        await saveSnapshot("measure_travel_time", snapKey, res, res.data);
        return fmt(res);
      }
      const fb = await fallback("measure_travel_time", snapKey, "路线服务不可用：" + (res.error ?? "未知错误"));
      return fb ?? fmt(res);
    },
    {
      name: "measure_travel_time",
      description:
        "算两个点之间的通勤距离与耗时。排每天动线、验证地理连贯性、写 notes 里的通勤时间时必须用它核实，别拍脑袋写「车程 20 分钟」。" +
        "可以给地名（fromPlace/toPlace，会自动地理编码）或坐标（fromLat/fromLon/toLat/toLon）。",
      schema: z.object({
        fromPlace: z.string().optional().describe("起点地名，如「上海浦东国际机场」"),
        fromLat: z.number().optional(),
        fromLon: z.number().optional(),
        toPlace: z.string().optional().describe("终点地名，如「外滩」"),
        toLat: z.number().optional(),
        toLon: z.number().optional(),
        mode: z.enum(["walking", "driving", "cycling"]).optional().describe("默认 driving")
      })
    }
  );

  // ---- 国家档案 ----
  const getCountryProfile = tool(
    async ({ country }) => {
      const key = "get_country_profile|" + country;
      const res = await deps.data.countryFacts(country);
      recordFact("get_country_profile", "country", country, res);
      if (res.ok && res.data) {
        await saveSnapshot("get_country_profile", key, res, res.data);
        return fmt(res);
      }
      const fb = await fallback("get_country_profile", key, "国别信息不可用：" + (res.error ?? "未知错误"));
      return fb ?? fmt(res);
    },
    {
      name: "get_country_profile",
      description:
        "查目的地国家的货币、语言、时区、首都、驾驶方向。用于预算币种、行程时间安排与自驾注意事项。" +
        "RestCountries 不可用时会回退到「内置事实表（非 API）」，来源会如实标注。",
      schema: z.object({
        country: z.string().describe("国家名，中文或英文，如「法国」「Japan」")
      })
    }
  );

  // ---- 预算 ----
  const computeBudget = tool(
    async ({ lines, travelersCount, budgetTotal, currency }) => {
      const total = lines.reduce((acc, l) => acc + Number(l.amount || 0), 0);
      const byCategory: Record<string, number> = {};
      for (const l of lines) {
        byCategory[l.category] = (byCategory[l.category] ?? 0) + Number(l.amount || 0);
      }
      const perPerson = travelersCount > 0 ? Math.round((total / travelersCount) * 100) / 100 : 0;
      const delta = Math.round((total - budgetTotal) * 100) / 100;
      const warnings: string[] = [];
      if (delta > 0) warnings.push("超预算 " + delta + " " + currency + "，需要压缩或改期");
      if (byCategory.transport && byCategory.transport / (total || 1) > 0.35) {
        warnings.push("交通占比偏高，考虑调整城际交通方式");
      }
      if (byCategory.stay && byCategory.stay / (total || 1) > 0.5) {
        warnings.push("住宿占比超过 50%，住宿档次可能超出预算档位");
      }
      return fmt({
        ok: true,
        availability: "ok",
        total: Math.round(total * 100) / 100,
        byCategory,
        perPerson,
        planned: budgetTotal,
        delta,
        overBudget: delta > 0,
        warnings,
        note: "本工具只做汇总与告警，金额口径仍以 budget-estimation 技能为准"
      });
    },
    {
      name: "compute_budget",
      description:
        "汇总预算明细，算总额、人均、分类小计与和预算的差额，并给出占比告警。写完预算明细后调用，避免心算出错。",
      schema: z.object({
        lines: z
          .array(
            z.object({
              category: z.enum(["stay", "transport", "sight", "food", "other"]),
              label: z.string(),
              amount: z.number().nonnegative(),
              unit: z.string().optional(),
              confidence: z.enum(["high", "medium", "low"]).optional()
            })
          )
          .describe("预算明细行"),
        travelersCount: z.number().int().positive(),
        budgetTotal: z.number().nonnegative(),
        currency: z.string().default("CNY")
      })
    }
  );

  // ---- 本地替代方案 ----
  const findLocalAlternative = tool(
    async ({ city, query, referenceName, referenceLat, referenceLon, limit }) => {
      const n = limit ?? 8;
      const q = (query ?? "").trim() || "景点";
      const key = "find_local_alternative|" + (city ?? "") + "|" + q;
      const { res, usedQuery } = await searchWithFallback(q, city, n, ["博物馆", "公园", "古迹", "景点"]);
      recordFact("find_local_alternative", "alternative", q + "@" + (city ?? ""), res);
      if (!res.ok || !res.data) {
        const fb = await fallback("find_local_alternative", key, "本地替代检索不可用：" + (res.error ?? "未知错误"));
        return fb ?? fmt(res);
      }
      let refLat = referenceLat;
      let refLon = referenceLon;
      let refName = referenceName ?? "";
      if ((refLat === undefined || refLon === undefined) && referenceName) {
        const g = await deps.data.geocode(referenceName);
        recordFact("geocode_place", "geo", referenceName, g);
        const hit = g.ok && g.data && g.data[0];
        if (hit) {
          refLat = hit.lat;
          refLon = hit.lon;
          refName = hit.name;
        }
      }
      const items = res.data.map((p) => {
        const base: Record<string, unknown> = {
          name: p.name,
          city: p.city,
          category: p.category,
          lat: p.lat,
          lon: p.lon,
          openingHours: p.openingHours,
          ticketRange: p.ticketRange,
          avgCost: p.avgCost,
          source: p.source,
          confidence: p.confidence,
          verified: p.verified
        };
        if (refLat !== undefined && refLon !== undefined) {
          const meters = haversineMeters(refLat, refLon, p.lat, p.lon);
          base.distanceToReferenceMeters = Math.round(meters);
          base.estimatedTravelMinutes = Math.max(1, Math.round((meters / 1000 / 30) * 60));
        }
        return base;
      });
      await repo?.upsertPlaces(res.data.map((c) => toStoredPlace(c, res.provenance.fetchedAt)));
      await saveSnapshot("find_local_alternative", key, res, res.data);
      return fmt({
        ok: true,
        availability: res.availability,
        data: items,
        provenance: {
          provider: res.provenance.provider,
          source: res.provenance.source,
          confidence: res.provenance.confidence,
          fetchedAt: res.provenance.fetchedAt,
          note: "本地替代候选（" + (city ?? "") + "）：用于与跨城方案做成本/耗时/体验对照"
        },
        reference: refName || null,
        usedQuery
      });
    },
    {
      name: "find_local_alternative",
      description:
        "在同一城市里找体验等价的替代点位（与远方目的地做性价比对照）。" +
        "跨城决策前必须用它拿到本地替代的真实点位与距离，然后写进 itinerary.json 的 alternatives。" +
        "给了参照点坐标/名称时，会附带与参照点的直线距离与估算车程。",
      schema: z.object({
        city: z.string().describe("本地城市（如用户从上海出发，跨城目的地是京都时，本地城市填「上海」）"),
        query: z.string().describe("体验主题，如「寺庙」「历史街区」「美术馆」"),
        referenceName: z.string().optional().describe("参照点（远方目的地那个体验点）名称"),
        referenceLat: z.number().optional(),
        referenceLon: z.number().optional(),
        limit: z.number().int().min(1).max(25).optional()
      })
    }
  );

  // ---- 审查关卡 ----
  const readReport = (): (ReviewReport & { round: number; planHash: string }) | null => {
    const raw = deps.workspace.read("review/report.json");
    if (!raw) return null;
    try {
      return JSON.parse(raw) as ReviewReport & { round: number; planHash: string };
    } catch {
      return null;
    }
  };

  const reviewItinerary = tool(
    async () => {
      const raw = deps.workspace.read("itinerary.json");
      if (!raw) {
        return fmt({
          ok: false,
          error: "工作区里还没有 itinerary.json —— 先用 write_file 写出 /itinerary.json 再来审查"
        });
      }
      let plan: unknown;
      try {
        plan = JSON.parse(raw);
      } catch (err) {
        return fmt({ ok: false, error: "itinerary.json 不是合法 JSON：" + String(err) });
      }
      if (!deps.reviewer) {
        return fmt({ ok: false, error: "审查器未配置，无法执行审查关卡" });
      }
      const hash = planHash(raw);
      const prev = readReport();
      const round = (prev?.round ?? 0) + 1;
      const report = await deps.reviewer({
        plan,
        planHash: hash,
        round,
        facts,
        requirements: deps.requirements ?? {
          destination: "（未知）",
          startDate: "",
          endDate: "",
          travelers: 1,
          budgetTotal: 0,
          currency: "CNY"
        }
      });
      const payload = {
        ...report,
        round,
        planHash: hash,
        at: new Date().toISOString()
      };
      deps.workspace.write("review/report.json", JSON.stringify(payload, null, 2));
      return fmt({
        ok: true,
        approved: report.approved,
        round,
        summary: report.summary,
        scores: report.scores,
        blocking: report.blocking,
        warnings: report.warnings,
        localAlternatives: report.localAlternatives,
        next: report.approved
          ? "审查通过：把 blocking 都改掉后调用 submit_itinerary"
          : "有 blocking 问题：逐条修改 /itinerary.json（用 edit_file），改完重新调用 review_itinerary"
      });
    },
    {
      name: "review_itinerary",
      description:
        "**强制关卡**：读 /itinerary.json 与本次取数的事实包，对照需求做 LLM 审查（需求匹配度 / 时间线与地理自洽 / 性价比 / 来源可信度），" +
        "输出结构化问题清单与本地替代建议。submit_itinerary 之前必须先通过它；改稿后必须重新审查（报告带 planHash）。" +
        "最多 3 轮。"
    }
  );

  const submitItinerary = tool(
    async () => {
      const raw = deps.workspace.read("itinerary.json");
      if (!raw) {
        return fmt({
          ok: false,
          error: "工作区里还没有 itinerary.json —— 先用 write_file 写出 /itinerary.json 再来校验"
        });
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        return fmt({ ok: false, error: "itinerary.json 不是合法 JSON：" + String(err) });
      }
      const issues = validatePlan(parsed);

      // 审查门禁：没有通过审查的行程单不许提交
      const gate: string[] = [];
      const report = readReport();
      const hash = planHash(raw);
      if (!report) {
        gate.push("尚未审查：先调用 review_itinerary，通过后再提交");
      } else {
        if (report.planHash !== hash) {
          gate.push("行程单已改稿但没有重新审查（报告 planHash 与当前 itinerary.json 不一致）—— 请再调一次 review_itinerary");
        }
        if (!report.approved) {
          gate.push(
            "审查未通过：还有 " +
              report.blocking.length +
              " 个 blocking 问题（" +
              report.blocking.map((b) => b.title).join("；") +
              "）"
          );
        }
        if (report.round > 3 && !report.approved) {
          gate.push("审查轮次已超过 3 轮上限（第 " + report.round + " 轮）仍有问题 —— 请收敛问题，别再打回重排");
        }
      }

      if (issues.length > 0 || gate.length > 0) {
        return fmt({
          ok: false,
          error: issues.length > 0 ? "校验未通过，请逐条修复后重新提交" : "审查关卡未通过，请先解决审查问题",
          issues,
          gate
        });
      }
      const plan = parsed as {
        days: unknown[];
        budget: { total: number; planned: number; delta: number };
      };
      if (repo && tripId) {
        await repo.saveArtifact(tripId, "itinerary.json", raw);
      }
      return fmt({
        ok: true,
        error: null,
        summary: {
          days: plan.days.length,
          total: plan.budget.total,
          planned: plan.budget.planned,
          delta: plan.budget.delta,
          overBudget: plan.budget.delta > 0,
          reviewRound: report?.round ?? 0,
          reviewScores: report?.scores ?? null
        },
        next: "现在调用 finalize_itinerary 提交人工确认"
      });
    },
    {
      name: "submit_itinerary",
      description:
        "对工作区里的 /itinerary.json 做机器校验（天数、日期连续性、预算一致性、来源与未确认项、时间单调、地理连贯、城市轨迹、跨城本地替代），" +
        "并检查审查关卡是否通过。返回 issues 就必须改到通过再提交；这是定稿前的强制关卡。"
    }
  );

  const finalizeItinerary = tool(
    async ({ summary, details }) => {
      deps.workspace.write(
        "approved.json",
        JSON.stringify({ summary, details, at: new Date().toISOString() }, null, 2)
      );
      deps.onApproved?.(summary);
      return fmt({
        ok: true,
        error: null,
        message: "已定稿。产物文件可在产物区下载。",
        summary,
        details
      });
    },
    {
      name: "finalize_itinerary",
      description:
        "提交行程定稿。这个调用会挂起等待人工放行 —— 放行前不要宣称行程已完成。" +
        "调用前必须已经通过 submit_itinerary 校验。",
      schema: z.object({
        summary: z.string().describe("3-5 行定稿摘要：行程主线、天数、预算差额、最需要确认的点"),
        details: z.array(z.string()).describe("需要人工确认的要点，逐条")
      })
    }
  );

  return [
    geocodePlace,
    searchSights,
    searchFood,
    searchLodging,
    searchTransportHub,
    getDailyWeather,
    measureTravelTime,
    getCountryProfile,
    computeBudget,
    findLocalAlternative,
    reviewItinerary,
    submitItinerary,
    finalizeItinerary
  ];
}

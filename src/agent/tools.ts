import { tool } from "langchain";
import { z } from "zod";
import type { TravelData } from "../data/providers.ts";
import type { TripWorkspace } from "../core/trips.ts";
import type { TripRepository } from "../core/persist.ts";
import { toCandidate, toStoredPlace } from "../core/persist.ts";
import { validatePlan } from "../core/schema.ts";

export interface ToolDeps {
  data: TravelData;
  workspace: TripWorkspace;
  /** 外部取数落库仓储（无 PG 时为 null） */
  repo?: TripRepository | null;
  /** 当前行程 id，用于把取数快照关联到行程 */
  tripId?: string | null;
  /** HITL 放行后回调：定稿落盘 + 行程状态置为 approved */
  onApproved?: (summary: string) => void;
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
 * 工具层的统一取数策略（三段式）：
 *   1. 本地优先 —— 落过库的数据直接用，不重复打外网
 *   2. 取到即落库 —— 每次外部取数都写快照，附来源/时间/置信度
 *   3. 存档兜底 —— 外网挂掉时用最近一次存档返回，并如实标注「存档 + 多久之前 + 置信度下调」
 * 这样即使实时源限流、抖动、宕机，行程也不会开天窗。
 */
export function createTools(deps: ToolDeps) {
  const repo = deps.repo ?? null;
  const tripId = deps.tripId ?? null;

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

  const geocode = tool(
    async ({ name }) => {
      const key = "geocode|" + name;
      const res = await deps.data.geocode(name);
      if (res.ok && res.data) {
        await saveSnapshot("geocode", key, res, res.data);
        return fmt(res);
      }
      const fb = await fallback("geocode", key, "地理编码不可用：" + (res.error ?? "未知错误"));
      return fb ?? fmt(res);
    },
    {
      name: "geocode",
      description:
        "把地名/景点名解析成坐标与行政区信息。查天气、算通勤、做点位安排前先调用它定位。返回带 source 与 fetchedAt。",
      schema: z.object({
        name: z.string().describe("地名，如「巴黎」「慕田峪长城」")
      })
    }
  );

  const searchPlaces = tool(
    async ({ query, city, limit }) => {
      const n = limit ?? 8;
      const key = "search_places|" + (city ?? "") + "|" + query;

      const local = (await repo?.findPlaces(query, city, n)) ?? [];
      if (local.length > 0) {
        return fmt({
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
        });
      }

      const res = await deps.data.searchPlaces(query, city, n);
      if (res.ok && res.data) {
        const fetchedAt = res.provenance.fetchedAt;
        await repo?.upsertPlaces(res.data.map((c) => toStoredPlace(c, fetchedAt)));
        await saveSnapshot("search_places", key, res, res.data);
        return fmt(res);
      }
      const fb = await fallback("search_places", key, "POI 检索不可用：" + (res.error ?? "未知错误"));
      return fb ?? fmt(res);
    },
    {
      name: "search_places",
      description:
        "按名称/类别检索景点、餐厅、酒店、市集等地点。返回坐标、开放时间、票价区间、来源与置信度。" +
        "优先使用已落库的本地地点库；本地没有才会实时查询并把结果落库。" +
        "完全取不到时会返回存档兜底结果（availability=degraded，来源标注为存档）。",
      schema: z.object({
        query: z.string().describe("检索词，如「博物馆」「拉面」「798 艺术区」"),
        city: z.string().optional().describe("城市名，用于限定范围，如「北京」"),
        limit: z.number().int().min(1).max(25).optional().describe("返回条数，默认 8")
      })
    }
  );

  const getWeather = tool(
    async ({ latitude, longitude, startDate, endDate }) => {
      const key = "get_weather|" + latitude + "," + longitude + "|" + startDate + "," + endDate;
      const res = await deps.data.weather(latitude, longitude, startDate, endDate);
      if (res.ok && res.data) {
        await saveSnapshot("get_weather", key, res, res.data);
        return fmt(res);
      }
      const fb = await fallback("get_weather", key, "天气数据不可用：" + (res.error ?? "未知错误"));
      return fb ?? fmt(res);
    },
    {
      name: "get_weather",
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

  const getRoute = tool(
    async ({ fromLat, fromLon, toLat, toLon, mode }) => {
      const m = mode ?? "driving";
      const fromKey = fromLat.toFixed(4) + "," + fromLon.toFixed(4);
      const toKey = toLat.toFixed(4) + "," + toLon.toFixed(4);
      const snapKey = fromKey + "->" + toKey + "|" + m;

      const cached = await repo?.getRoute(fromKey, toKey, m);
      if (cached) {
        return fmt({
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
        });
      }

      const res = await deps.data.route(fromLat, fromLon, toLat, toLon, m);
      if (res.ok && res.data) {
        await repo?.saveRoute({
          fromKey,
          toKey,
          mode: m,
          durationMin: res.data.durationMinutes,
          distanceKm: res.data.distanceMeters / 1000,
          source: res.data.source
        });
        await saveSnapshot("get_route", snapKey, res, res.data);
        return fmt(res);
      }
      const fb = await fallback("get_route", snapKey, "路线服务不可用：" + (res.error ?? "未知错误"));
      return fb ?? fmt(res);
    },
    {
      name: "get_route",
      description:
        "算两个坐标之间的通勤距离与耗时。排每天动线、算住宿区可达性时必须用它核实，别拍脑袋写「车程 20 分钟」。" +
        "优先使用本地路线缓存，缓存没有才实时查询并落库。",
      schema: z.object({
        fromLat: z.number(),
        fromLon: z.number(),
        toLat: z.number(),
        toLon: z.number(),
        mode: z.enum(["walking", "driving", "cycling"]).optional().describe("默认 driving")
      })
    }
  );

  const getCountryFacts = tool(
    async ({ country }) => {
      const key = "get_country_facts|" + country;
      const res = await deps.data.countryFacts(country);
      if (res.ok && res.data) {
        await saveSnapshot("get_country_facts", key, res, res.data);
        return fmt(res);
      }
      const fb = await fallback("get_country_facts", key, "国别信息不可用：" + (res.error ?? "未知错误"));
      return fb ?? fmt(res);
    },
    {
      name: "get_country_facts",
      description:
        "查目的地国家的货币、语言、时区、首都、驾驶方向。用于预算币种、行程时间安排与自驾注意事项。",
      schema: z.object({
        country: z.string().describe("国家名，中文或英文，如「法国」")
      })
    }
  );

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
      if (issues.length > 0) {
        return fmt({
          ok: false,
          error: "校验未通过，请逐条修复后重新提交",
          issues
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
          overBudget: plan.budget.delta > 0
        },
        next: "现在调用 finalize_itinerary 提交人工确认"
      });
    },
    {
      name: "submit_itinerary",
      description:
        "对工作区里的 /itinerary.json 做机器校验（天数、日期连续性、预算一致性、来源与未确认项）。" +
        "返回 issues 就必须改到通过再提交；这是定稿前的强制关卡。"
    }
  );

  const finalizeItinerary = tool(
    async ({ summary, details }) => {
      deps.workspace.write("approved.json", JSON.stringify({ summary, details, at: new Date().toISOString() }, null, 2));
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
    geocode,
    searchPlaces,
    getWeather,
    getRoute,
    getCountryFacts,
    computeBudget,
    submitItinerary,
    finalizeItinerary
  ];
}

import { tool } from "langchain";
import { z } from "zod";
import type { TravelData } from "../data/providers.ts";
import type { TripWorkspace } from "../core/trips.ts";
import { validatePlan } from "../core/schema.ts";

export interface ToolDeps {
  data: TravelData;
  workspace: TripWorkspace;
  /** HITL 放行后回调：定稿落盘 + 行程状态置为 approved */
  onApproved?: (summary: string) => void;
}

function fmt(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function createTools(deps: ToolDeps) {
  const geocode = tool(
    async ({ name }) => {
      const res = await deps.data.geocode(name);
      return fmt(res);
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
      const res = await deps.data.searchPlaces(query, city, limit ?? 8);
      return fmt(res);
    },
    {
      name: "search_places",
      description:
        "按名称/类别检索景点、餐厅、酒店、市集等地点。返回坐标、开放时间、票价区间、来源与置信度。" +
        "找不到时返回 availability=unavailable —— 此时必须把相关结论标为未确认，不得凭记忆补。",
      schema: z.object({
        query: z.string().describe("检索词，如「博物馆」「拉面」「798 艺术区」"),
        city: z.string().optional().describe("城市名，用于限定范围，如「北京」"),
        limit: z.number().int().min(1).max(25).optional().describe("返回条数，默认 8")
      })
    }
  );

  const getWeather = tool(
    async ({ latitude, longitude, startDate, endDate }) => {
      const res = await deps.data.weather(latitude, longitude, startDate, endDate);
      return fmt(res);
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
      const res = await deps.data.route(fromLat, fromLon, toLat, toLon, mode ?? "driving");
      return fmt(res);
    },
    {
      name: "get_route",
      description:
        "算两个坐标之间的通勤距离与耗时。排每天动线、算住宿区可达性时必须用它核实，别拍脑袋写「车程 20 分钟」。",
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
      const res = await deps.data.countryFacts(country);
      return fmt(res);
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
      if (delta > 0) warnings.push(`超预算 ${delta} ${currency}，需要压缩或改期`);
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
      const plan = parsed as { days: unknown[]; budget: { total: number; planned: number; delta: number } };
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

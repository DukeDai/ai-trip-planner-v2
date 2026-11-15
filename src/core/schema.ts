import crypto from "node:crypto";
import { z } from "zod";

export const ActivitySchema = z.object({
  time: z.string().min(1, "time 不能为空"),
  title: z.string().min(1, "title 不能为空"),
  type: z.enum(["sight", "food", "transport", "stay", "free"]),
  location: z.string().default(""),
  durationMin: z.number().int().nonnegative(),
  costPerPerson: z.number().nonnegative(),
  costTotal: z.number().nonnegative(),
  costBasis: z.enum(["per_person", "per_group"]).optional(),
  notes: z.string().default(""),
  source: z.string().min(1, "source 不能为空：每个条目都必须写清数据来自哪里"),
  fetchedAt: z.string().min(1),
  confidence: z.enum(["high", "medium", "low"]),
  needsBooking: z.boolean(),
  bookingLeadDays: z.number().int().nonnegative().optional(),
  verified: z.boolean(),
  /** 第二轮：所在城市（城市名，如「上海」/「京都」），用于城市轨迹校验 */
  city: z.string().optional(),
  /** 第二轮：坐标，用于相邻点位地理连贯性校验 */
  lat: z.number().optional(),
  lon: z.number().optional(),
  /** 第二轮：仅 transport 类，跨城移动起点 */
  fromCity: z.string().optional(),
  /** 第二轮：仅 transport 类，跨城移动终点 */
  toCity: z.string().optional()
});

export const DaySchema = z.object({
  day: z.number().int().positive(),
  date: z.string().min(1),
  theme: z.string().default(""),
  totalCost: z.number().nonnegative(),
  activities: z.array(ActivitySchema).min(1, "每天至少一个条目")
});

export const BudgetLineSchema = z.object({
  category: z.enum(["stay", "transport", "sight", "food", "other"]),
  label: z.string().min(1),
  amount: z.number().nonnegative(),
  unit: z.string().default(""),
  confidence: z.enum(["high", "medium", "low"])
});

/** 第二轮：跨城/远距离决策的本地替代对比 */
export const AlternativeSchema = z.object({
  decision: z.string().min(1, "decision 不能为空"),
  fromCity: z.string().min(1, "fromCity 不能为空"),
  toCity: z.string().min(1, "toCity 不能为空"),
  chosen: z.string().min(1, "chosen 不能为空：采用方案"),
  localAlternative: z.string().min(1, "localAlternative 不能为空：必须给出本地替代方案"),
  chosenCost: z.number().nonnegative(),
  localCost: z.number().nonnegative(),
  costDelta: z.number(),
  chosenTime: z.string().min(1, "chosenTime 不能为空：跨城方案耗时"),
  localTime: z.string().min(1, "localTime 不能为空：本地替代耗时"),
  experienceGain: z.string().min(1, "experienceGain 不能为空：体验维度对照"),
  recommendation: z.enum(["keep", "downgrade", "switch"]),
  rationale: z.string().min(1, "rationale 不能为空：结论依据")
});

export const PlanSchema = z.object({
  tripId: z.string().min(1),
  /** 第二轮：出发城市。跨城与城市轨迹校验的起点 */
  origin: z.string().optional(),
  destination: z.string().min(1),
  startDate: z.string().min(1),
  endDate: z.string().min(1),
  travelers: z.object({
    count: z.number().int().positive(),
    budgetTotal: z.number().nonnegative(),
    currency: z.string().min(1)
  }),
  days: z.array(DaySchema).min(1),
  budget: z.object({
    lines: z.array(BudgetLineSchema),
    total: z.number(),
    planned: z.number(),
    delta: z.number()
  }),
  risks: z.array(
    z.object({
      level: z.enum(["high", "medium", "low"]),
      title: z.string(),
      mitigation: z.string()
    })
  ),
  unconfirmed: z.array(
    z.object({
      item: z.string(),
      reason: z.string(),
      howToVerify: z.string()
    })
  ),
  /** 第二轮：跨城决策的本地替代对比 */
  alternatives: z.array(AlternativeSchema).optional()
});

export type PlanValidationIssue = { path: string; message: string };

const EPS = 0.51;

/** 相邻点位直线距离阈值（km）：超过即认为缺少交通衔接 */
const GEO_JUMP_KM = 80;

/** 跨城成本超过本地替代这个倍数时，必须在 risks 里给出降级建议 */
const COST_RATIO_NEEDS_RISK = 1.5;

function daysBetween(start: string, end: string): number | null {
  const a = Date.parse(start + "T00:00:00Z");
  const b = Date.parse(end + "T00:00:00Z");
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86_400_000) + 1;
}

/** HH:mm → 当日分钟数；格式非法返回 null */
export function parseClock(t: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t ?? "").trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(mi) || h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

/** 两点直线距离（km） */
export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** 城市名宽松相等：去空白、去「市」后缀，包含关系也算同一个城市 */
export function sameCity(a: string | undefined, b: string | undefined): boolean {
  const norm = (s: string | undefined): string =>
    String(s ?? "").trim().replace(/[市\s]/g, "");
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  return x.includes(y) || y.includes(x);
}

/** 行程单内容哈希：审查报告必须与当前 itinerary.json 对得上 */
export function planHash(raw: string): string {
  return crypto.createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 16);
}

/** 行程里出现的跨城移动（去重） */
export function detectCrossCityTransfers(
  plan: { days: { day: number; activities: { title: string; type: string; fromCity?: string; toCity?: string }[] }[] }
): { fromCity: string; toCity: string; day: number; title: string }[] {
  const seen = new Map<string, { fromCity: string; toCity: string; day: number; title: string }>();
  for (const day of plan.days ?? []) {
    for (const a of day.activities ?? []) {
      if (a.type !== "transport") continue;
      const from = (a.fromCity ?? "").trim();
      const to = (a.toCity ?? "").trim();
      if (!from || !to) continue;
      if (sameCity(from, to)) continue;
      const key = from + "→" + to;
      if (!seen.has(key)) seen.set(key, { fromCity: from, toCity: to, day: day.day, title: a.title });
    }
  }
  return [...seen.values()];
}

/**
 * 行程数据一致性 + 行程合理性校验。SPEC §10 与 §15.2 A 的全部规则都在这里。
 * 返回 issues 列表；空数组 = 通过。
 */
export function validatePlan(input: unknown): PlanValidationIssue[] {
  const issues: PlanValidationIssue[] = [];
  const parsed = PlanSchema.safeParse(input);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      issues.push({
        path: issue.path.join(".") || "(root)",
        message: issue.message
      });
    }
    return issues;
  }
  const plan = parsed.data;

  const expectedDays = daysBetween(plan.startDate, plan.endDate);
  if (expectedDays === null) {
    issues.push({ path: "startDate/endDate", message: "日期无法解析，必须是 YYYY-MM-DD" });
  } else if (plan.days.length !== expectedDays) {
    issues.push({
      path: "days",
      message: `天数与日期区间不符：${plan.startDate} → ${plan.endDate} 应有 ${expectedDays} 天，实际 ${plan.days.length} 天`
    });
  }

  plan.days.forEach((day, idx) => {
    const daySum = day.activities.reduce((acc, a) => acc + a.costTotal, 0);
    if (Math.abs(daySum - day.totalCost) > EPS) {
      issues.push({
        path: `days.${idx}.totalCost`,
        message: `第 ${day.day} 天小计错误：条目合计 ${round2(daySum)} ≠ totalCost ${round2(day.totalCost)}`
      });
    }
    const expectedDate = addDays(plan.startDate, idx);
    if (expectedDate && day.date !== expectedDate) {
      issues.push({
        path: `days.${idx}.date`,
        message: `第 ${day.day} 天日期应为 ${expectedDate}，实际 ${day.date}`
      });
    }
    day.activities.forEach((a, aidx) => {
      if ((a.costBasis ?? "per_person") === "per_person") {
        const expect = a.costPerPerson * plan.travelers.count;
        if (Math.abs(expect - a.costTotal) > EPS) {
          issues.push({
            path: `days.${idx}.activities.${aidx}.costTotal`,
            message: `「${a.title}」单人价 × ${plan.travelers.count} 人 = ${round2(expect)}，与 costTotal ${round2(a.costTotal)} 不符（若为全团费用请设 costBasis="per_group"）`
          });
        }
      }
      if (a.needsBooking && a.bookingLeadDays === undefined) {
        issues.push({
          path: `days.${idx}.activities.${aidx}.bookingLeadDays`,
          message: `「${a.title}」标记为需预订时必须给出 bookingLeadDays`
        });
      }
    });
  });

  const linesSum = plan.budget.lines.reduce((acc, l) => acc + l.amount, 0);
  if (Math.abs(linesSum - plan.budget.total) > EPS) {
    issues.push({
      path: "budget.total",
      message: `预算合计错误：明细合计 ${round2(linesSum)} ≠ total ${round2(plan.budget.total)}`
    });
  }
  const daysSum = plan.days.reduce((acc, d) => acc + d.totalCost, 0);
  if (Math.abs(daysSum - plan.budget.total) > EPS) {
    issues.push({
      path: "budget.total",
      message: `预算合计与行程条目不一致：行程合计 ${round2(daysSum)} ≠ budget.total ${round2(plan.budget.total)}`
    });
  }
  const expectDelta = plan.budget.total - plan.budget.planned;
  if (Math.abs(expectDelta - plan.budget.delta) > EPS) {
    issues.push({
      path: "budget.delta",
      message: `预算差额错误：total - planned = ${round2(expectDelta)}，与 delta ${round2(plan.budget.delta)} 不符`
    });
  }
  if (plan.budget.planned !== plan.travelers.budgetTotal) {
    issues.push({
      path: "budget.planned",
      message: `budget.planned 必须等于 travelers.budgetTotal（${plan.travelers.budgetTotal}）`
    });
  }

  for (const day of plan.days) {
    for (const a of day.activities) {
      if (a.verified) continue;
      const covered = plan.unconfirmed.some(
        (u) => u.item.includes(a.title) || a.title.includes(u.item) || a.location.includes(u.item)
      );
      if (!covered) {
        issues.push({
          path: "unconfirmed",
          message: `「${a.title}」标记 verified=false，但未出现在 unconfirmed 清单里`
        });
      }
    }
  }

  // ---- 第二轮：行程合理性（§15.2 A） ----
  issues.push(...validateTimeMonotonic(plan));
  issues.push(...validateGeoContinuity(plan));
  const cityCheck = validateCityTrack(plan);
  issues.push(...cityCheck.issues);
  issues.push(...validateLocalAlternatives(plan, cityCheck.crossCity));

  return issues;
}

/** 规则 7：每天条目时间单调不减 */
function validateTimeMonotonic(plan: z.infer<typeof PlanSchema>): PlanValidationIssue[] {
  const issues: PlanValidationIssue[] = [];
  plan.days.forEach((day, idx) => {
    let prev: number | null = null;
    let prevTitle = "";
    day.activities.forEach((a, aidx) => {
      const t = parseClock(a.time);
      if (t === null) {
        issues.push({
          path: `days.${idx}.activities.${aidx}.time`,
          message: `第 ${day.day} 天「${a.title}」的时间「${a.time}」格式非法，必须是 HH:mm`
        });
        return;
      }
      if (prev !== null && t < prev) {
        issues.push({
          path: `days.${idx}.activities.${aidx}.time`,
          message: `第 ${day.day} 天时间倒退：「${a.title}」${a.time} 早于上一条「${prevTitle}」`
        });
      }
      if (prev === null || t > prev) {
        prev = t;
        prevTitle = a.title;
      }
    });
  });
  return issues;
}

/** 规则 8：同一天相邻点位的地理连贯性（距离突变 = 缺交通衔接） */
function validateGeoContinuity(plan: z.infer<typeof PlanSchema>): PlanValidationIssue[] {
  const issues: PlanValidationIssue[] = [];
  plan.days.forEach((day, idx) => {
    day.activities.forEach((a, aidx) => {
      if (aidx === 0) return;
      const prev = day.activities[aidx - 1];
      if (prev.type === "transport" || a.type === "transport") return;
      if (prev.lat == null || prev.lon == null || a.lat == null || a.lon == null) return;
      const km = haversineKm(prev.lat, prev.lon, a.lat, a.lon);
      if (km > GEO_JUMP_KM) {
        issues.push({
          path: `days.${idx}.activities.${aidx}.lat`,
          message: `第 ${day.day} 天地理跳变：「${prev.title}」→「${a.title}」直线距离约 ${km.toFixed(0)} km（阈值 ${GEO_JUMP_KM} km），中间缺少交通条目衔接`
        });
      }
    });
  });
  return issues;
}

/**
 * 规则 9/10/11：城市轨迹。
 * - 起点是 origin，按时间顺序推进「当前所在城市」
 * - 城市变化只能由 type=transport 且带 fromCity/toCity 的条目产生（规则 10）
 * - 任何非交通条目的 city 必须等于当前所在城市（规则 9/11：落地前不能排目的地活动）
 */
export function validateCityTrack(plan: z.infer<typeof PlanSchema>): {
  issues: PlanValidationIssue[];
  crossCity: { fromCity: string; toCity: string; day: number; title: string }[];
} {
  const issues: PlanValidationIssue[] = [];
  const origin = (plan.origin ?? "").trim();
  if (!origin) {
    issues.push({
      path: "origin",
      message: "缺少 origin（出发城市）—— 跨城与城市轨迹校验依赖它，必须写明从哪里出发"
    });
  }
  let currentCity = origin || "";
  const crossCity = detectCrossCityTransfers(plan as never);

  plan.days.forEach((day, idx) => {
    day.activities.forEach((a, aidx) => {
      const path = `days.${idx}.activities.${aidx}`;
      const actCity = (a.city ?? "").trim();
      const from = (a.fromCity ?? "").trim();
      const to = (a.toCity ?? "").trim();

      if (a.type === "transport" && from && to) {
        if (currentCity && !sameCity(from, currentCity)) {
          issues.push({
            path: path + ".fromCity",
            message: `第 ${day.day} 天「${a.title}」的跨城起点是「${from}」，但按行程顺序人此时在「${currentCity}」—— 跨城移动必须从当前所在城市出发`
          });
        }
        currentCity = to;
        return;
      }

      if (!actCity) {
        issues.push({
          path: path + ".city",
          message: `第 ${day.day} 天「${a.title}」缺少 city —— 必须填**城市名**（如「上海」「京都」），不是区域名（如「外滩」），否则无法校验城市归属`
        });
        return;
      }
      if (!currentCity) return;
      if (!sameCity(actCity, currentCity)) {
        issues.push({
          path: path + ".city",
          message: `第 ${day.day} 天「${a.title}」在「${actCity}」，但按时间顺序此时人还在「${currentCity}」—— 落地前不能排目的地活动；跨城移动必须显式写成 type=transport 且带 fromCity/toCity 的条目`
        });
      }
    });
  });

  return { issues, crossCity };
}

/**
 * 规则 12：本地替代硬规则。
 * 出现跨城就必须给出「本地替代方案」的成本 / 耗时 / 体验对照与结论；
 * 成本显著高于本地替代时，还必须在 risks 里给出降级建议。
 */
function validateLocalAlternatives(
  plan: z.infer<typeof PlanSchema>,
  crossCity: { fromCity: string; toCity: string; day: number; title: string }[]
): PlanValidationIssue[] {
  const issues: PlanValidationIssue[] = [];
  const alts = plan.alternatives ?? [];

  alts.forEach((alt, i) => {
    const expectDelta = round2(alt.chosenCost - alt.localCost);
    if (Math.abs(expectDelta - round2(alt.costDelta)) > EPS) {
      issues.push({
        path: `alternatives.${i}.costDelta`,
        message: `「${alt.fromCity} → ${alt.toCity}」成本差写错：chosenCost - localCost = ${expectDelta}，与 costDelta ${round2(alt.costDelta)} 不符`
      });
    }
    if (!alt.localAlternative.trim()) {
      issues.push({
        path: `alternatives.${i}.localAlternative`,
        message: `「${alt.fromCity} → ${alt.toCity}」缺少本地替代方案描述`
      });
    }
    if (!alt.experienceGain.trim()) {
      issues.push({
        path: `alternatives.${i}.experienceGain`,
        message: `「${alt.fromCity} → ${alt.toCity}」缺少体验维度对照（跨城换来的是什么体验上的差别）`
      });
    }
    if (!alt.rationale.trim()) {
      issues.push({
        path: `alternatives.${i}.rationale`,
        message: `「${alt.fromCity} → ${alt.toCity}」缺少结论依据 rationale`
      });
    }
  });

  for (const cc of crossCity) {
    const alt = alts.find((a) => sameCity(a.fromCity, cc.fromCity) && sameCity(a.toCity, cc.toCity));
    if (!alt) {
      issues.push({
        path: "alternatives",
        message: `跨城「${cc.fromCity} → ${cc.toCity}」（第 ${cc.day} 天「${cc.title}」）缺少本地替代方案对比：alternatives 里必须有 fromCity="${cc.fromCity}"、toCity="${cc.toCity}" 的条目，写清本地替代 / 成本差 / 耗时 / 体验 / 结论`
      });
      continue;
    }
    if (alt.localCost > 0 && alt.chosenCost > alt.localCost * COST_RATIO_NEEDS_RISK) {
      const mentioned = plan.risks.some((r) =>
        (r.title + " " + r.mitigation).includes(cc.toCity) ||
        (r.title + " " + r.mitigation).includes(cc.fromCity)
      );
      if (!mentioned) {
        issues.push({
          path: "alternatives",
          message: `跨城「${cc.fromCity} → ${cc.toCity}」成本是本地替代的 ${(alt.chosenCost / alt.localCost).toFixed(1)} 倍，必须在 risks 里给出降级建议（条目里提到「${cc.toCity}」或「${cc.fromCity}」）`
        });
      }
    }
  }

  return issues;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function addDays(date: string, days: number): string | null {
  const t = Date.parse(date + "T00:00:00Z");
  if (Number.isNaN(t)) return null;
  return new Date(t + days * 86_400_000).toISOString().slice(0, 10);
}

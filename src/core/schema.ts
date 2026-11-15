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
});

export const DaySchema = z.object({
  day: z.number().int().positive(),
  date: z.string().min(1),
  theme: z.string().default(""),
  totalCost: z.number().nonnegative(),
  activities: z.array(ActivitySchema).min(1, "每天至少一个条目"),
});

export const BudgetLineSchema = z.object({
  category: z.enum(["stay", "transport", "sight", "food", "other"]),
  label: z.string().min(1),
  amount: z.number().nonnegative(),
  unit: z.string().default(""),
  confidence: z.enum(["high", "medium", "low"]),
});

export const PlanSchema = z.object({
  tripId: z.string().min(1),
  destination: z.string().min(1),
  startDate: z.string().min(1),
  endDate: z.string().min(1),
  travelers: z.object({
    count: z.number().int().positive(),
    budgetTotal: z.number().nonnegative(),
    currency: z.string().min(1),
  }),
  days: z.array(DaySchema).min(1),
  budget: z.object({
    lines: z.array(BudgetLineSchema),
    total: z.number(),
    planned: z.number(),
    delta: z.number(),
  }),
  risks: z.array(
    z.object({
      level: z.enum(["high", "medium", "low"]),
      title: z.string(),
      mitigation: z.string(),
    })
  ),
  unconfirmed: z.array(
    z.object({
      item: z.string(),
      reason: z.string(),
      howToVerify: z.string(),
    })
  ),
});

export type PlanValidationIssue = { path: string; message: string };

const EPS = 0.51;

function daysBetween(start: string, end: string): number | null {
  const a = Date.parse(start + "T00:00:00Z");
  const b = Date.parse(end + "T00:00:00Z");
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86_400_000) + 1;
}

/**
 * 行程数据一致性校验。SPEC §10 的验收规则全部在这里。
 * 返回 issues 列表；空数组 = 通过。
 */
export function validatePlan(input: unknown): PlanValidationIssue[] {
  const issues: PlanValidationIssue[] = [];
  const parsed = PlanSchema.safeParse(input);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      issues.push({
        path: issue.path.join(".") || "(root)",
        message: issue.message,
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
      message: `天数与日期区间不符：${plan.startDate} → ${plan.endDate} 应有 ${expectedDays} 天，实际 ${plan.days.length} 天`,
    });
  }

  plan.days.forEach((day, idx) => {
    const daySum = day.activities.reduce((acc, a) => acc + a.costTotal, 0);
    if (Math.abs(daySum - day.totalCost) > EPS) {
      issues.push({
        path: `days.${idx}.totalCost`,
        message: `第 ${day.day} 天小计错误：条目合计 ${round2(daySum)} ≠ totalCost ${round2(day.totalCost)}`,
      });
    }
    const expectedDate = addDays(plan.startDate, idx);
    if (expectedDate && day.date !== expectedDate) {
      issues.push({
        path: `days.${idx}.date`,
        message: `第 ${day.day} 天日期应为 ${expectedDate}，实际 ${day.date}`,
      });
    }
    day.activities.forEach((a, aidx) => {
      if ((a.costBasis ?? "per_person") === "per_person") {
        const expect = a.costPerPerson * plan.travelers.count;
        if (Math.abs(expect - a.costTotal) > EPS) {
          issues.push({
            path: `days.${idx}.activities.${aidx}.costTotal`,
            message: `「${a.title}」单人价 × ${plan.travelers.count} 人 = ${round2(expect)}，与 costTotal ${round2(a.costTotal)} 不符（若为全团费用请设 costBasis="per_group"）`,
          });
        }
      }
      if (a.needsBooking && a.bookingLeadDays === undefined) {
        issues.push({
          path: `days.${idx}.activities.${aidx}.bookingLeadDays`,
          message: `「${a.title}」标记为需预订时必须给出 bookingLeadDays`,
        });
      }
    });
  });

  const linesSum = plan.budget.lines.reduce((acc, l) => acc + l.amount, 0);
  if (Math.abs(linesSum - plan.budget.total) > EPS) {
    issues.push({
      path: "budget.total",
      message: `预算合计错误：明细合计 ${round2(linesSum)} ≠ total ${round2(plan.budget.total)}`,
    });
  }
  const daysSum = plan.days.reduce((acc, d) => acc + d.totalCost, 0);
  if (Math.abs(daysSum - plan.budget.total) > EPS) {
    issues.push({
      path: "budget.total",
      message: `预算合计与行程条目不一致：行程合计 ${round2(daysSum)} ≠ budget.total ${round2(plan.budget.total)}`,
    });
  }
  const expectDelta = plan.budget.total - plan.budget.planned;
  if (Math.abs(expectDelta - plan.budget.delta) > EPS) {
    issues.push({
      path: "budget.delta",
      message: `预算差额错误：total - planned = ${round2(expectDelta)}，与 delta ${round2(plan.budget.delta)} 不符`,
    });
  }
  if (plan.budget.planned !== plan.travelers.budgetTotal) {
    issues.push({
      path: "budget.planned",
      message: `budget.planned 必须等于 travelers.budgetTotal（${plan.travelers.budgetTotal}）`,
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
          message: `「${a.title}」标记 verified=false，但未出现在 unconfirmed 清单里`,
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

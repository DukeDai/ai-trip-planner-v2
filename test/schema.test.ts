import assert from "node:assert/strict";
import test from "node:test";
import { validatePlan } from "../src/core/schema.ts";

function basePlan(): Record<string, unknown> {
  return {
    tripId: "t1",
    destination: "北京",
    startDate: "2026-11-20",
    endDate: "2026-11-21",
    travelers: { count: 2, budgetTotal: 1000, currency: "CNY" },
    days: [
      {
        day: 1,
        date: "2026-11-20",
        theme: "中轴线",
        totalCost: 300,
        activities: [
          {
            time: "09:00",
            title: "故宫",
            type: "sight",
            location: "东城",
            durationMin: 120,
            costPerPerson: 100,
            costTotal: 200,
            notes: "",
            source: "open-meteo",
            fetchedAt: "2026-11-15T00:00:00.000Z",
            confidence: "high",
            needsBooking: false,
            verified: true
          },
          {
            time: "13:00",
            title: "午餐",
            type: "food",
            location: "东城",
            durationMin: 60,
            costPerPerson: 50,
            costTotal: 100,
            notes: "",
            source: "内置离线种子库（需复核）",
            fetchedAt: "2026-11-15T00:00:00.000Z",
            confidence: "medium",
            needsBooking: false,
            verified: false
          }
        ]
      },
      {
        day: 2,
        date: "2026-11-21",
        theme: "胡同",
        totalCost: 0,
        activities: [
          {
            time: "10:00",
            title: "什刹海",
            type: "sight",
            location: "西城",
            durationMin: 90,
            costPerPerson: 0,
            costTotal: 0,
            notes: "",
            source: "open-meteo",
            fetchedAt: "2026-11-15T00:00:00.000Z",
            confidence: "high",
            needsBooking: false,
            verified: true
          }
        ]
      }
    ],
    budget: {
      lines: [
        { category: "sight", label: "故宫门票", amount: 200, unit: "CNY", confidence: "high" },
        { category: "food", label: "午餐", amount: 100, unit: "CNY", confidence: "medium" }
      ],
      total: 300,
      planned: 1000,
      delta: -700
    },
    risks: [],
    unconfirmed: [{ item: "午餐", reason: "营业时间未确认", howToVerify: "电话确认" }]
  };
}

test("通过：一致的行程单没有 issue", () => {
  const issues = validatePlan(basePlan());
  assert.deepEqual(issues, []);
});

test("天数与日期区间不符会报错", () => {
  const plan = basePlan() as any;
  plan.days = plan.days.slice(0, 1);
  const issues = validatePlan(plan);
  assert.ok(issues.some((i) => i.path === "days" && i.message.includes("天数")));
});

test("日期不连续会报错", () => {
  const plan = basePlan() as any;
  plan.days[1].date = "2026-11-23";
  const issues = validatePlan(plan);
  assert.ok(issues.some((i) => i.path === "days.1.date"));
});

test("预算明细合计与 total 不一致会报错", () => {
  const plan = basePlan() as any;
  plan.budget.total = 999;
  const issues = validatePlan(plan);
  assert.ok(issues.some((i) => i.path === "budget.total"));
});

test("预算与行程条目不一致会报错", () => {
  const plan = basePlan() as any;
  plan.budget.lines[0].amount = 250;
  const issues = validatePlan(plan);
  assert.ok(issues.some((i) => i.path === "budget.total" && i.message.includes("明细合计")));
});

test("delta 计算错误会报错", () => {
  const plan = basePlan() as any;
  plan.budget.delta = 0;
  const issues = validatePlan(plan);
  assert.ok(issues.some((i) => i.path === "budget.delta"));
});

test("单人价 × 人数 与 costTotal 不符会报错", () => {
  const plan = basePlan() as any;
  plan.days[0].activities[0].costTotal = 150;
  const issues = validatePlan(plan);
  assert.ok(issues.some((i) => i.path.includes("costTotal")));
});

test("per_group 计价不按人数校验", () => {
  const plan = basePlan() as any;
  plan.days[0].activities[0].costBasis = "per_group";
  plan.days[0].activities[0].costTotal = 150;
  plan.days[0].totalCost = 250;
  plan.budget.lines[0].amount = 150;
  plan.budget.total = 250;
  plan.budget.delta = -750;
  const issues = validatePlan(plan);
  assert.deepEqual(issues, []);
});

test("verified=false 但没进 unconfirmed 会报错", () => {
  const plan = basePlan() as any;
  plan.unconfirmed = [];
  const issues = validatePlan(plan);
  assert.ok(issues.some((i) => i.path === "unconfirmed"));
});

test("source 为空会报错", () => {
  const plan = basePlan() as any;
  plan.days[0].activities[0].source = "";
  const issues = validatePlan(plan);
  assert.ok(issues.length > 0);
});

test("needsBooking 缺 bookingLeadDays 会报错", () => {
  const plan = basePlan() as any;
  plan.days[0].activities[0].needsBooking = true;
  const issues = validatePlan(plan);
  assert.ok(issues.some((i) => i.path.includes("bookingLeadDays")));
});

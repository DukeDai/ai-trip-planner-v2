import assert from "node:assert/strict";
import test from "node:test";
import { validatePlan } from "../src/core/schema.ts";

const FETCHED_AT = "2026-11-15T00:00:00.000Z";

function act(over: Record<string, unknown>): Record<string, unknown> {
  return {
    time: "09:00",
    title: "条目",
    type: "sight",
    location: "",
    durationMin: 60,
    costPerPerson: 0,
    costTotal: 0,
    notes: "",
    source: "Wikidata",
    fetchedAt: FETCHED_AT,
    confidence: "medium",
    needsBooking: false,
    verified: true,
    ...over
  };
}

function basePlan(): Record<string, unknown> {
  return {
    tripId: "t1",
    origin: "北京",
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
          act({
            time: "09:00",
            title: "故宫",
            type: "sight",
            location: "东城",
            durationMin: 120,
            costPerPerson: 100,
            costTotal: 200,
            source: "Wikidata",
            confidence: "high",
            city: "北京",
            lat: 39.9156,
            lon: 116.3908
          }),
          act({
            time: "13:00",
            title: "午餐",
            type: "food",
            location: "东城",
            durationMin: 60,
            costPerPerson: 50,
            costTotal: 100,
            source: "OpenStreetMap (Nominatim)",
            confidence: "medium",
            verified: false,
            city: "北京",
            lat: 39.906,
            lon: 116.4
          })
        ]
      },
      {
        day: 2,
        date: "2026-11-21",
        theme: "胡同",
        totalCost: 0,
        activities: [
          act({
            time: "10:00",
            title: "什刹海",
            type: "sight",
            location: "西城",
            durationMin: 90,
            source: "Wikidata",
            confidence: "high",
            city: "北京",
            lat: 39.9403,
            lon: 116.3855
          })
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

/** 上海 → 京都 的跨城行程（DD 点名的反例场景） */
function crossCityPlan(): Record<string, unknown> {
  return {
    tripId: "t2",
    origin: "上海",
    destination: "京都",
    startDate: "2026-11-20",
    endDate: "2026-11-21",
    travelers: { count: 2, budgetTotal: 1000, currency: "CNY" },
    days: [
      {
        day: 1,
        date: "2026-11-20",
        theme: "出发与落地",
        totalCost: 3000,
        activities: [
          act({
            time: "08:00",
            title: "上海浦东国际机场出发",
            type: "transport",
            location: "浦东新区",
            durationMin: 60,
            costPerPerson: 1500,
            costTotal: 3000,
            source: "Wikidata",
            needsBooking: true,
            bookingLeadDays: 14,
            city: "上海",
            lat: 31.1443,
            lon: 121.8083,
            fromCity: "上海",
            toCity: "京都"
          }),
          act({
            time: "15:00",
            title: "京都站周边",
            type: "sight",
            location: "京都站",
            durationMin: 60,
            source: "Wikidata",
            city: "京都",
            lat: 34.9858,
            lon: 135.7588
          })
        ]
      },
      {
        day: 2,
        date: "2026-11-21",
        theme: "京都古都",
        totalCost: 0,
        activities: [
          act({
            time: "09:00",
            title: "伏见稻荷大社",
            type: "sight",
            location: "伏见区",
            durationMin: 120,
            source: "Wikidata",
            city: "京都",
            lat: 34.9671,
            lon: 135.7727
          })
        ]
      }
    ],
    budget: {
      lines: [{ category: "transport", label: "往返机票", amount: 3000, unit: "CNY", confidence: "medium" }],
      total: 3000,
      planned: 1000,
      delta: 2000
    },
    risks: [],
    unconfirmed: []
  };
}

function withAlternative(plan: Record<string, unknown>): Record<string, unknown> {
  const p = plan;
  p.alternatives = [
    {
      decision: "上海 → 京都 2 天",
      fromCity: "上海",
      toCity: "京都",
      chosen: "上海浦东飞关西机场，再坐特急到京都",
      localAlternative: "上海本地：外滩、豫园、武康路、当代艺术博物馆",
      chosenCost: 3000,
      localCost: 400,
      costDelta: 2600,
      chosenTime: "单程飞行约 2.5 小时 + 特急 80 分钟",
      localTime: "市内地铁合计约 90 分钟",
      experienceGain: "京都的古寺与街景是上海没有的",
      recommendation: "downgrade",
      rationale: "成本是本地替代的 7.5 倍，若只是想看庭园，豫园与苏州园林更划算"
    }
  ];
  return p;
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

// ---------------- 第二轮：行程合理性 ----------------

test("同一天时间倒退会报错", () => {
  const plan = basePlan() as any;
  plan.days[0].activities[1].time = "08:00";
  const issues = validatePlan(plan);
  assert.ok(issues.some((i) => i.path === "days.0.activities.1.time" && i.message.includes("时间倒退")));
});

test("相邻点位地理跳变（无交通衔接）会报错", () => {
  const plan = basePlan() as any;
  plan.days[0].activities[1].lat = 35.0116;
  plan.days[0].activities[1].lon = 135.7681;
  const issues = validatePlan(plan);
  assert.ok(issues.some((i) => i.message.includes("地理跳变")));
});

test("缺 origin 会报错（城市轨迹无法校验）", () => {
  const plan = basePlan() as any;
  delete plan.origin;
  const issues = validatePlan(plan);
  assert.ok(issues.some((i) => i.path === "origin"));
});

test("activity 缺 city 会报错", () => {
  const plan = basePlan() as any;
  delete plan.days[0].activities[0].city;
  const issues = validatePlan(plan);
  assert.ok(issues.some((i) => i.path === "days.0.activities.0.city"));
});

test("落地前排目的地活动会报错（先在京都吃早餐、才从上海出发）", () => {
  const plan = crossCityPlan() as any;
  plan.days[0].activities = [
    act({
      time: "07:30",
      title: "京都早餐",
      type: "food",
      city: "京都",
      lat: 35.0116,
      lon: 135.7681,
      source: "Wikidata"
    }),
    plan.days[0].activities[0]
  ];
  plan.days[0].totalCost = 3000;
  const issues = validatePlan(plan);
  assert.ok(
    issues.some((i) => i.path === "days.0.activities.0.city" && i.message.includes("落地前")),
    "应当报「落地前不能排目的地活动」，实际：" + JSON.stringify(issues)
  );
});

test("跨城点位没有显式交通条目会报错", () => {
  const plan = crossCityPlan() as any;
  plan.days[0].activities = [plan.days[0].activities[1]];
  plan.days[0].totalCost = 0;
  plan.budget.lines = [];
  plan.budget.total = 0;
  plan.budget.delta = -1000;
  const issues = validatePlan(plan);
  assert.ok(issues.some((i) => i.path === "days.0.activities.0.city" && i.message.includes("跨城移动")));
});

test("跨城交通的起点与当前位置不符会报错", () => {
  const plan = crossCityPlan() as any;
  plan.days[0].activities[0].fromCity = "广州";
  const issues = validatePlan(plan);
  assert.ok(issues.some((i) => i.path === "days.0.activities.0.fromCity"));
});

test("跨城决策缺少本地替代方案会报错", () => {
  const plan = crossCityPlan();
  const issues = validatePlan(plan);
  assert.ok(
    issues.some((i) => i.path === "alternatives" && i.message.includes("本地替代")),
    "实际：" + JSON.stringify(issues)
  );
});

test("跨城决策给了本地替代对照 + 降级建议后通过", () => {
  const plan = withAlternative(crossCityPlan()) as any;
  plan.risks = [
    { level: "medium", title: "跨城性价比偏低", mitigation: "预算敏感就改上海本地替代，成本差约 2600 元" }
  ];
  const issues = validatePlan(plan);
  assert.deepEqual(issues, []);
});

test("本地替代的成本差算错会报错", () => {
  const plan = withAlternative(crossCityPlan()) as any;
  plan.alternatives[0].costDelta = 999;
  const issues = validatePlan(plan);
  assert.ok(issues.some((i) => i.path === "alternatives.0.costDelta"));
});

test("跨城成本远高于本地替代但没有降级建议会报错", () => {
  const plan = withAlternative(crossCityPlan());
  const issues = validatePlan(plan);
  assert.ok(issues.some((i) => i.path === "alternatives" && i.message.includes("降级建议")));
});

test("补上降级建议（risks 提到目的地）后通过", () => {
  const plan = withAlternative(crossCityPlan()) as any;
  plan.risks = [
    { level: "medium", title: "跨城性价比偏低", mitigation: "预算敏感就改上海本地替代，成本差约 2600 元" }
  ];
  const issues = validatePlan(plan);
  assert.deepEqual(issues, []);
});

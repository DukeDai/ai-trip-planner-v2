---
name: itinerary-craft
description: 行程编排规范与产物文件契约。当需要安排每日点位、平衡节奏、写出 itinerary.json / itinerary.md / budget.csv / packing.md / bookings.md 时使用。
---

# 行程编排规范

## 节奏

- 每日 **2–4 个正式点位**，最多 1 个「机动」条目
- 跨区移动（如城东→城西）必须用 `measure_travel_time` 核实耗时，并在 notes 写明通勤时间
- 每天至少留 **15% 时间缓冲**（估算点位时长总和 × 1.15 不得超过当天可用时长）
- 每天包含早/午/晚三个餐段（可写「自由用餐」但要占位）
- 连续两天高强度后，安排一个半日或全天的低强度日

## 主题

- 每天给一句话主题（`theme`），体现分区或主题差异（如「中轴线·皇城中轴」「艺术与工业」）

## 时间

- `time` 用 24 小时制 HH:mm
- `durationMin` 为该点位停留时长（不含通勤）
- 排程要真实：从上一个点位的结束时间 + 通勤时间开始排
- **同一天的时间必须单调不减** —— 时间倒排会被机器校验打回

## 城市与坐标（第二轮硬要求）

- 每条 activity 必须写：
  - `city`：**城市名**（如「上海」「京都」），不是区域名（外滩、伏见）
  - `lat` / `lon`：从工具返回里抄，不要凭印象填
- 跨城移动必须显式写成一条 `type=transport` 的条目，并写 `fromCity` / `toCity`：
  ```jsonc
  { "time": "08:00", "title": "上海浦东国际机场出发", "type": "transport",
    "city": "上海", "lat": 31.1443, "lon": 121.8083,
    "fromCity": "上海", "toCity": "京都", ... }
  ```
- **落地前不得排目的地活动**：先写跨城交通条目，再写当地活动。
  写成「第 1 天先在京都吃早餐，再从上海机场出发」会被机器校验打回。

## 跨城决策的本地替代（第二轮硬要求）

- 只要行程里出现跨城（`fromCity !== toCity`），`alternatives` 里必须有对应条目。
- 每条 alternative 必须写全：
  | 字段 | 含义 |
  |---|---|
  | `decision` / `fromCity` / `toCity` | 这次跨城决策是什么 |
  | `chosen` | 采用的方案 |
  | `localAlternative` | **不出远门的本地替代** |
  | `chosenCost` / `localCost` / `costDelta` | 成本对照（`costDelta = chosenCost - localCost`） |
  | `chosenTime` / `localTime` | 耗时对照 |
  | `experienceGain` | 体验维度对照：跨城换来了什么 |
  | `recommendation` | `keep` / `downgrade` / `switch` |
  | `rationale` | 结论依据 |
- 本地替代的点位要用 `find_local_alternative` 取真实数据，别空口比较。
- 跨城成本是本地替代 1.5 倍以上时，必须在 `risks` 里给出降级建议。

## 产物文件契约

行程目录（工作区根目录）下必须产出：

| 文件 | 内容 |
|---|---|
| `/itinerary.json` | 结构化行程（看板数据源），**必须通过校验** |
| `/itinerary.md` | 人读版行程单 |
| `/budget.csv` | 逐项预算，列：category,label,amount,unit,confidence |
| `/packing.md` | 打包与证件清单 |
| `/bookings.md` | 需预订清单（含提前天数与复核方式） |
| `/research/*.md` | 各子代理的调研原始记录 |
| `/research/facts.json` | 工具事实包（自动生成，审查用） |
| `/review/report.json` | 审查报告（自动生成，审查用） |

### itinerary.json 骨架

```jsonc
{
  "tripId": "…", "origin": "上海", "destination": "京都",
  "startDate": "YYYY-MM-DD", "endDate": "YYYY-MM-DD",
  "travelers": { "count": 2, "budgetTotal": 100000, "currency": "CNY" },
  "days": [{
    "day": 1, "date": "YYYY-MM-DD", "theme": "…", "totalCost": 0,
    "activities": [{
      "time": "09:30", "title": "…", "type": "sight|food|transport|stay|free",
      "location": "…", "durationMin": 120,
      "costPerPerson": 0, "costTotal": 0, "costBasis": "per_person",
      "notes": "…", "source": "…", "fetchedAt": "ISO8601",
      "confidence": "high|medium|low",
      "needsBooking": false, "bookingLeadDays": 0, "verified": true,
      "city": "京都", "lat": 35.0116, "lon": 135.7681,
      "fromCity": "上海", "toCity": "京都"
    }]
  }],
  "budget": { "lines": [{ "category": "stay|transport|sight|food|other", "label": "…", "amount": 0, "unit": "…", "confidence": "high|medium|low" }], "total": 0, "planned": 0, "delta": 0 },
  "risks": [{ "level": "high|medium|low", "title": "…", "mitigation": "…" }],
  "unconfirmed": [{ "item": "…", "reason": "…", "howToVerify": "…" }],
  "alternatives": [{
    "decision": "上海 → 京都 3 天",
    "fromCity": "上海", "toCity": "京都",
    "chosen": "…", "localAlternative": "…",
    "chosenCost": 12000, "localCost": 1800, "costDelta": 10200,
    "chosenTime": "…", "localTime": "…",
    "experienceGain": "…",
    "recommendation": "keep|downgrade|switch",
    "rationale": "…"
  }]
}
```

### 硬性约束

1. `days` 数组长度必须等于日期区间天数，且 `date` 逐日递增
2. `budget.total` = 明细合计 = 所有天小计合计
3. `budget.delta` = `total - planned`
4. `verified: false` 的条目必须出现在 `unconfirmed` 里
5. 每条 activity 的 `source` 不得为空
6. `tripId`、`destination`、日期、人数、预算必须与本次行程一致
7. `origin` 必须写（出发城市）
8. 每条 activity 必须有 `city`；跨城必须有显式 transport 条目
9. 同一天时间单调不减；相邻点位不能有巨大地理跳变
10. 跨城必须有 `alternatives` 对照（含成本 / 耗时 / 体验 / 结论）

## 交付流程（三道关卡，顺序不能乱）

1. 写完 `/itinerary.json` → 调 **`review_itinerary`**（LLM 审查：需求匹配 / 时间线地理自洽 / 性价比 / 来源可信度）
2. 报告有 blocking → 改稿 → 再调 `review_itinerary`（**最多 3 轮**）
3. 审查通过 → 调 **`submit_itinerary`**（机器校验 + 审查门禁）
4. 校验通过 → 调 `finalize_itinerary`（人工放行）

**有报错就改到通过为止**，不要带着错误往下走，也不要口头声称「已通过」。

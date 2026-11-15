---
name: itinerary-craft
description: 行程编排规范与产物文件契约。当需要安排每日点位、平衡节奏、写出 itinerary.json / itinerary.md / budget.csv / packing.md / bookings.md 时使用。
---

# 行程编排规范

## 节奏

- 每日 **2–4 个正式点位**，最多 1 个「机动」条目
- 跨区移动（如城东→城西）必须用 `get_route` 核实耗时，并在 notes 写明通勤时间
- 每天至少留 **15% 时间缓冲**（估算点位时长总和 × 1.15 不得超过当天可用时长）
- 每天包含早/午/晚三个餐段（可写「自由用餐」但要占位）
- 连续两天高强度后，安排一个半日或全天的低强度日

## 主题

- 每天给一句话主题（`theme`），体现分区或主题差异（如「中轴线·皇城中轴」「艺术与工业」）

## 时间

- `time` 用 24 小时制 HH:mm
- `durationMin` 为该点位停留时长（不含通勤）
- 排程要真实：从上一个点位的结束时间 + 通勤时间开始排

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

### itinerary.json 骨架

```json
{
  "tripId": "…", "destination": "…", "startDate": "YYYY-MM-DD", "endDate": "YYYY-MM-DD",
  "travelers": { "count": 2, "budgetTotal": 100000, "currency": "CNY" },
  "days": [{
    "day": 1, "date": "YYYY-MM-DD", "theme": "…", "totalCost": 0,
    "activities": [{
      "time": "09:30", "title": "…", "type": "sight|food|transport|stay|free",
      "location": "…", "durationMin": 120,
      "costPerPerson": 0, "costTotal": 0, "costBasis": "per_person",
      "notes": "…", "source": "…", "fetchedAt": "ISO8601",
      "confidence": "high|medium|low",
      "needsBooking": false, "bookingLeadDays": 0, "verified": true
    }]
  }],
  "budget": { "lines": [{ "category": "stay|transport|sight|food|other", "label": "…", "amount": 0, "unit": "…", "confidence": "high|medium|low" }], "total": 0, "planned": 0, "delta": 0 },
  "risks": [{ "level": "high|medium|low", "title": "…", "mitigation": "…" }],
  "unconfirmed": [{ "item": "…", "reason": "…", "howToVerify": "…" }]
}
```

### 硬性约束

1. `days` 数组长度必须等于日期区间天数，且 `date` 逐日递增
2. `budget.total` = 明细合计 = 所有天小计合计
3. `budget.delta` = `total - planned`
4. `verified: false` 的条目必须出现在 `unconfirmed` 里
5. 每条 activity 的 `source` 不得为空
6. `tripId`、`destination`、日期、人数、预算必须与本次行程一致

写完后调用 `submit_itinerary` 做机器校验；**有报错就改到通过为止**，不要带着错误往下走。

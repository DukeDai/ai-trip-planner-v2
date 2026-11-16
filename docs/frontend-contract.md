# 前端契约（TripPilot Web）— 前后端唯一事实来源

后端实现必须严格遵守本文件；前端只依赖本文件，不依赖后端源码。

## 0. 运行方式

- 静态目录：`web/`，由后端在 `/` 路径挂载（`GET /` → `web/index.html`）
- **无构建步骤**：纯 HTML + CSS + 原生 ES Module JS（`web/app.js`），禁止 CDN 外链（可能离线运行），禁止 TS 编译
- 浏览器支持：Chrome/Safari 近两年版本

## 1. HTTP API

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `/api/health` | — | `{ "ok": true, "llm": { "model": "...", "provider": "..." }, "dataSources": [{ "name": "open-meteo", "status": "up|down|degraded", "note": "..." }] }` |
| POST | `/api/trips` | `{ "title"?: string, "origin"?: string, "destination": string, "startDate": "YYYY-MM-DD", "endDate": "YYYY-MM-DD", "travelers": number, "budgetTotal": number, "currency"?: "CNY", "preferences"?: string[] }` | `201 { "trip": { "id": "...", "title": "...", ... } }` |
| GET | `/api/trips` | — | `{ "trips": [ { "id", "title", "origin", "destination", "startDate", "endDate", "status", "createdAt" } ] }` |
| GET | `/api/trips/:id` | — | `{ "trip": {...}, "plan": ItineraryPlan \| null, "files": [{ "name", "bytes", "updatedAt" }] }` |
| GET | `/api/trips/:id/files/:name` | — | 文件原文（`text/markdown`、`application/json`、`text/csv`），支持 `?download=1` 触发下载 |
| POST | `/api/trips/:id/chat` | `{ "message": string }` | SSE（见 §2），**POST + fetch 流式读取**，不是 EventSource |
| POST | `/api/trips/:id/approve` | `{ "interruptId": string, "approved": boolean, "reason"?: string }` | `{ "ok": true }`，随后客户端继续读 SSE |

### 错误约定
HTTP 4xx/5xx 时返回 JSON：`{ "error": { "code": "BAD_REQUEST", "message": "人话说明" } }`，前端需把 message 显示出来。

## 2. SSE 事件流

响应头：`Content-Type: text/event-stream; charset=utf-8`、`Cache-Control: no-cache`、`Connection: keep-alive`
每条消息格式：`data: {json}\n\n`

事件 JSON 统一形状：`{ "type": "...", ...}`

```ts
type SSEEvent =
  | { type: "status"; phase: "clarify"|"research"|"synthesize"|"budget"|"finalize"|"done"|"error"; message: string }
  | { type: "todo"; todos: { content: string; status: "pending"|"in_progress"|"completed" }[] }
  | { type: "tool"; name: string; status: "running"|"ok"|"error"; input?: unknown; outputPreview?: string; ms?: number }
  | { type: "subagent"; name: string; status: "running"|"ok"|"error"; summary?: string }
  | { type: "token"; text: string }
  | { type: "artifact"; name: string; bytes: number }
  | { type: "interrupt"; interruptId: string; kind: "finalize"; title: string; details: string[]; budget?: { planned: number; total: number; delta: number; currency: string } }
  | { type: "error"; code: string; message: string }
  | { type: "done"; messageId?: string; plan?: ItineraryPlan | null };
```

事件到达顺序不做强保证；`done` 是流结束标志；断流视为失败。

## 3. ItineraryPlan 结构（看板数据源）

```ts
interface ItineraryPlan {
  tripId: string;
  origin?: string;          // 出发城市（第二轮新增）
  destination: string;
  startDate: string;         // YYYY-MM-DD
  endDate: string;           // YYYY-MM-DD
  travelers: { count: number; budgetTotal: number; currency: string };
  days: Array<{
    day: number;
    date: string;            // YYYY-MM-DD
    theme: string;
    totalCost: number;
    activities: Array<{
      time: string;          // "09:30"
      title: string;
      type: "sight" | "food" | "transport" | "stay" | "free";
      location: string;
      durationMin: number;
      costPerPerson: number;
      costTotal: number;
      notes: string;
      source: string;        // 数据来源，永不为空
      fetchedAt: string;     // ISO 时间
      confidence: "high" | "medium" | "low";
      needsBooking: boolean;
      bookingLeadDays?: number;
      verified: boolean;     // false → 必须出现在 unconfirmed
      city?: string;         // 所在城市（第二轮新增）
      lat?: number;          // 第二轮新增：地理连贯性校验
      lon?: number;
      fromCity?: string;     // 仅 transport 类：跨城起点（第二轮新增）
      toCity?: string;       // 仅 transport 类：跨城终点（第二轮新增）
    }>;
  }>;
  budget: {
    lines: { category: "stay"|"transport"|"sight"|"food"|"other"; label: string; amount: number; unit: string; confidence: string }[];
    total: number;
    planned: number;         // = travelers.budgetTotal
    delta: number;           // = total - planned，负数=超支
  };
  risks: { level: "high"|"medium"|"low"; title: string; mitigation: string }[];
  unconfirmed: { item: string; reason: string; howToVerify: string }[];
  alternatives?: ItineraryAlternative[];   // 第二轮：跨城决策的本地替代对比
}

interface ItineraryAlternative {
  decision: string;        // 这次决策的标题
  fromCity: string;
  toCity: string;
  chosen: string;          // 采用的方案
  localAlternative: string;// 本地替代方案
  chosenCost: number;
  localCost: number;
  costDelta: number;       // chosenCost - localCost
  chosenTime: string;      // 耗时对比
  localTime: string;
  experienceGain: string;  // 体验增益
  recommendation: "keep" | "downgrade" | "switch";
  rationale: string;       // 结论依据
}
```

## 4. 页面结构（三栏工作台）

```
┌────────────────────────────────────────────────────────────┐
│ 顶栏: 产品名 | 行程选择器 | 预算徽标 | 数据源状态 | 新建行程 │
├───────────────┬─────────────────────────┬──────────────────┤
│ 左: 对话流     │ 中: 行程看板（按天）      │ 右: 预算 & 产物   │
│ - 消息气泡     │ - Day 卡片: 日期/主题/小计 │ - 预算进度条      │
│ - todo 清单   │ - 条目: 时间/类型/标题/耗时 │ - 分类金额        │
│ - 工具调用折叠 │        费用/来源徽标/待订标记 │ - 超支高亮       │
│ - 子代理委派   │ - 风险卡 / 待确认卡         │ - 产物文件列表    │
│ - 输入框       │ - 本地替代对比（第二轮）    │ - 导出按钮        │
└───────────────┴─────────────────────────┴──────────────────┘
```

## 5. 交互要求

1. **新建行程表单**（弹窗）：目的地、起止日期、人数、总预算、偏好多选（美食/自然/艺术/购物/夜景/亲子/历史/休闲）。
2. **对话**：用户发消息 → 左栏出现气泡 → 实时显示 todo 进度、工具调用（可折叠）、子代理委派、模型输出 token。
3. **看板**：拿到 `done` 事件里的 plan 后渲染；之后任何 `artifact` 事件也刷新看板（可重新 GET /api/trips/:id）。
4. **HITL**：收到 `interrupt` 事件 → 在对话流中插入「待确认卡片」，列出 details + 预算差额，提供「放行 / 驳回并说明」两个按钮 → 调用 `/api/trips/:id/approve` → 继续读流。
5. **预算条**：口径为 `delta = 实际合计 - 预算计划` —— `delta > 0` 为超支（红色，显示超出额），`delta < 0` 为结余（绿色，显示结余额），`delta === 0` 持平。
6. **来源徽标**：confidence=high 绿 / medium 黄 / low 灰；`verified:false` 显示「待核实」徽标。
7. **产物区**：列出 `itinerary.md` / `itinerary.json` / `budget.csv` / `packing.md` / `bookings.md` / `research/*.md`，点击下载或预览。
   **只暴露这 5 个根目录交付物 + `research/*.md`** —— 内部事实包（`research/facts.json`）、
   审查报告（`review/report.json`）、草稿脚本、`skills/` 一律不列出。
8. **本地替代对比**（第二轮）：行程含 `alternatives` 时，在看板下方渲染「本地替代对比」板块，
   每项显示：采用方案 / 本地替代 / 成本对比（¥X vs ¥Y，差 ¥Z）/ 耗时对比 / 体验增益 / 结论依据，
   并按 `recommendation` 打徽标：keep=保留 / downgrade=降级 / switch=换成本地。
9. **错误**：任何 `error` 事件必须在左栏以红色条展示，且解除输入框禁用。

## 6. 视觉方向

- 深色专业控制台风格（背景 `#0d1117`~`#111827` 系，卡片 `#161b22`，分割线 `#232b36`，文字 `#e6edf3`/`#8b949e`）
- 主色：青绿 `#2dd4bf`；警示：琥珀 `#f59e0b`；危险：`#f43f5e`
- 中文界面；数字用等宽字体；不要花哨动画，控制在 150ms 内
- 响应式：<1100px 时三栏折叠为单栏 + 顶部标签切换
- 不使用任何外部字体/图标库（用 Unicode 符号或内联 SVG）
